const express = require('express');
const StellarSdk = require('@stellar/stellar-sdk');
const { validateStellarPublicKey } = require('../middleware/wallet');
const { simulateContract, verifyVaccination, SorobanTimeoutError, sendRpcTimeout } = require('../stellar/soroban');
const { resolveContractErrorMessage } = require('../stellar/contractErrors');
const { verifyLimiter, verifierKeyLimiter } = require('../middleware/rateLimiter');
const verifierApiKey = require('../middleware/verifierApiKey');
const authMiddleware = require('../middleware/auth');
const { audit } = require('../middleware/auditLog');
const { requestIdMiddleware } = require('../middleware/requestId');
const config = require('../config');

const router = express.Router();

const verifyCache = new Map();
const CACHE_TTL = 60 * 1000; // 60 seconds

// Bounded batch verification limits (see config for documented limits).
const BATCH_MAX_SIZE = config.batchMaxSize;
const BATCH_CONCURRENCY = config.batchConcurrency;

/**
 * Run `worker` over `items` with at most `limit` in flight at any time.
 * Results preserve input order; each entry is { ok, value } or { ok: false, error }.
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function run() {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      try {
        results[current] = { ok: true, value: await worker(items[current], current) };
      } catch (err) {
        results[current] = { ok: false, error: err };
      }
    }
  }

  const runners = [];
  const workerCount = Math.min(limit, items.length);
  for (let i = 0; i < workerCount; i += 1) {
    runners.push(run());
  }
  await Promise.all(runners);
  return results;
}

function isTimeoutError(err) {
  return Boolean(err && err.message && (
    err.message.toLowerCase().includes('timeout') ||
    err.message.toLowerCase().includes('deadline') ||
    err.message.toLowerCase().includes('abort')
  ));
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
 *                   description: Whether the wallet has vaccination records
 *                 records:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/VaccinationRecord'
 *       400:
 *         description: Invalid wallet format
 *       429:
 *         description: Rate limit exceeded (60 requests per IP per minute)
 *       503:
 *         description: RPC timeout or service unavailable
 *       500:
 *         description: Contract query failed
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
        verified: cached.vaccinated,
        records: cached.records
      });
    }

    try {
      const { vaccinated, records } = await verifyVaccination(wallet, { requestId: req.id });

      verifyCache.set(wallet, {
        vaccinated,
        records,
        timestamp: now
      });

      audit({
        actor: ip,
        action: 'verify.public_lookup',
        target: wallet,
        result: 'success',
        meta: { ip },
      });

      res.json({ wallet, verified: vaccinated, records });
    } catch (err) {
      const errorMessage = resolveContractErrorMessage(err);
      audit({ actor: ip, action: 'verify.public_lookup', target: wallet, result: 'failure', meta: { error: errorMessage, ip } });

      res.status(isTimeoutError(err) ? 503 : 500).json({ error: errorMessage, requestId: req.id });
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
 *         description: RPC timeout or service unavailable
 *       500:
 *         description: Contract query failed
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
        vaccinated: cached.vaccinated,
        verified: cached.vaccinated,
        record_count: cached.records.length,
        records: cached.records
      });
    }

    try {
      const { vaccinated, records } = await verifyVaccination(wallet, { requestId: req.id });

      verifyCache.set(wallet, {
        vaccinated,
        records,
        timestamp: now
      });

      audit({
        actor,
        action: 'verify.lookup',
        target: wallet,
        result: 'success',
        meta: req.verifier ? { verifier_label: req.verifier.label } : {},
      });

      res.json({ wallet, vaccinated, verified: vaccinated, record_count: records.length, records });
    } catch (err) {
      const errorMessage = resolveContractErrorMessage(err);
      audit({ actor, action: 'verify.lookup', target: wallet, result: 'failure', meta: { error: errorMessage } });

      res.status(isTimeoutError(err) ? 503 : 500).json({ error: errorMessage, requestId: req.id });
    }
  }
);

router.verifyCache = verifyCache;
module.exports = router;
