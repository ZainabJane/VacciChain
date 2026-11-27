const express = require('express');
const { ERROR_CODES, sendError } = require('../errors');
const crypto = require('crypto');
const StellarSdk = require('@stellar/stellar-sdk');
const authMiddleware = require('../middleware/auth');
const { adminAuthMiddleware } = require('../middleware/auth');
const { queryAuditLog, audit } = require('../middleware/auditLog');
const { insertApiKey, listApiKeys, revokeApiKey, updateApiKeyScopes } = require('../indexer/db');
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
const { getIndexerStatus, pauseIndexer, resumeIndexer, reconcileRange } = require('../indexer/operations');
const validate = require('../middleware/validate');
const { addIssuerSchema, createApiKeySchema, rotateJwtSchema, approveProposalSchema, purgeRetentionSchema } = require('./schemas/admin.schemas');
const { runRetentionPurge, RETENTION_POLICIES } = require('../retention');

const router = express.Router();

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}



// ── Issuer management ─────────────────────────────────────────────────────────

/**
 * @swagger
 * /admin/issuers:
 *   post:
 *     summary: Authorize a new issuer on-chain
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - address
 *             properties:
 *               address:
 *                 type: string
 *     responses:
 *       201:
 *         description: Issuer authorized
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - admin required
 *   delete:
 *     summary: Revoke an issuer on-chain
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: wallet
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Issuer revoked
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - admin required
 *   get:
 *     summary: List all authorized issuers
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Issuer list
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - admin required
 */

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
    sendError(req, res, 500, ERROR_CODES.INTERNAL_ERROR, err.message);
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
    sendError(req, res, 500, ERROR_CODES.INTERNAL_ERROR, err.message);
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
    sendError(req, res, 500, ERROR_CODES.INTERNAL_ERROR, err.message);
  }
});

// ── Audit log ─────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /admin/audit:
 *   get:
 *     summary: Query audit log entries
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: actor
 *         schema: { type: string }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *       - in: query
 *         name: offset
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Audit entries
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - admin required
 */

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

/**
 * @swagger
 * /admin/api-keys:
 *   post:
 *     summary: Create a verifier API key
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - label
 *             properties:
 *               label:
 *                 type: string
 *     responses:
 *       201:
 *         description: API key created
 *   get:
 *     summary: List all API keys
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: API key list
 *   delete:
 *     summary: Revoke an API key
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: API key revoked
 */

/**
 * POST /admin/api-keys
 * Body: { label: string }
 */
router.post('/api-keys', adminAuthMiddleware, adminOnly, validate(createApiKeySchema), (req, res) => {
  const { label } = req.body;
  const scopes = normalizeScopes(req.body.scopes);
  if (scopes === null) {
    return res.status(400).json({ error: 'scopes must be an array of strings' });
  }

  const rawKey  = generateApiKey();
  const keyHash = hashApiKey(rawKey);
  const id      = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  try {
    insertApiKey({
      id,
      key_hash: keyHash,
      label: label.trim(),
      scopes,
      created_at: createdAt,
      rotated_from: null,
    });
    audit({ actor: req.user.wallet, action: 'api_key.create', target: id, result: 'success', meta: { label: label.trim(), scopes } });
    res.status(201).json({ id, label: label.trim(), scopes, created_at: createdAt, key: rawKey });
  } catch (err) {
    audit({ actor: req.user.wallet, action: 'api_key.create', target: id, result: 'failure', meta: { error: err.message } });
    res.status(500).json({ error: err.message });
  }
});

router.get('/api-keys', adminAuthMiddleware, adminOnly, (_req, res) => {
  res.json(listApiKeys());
});

/**
 * POST /admin/api-keys/:id/rotate
 *
 * Issues a replacement key for an existing (non-revoked) key. The old record
 * is revoked and linked to the new one via rotated_from; the new raw key is
 * returned exactly once.
 */
