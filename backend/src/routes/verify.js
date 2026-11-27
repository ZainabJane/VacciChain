const express = require('express');
const StellarSdk = require('@stellar/stellar-sdk');
const { validateStellarPublicKey } = require('../middleware/wallet');
const { simulateContract, verifyVaccination, SorobanTimeoutError, sendRpcTimeout } = require('../stellar/soroban');
const { resolveContractErrorMessage } = require('../stellar/contractErrors');
const { verifyLimiter, verifierKeyLimiter } = require('../middleware/rateLimiter');
const verifierApiKey = require('../middleware/verifierApiKey');
const authMiddleware = require('../middleware/auth');
const { toApiRecords } = require('../schemas/vaccinationRecord');
const { audit } = require('../middleware/auditLog');
const { AppError } = require('../middleware/errors');

const router = express.Router();

const verifyCache = new Map();
const CACHE_TTL = 60 * 1000; // 60 seconds

// Maximum number of records returned in a single verification response.
// Histories longer than this are truncated; clients can page through the
// remainder using the `limit` and `offset` query parameters.
const MAX_RECORDS_LIMIT = 100;
const DEFAULT_RECORDS_LIMIT = 50;

/**
 * Parse and clamp the `limit` / `offset` query parameters.
 * - `limit` defaults to DEFAULT_RECORDS_LIMIT and is clamped to [1, MAX_RECORDS_LIMIT].
 * - `offset` defaults to 0 and must be a non-negative integer.
 * Invalid values fall back to the defaults so responses stay bounded.
 */
function parsePagination(query = {}) {
  const rawLimit = Number.parseInt(query.limit, 10);
  const rawOffset = Number.parseInt(query.offset, 10);

  let limit = Number.isFinite(rawLimit) ? rawLimit : DEFAULT_RECORDS_LIMIT;
  if (limit < 1) limit = 1;
  if (limit > MAX_RECORDS_LIMIT) limit = MAX_RECORDS_LIMIT;

  let offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;

  return { limit, offset };
}

/**
 * Apply pagination/truncation to a record history and build metadata.
 * The returned `records` array never exceeds `limit` entries.
 */
function paginateRecords(records, { limit, offset }) {
  const all = Array.isArray(records) ? records : [];
  const total = all.length;
  const page = all.slice(offset, offset + limit);
  const truncated = offset + page.length < total;

  return {
    records: page,
    meta: {
      total,
      returned: page.length,
      limit,
      offset,
      truncated,
      max_limit: MAX_RECORDS_LIMIT,
      next_offset: truncated ? offset + page.length : null,
    },
  };
}

/**
 * Revocation semantics (Backlog 079):
 * - Revocation is per-record and irreversible; a revoked record can never be
 *   un-revoked or re-issued under the same record id.
 * - Revoking a record does NOT revoke the wallet or the issuer's permission.
 * - Verifiers must treat revoked records as invalid: they are excluded from
 *   results, and a wallet is only `verified` if at least one non-revoked
 *   record remains.
 */
function isRevokedRecord(record) {
  if (!record || typeof record !== 'object') return false;
  return record.revoked === true || record.is_revoked === true || record.status === 'revoked';
}

