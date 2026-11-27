const express = require('express');
const authMiddleware = require('../middleware/auth');
const { adminAuthMiddleware, requireWalletAccess } = require('../middleware/auth');
const { getConsent, recordConsent, hasConsented, transaction } = require('../indexer/db');
const validate = require('../middleware/validate');
const { recordConsentSchema } = require('./schemas/consent.schemas');
const { AppError } = require('../middleware/errors');

const router = express.Router();

/**
 * @swagger
 * /v1/patient/consent/{wallet}:
 *   get:
 *     summary: Get consent status for a wallet
 *     tags:
 *       - Consent
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: wallet
 *         required: true
 *         schema: { type: string }
 *         description: Stellar wallet address
 *     responses:
 *       200:
 *         description: Consent status
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - patients may only read their own consent
 */

/**
 * GET /patient/consent/:wallet
 * Returns consent status for a wallet. Requires a JWT (#45): a patient may
 * only read their own consent; issuers (re-verified on-chain, used before
 * minting) and admins may read any wallet's.
 */
router.get('/consent/:wallet', adminAuthMiddleware, requireWalletAccess('wallet'), (req, res) => {
  const { wallet } = req.params;

  if (req.user.role === 'patient' && req.user.wallet !== wallet) {
    return next(new AppError('forbidden', 'Patients may only access their own consent data', 403));
  }

  const consent = getConsent(wallet);
  res.json(buildConsentResponse(wallet, consent));
});

/**
 * @swagger
 * /v1/patient/consent:
 *   post:
 *     summary: Record explicit patient consent
 *     tags:
 *       - Consent
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               wallet:
 *                 type: string
 *             required:
 *               - wallet
 *     responses:
 *       201:
 *         description: Consent recorded
 *       401:
 *         description: Unauthorized
 */

/**
 * POST /patient/consent
 * Record explicit patient consent. Requires patient JWT.
 *
 * Transitions:
 *   absent  -> granted
 *   revoked -> changed (re-grant)
 *   granted/changed -> no-op (idempotent)
 *
 * The existence check and the insert are performed inside a single explicit
 * transaction so that concurrent requests for the same wallet cannot both
 * observe "no consent" and race to insert. The transaction is rolled back on
 * any partial failure.
 */
router.post('/consent', authMiddleware, validate(recordConsentSchema), (req, res, next) => {
  const { publicKey } = req.user;

  let existing = null;
  let wasRevoked = false;
  let alreadyConsented = false;

  try {
    transaction((tx) => {
      existing = getConsent(publicKey, tx);
      const current = deriveConsentState(existing);

      if (current.state === CONSENT_STATES.GRANTED || current.state === CONSENT_STATES.CHANGED) {
        alreadyConsented = true;
        return;
      }

      // absent -> granted, or revoked -> changed (re-grant).
      wasRevoked = current.state === CONSENT_STATES.REVOKED;
      recordConsent(publicKey, { regrant: wasRevoked, tx });
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to record consent' });
  }

  if (alreadyConsented) {
    return res.json({
      success: true,
      ...buildConsentResponse(publicKey, existing),
      already_consented: true,
    });
  }

  const updated = getConsent(publicKey);
  const status = wasRevoked ? 200 : 201;
  res.status(status).json({
    success: true,
    ...buildConsentResponse(publicKey, updated),
  });
});

/**
 * DELETE /patient/consent
 * Revoke previously granted consent. Requires patient JWT.
 *
 * Transitions:
 *   granted/changed -> revoked
 *   absent/revoked  -> no-op (idempotent, returns current state)
 *
 * Note: revocation stops future issuance but does not remove already-issued
 * credentials from the public chain.
 */
router.delete('/consent', authMiddleware, (req, res) => {
  const { publicKey } = req.user;
  const existing = getConsent(publicKey);
  const current = deriveConsentState(existing);

  if (current.state === CONSENT_STATES.ABSENT || current.state === CONSENT_STATES.REVOKED) {
    return res.json({
      success: true,
      ...buildConsentResponse(publicKey, existing),
      already_revoked: current.state === CONSENT_STATES.REVOKED,
    });
  }

  revokeConsent(publicKey);
  const updated = getConsent(publicKey);
  res.json({
    success: true,
    ...buildConsentResponse(publicKey, updated),
  });
});

module.exports = router;
module.exports.CONSENT_STATES = CONSENT_STATES;
module.exports.deriveConsentState = deriveConsentState;
