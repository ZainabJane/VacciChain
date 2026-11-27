const express = require('express');
const StellarSdk = require('@stellar/stellar-sdk');
const authMiddleware = require('../middleware/auth');
const { adminAuthMiddleware, requireWalletAccess } = require('../middleware/auth');
const issuerMiddleware = require('../middleware/issuer');
const { validateStellarPublicKey } = require('../middleware/wallet');
const { invokeContract, simulateContract, mintVaccination, sendRpcTimeout, SorobanTimeoutError } = require('../stellar/soroban');
const { resolveContractErrorMessage, mapContractError } = require('../stellar/contractErrors');
const { audit } = require('../middleware/auditLog');
const { AppError } = require('../middleware/errors');
const validate = require('../middleware/validate');
const { validateQuery } = require('../middleware/validate');
const { hasConsented } = require('../indexer/db');
const { toApiRecords } = require('../schemas/vaccinationRecord');
const { issueSchema, revokeSchema, vaccinationListQuerySchema } = require('./schemas/vaccination.schemas');
const { createRateLimiter } = require('../middleware/rateLimit');
const idempotency = require('../middleware/idempotency');

const MAX_PAGE_SIZE = Number(process.env.VACCINATION_MAX_PAGE_SIZE) || 100;
const DEFAULT_PAGE_SIZE = Math.min(Number(process.env.VACCINATION_DEFAULT_PAGE_SIZE) || 20, MAX_PAGE_SIZE);

const router = express.Router();

/**
 * Normalize a vaccine name so the API and contract agree on the duplicate key.
 * Mirrors the on-chain normalization: trim, collapse internal whitespace,
 * and compare case-insensitively.
 */
function normalizeVaccineName(name) {
  return String(name).trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Normalize a date to a canonical UTC ISO-8601 string (YYYY-MM-DDTHH:mm:ss.sssZ).
 * Mirrors the on-chain normalization so semantically equivalent dates
 * (e.g. differing offsets or precision) map to the same duplicate key.
 */
function normalizeDateAdministered(date) {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Invalid date_administered');
  }
  return parsed.toISOString();
}

// Batch verification is expensive (multiple contract simulations per request),
// so it gets a tighter limit than single-record verification.
const batchVerifyLimiter = createRateLimiter({
  name: 'vaccination-batch-verify',
  windowMs: Number(process.env.BATCH_VERIFY_RATE_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.BATCH_VERIFY_RATE_MAX) || 10,
});

/**
 * Stable API error codes returned by the vaccination routes.
 *
 * These codes are part of the public API contract: callers may rely on them
 * remaining stable even as contract error variants or function arguments
 * evolve. Human-readable `error` messages may change; `code` values must not.
 *
 * - CONSENT_REQUIRED      Patient has not granted consent (403)
 * - PATIENT_NOT_ALLOWLISTED Patient is not on the issuer allowlist (403)
 * - DUPLICATE_RECORD      Contract rejected a duplicate record (409)
 * - CONTRACT_ERROR        Unmapped contract failure (500)
 * - RPC_TIMEOUT           Soroban RPC timed out (504)
 */
const ERROR_CODES = Object.freeze({
  CONSENT_REQUIRED: 'CONSENT_REQUIRED',
  PATIENT_NOT_ALLOWLISTED: 'PATIENT_NOT_ALLOWLISTED',
  DUPLICATE_RECORD: 'DUPLICATE_RECORD',
  CONTRACT_ERROR: 'CONTRACT_ERROR',
  RPC_TIMEOUT: 'RPC_TIMEOUT',
});

/**
 * Map a contract error to a stable HTTP status + API error code.
 * Falls back to a generic 500/CONTRACT_ERROR for unknown variants so that
 * new contract errors never leak internals or change existing status codes.
 */
function toStableErrorResponse(err) {
  const mapped = mapContractError(err);
  const message = resolveContractErrorMessage(err);
  switch (mapped?.name) {
    case 'DuplicateRecord':
      return { status: 409, body: { error: message, code: ERROR_CODES.DUPLICATE_RECORD } };
    case 'Unauthorized':
    case 'NotIssuer':
      return { status: 403, body: { error: message, code: ERROR_CODES.CONTRACT_ERROR } };
    default:
      return { status: 500, body: { error: message, code: ERROR_CODES.CONTRACT_ERROR } };
  }
}

