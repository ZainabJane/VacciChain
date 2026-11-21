const express = require('express');
const crypto = require('crypto');
const StellarSdk = require('@stellar/stellar-sdk');
const authMiddleware = require('../middleware/auth');
const { adminAuthMiddleware } = require('../middleware/auth');
const { queryAuditLog, audit } = require('../middleware/auditLog');
const { insertApiKey, listApiKeys, revokeApiKey } = require('../indexer/db');
const { rotateKey, reloadFromEnv } = require('../jwtKeys');
const {
  approveProposal,
  getProposal,
  createProposal,
  cancelProposal,
} = require('../middleware/multiSig');
const { isValidStellarPublicKey } = require('../middleware/wallet');
const { addIssuer, revokeIssuer, simulateContract } = require('../stellar/soroban');
const { isAuthorizedIssuer, invalidateCache } = require('../stellar/issuerCache');
const validate = require('../middleware/validate');
const {
  addIssuerSchema,
  createApiKeySchema,
  rotateJwtSchema,
  approveProposalSchema,
  proposeAdminRotationSchema,
  cancelProposalSchema,
} = require('./schemas/admin.schemas');

// Admin rotation policy: a rotation proposal must collect MULTISIG_THRESHOLD
// approvals and cannot be accepted before ADMIN_ROTATION_DELAY_MS has elapsed
// since it was proposed (gives the incumbent admin time to cancel a hostile
// proposal). Proposals expire after ADMIN_ROTATION_EXPIRY_MS.
const ADMIN_ROTATION_DELAY_MS = parseInt(process.env.ADMIN_ROTATION_DELAY_MS || '86400000', 10);
const ADMIN_ROTATION_EXPIRY_MS = parseInt(process.env.ADMIN_ROTATION_EXPIRY_MS || '604800000', 10);
const ADMIN_ROTATION_OPERATION = 'admin.rotate';

// In-memory record of the currently active admin rotation, if any. Only one
// rotation may be in flight at a time so that a compromised key cannot stack
// competing proposals.
let activeAdminRotation = null;
=======

const router = express.Router();

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}



// ── Issuer management ─────────────────────────────────────────────────────────

/**
 * POST /admin/issuers
 * Body: { address: string }
 * Authorizes a new issuer on-chain via add_issuer contract call.
 *
 * Idempotency: re-adding an already-authorized issuer is a no-op that returns
 * 200 with `already_authorized: true` (the contract call is not re-submitted).
 */