router.post('/api-keys/:id/rotate', adminAuthMiddleware, adminOnly, (req, res) => {
  const oldId = req.params.id;
  const existing = listApiKeys().find((k) => k.id === oldId);
  if (!existing) {
    audit({ actor: req.user.wallet, action: 'api_key.rotate', target: oldId, result: 'failure', meta: { error: 'not found' } });
    return res.status(404).json({ error: 'API key not found' });
  }
  if (existing.revoked_at) {
    audit({ actor: req.user.wallet, action: 'api_key.rotate', target: oldId, result: 'failure', meta: { error: 'already revoked' } });
    return res.status(409).json({ error: 'API key already revoked' });
  }

  const rawKey  = generateApiKey();
  const keyHash = hashApiKey(rawKey);
  const newId   = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  try {
    insertApiKey({
      id: newId,
      key_hash: keyHash,
      label: existing.label,
      scopes: existing.scopes || [],
      created_at: createdAt,
      rotated_from: oldId,
    });
    revokeApiKey(oldId);
    audit({ actor: req.user.wallet, action: 'api_key.rotate', target: oldId, result: 'success', meta: { new_id: newId } });
    res.status(201).json({
      id: newId,
      label: existing.label,
      scopes: existing.scopes || [],
      created_at: createdAt,
      rotated_from: oldId,
      key: rawKey,
    });
  } catch (err) {
    audit({ actor: req.user.wallet, action: 'api_key.rotate', target: oldId, result: 'failure', meta: { error: err.message } });
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /admin/api-keys/:id/scopes
 * Body: { scopes: string[] }
 *
 * Replaces the scope set of an existing, non-revoked key.
 */
router.patch('/api-keys/:id/scopes', adminAuthMiddleware, adminOnly, (req, res) => {
  const id = req.params.id;
  const scopes = normalizeScopes(req.body.scopes);
  if (scopes === null || scopes.length === 0) {
    audit({ actor: req.user.wallet, action: 'api_key.scope', target: id, result: 'failure', meta: { error: 'invalid scopes' } });
    return res.status(400).json({ error: 'scopes must be a non-empty array of strings' });
  }

  const existing = listApiKeys().find((k) => k.id === id);
  if (!existing) {
    audit({ actor: req.user.wallet, action: 'api_key.scope', target: id, result: 'failure', meta: { error: 'not found' } });
    return res.status(404).json({ error: 'API key not found' });
  }
  if (existing.revoked_at) {
    audit({ actor: req.user.wallet, action: 'api_key.scope', target: id, result: 'failure', meta: { error: 'already revoked' } });
    return res.status(409).json({ error: 'API key already revoked' });
  }

  try {
    updateApiKeyScopes(id, scopes);
    audit({ actor: req.user.wallet, action: 'api_key.scope', target: id, result: 'success', meta: { scopes } });
    res.json({ id, scopes });
  } catch (err) {
    audit({ actor: req.user.wallet, action: 'api_key.scope', target: id, result: 'failure', meta: { error: err.message } });
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api-keys/:id', adminAuthMiddleware, adminOnly, (req, res) => {
  const id = req.params.id;
  try {
    revokeApiKey(id);
    audit({ actor: req.user.wallet, action: 'api_key.revoke', target: id, result: 'success' });
    res.json({ revoked: true });
  } catch (err) {
    audit({ actor: req.user.wallet, action: 'api_key.revoke', target: id, result: 'failure', meta: { error: err.message } });
    res.status(500).json({ error: err.message });
  }
});

// ── JWT key rotation ──────────────────────────────────────────────────────────

/**
 * @swagger
 * /admin/jwt/rotate:
 *   post:
 *     summary: Rotate the JWT signing key at runtime
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               new_secret:
 *                 type: string
 *               new_kid:
 *                 type: string
 *               reload_from_env:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Key rotated
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - admin required
 */

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
    sendError(req, res, 500, ERROR_CODES.INTERNAL_ERROR, err.message);
  }
});

// ── Multi-sig proposal management ─────────────────────────────────────────────

/**
 * @swagger
 * /admin/multisig/approve:
 *   post:
 *     summary: Approve a pending multi-sig proposal
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - proposal_id
 *             properties:
 *               proposal_id:
 *                 type: string
 *     responses:
 *       200:
 *         description: Proposal approval recorded
 *   get:
 *     summary: Get the current state of a proposal
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Proposal state
 */

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

// ── Retention & purge policies ────────────────────────────────────────────────

/**
 * GET /admin/retention/policies
 * Returns the documented data classes, retention periods and deletion
 * constraints. Audit and recovery records are flagged as protected.
 */
router.get('/retention/policies', adminAuthMiddleware, adminOnly, (_req, res) => {
  res.json({ policies: RETENTION_POLICIES });
});

/**
 * POST /admin/retention/purge
 * Body: { data_classes?: string[], dry_run?: boolean }
 *
 * Triggers the automated retention purge jobs. Only data classes that are
 * eligible for deletion are purged; audit logs and recovery records are
 * always protected and never deleted by this job. The purge action itself
 * is recorded in the audit log.
 */
router.post('/retention/purge', adminAuthMiddleware, adminOnly, validate(purgeRetentionSchema), (req, res) => {
  const { data_classes: dataClasses, dry_run: dryRun = false } = req.body || {};

  try {
    const result = runRetentionPurge({ dataClasses, dryRun });

    if (!dryRun) {
      audit({
        actor: req.user.wallet,
        action: 'admin.retention_purge',
        result: 'success',
        meta: {
          data_classes: result.purged.map((p) => p.data_class),
          deleted: result.purged.reduce((sum, p) => sum + p.deleted, 0),
          skipped_protected: result.skipped,
        },
      });
    }

    res.json(result);
  } catch (err) {
    audit({
      actor: req.user.wallet,
      action: 'admin.retention_purge',
      result: 'failure',
      meta: { error: err.message },
    });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
