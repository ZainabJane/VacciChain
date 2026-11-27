'use strict';

/**
 * Admin multi-signature middleware.
 *
 * Critical admin operations (add/revoke issuer, contract upgrade, pause) require
 * M-of-N approvals from registered key holders before the operation is executed.
 *
 * Flow:
 *  1. Initiator submits the operation with their JWT — a pending proposal is created.
 *  2. Each additional key holder calls POST /admin/multisig/approve with the proposal ID.
 *  3. Once M approvals are collected the proposal is marked "approved" and the
 *     original handler is allowed to proceed.
 *  4. Proposals expire after PROPOSAL_TTL_MS (default 1 hour).
 *
 * Configuration (environment variables):
 *  MULTISIG_THRESHOLD   – number of approvals required (M), default 2
 *  MULTISIG_KEY_HOLDERS – comma-separated list of wallet addresses that may approve
 *
 * Storage is in-process (Map). For multi-instance deployments replace with Redis.
 */

const crypto = require('crypto');
const { audit } = require('./auditLog');
const logger = require('../logger');

const PROPOSAL_TTL_MS = parseInt(process.env.MULTISIG_PROPOSAL_TTL_MS || String(60 * 60 * 1000), 10);
const THRESHOLD = parseInt(process.env.MULTISIG_THRESHOLD || '2', 10);

// Admin rotation policy configuration
// Delay between a rotation proposal reaching threshold and being executable (timelock).
const ROTATION_DELAY_MS = parseInt(process.env.MULTISIG_ROTATION_DELAY_MS || String(24 * 60 * 60 * 1000), 10);
// Rotation proposals expire after this window if not executed.
const ROTATION_TTL_MS = parseInt(process.env.MULTISIG_ROTATION_TTL_MS || String(7 * 24 * 60 * 60 * 1000), 10);
// Threshold required for rotation proposals (defaults to the general threshold).
const ROTATION_THRESHOLD = parseInt(process.env.MULTISIG_ROTATION_THRESHOLD || String(THRESHOLD), 10);
// Emergency rotations bypass the delay but still require the full threshold.
const EMERGENCY_ROTATION_DELAY_MS = parseInt(process.env.MULTISIG_EMERGENCY_ROTATION_DELAY_MS || '0', 10);
=======

/**
 * Parse the comma-separated key holder list from env.
 * @returns {Set<string>}
 */