router.post('/issuers', adminAuthMiddleware, adminOnly, validate(addIssuerSchema), async (req, res) => {
  const { address } = req.body;

  try {
    const alreadyAuthorized = await isAuthorizedIssuer(address);
    if (alreadyAuthorized) {
      audit({
        actor: req.user.wallet,
        action: 'admin.add_issuer',
        result: 'noop',
        meta: { address, reason: 'already_authorized' },
      });
      return res.status(200).json({ address, authorized: true, already_authorized: true });
    }

    const result = await addIssuer(address);
    invalidateCache(address);
    audit({ actor: req.user.wallet, action: 'admin.add_issuer', result: 'success', meta: { address, hash: result.hash } });
    res.status(201).json({ address, authorized: true, already_authorized: false, hash: result.hash });
  } catch (err) {
    audit({ actor: req.user.wallet, action: 'admin.add_issuer', result: 'failure', meta: { address, error: err.message } });
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /admin/issuers/:wallet
 * Revokes an issuer on-chain via revoke_issuer contract call.
 *
 * Idempotency: revoking an issuer that is not currently authorized is a no-op
 * that returns 200 with `already_revoked: true` (the contract call is not
 * re-submitted).
 */
router.delete('/issuers/:wallet', adminAuthMiddleware, adminOnly, async (req, res) => {
  const { wallet } = req.params;
  if (!isValidStellarPublicKey(wallet)) {
    return res.status(400).json({ error: 'Invalid Stellar public key' });
  }

  try {
    const authorized = await isAuthorizedIssuer(wallet);
    if (!authorized) {
      audit({
        actor: req.user.wallet,
        action: 'admin.revoke_issuer',
        target: wallet,
        result: 'noop',
        meta: { reason: 'not_authorized' },
      });
      return res.status(200).json({ wallet, authorized: false, already_revoked: true });
    }

    const result = await revokeIssuer(wallet);
    invalidateCache(wallet);
    audit({ actor: req.user.wallet, action: 'admin.revoke_issuer', target: wallet, result: 'success', meta: { hash: result.hash } });
    res.json({ wallet, authorized: false, already_revoked: false, hash: result.hash });
  } catch (err) {
    audit({ actor: req.user.wallet, action: 'admin.revoke_issuer', target: wallet, result: 'failure', meta: { error: err.message } });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /admin/issuers
 * Lists all authorized issuers by reading contract state.
 */
router.get('/issuers', adminAuthMiddleware, adminOnly, async (req, res) => {
  try {
    const retval = await simulateContract('list_issuers', []);
    // Contract returns a Vec of addresses; parse into an array of strings
    let issuers = [];
    if (retval && retval.switch().name === 'scvVec') {
      issuers = retval.vec().map((v) => StellarSdk.Address.fromScVal(v).toString());
    }
    res.json({ issuers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Audit log ─────────────────────────────────────────────────────────────────

/**
 * GET /admin/audit
 */
router.get('/audit', adminAuthMiddleware, adminOnly, (req, res) => {
  const { actor, from, to } = req.query;
  const limit  = Math.min(parseInt(req.query.limit  || '100', 10), 1000);
  const offset = Math.max(parseInt(req.query.offset || '0',   10), 0);

  if (from && isNaN(new Date(from).getTime())) {
    return res.status(400).json({ error: 'Invalid "from" date' });
  }
  if (to && isNaN(new Date(to).getTime())) {
    return res.status(400).json({ error: 'Invalid "to" date' });
  }

  const entries = queryAuditLog({ actor, from, to });
  const page    = entries.slice(offset, offset + limit);
  res.json({ total: entries.length, offset, limit, entries: page });
});

// ── API key management ────────────────────────────────────────────────────────

router.post('/api-keys', adminAuthMiddleware, adminOnly, validate(createApiKeySchema), (req, res) => {
  const { label } = req.body;

  const rawKey  = crypto.randomBytes(32).toString('hex');
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const id      = crypto.randomUUID();

  insertApiKey({ id, key_hash: keyHash, label: label.trim(), created_at: new Date().toISOString() });

  res.status(201).json({ id, label: label.trim(), key: rawKey });
});

router.get('/api-keys', adminAuthMiddleware, adminOnly, (_req, res) => {
  res.json(listApiKeys());
});

router.delete('/api-keys/:id', adminAuthMiddleware, adminOnly, (req, res) => {
  revokeApiKey(req.params.id);
  res.json({ revoked: true });
});

// ── JWT key rotation ──────────────────────────────────────────────────────────

/**
 * POST /admin/jwt/rotate
 *
 * Rotate the JWT signing key at runtime without a service restart.
 * The current key is demoted to "previous" (still accepted for verification
 * during the transition window). The new key is used for all future tokens.
 *
 * Body (option A — supply new secret directly):
 *   { new_secret: string, new_kid?: string }
 *
 * Body (option B — reload from environment, e.g. after secrets manager refresh):
 *   { reload_from_env: true }
 *
 * Requires admin role.
 */
router.post('/jwt/rotate', adminAuthMiddleware, adminOnly, validate(rotateJwtSchema), (req, res) => {
  const { new_secret, new_kid, reload_from_env } = req.body;

  try {
    if (reload_from_env) {
      reloadFromEnv();
      return res.json({ rotated: true, method: 'env_reload' });
    }

    rotateKey({ newSecret: new_secret, newKid: new_kid });
    res.json({ rotated: true, method: 'inline', kid: new_kid || 'auto' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Multi-sig proposal management ─────────────────────────────────────────────

/**
 * POST /admin/multisig/approve
 * Body: { proposal_id: string }
 *
 * A registered key holder approves a pending multi-sig proposal.
 * Once MULTISIG_THRESHOLD approvals are collected the proposal is marked
 * "approved" and the initiator can re-submit the original request with
 * the proposal_id to execute it.
 */
router.post('/multisig/approve', adminAuthMiddleware, adminOnly, validate(approveProposalSchema), (req, res) => {
  const { proposal_id } = req.body;

  try {
    const proposal = approveProposal(proposal_id, req.user.wallet);
    res.json({
      proposal_id: proposal.id,
      operation: proposal.operation,
      approvals: proposal.approvals.size,
      status: proposal.status,
      expires_at: new Date(proposal.expiresAt).toISOString(),
    });
  } catch (err) {
    const status = err.message.includes('not found') ? 404
      : err.message.includes('expired') ? 410
      : err.message.includes('not a registered') ? 403
      : 400;
    res.status(status).json({ error: err.message });
  }
});

/**
 * GET /admin/multisig/proposals/:id
 * Returns the current state of a proposal (approval count, status, expiry).
 */
router.get('/multisig/proposals/:id', adminAuthMiddleware, adminOnly, (req, res) => {
  const proposal = getProposal(req.params.id);
  if (!proposal) {
    return res.status(404).json({ error: 'Proposal not found or expired' });
  }
  res.json({
    proposal_id: proposal.id,
    operation: proposal.operation,
    initiator: proposal.initiator,
    approvals: proposal.approvals.size,
    status: proposal.status,
    expires_at: new Date(proposal.expiresAt).toISOString(),
  });
});

// ── Administrator recovery / rotation ─────────────────────────────────────────

function serializeRotation(proposal) {
  return {
    proposal_id: proposal.id,
    operation: proposal.operation,
    initiator: proposal.initiator,
    new_admin: proposal.payload?.new_admin,
    approvals: proposal.approvals.size,
    status: proposal.status,
    proposed_at: new Date(proposal.createdAt).toISOString(),
    accept_after: new Date(proposal.createdAt + ADMIN_ROTATION_DELAY_MS).toISOString(),
    expires_at: new Date(proposal.expiresAt).toISOString(),
  };
}

/**
 * POST /admin/rotation/propose
 * Body: { new_admin: string }
 *
 * Proposes replacing the administrator key. The proposal is subject to the
 * multi-sig threshold and a mandatory delay before it can be accepted. Only
 * one rotation may be in flight at a time; a second proposal is rejected with
 * 409 until the active one is accepted or cancelled.
 */
router.post('/rotation/propose', adminAuthMiddleware, adminOnly, validate(proposeAdminRotationSchema), (req, res) => {
  const { new_admin } = req.body;

  if (activeAdminRotation) {
    const existing = getProposal(activeAdminRotation);
    if (existing && existing.status === 'pending') {
      audit({
        actor: req.user.wallet,
        action: 'admin.rotation.propose',
        result: 'failure',
        meta: { new_admin, reason: 'rotation_in_progress', proposal_id: existing.id },
      });
      return res.status(409).json({ error: 'A rotation proposal is already in progress', proposal_id: existing.id });
    }
    activeAdminRotation = null;
  }

  try {
    const proposal = createProposal({
      operation: ADMIN_ROTATION_OPERATION,
      initiator: req.user.wallet,
      payload: { new_admin },
      ttlMs: ADMIN_ROTATION_EXPIRY_MS,
    });
    activeAdminRotation = proposal.id;
    audit({
      actor: req.user.wallet,
      action: 'admin.rotation.propose',
      result: 'success',
      meta: { new_admin, proposal_id: proposal.id },
    });
    res.status(201).json(serializeRotation(proposal));
  } catch (err) {
    audit({
      actor: req.user.wallet,
      action: 'admin.rotation.propose',
      result: 'failure',
      meta: { new_admin, error: err.message },
    });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /admin/rotation/accept
 * Body: { proposal_id: string }
 *
 * Records this admin's approval of the rotation proposal. The rotation only
 * takes effect once the multi-sig threshold is met AND the mandatory delay has
 * elapsed since the proposal was created. Replay of an already-accepted
 * proposal returns 409.
 */
router.post('/rotation/accept', adminAuthMiddleware, adminOnly, validate(approveProposalSchema), (req, res) => {
  const { proposal_id } = req.body;

  try {
    const existing = getProposal(proposal_id);
    if (!existing) {
      audit({ actor: req.user.wallet, action: 'admin.rotation.accept', result: 'failure', meta: { proposal_id, reason: 'not_found' } });
      return res.status(404).json({ error: 'Proposal not found or expired' });
    }
    if (existing.operation !== ADMIN_ROTATION_OPERATION) {
      audit({ actor: req.user.wallet, action: 'admin.rotation.accept', result: 'failure', meta: { proposal_id, reason: 'wrong_operation' } });
      return res.status(400).json({ error: 'Proposal is not an admin rotation' });
    }
    if (existing.status === 'approved') {
      audit({ actor: req.user.wallet, action: 'admin.rotation.accept', result: 'failure', meta: { proposal_id, reason: 'already_accepted' } });
      return res.status(409).json({ error: 'Rotation proposal already accepted' });
    }
    if (Date.now() < existing.createdAt + ADMIN_ROTATION_DELAY_MS) {
      audit({ actor: req.user.wallet, action: 'admin.rotation.accept', result: 'failure', meta: { proposal_id, reason: 'delay_not_elapsed' } });
      return res.status(425).json({
        error: 'Rotation delay has not elapsed',
        accept_after: new Date(existing.createdAt + ADMIN_ROTATION_DELAY_MS).toISOString(),
      });
    }

    const proposal = approveProposal(proposal_id, req.user.wallet);
    audit({
      actor: req.user.wallet,
      action: 'admin.rotation.accept',
      result: 'success',
      meta: { proposal_id, approvals: proposal.approvals.size, status: proposal.status },
    });
    if (proposal.status === 'approved') {
      activeAdminRotation = null;
    }
    res.json(serializeRotation(proposal));
  } catch (err) {
    const status = err.message.includes('not found') ? 404
      : err.message.includes('expired') ? 410
      : err.message.includes('not a registered') ? 403
      : 400;
    audit({ actor: req.user.wallet, action: 'admin.rotation.accept', result: 'failure', meta: { proposal_id, error: err.message } });
    res.status(status).json({ error: err.message });
  }
});

/**
 * POST /admin/rotation/cancel
 * Body: { proposal_id: string }
 *
 * Cancels a pending rotation proposal. Cancelling an already-cancelled
 * proposal is idempotent (200). Cancelling an accepted proposal is rejected
 * with 409 because the rotation has already taken effect.
 */
router.post('/rotation/cancel', adminAuthMiddleware, adminOnly, validate(cancelProposalSchema), (req, res) => {
  const { proposal_id } = req.body;

  try {
    const existing = getProposal(proposal_id);
    if (!existing) {
      audit({ actor: req.user.wallet, action: 'admin.rotation.cancel', result: 'failure', meta: { proposal_id, reason: 'not_found' } });
      return res.status(404).json({ error: 'Proposal not found or expired' });
    }
    if (existing.operation !== ADMIN_ROTATION_OPERATION) {
      audit({ actor: req.user.wallet, action: 'admin.rotation.cancel', result: 'failure', meta: { proposal_id, reason: 'wrong_operation' } });
      return res.status(400).json({ error: 'Proposal is not an admin rotation' });
    }
    if (existing.status === 'approved') {
      audit({ actor: req.user.wallet, action: 'admin.rotation.cancel', result: 'failure', meta: { proposal_id, reason: 'already_accepted' } });
      return res.status(409).json({ error: 'Rotation proposal already accepted' });
    }
    if (existing.status === 'cancelled') {
      audit({ actor: req.user.wallet, action: 'admin.rotation.cancel', result: 'noop', meta: { proposal_id } });
      return res.status(200).json({ ...serializeRotation(existing), already_cancelled: true });
    }

    const proposal = cancelProposal(proposal_id, req.user.wallet);
    if (activeAdminRotation === proposal_id) {
      activeAdminRotation = null;
    }
    audit({ actor: req.user.wallet, action: 'admin.rotation.cancel', result: 'success', meta: { proposal_id } });
    res.json({ ...serializeRotation(proposal), already_cancelled: false });
  } catch (err) {
    const status = err.message.includes('not found') ? 404
      : err.message.includes('expired') ? 410
      : err.message.includes('not a registered') ? 403
      : 400;
    audit({ actor: req.user.wallet, action: 'admin.rotation.cancel', result: 'failure', meta: { proposal_id, error: err.message } });
    res.status(status).json({ error: err.message });
  }
});

/**
 * GET /admin/rotation
 * Returns the currently active admin rotation proposal, if any.
 */
router.get('/rotation', adminAuthMiddleware, adminOnly, (_req, res) => {
  if (!activeAdminRotation) {
    return res.json({ active: null });
  }
  const proposal = getProposal(activeAdminRotation);
  if (!proposal) {
    activeAdminRotation = null;
    return res.json({ active: null });
  }
  res.json({ active: serializeRotation(proposal) });
});

module.exports = router;