/**
 * @swagger
 * /vaccination/issue:
 *   post:
 *     summary: Issue a vaccination NFT (issuer only)
 *     tags:
 *       - Vaccination
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               patient_address:
 *                 type: string
 *                 description: Stellar address of patient
 *               vaccine_name:
 *                 type: string
 *               date_administered:
 *                 type: string
 *                 format: date-time
 *             required:
 *               - patient_address
 *               - vaccine_name
 *               - date_administered
 *     responses:
 *       200:
 *         description: Vaccination NFT issued successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 tokenId:
 *                   type: string
 *                 transactionHash:
 *                   type: string
 *                 ledger:
 *                   type: number
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - issuer role required
 *       409:
 *         description: Duplicate record - an equivalent record (same normalized vaccine name and date) already exists
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Contract invocation failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// POST /vaccination/issue — mint NFT (issuer only)
router.post(
  '/issue',
  authMiddleware,
  issuerMiddleware,
  idempotency,
  validateStellarPublicKey('body', 'patient_address'),
  validate(issueSchema),
  async (req, res) => {
  const { patient_address, vaccine_name, date_administered, dose_number, dose_series } = req.body;

  // Enforce patient allowlisting before any issuance is attempted.
  // Allowlisting is a prerequisite for consent: a patient who is not
  // allowlisted cannot be issued a record regardless of consent state.
  if (!isAllowlisted(patient_address)) {
    audit({
      actor: req.user.publicKey,
      action: 'vaccination.issue',
      target: patient_address,
      result: 'failure',
      meta: { error: 'patient_not_allowlisted' },
    });
    return res.status(403).json({
      error: 'Patient is not allowlisted for issuance.',
      code: ERROR_CODES.PATIENT_NOT_ALLOWLISTED,
    });
  }

  // Enforce patient consent unless jurisdiction config waives it.
  // Consent states: absent -> rejected here; granted -> proceeds;
  // revoked/changed -> hasConsented returns false and issuance is rejected.
  if (process.env.REQUIRE_PATIENT_CONSENT !== 'false' && !hasConsented(patient_address)) {
    audit({
      actor: req.user.publicKey,
      action: 'vaccination.issue',
      target: patient_address,
      result: 'failure',
      meta: { error: 'consent_required' },
    });
    return res.status(403).json({
      error: 'Patient has not provided consent. They must consent before a record can be issued.',
      code: ERROR_CODES.CONSENT_REQUIRED,
    });
  }

  // Normalize before sending to the contract so the duplicate key matches on-chain.
  let normalizedVaccineName;
  let normalizedDate;
  try {
    normalizedVaccineName = normalizeVaccineName(vaccine_name);
    normalizedDate = normalizeDateAdministered(date_administered);
  } catch (err) {
    return res.status(400).json({ error: 'date_administered must be a valid ISO-8601 date-time' });
  }

  try {
    const result = await mintVaccination(
      patient_address,
      normalizedVaccineName,
      normalizedDate,
      process.env.ISSUER_SECRET_KEY,
      { doseNumber: dose_number, doseSeries: dose_series, requestId: req.requestId }
    );
    const timestamp = new Date().toISOString();

    audit({
      actor: req.user.publicKey,
      action: 'vaccination.issue',
      target: patient_address,
      result: 'success',
      meta: { token_id: result.tokenId, vaccine_name: normalizedVaccineName, date_administered: normalizedDate, dose_number, dose_series },
    });

    res.json({
      success: true,
      tokenId: result.tokenId,
      transactionHash: result.hash,
      ledger: result.ledger,
      timestamp,
      revoked: false,
    });
  } catch (err) {
    if (err instanceof SorobanTimeoutError) return sendRpcTimeout(res);
    const errorMessage = resolveContractErrorMessage(err);
    audit({
      actor: req.user.publicKey,
      action: 'vaccination.issue',
      target: patient_address,
      result: 'failure',
      meta: { error: errorMessage, requestId: req.requestId },
    });
    const { status, body } = toStableErrorResponse(err);
    res.status(status).json(body);
  }
});

/**
 * @swagger
 * /vaccination/revoke:
 *   post:
 *     summary: Revoke a single vaccination record (issuer only)
 *     description: >
 *       Revocation is record-level and irreversible. It marks only the record
 *       identified by token_id as revoked; other records held by the same wallet
 *       remain valid, and the wallet itself is not deactivated. The issuer's
 *       permission to issue is unaffected. Verifiers must treat a revoked record
 *       as invalid while continuing to accept the wallet's remaining records.
 *     tags:
 *       - Vaccination
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               token_id:
 *                 type: string
 *                 description: Token ID of the single record to revoke
 *             required:
 *               - token_id
 *     responses:
 *       200:
 *         description: Vaccination record revoked (irreversible, record-level)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 token_id:
 *                   type: string
 *                 revoked:
 *                   type: boolean
 *                   description: Always true once revocation succeeds
 *                 scope:
 *                   type: string
 *                   description: Revocation scope (always "record")
 *                 irreversible:
 *                   type: boolean
 *                   description: Always true; revocation cannot be undone
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - issuer role required
 *       404:
 *         description: Record not found
 *       409:
 *         description: Record already revoked (revocation is irreversible)
 *       500:
 *         description: Contract invocation failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// POST /vaccination/revoke — revoke a single vaccination record (issuer or admin only)
router.post(
  '/revoke',
  authMiddleware,
  issuerMiddleware,
  validate(revokeSchema),
  async (req, res) => {
    const { token_id } = req.body;

    try {
      const args = [
        StellarSdk.xdr.ScVal.scvU64(StellarSdk.xdr.Uint64.fromString(String(token_id))),
        StellarSdk.Address.fromString(req.user.publicKey).toScVal(),
      ];

      await invokeContract(process.env.ISSUER_SECRET_KEY, 'revoke_vaccination', args, { requestId: req.requestId });

      audit({
        actor: req.user.publicKey,
        action: 'vaccination.revoke',
        target: String(token_id),
        result: 'success',
        meta: { token_id, scope: 'record', irreversible: true },
      });

      res.json({
        success: true,
        token_id,
        revoked: true,
        scope: 'record',
        irreversible: true,
      });
    } catch (err) {
      if (err instanceof SorobanTimeoutError) return sendRpcTimeout(res);
      const errorMessage = resolveContractErrorMessage(err);
      audit({
        actor: req.user.publicKey,
        action: 'vaccination.revoke',
        target: String(token_id),
        result: 'failure',
        meta: { token_id, error: errorMessage, requestId: req.requestId },
      });
      const { status, body } = toStableErrorResponse(err);
      res.status(status).json(body);
    }
  }
);

/**
 * @swagger
 * /vaccination/{wallet}:
 *   get:
 *     summary: Fetch all vaccination records for a wallet
 *     tags:
 *       - Vaccination
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: wallet
 *         required: true
 *         schema:
 *           type: string
 *         description: Stellar wallet address
 *     responses:
 *       200:
 *         description: Vaccination records retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 wallet:
 *                   type: string
 *                 vaccinated:
 *                   type: boolean
 *                 records:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/VaccinationRecord'
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Contract query failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
/**
 * @swagger
 * /vaccination/batch-verify:
 *   post:
 *     summary: Verify vaccination status for multiple wallets
 *     tags:
 *       - Vaccination
 *     security:
 *       - bearerAuth: []
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
 *             required:
 *               - wallets
 *     responses:
 *       200:
 *         description: Verification results per wallet
 *       400:
 *         description: Invalid request body
 *       401:
 *         description: Unauthorized
 *       429:
 *         description: Too many batch verification requests
 *         headers:
 *           Retry-After:
 *             description: Seconds until the next request is allowed
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
 *                 limit:
 *                   type: integer
 *                 remaining:
 *                   type: integer
 *                 reset:
 *                   type: integer
 */
