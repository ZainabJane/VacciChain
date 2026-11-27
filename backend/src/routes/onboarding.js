/**
 * Issuer onboarding routes.
 *
 * POST /v1/onboarding/apply       — healthcare provider submits application (requires patient/issuer JWT)
 * GET  /v1/onboarding/applications — admin lists all applications (admin JWT required)
 * POST /v1/onboarding/applications/:id/review — admin approves or rejects (admin JWT required)
 */

const express = require('express');
const { ERROR_CODES, sendError } = require('../errors');
const crypto = require('crypto');
const authMiddleware = require('../middleware/auth');
const validate = require('../middleware/validate');
const { audit } = require('../middleware/auditLog');
const { addIssuer } = require('../stellar/soroban');
const { requireMultiSig } = require('../middleware/multiSig');
const {
  insertIssuerApplication,
  getIssuerApplication,
  listIssuerApplications,
  updateIssuerApplicationStatus,
} = require('../indexer/db');
const { applySchema, reviewSchema } = require('./schemas/onboarding.schemas');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();

/**
 * Rate limiters for onboarding endpoints.
 *
 * Client identity is derived from the trusted proxy configuration (see
 * `middleware/rateLimit`), so spoofed `X-Forwarded-For` headers from
 * untrusted sources cannot be used to bypass the limit.
 *
 * On limit exceeded the response is:
 *   429 Too Many Requests
 *   Retry-After: <seconds>
 *   { "error": "Too many requests", "retryAfter": <seconds> }
 */
const applyLimiter = createRateLimiter({
  name: 'onboarding_apply',
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
});

const reviewLimiter = createRateLimiter({
  name: 'onboarding_review',
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
});

function adminOnly(req, res, next) {
  if (req.user?.role !== 'issuer') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Any authenticated user can submit an onboarding request.
 */
router.post('/apply', applyLimiter, authMiddleware, validate(applySchema), async (req, res) => {
  const { name, license_number, country, wallet } = req.body;

  // Prevent duplicate applications from the same wallet
  const existing = listIssuerApplications().find(a => a.wallet === wallet && a.status === 'pending');
  if (existing) {
    return res.status(409).json({ error: 'A pending application already exists for this wallet.' });
  }

  const id = crypto.randomUUID();
  insertIssuerApplication({ id, wallet, name, license_number, country, submitted_at: new Date().toISOString() });

  audit({ actor: req.user.wallet, action: 'onboarding.apply', result: 'submitted', meta: { id, wallet } });

  res.status(201).json({ id, status: 'pending', message: 'Application submitted. You will be notified of the outcome.' });
});

/**
 * GET /onboarding/applications
 * Admin only — list all applications, optionally filtered by status.
 */
router.get('/applications', authMiddleware, adminOnly, (req, res) => {
  const { status } = req.query;
  const allowed = ['pending', 'approved', 'rejected'];
  if (status && !allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }
  res.json(listIssuerApplications({ status }));
});

/**
 * POST /onboarding/applications/:id/review
 * Admin only — approve or reject an application.
 * On approval, the wallet is added to the contract issuer allowlist.
 * Requires M-of-N multi-sig approval (see MULTISIG_THRESHOLD env var).
 */
router.post('/applications/:id/review', reviewLimiter, authMiddleware, adminOnly, validate(reviewSchema), requireMultiSig('onboarding_review'), async (req, res) => {
  const application = getIssuerApplication(req.params.id);
  if (!application) {
    return res.status(404).json({ error: 'Application not found' });
  }
  if (application.status !== 'pending') {
    return res.status(409).json({ error: `Application is already ${application.status}` });
  }

  const { decision, reviewer_note } = req.body;

  const previousStatus = application.status;

  if (!isValidTransition(previousStatus, decision)) {
    return res.status(400).json({
      error: `Invalid transition from '${previousStatus}' to '${decision}'`,
      allowed: ALLOWED_TRANSITIONS[previousStatus] || [],
    });
  }

  if (decision === ONBOARDING_STATES.APPROVED) {
    try {
      await addIssuer(application.wallet);
    } catch (err) {
      return sendError(req, res, 502, ERROR_CODES.RPC_ERROR, 'Contract call failed');
    }
  }

  const reviewedAt = new Date().toISOString();
  const reviewedBy = req.user.wallet;

  updateIssuerApplicationStatus(req.params.id, {
    status: decision,
    reviewer_note,
    reviewed_by: reviewedBy,
    reviewed_at: reviewedAt,
  });

  audit({
    actor: reviewedBy,
    action: 'onboarding.review',
    result: decision,
    meta: {
      applicationId: req.params.id,
      applicantWallet: application.wallet,
      previousStatus,
      newStatus: decision,
      reviewer_note: reviewer_note ?? null,
      reviewedAt,
    },
  });

  res.json({
    id: req.params.id,
    status: decision,
    wallet: application.wallet,
    reviewed_by: reviewedBy,
    reviewed_at: reviewedAt,
  });
});

module.exports = router;