function getKeyHolders() {
  const raw = process.env.MULTISIG_KEY_HOLDERS || '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/**
 * @typedef {Object} Proposal
 * @property {string}   id          - UUID
 * @property {string}   operation   - e.g. "add_issuer", "revoke_issuer", "upgrade"
 * @property {Object}   params      - operation parameters (for audit trail)
 * @property {string}   initiator   - wallet address of the initiator
 * @property {Set<string>} approvals - wallet addresses that have approved
 * @property {number}   createdAt   - epoch ms
 * @property {number}   expiresAt   - epoch ms
 * @property {'pending'|'approved'|'expired'} status
 */

/** @type {Map<string, Proposal>} */
const proposals = new Map();

/**
 * @typedef {Object} RotationProposal
 * @property {string}   id            - UUID
 * @property {'rotation'} kind
 * @property {string}   operation     - "rotate_admin_key" | "recover_admin_key"
 * @property {string}   targetWallet  - wallet address being added/replaced
 * @property {string}   replacedWallet - wallet address being removed (may be null)
 * @property {string}   initiator     - wallet address of the initiator
 * @property {Set<string>} approvals  - wallet addresses that have approved
 * @property {number}   createdAt     - epoch ms
 * @property {number}   expiresAt     - epoch ms
 * @property {number}   executableAt  - epoch ms (createdAt + delay)
 * @property {boolean}  emergency     - whether the timelock delay is bypassed
 * @property {string}   nonce         - single-use nonce for replay protection
 * @property {'pending'|'approved'|'executed'|'cancelled'|'expired'} status
 */

/** @type {Map<string, RotationProposal>} */
const rotationProposals = new Map();

// Track consumed nonces to prevent replay of executed/cancelled rotations.
/** @type {Set<string>} */
const consumedNonces = new Set();

// Purge expired proposals every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of proposals) {
    if (now > p.expiresAt && p.status === 'pending') {
      p.status = 'expired';
      proposals.delete(id);
    }
  }
  for (const [id, p] of rotationProposals) {
    if (now > p.expiresAt && (p.status === 'pending' || p.status === 'approved')) {
      p.status = 'expired';
      rotationProposals.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();

/**
 * Create a new multi-sig proposal.
 * The initiator's approval is counted automatically.
 *
 * @param {string} operation
 * @param {Object} params
 * @param {string} initiatorWallet
 * @returns {Proposal}
 */
function createProposal(operation, params, initiatorWallet) {
  const id = crypto.randomUUID();
  const now = Date.now();
  const proposal = {
    id,
    operation,
    params,
    initiator: initiatorWallet,
    approvals: new Set([initiatorWallet]),
    createdAt: now,
    expiresAt: now + PROPOSAL_TTL_MS,
    status: 'pending',
  };
  proposals.set(id, proposal);

  audit({
    actor: initiatorWallet,
    action: `multisig.proposal_created`,
    result: 'pending',
    meta: { proposalId: id, operation, threshold: THRESHOLD },
  });

  logger.info('multisig proposal created', { proposalId: id, operation, initiator: initiatorWallet });
  return proposal;
}

/**
 * Add an approval to an existing proposal.
 * Returns the updated proposal.
 *
 * @param {string} proposalId
 * @param {string} approverWallet
 * @returns {Proposal}
 */
function approveProposal(proposalId, approverWallet) {
  const proposal = proposals.get(proposalId);
  if (!proposal) throw new Error('Proposal not found');
  if (proposal.status !== 'pending') throw new Error(`Proposal is ${proposal.status}`);
  if (Date.now() > proposal.expiresAt) {
    proposal.status = 'expired';
    proposals.delete(proposalId);
    throw new Error('Proposal has expired');
  }

  const keyHolders = getKeyHolders();
  if (keyHolders.size > 0 && !keyHolders.has(approverWallet)) {
    throw new Error('Approver is not a registered key holder');
  }

  proposal.approvals.add(approverWallet);

  audit({
    actor: approverWallet,
    action: 'multisig.approval_added',
    result: 'pending',
    meta: { proposalId, operation: proposal.operation, approvals: proposal.approvals.size, threshold: THRESHOLD },
  });

  if (proposal.approvals.size >= THRESHOLD) {
    proposal.status = 'approved';
    audit({
      actor: approverWallet,
      action: 'multisig.proposal_approved',
      result: 'success',
      meta: { proposalId, operation: proposal.operation },
    });
    logger.info('multisig proposal approved', { proposalId, operation: proposal.operation });
  }

  return proposal;
}

/**
 * Get a proposal by ID (read-only).
 * @param {string} proposalId
 * @returns {Proposal|undefined}
 */
function getProposal(proposalId) {
  return proposals.get(proposalId);
}

/**
 * Create an admin key rotation/recovery proposal.
 * The initiator's approval is counted automatically.
 *
 * @param {Object} opts
 * @param {string} opts.operation      - "rotate_admin_key" | "recover_admin_key"
 * @param {string} opts.targetWallet   - wallet being added/replaced
 * @param {string|null} [opts.replacedWallet] - wallet being removed
 * @param {string} opts.initiatorWallet
 * @param {boolean} [opts.emergency]   - bypass the timelock delay
 * @param {string} [opts.nonce]        - client-supplied nonce (defaults to random)
 * @returns {RotationProposal}
 */
function createRotationProposal(opts) {
  const { operation, targetWallet, replacedWallet = null, initiatorWallet, emergency = false } = opts;
  if (!operation) throw new Error('operation is required');
  if (!targetWallet) throw new Error('targetWallet is required');
  if (!initiatorWallet) throw new Error('initiatorWallet is required');

  const nonce = opts.nonce || crypto.randomBytes(16).toString('hex');
  if (consumedNonces.has(nonce)) {
    throw new Error('Nonce already used (replay detected)');
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const delay = emergency ? EMERGENCY_ROTATION_DELAY_MS : ROTATION_DELAY_MS;
  const proposal = {
    id,
    kind: 'rotation',
    operation,
    targetWallet,
    replacedWallet,
    initiator: initiatorWallet,
    approvals: new Set([initiatorWallet]),
    createdAt: now,
    expiresAt: now + ROTATION_TTL_MS,
    executableAt: now + delay,
    emergency: Boolean(emergency),
    nonce,
    status: 'pending',
  };
  rotationProposals.set(id, proposal);

  audit({
    actor: initiatorWallet,
    action: 'multisig.rotation_proposed',
    result: 'pending',
    meta: {
      proposalId: id,
      operation,
      targetWallet,
      replacedWallet,
      emergency: proposal.emergency,
      threshold: ROTATION_THRESHOLD,
      delayMs: delay,
      expiresAt: new Date(proposal.expiresAt).toISOString(),
    },
  });

  logger.info('multisig rotation proposal created', {
    proposalId: id,
    operation,
    initiator: initiatorWallet,
    emergency: proposal.emergency,
  });
  return proposal;
}

/**
 * Approve a rotation proposal.
 *
 * @param {string} proposalId
 * @param {string} approverWallet
 * @returns {RotationProposal}
 */
function approveRotationProposal(proposalId, approverWallet) {
  const proposal = rotationProposals.get(proposalId);
  if (!proposal) throw new Error('Rotation proposal not found');
  if (proposal.status === 'cancelled') throw new Error('Rotation proposal is cancelled');
  if (proposal.status === 'executed') throw new Error('Rotation proposal already executed');
  if (proposal.status === 'expired') throw new Error('Rotation proposal has expired');
  if (Date.now() > proposal.expiresAt) {
    proposal.status = 'expired';
    rotationProposals.delete(proposalId);
    throw new Error('Rotation proposal has expired');
  }

  const keyHolders = getKeyHolders();
  if (keyHolders.size > 0 && !keyHolders.has(approverWallet)) {
    throw new Error('Approver is not a registered key holder');
  }

  proposal.approvals.add(approverWallet);

  audit({
    actor: approverWallet,
    action: 'multisig.rotation_approval_added',
    result: 'pending',
    meta: {
      proposalId,
      operation: proposal.operation,
      approvals: proposal.approvals.size,
      threshold: ROTATION_THRESHOLD,
    },
  });

  if (proposal.approvals.size >= ROTATION_THRESHOLD && proposal.status === 'pending') {
    proposal.status = 'approved';
    audit({
      actor: approverWallet,
      action: 'multisig.rotation_approved',
      result: 'success',
      meta: {
        proposalId,
        operation: proposal.operation,
        executableAt: new Date(proposal.executableAt).toISOString(),
      },
    });
    logger.info('multisig rotation proposal approved', { proposalId, operation: proposal.operation });
  }

  return proposal;
}

/**
 * Cancel a rotation proposal. Any registered key holder may cancel while pending/approved.
 *
 * @param {string} proposalId
 * @param {string} actorWallet
 * @returns {RotationProposal}
 */
function cancelRotationProposal(proposalId, actorWallet) {
  const proposal = rotationProposals.get(proposalId);
  if (!proposal) throw new Error('Rotation proposal not found');
  if (proposal.status === 'executed') throw new Error('Rotation proposal already executed');
  if (proposal.status === 'cancelled') throw new Error('Rotation proposal already cancelled');

  const keyHolders = getKeyHolders();
  if (keyHolders.size > 0 && !keyHolders.has(actorWallet)) {
    throw new Error('Actor is not a registered key holder');
  }

  proposal.status = 'cancelled';
  consumedNonces.add(proposal.nonce);
  rotationProposals.delete(proposalId);

  audit({
    actor: actorWallet,
    action: 'multisig.rotation_cancelled',
    result: 'success',
    meta: { proposalId, operation: proposal.operation },
  });
  logger.info('multisig rotation proposal cancelled', { proposalId, operation: proposal.operation });
  return proposal;
}

/**
 * Execute an approved rotation proposal once the timelock delay has elapsed.
 * Returns the executed proposal. The nonce is consumed to prevent replay.
 *
 * @param {string} proposalId
 * @param {string} actorWallet
 * @returns {RotationProposal}
 */
function executeRotationProposal(proposalId, actorWallet) {
  const proposal = rotationProposals.get(proposalId);
  if (!proposal) throw new Error('Rotation proposal not found');
  if (proposal.status === 'executed') throw new Error('Rotation proposal already executed');
  if (proposal.status === 'cancelled') throw new Error('Rotation proposal is cancelled');
  if (proposal.status === 'expired') throw new Error('Rotation proposal has expired');
  if (Date.now() > proposal.expiresAt) {
    proposal.status = 'expired';
    rotationProposals.delete(proposalId);
    throw new Error('Rotation proposal has expired');
  }
  if (proposal.status !== 'approved') {
    throw new Error('Rotation proposal has not reached threshold');
  }
  if (Date.now() < proposal.executableAt) {
    throw new Error('Rotation proposal timelock has not elapsed');
  }
  if (consumedNonces.has(proposal.nonce)) {
    throw new Error('Nonce already used (replay detected)');
  }

  const keyHolders = getKeyHolders();
  if (keyHolders.size > 0 && !keyHolders.has(actorWallet)) {
    throw new Error('Actor is not a registered key holder');
  }

  proposal.status = 'executed';
  consumedNonces.add(proposal.nonce);
  rotationProposals.delete(proposalId);

  audit({
    actor: actorWallet,
    action: 'multisig.rotation_executed',
    result: 'success',
    meta: {
      proposalId,
      operation: proposal.operation,
      targetWallet: proposal.targetWallet,
      replacedWallet: proposal.replacedWallet,
      emergency: proposal.emergency,
    },
  });
  logger.info('multisig rotation proposal executed', { proposalId, operation: proposal.operation });
  return proposal;
}

/**
 * Get a rotation proposal by ID (read-only).
 * @param {string} proposalId
 * @returns {RotationProposal|undefined}
 */
function getRotationProposal(proposalId) {
  return rotationProposals.get(proposalId);
}

/**
 * Express middleware factory.
 *
 * Wraps a critical admin operation with multi-sig enforcement.
 * Usage:
 *   router.post('/issuers', authMiddleware, adminOnly, requireMultiSig('add_issuer'), handler)
 *
 * Request flow:
 *  - If no `proposal_id` in body → create a new proposal, return 202 with proposal details.
 *  - If `proposal_id` present and proposal is approved → allow handler to proceed.
 *  - If `proposal_id` present but not yet approved → return 202 with current approval count.
 *
 * @param {string} operationName - human-readable name for audit logs
 * @returns {import('express').RequestHandler}
 */
function requireMultiSig(operationName) {
  return (req, res, next) => {
    // If threshold is 1 (or 0), skip multi-sig — single admin is sufficient
    if (THRESHOLD <= 1) return next();

    const { proposal_id } = req.body;
    const initiatorWallet = req.user?.wallet;

    if (!proposal_id) {
      // Step 1: create proposal
      const proposal = createProposal(operationName, req.body, initiatorWallet);
      return res.status(202).json({
        message: `Multi-sig required. ${THRESHOLD - 1} more approval(s) needed.`,
        proposal_id: proposal.id,
        approvals: proposal.approvals.size,
        threshold: THRESHOLD,
        expires_at: new Date(proposal.expiresAt).toISOString(),
      });
    }

    // Step 2: check existing proposal
    const proposal = proposals.get(proposal_id);
    if (!proposal) {
      return res.status(404).json({ error: 'Proposal not found or expired' });
    }
    if (proposal.status === 'expired') {
      return res.status(410).json({ error: 'Proposal has expired' });
    }
    if (proposal.status !== 'approved') {
      return res.status(202).json({
        message: `Waiting for approvals. ${THRESHOLD - proposal.approvals.size} more needed.`,
        proposal_id: proposal.id,
        approvals: proposal.approvals.size,
        threshold: THRESHOLD,
        expires_at: new Date(proposal.expiresAt).toISOString(),
      });
    }

    // Approved — consume proposal and proceed
    proposals.delete(proposal_id);
    next();
  };
}

module.exports = {
  requireMultiSig,
  createProposal,
  approveProposal,
  getProposal,
  createRotationProposal,
  approveRotationProposal,
  cancelRotationProposal,
  executeRotationProposal,
  getRotationProposal,
};