function filterActiveRecords(records) {
  if (!Array.isArray(records)) return [];
  return records.filter((record) => !isRevokedRecord(record));
}

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
 *
 *       Response size is bounded: at most 100 records are ever returned per call
 *       (default 50). Longer histories are truncated and reported via `meta.truncated`
 *       and `meta.next_offset`; page through the remainder with `limit` and `offset`.
 *     tags:
 *       - Verification
 *     parameters:
 *       - in: path
 *         name: wallet
 *         required: true
 *         schema:
 *           type: string
 *         description: Stellar wallet address to verify
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *         description: Maximum number of records to return (clamped to 1..100).
 *       - in: query
 *         name: offset
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *         description: Number of records to skip before returning results.
 *     responses:
 *       200:
 *         description: Vaccination status retrieved (redacted public projection)
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
 *                   description: Redacted record summaries (no prohibited fields)
 *                   items:
 *                     $ref: '#/components/schemas/VaccinationRecord'
 *                 meta:
 *                   type: object
 *                   description: Pagination/truncation metadata
 *                   properties:
 *                     total:
 *                       type: integer
 *                     returned:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     offset:
 *                       type: integer
 *                     truncated:
 *                       type: boolean
 *                     max_limit:
 *                       type: integer
 *                     next_offset:
 *                       type: integer
 *                       nullable: true
 *       400:
 *         description: Invalid wallet format
 *       429:
 *         description: >
 *           Rate limit exceeded (60 requests per trusted client per minute).
 *           The response body includes `retryAfter` (seconds until the caller may retry)
 *           and the response carries `RateLimit-*` and `Retry-After` headers.
 *         headers:
 *           Retry-After:
 *             description: Seconds to wait before retrying
 *             schema:
 *               type: integer
 *           RateLimit-Limit:
 *             description: Request quota for the current window
 *             schema:
 *               type: integer
 *           RateLimit-Remaining:
 *             description: Requests remaining in the current window
 *             schema:
 *               type: integer
 *           RateLimit-Reset:
 *             description: Seconds until the current window resets
 *             schema:
 *               type: integer
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                 retryAfter:
 *                   type: integer
 *                   description: Seconds until the caller may retry
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
    // Trusted client identity resolved by the rate limiter (respects trust proxy config).
    const ip = req.rateLimitClientId || req.ip || req.socket?.remoteAddress || 'unknown';

    const now = Date.now();
    const cached = verifyCache.get(wallet);
    if (cached && (now - cached.timestamp < CACHE_TTL)) {
      const { records, meta } = paginateRecords(cached.records, pagination);
      return res.json({
        wallet,
        status: cached.status,
        verified: cached.status === VERIFY_STATUS.VALID,
        records,
        meta
      });
    }

    try {
      const { vaccinated, records: rawRecords } = await verifyVaccination(wallet);
      const records = toApiRecords(rawRecords);
      const status = deriveStatus(vaccinated, records);

      verifyCache.set(wallet, {
        status,
        vaccinated,
        records: activeRecords,
        timestamp: now
      });

      audit({
        actor: ip,
        action: 'verify.public_lookup',
        target: wallet,
        result: 'success',
        meta: { ip, status },
      });

      const { records: page, meta } = paginateRecords(records, pagination);
      res.json({
        wallet,
        status,
        verified: status === VERIFY_STATUS.VALID,
        records: page,
        meta
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
        error: errorMessage,
        requestId: req.id
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
 *
 *       Response size is bounded: at most 100 records are ever returned per call
 *       (default 50). Longer histories are truncated and reported via `meta.truncated`
 *       and `meta.next_offset`; page through the remainder with `limit` and `offset`.
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
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *         description: Maximum number of records to return (clamped to 1..100).
 *       - in: query
 *         name: offset
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *         description: Number of records to skip before returning results.
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
 *                   description: Number of records returned in this response
 *                 records:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/VaccinationRecord'
 *                 meta:
 *                   type: object
 *                   description: Pagination/truncation metadata
 *                   properties:
 *                     total:
 *                       type: integer
 *                     returned:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     offset:
 *                       type: integer
 *                     truncated:
 *                       type: boolean
 *                     max_limit:
 *                       type: integer
 *                     next_offset:
 *                       type: integer
 *                       nullable: true
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
/**
 * @swagger
 * /verify/batch:
 *   post:
 *     summary: Batch vaccination status verification
 *     description: >
 *       Verifies up to BATCH_MAX_SIZE wallets per request. Items are processed
 *       with bounded concurrency (BATCH_CONCURRENCY) to protect the RPC provider
 *       and worker pool. Partial failures are reported per item.
 *     tags:
 *       - Verification
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               wallets:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Per-item verification results
 *       400:
 *         description: Invalid request (bad wallets or batch too large)
 *       401:
 *         description: Unauthorized - JWT or API key required
 *       429:
 *         description: Rate limit exceeded
 */
// POST /verify/batch — JWT or verifier API key, bounded concurrency
router.post(
  '/batch',
  jwtOrApiKey,
  adaptiveLimiter,
  async (req, res) => {
    const requestId = req.id;
    const actor = req.verifier ? `apikey:${req.verifier.id}` : (req.user?.wallet ?? 'unknown');
    const wallets = req.body && req.body.wallets;

    if (!Array.isArray(wallets) || wallets.length === 0) {
      return res.status(400).json({ error: 'wallets must be a non-empty array', requestId });
    }
    if (wallets.length > BATCH_MAX_SIZE) {
      return res.status(400).json({
        error: `batch size exceeds maximum of ${BATCH_MAX_SIZE}`,
        requestId,
      });
    }

    const invalid = [];
    wallets.forEach((wallet, index) => {
      if (typeof wallet !== 'string' || !StellarSdk.StrKey.isValidEd25519PublicKey(wallet)) {
        invalid.push({ index, wallet, error: 'invalid wallet address' });
      }
    });
    if (invalid.length > 0) {
      return res.status(400).json({ error: 'invalid wallet address in batch', invalid, requestId });
    }

    const now = Date.now();
    const results = await mapWithConcurrency(wallets, BATCH_CONCURRENCY, async (wallet) => {
      const cached = verifyCache.get(wallet);
      if (cached && (now - cached.timestamp < CACHE_TTL)) {
        return { wallet, vaccinated: cached.vaccinated, verified: cached.vaccinated, records: cached.records };
      }
      const { vaccinated, records } = await verifyVaccination(wallet, { requestId });
      verifyCache.set(wallet, { vaccinated, records, timestamp: now });
      return { wallet, vaccinated, verified: vaccinated, records };
    });

    const items = results.map((result, index) => {
      if (result.ok) {
        return { index, wallet: wallets[index], ok: true, ...result.value };
      }
      const errorMessage = resolveContractErrorMessage(result.error);
      return {
        index,
        wallet: wallets[index],
        ok: false,
        error: { message: errorMessage, timeout: isTimeoutError(result.error) },
      };
    });

    const failed = items.filter((item) => !item.ok).length;
    audit({
      actor,
      action: 'verify.batch',
      target: `${wallets.length} wallets`,
      result: failed === 0 ? 'success' : 'partial_failure',
      meta: { requestId, total: wallets.length, failed },
    });

    res.json({
      requestId,
      total: wallets.length,
      succeeded: wallets.length - failed,
      failed,
      results: items,
    });
  }
);

// GET /verify/:wallet — JWT or verifier API key
router.get(
  '/:wallet',
  validateStellarPublicKey('params', 'wallet'),
  // Declare the scope required for verifier API keys. JWT callers are unaffected
  // because verifierApiKey only enforces this when an API key is presented.
  (req, res, next) => {
    req.requiredScope = 'verify:read';
    next();
  },
  jwtOrApiKey,
  adaptiveLimiter,
  async (req, res, next) => {
    const { wallet } = req.params;
    const actor = req.verifier ? `apikey:${req.verifier.id}` : (req.user?.wallet ?? 'unknown');
    const pagination = parsePagination(req.query);

    // Object-level authorization (#45): patients may only verify their own wallet;
    // issuers, admins, and verifier API-key callers may verify any wallet.
    if (req.user && req.user.role === 'patient' && req.user.wallet !== wallet) {
      return next(new AppError('forbidden', 'Patients may only verify their own vaccination status', 403));
    }

    const now = Date.now();
    const cached = verifyCache.get(wallet);
    if (cached && (now - cached.timestamp < CACHE_TTL)) {
      const { records, meta } = paginateRecords(cached.records, pagination);
      return res.json({
        wallet,
        status: cached.status,
        vaccinated: cached.vaccinated,
        verified: cached.status === VERIFY_STATUS.VALID,
        record_count: records.length,
        records,
        meta
      });
    }

    try {
      const { vaccinated, records: rawRecords } = await verifyVaccination(wallet);
      const records = toApiRecords(rawRecords);
      const status = deriveStatus(vaccinated, records);

      verifyCache.set(wallet, {
        status,
        vaccinated,
        records: activeRecords,
        timestamp: now
      });

      audit({
        actor,
        action: 'verify.lookup',
        target: wallet,
        result: 'success',
        meta: req.verifier ? { verifier_label: req.verifier.label, status } : { status },
      });

      const { records: page, meta } = paginateRecords(records, pagination);
      res.json({
        wallet,
        status,
        vaccinated,
        verified: status === VERIFY_STATUS.VALID,
        record_count: page.length,
        records: page,
        meta
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
        error: errorMessage,
        requestId: req.id
      });
    }
  }
);

router.verifyCache = verifyCache;
router.toPublicRecord = toPublicRecord;
router.toPublicRecords = toPublicRecords;
router.VERIFY_STATUS = VERIFY_STATUS;
router.MAX_RECORDS_LIMIT = MAX_RECORDS_LIMIT;
router.DEFAULT_RECORDS_LIMIT = DEFAULT_RECORDS_LIMIT;
router.parsePagination = parsePagination;
router.paginateRecords = paginateRecords;
module.exports = router;