// POST /vaccination/batch-verify — verify multiple wallets (rate limited)
router.post('/batch-verify', authMiddleware, batchVerifyLimiter, async (req, res) => {
  const { wallets } = req.body || {};

  if (!Array.isArray(wallets) || wallets.length === 0) {
    return res.status(400).json({ error: 'wallets must be a non-empty array' });
  }
  if (wallets.length > 50) {
    return res.status(400).json({ error: 'wallets must contain at most 50 entries' });
  }

  const invalid = wallets.find((w) => typeof w !== 'string' || !StellarSdk.StrKey.isValidEd25519PublicKey(w));
  if (invalid !== undefined) {
    return res.status(400).json({ error: `Invalid Stellar public key: ${invalid}` });
  }

  try {
    const results = await Promise.all(
      wallets.map(async (wallet) => {
        try {
          const args = [StellarSdk.Address.fromString(wallet).toScVal()];
          const result = await simulateContract('verify_vaccination', args);
          const [vaccinated, records] = StellarSdk.scValToNative(result);
          return { wallet, vaccinated, recordCount: records.length };
        } catch (err) {
          if (err instanceof SorobanTimeoutError) throw err;
          return { wallet, error: resolveContractErrorMessage(err) };
        }
      })
    );

    res.json({ results });
  } catch (err) {
    if (err instanceof SorobanTimeoutError) return sendRpcTimeout(res);
    const errorMessage = resolveContractErrorMessage(err);
    next(new AppError('rpc_error', errorMessage, 500));
  }
  }
);

