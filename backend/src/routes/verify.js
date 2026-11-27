const express = require('express');
const StellarSdk = require('@stellar/stellar-sdk');
const { validateStellarPublicKey } = require('../middleware/wallet');
const { simulateContract, verifyVaccination, SorobanTimeoutError, sendRpcTimeout } = require('../stellar/soroban');
const { resolveContractErrorMessage } = require('../stellar/contractErrors');
const { verifyLimiter, verifierKeyLimiter } = require('../middleware/rateLimiter');
const verifierApiKey = require('../middleware/verifierApiKey');
const authMiddleware = require('../middleware/auth');
const { audit } = require('../middleware/auditLog');

const router = express.Router();

const verifyCache = new Map();
const CACHE_TTL = 60 * 1000; // 60 seconds

/**
 * Verification status values. These are the only values a caller may rely on:
 * - valid:       records exist and are currently valid
 * - revoked:     records exist but have been revoked
 * - absent:      no records exist for the wallet
 * - unavailable: the contract/RPC could not be queried; this is NOT a negative result
 */
const VERIFY_STATUS = Object.freeze({
  VALID: 'valid',
  REVOKED: 'revoked',
  ABSENT: 'absent',
  UNAVAILABLE: 'unavailable',
});

/**
 * Derive the explicit verification status from a successful contract result.
 * A wallet is only "valid" when it has at least one non-revoked record.
 */
function deriveStatus(vaccinated, records) {
  const list = Array.isArray(records) ? records : [];
  if (list.length === 0) return VERIFY_STATUS.ABSENT;
  if (vaccinated) return VERIFY_STATUS.VALID;
  return VERIFY_STATUS.REVOKED;
}

/**
 * Detect RPC/transport failures that must be surfaced as "unavailable"
 * rather than collapsed into a positive or negative verification result.
 */
function isUnavailableError(err) {
  if (!err) return true;
  if (err instanceof SorobanTimeoutError) return true;
  if (err.code === 'SOROBAN_TIMEOUT' || err.code === 'RPC_UNAVAILABLE') return true;
  const msg = typeof err.message === 'string' ? err.message.toLowerCase() : '';
  return (
    msg.includes('timeout') ||
    msg.includes('deadline') ||
    msg.includes('abort') ||
    msg.includes('unavailable') ||
    msg.includes('econnrefused') ||
    msg.includes('network')
  );
}

/**
 * Try JWT first; if no Authorization header, fall through to API key auth.
 * One of the two must succeed — otherwise 401.
 */
function jwtOrApiKey(req, res, next) {
  if (req.headers.authorization) {
    return authMiddleware(req, res, next);
  }
  return verifierApiKey(req, res, next);
}

/**
 * Pick the right rate limiter based on how the caller authenticated.
 * API-key callers get verifierKeyLimiter; JWT callers get verifyLimiter.
 */
function adaptiveLimiter(req, res, next) {
  if (req.verifier) return verifierKeyLimiter(req, res, next);
  return verifyLimiter(req, res, next);
}