// GET /vaccination/:wallet — fetch paginated records for a wallet
// #45: patients may only read their own wallet; issuers (re-verified on-chain) and admins may read any.
router.get(
  '/:wallet',
  adminAuthMiddleware,
  validateStellarPublicKey('params', 'wallet'),
  requireWalletAccess('wallet'),
  validate(vaccinationListQuerySchema, 'query'),
  async (req, res) => {
    const { wallet } = req.params;

    const rawPage = req.query.page !== undefined ? Number(req.query.page) : 1;
    const rawLimit = req.query.limit !== undefined ? Number(req.query.limit) : DEFAULT_PAGE_SIZE;

    if (!Number.isInteger(rawPage) || rawPage < 1) {
      return res.status(400).json({ error: 'page must be a positive integer' });
    }
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_PAGE_SIZE) {
      return res.status(400).json({ error: `limit must be an integer between 1 and ${MAX_PAGE_SIZE}` });
    }

    try {
      const args = [StellarSdk.Address.fromString(wallet).toScVal()];
      const result = await simulateContract('verify_vaccination', args);
      const [vaccinated, allRecords] = StellarSdk.scValToNative(result);

      // Deterministic ordering: created_at DESC, then token_id DESC as tiebreaker.
      const sorted = [...allRecords].sort((a, b) => {
        const aTime = a.created_at ?? a.createdAt ?? 0;
        const bTime = b.created_at ?? b.createdAt ?? 0;
        const timeDiff = new Date(bTime).getTime() - new Date(aTime).getTime();
        if (timeDiff !== 0 && !Number.isNaN(timeDiff)) return timeDiff;
        return String(b.token_id ?? b.tokenId ?? '').localeCompare(String(a.token_id ?? a.tokenId ?? ''));
      });

      // Revocation is record-level: expose per-record status so verifiers can
      // ignore revoked records while still trusting the wallet's remaining ones.
      const records = sorted.map((record) => ({
        ...record,
        revoked: Boolean(record.revoked),
      }));

      const total = records.length;
      const start = (rawPage - 1) * rawLimit;
      const data = toApiRecords(sorted.slice(start, start + rawLimit));
      const hasMore = start + data.length < total;

      res.json({
        data,
        total,
        page: rawPage,
        limit: rawLimit,
        has_more: hasMore,
        next_page: hasMore ? rawPage + 1 : null,
        vaccinated: Boolean(vaccinated),
      });
    } catch (err) {
      if (err instanceof SorobanTimeoutError) return sendRpcTimeout(res);
      const errorMessage = resolveContractErrorMessage(err);
      res.status(500).json({ error: errorMessage });
    }
  }
);

module.exports = router;
module.exports.ERROR_CODES = ERROR_CODES;
module.exports.toStableErrorResponse = toStableErrorResponse;