/**
 * @swagger
 * /verify/public/{wallet}:
 *   get:
 *     summary: Public vaccination status verification (no authentication required)
 *     description: >
 *       Public endpoint for checking vaccination status. Used by verification pages
 *       and third-party integrators. No authentication required.
 *       Results are cached for 60 seconds to reduce RPC load.
 *     tags:
 *       - Verification
 *     parameters:
 *       - in: path
 *         name: wallet
 *         required: true
 *         schema:
 *           type: string
 *         description: Stellar wallet address to verify
 *     responses:
 *       200:
 *         description: Vaccination status retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 wallet:
 *                   type: string
 *                 verified:
 *                   type: boolean
 *                   description: >
 *                     True only when status is "valid". Never true when status is
 *                     "revoked", "absent", or "unavailable".
 *                 status:
 *                   type: string
 *                   enum: [valid, revoked, absent, unavailable]
 *                   description: >
 *                     Explicit verification status. "unavailable" means the data
 *                     could not be retrieved and MUST NOT be interpreted as a
 *                     negative (or positive) medical determination.
 *                 records:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/VaccinationRecord'
 *       400:
 *         description: Invalid wallet format
 *       429:
 *         description: Rate limit exceeded (60 requests per IP per minute)
 *       503:
 *         description: >
 *           RPC timeout or service unavailable. Response body has
 *           status "unavailable" and verified false; this is not a negative result.
 *       500:
 *         description: Contract query failed (status "unavailable", verified false)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// GET /verify/public/:wallet — Public endpoint, no authentication required
router.get(
  '/public/:wallet',
  validateStellarPublicKey('params', 'wallet'),
  verifyLimiter,
  async (req, res) => {
    const { wallet } = req.params;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    const now = Date.now();
    const cached = verifyCache.get(wallet);
    if (cached && (now - cached.timestamp < CACHE_TTL)) {
      return res.json({
        wallet,
        status: cached.status,
        verified: cached.status === VERIFY_STATUS.VALID,
        records: cached.records
      });
    }

    try {
      const { vaccinated, records } = await verifyVaccination(wallet);
      const status = deriveStatus(vaccinated, records);

      verifyCache.set(wallet, {
        status,
        vaccinated,
        records,
        timestamp: now
      });

      audit({
        actor: ip,
        action: 'verify.public_lookup',
        target: wallet,
        result: 'success',
        meta: { ip, status },
      });

      res.json({
        wallet,
        status,
        verified: status === VERIFY_STATUS.VALID,
        records
      });
    } catch (err) {
      const errorMessage = resolveContractErrorMessage(err);
      audit({ actor: ip, action: 'verify.public_lookup', target: wallet, result: 'failure', meta: { error: errorMessage, ip } });

      // An RPC/contract failure is "unavailable" — never a positive verification
      // result, and never a negative determination either.
      const unavailable = isUnavailableError(err);
      res.status(unavailable ? 503 : 500).json({
        wallet,
        status: VERIFY_STATUS.UNAVAILABLE,
        verified: false,
        error: errorMessage
      });
    }
  }
);

/**
 * @swagger
 * /verify/{wallet}:
 *   get:
 *     summary: Authenticated vaccination status verification
 *     description: >
 *       Requires JWT or API key authentication. Returns detailed vaccination records
 *       with additional metadata. Results are cached for 60 seconds.
 *     tags:
 *       - Verification
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: wallet
 *         required: true
 *         schema:
 *           type: string
 *         description: Stellar wallet address to verify
 *     responses:
 *       200:
 *         description: Vaccination status retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 wallet:
 *                   type: string
 *                 vaccinated:
 *                   type: boolean
 *                 verified:
 *                   type: boolean
 *                   description: >
 *                     True only when status is "valid". Never true when status is
 *                     "revoked", "absent", or "unavailable".
 *                 status:
 *                   type: string
 *                   enum: [valid, revoked, absent, unavailable]
 *                   description: >
 *                     Explicit verification status. "unavailable" means the data
 *                     could not be retrieved and MUST NOT be interpreted as a
 *                     negative (or positive) medical determination.
 *                 record_count:
 *                   type: number
 *                 records:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/VaccinationRecord'
 *       400:
 *         description: Invalid wallet format
 *       401:
 *         description: Unauthorized - JWT or API key required
 *       429:
 *         description: Rate limit exceeded
 *       503:
 *         description: >
 *           RPC timeout or service unavailable. Response body has
 *           status "unavailable" and verified false; this is not a negative result.
 *       500:
 *         description: Contract query failed (status "unavailable", verified false)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// GET /verify/:wallet — JWT or verifier API key
router.get(
  '/:wallet',
  validateStellarPublicKey('params', 'wallet'),
  jwtOrApiKey,
  adaptiveLimiter,
  async (req, res) => {
    const { wallet } = req.params;
    const actor = req.verifier ? `apikey:${req.verifier.id}` : (req.user?.wallet ?? 'unknown');

    const now = Date.now();
    const cached = verifyCache.get(wallet);
    if (cached && (now - cached.timestamp < CACHE_TTL)) {
      return res.json({
        wallet,
        status: cached.status,
        vaccinated: cached.vaccinated,
        verified: cached.status === VERIFY_STATUS.VALID,
        record_count: cached.records.length,
        records: cached.records
      });
    }

    try {
      const { vaccinated, records } = await verifyVaccination(wallet);
      const status = deriveStatus(vaccinated, records);

      verifyCache.set(wallet, {
        status,
        vaccinated,
        records,
        timestamp: now
      });

      audit({
        actor,
        action: 'verify.lookup',
        target: wallet,
        result: 'success',
        meta: req.verifier ? { verifier_label: req.verifier.label, status } : { status },
      });

      res.json({
        wallet,
        status,
        vaccinated,
        verified: status === VERIFY_STATUS.VALID,
        record_count: records.length,
        records
      });
    } catch (err) {
      const errorMessage = resolveContractErrorMessage(err);
      audit({ actor, action: 'verify.lookup', target: wallet, result: 'failure', meta: { error: errorMessage } });

      // An RPC/contract failure is "unavailable" — never a positive verification
      // result, and never a negative determination either.
      const unavailable = isUnavailableError(err);
      res.status(unavailable ? 503 : 500).json({
        wallet,
        status: VERIFY_STATUS.UNAVAILABLE,
        verified: false,
        error: errorMessage
      });
    }
  }
);

router.verifyCache = verifyCache;
router.VERIFY_STATUS = VERIFY_STATUS;
module.exports = router;
