const express = require('express');
const StellarSdk = require('@stellar/stellar-sdk');
const authMiddleware = require('../middleware/auth');
const issuerMiddleware = require('../middleware/issuer');
const { validateStellarPublicKey } = require('../middleware/wallet');
const { invokeContract, simulateContract, mintVaccination, sendRpcTimeout, SorobanTimeoutError } = require('../stellar/soroban');
const { resolveContractErrorMessage, mapContractError } = require('../stellar/contractErrors');
const { audit } = require('../middleware/auditLog');
const validate = require('../middleware/validate');
const { hasConsented } = require('../indexer/db');
const { issueSchema, revokeSchema } = require('./schemas/vaccination.schemas');

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
  validateStellarPublicKey('body', 'patient_address'),
  validate(issueSchema),
  async (req, res) => {
  const { patient_address, vaccine_name, date_administered, dose_number, dose_series } = req.body;

  // Enforce patient consent unless jurisdiction config waives it
  if (process.env.REQUIRE_PATIENT_CONSENT !== 'false' && !hasConsented(patient_address)) {
    return res.status(403).json({ error: 'Patient has not provided consent. They must consent before a record can be issued.' });
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
      { doseNumber: dose_number, doseSeries: dose_series }
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
      meta: { error: errorMessage },
    });
    const mapped = mapContractError(err);
    if (mapped?.name === 'DuplicateRecord') {
      return res.status(409).json({
        error: 'Duplicate record: an equivalent record with the same normalized vaccine name and date already exists for this patient.',
        code: 'DuplicateRecord',
      });
    }
    res.status(500).json({ error: errorMessage });
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

      await invokeContract(process.env.ISSUER_SECRET_KEY, 'revoke_vaccination', args);

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
        meta: { token_id, error: errorMessage },
      });
      const mapped = mapContractError(err);
      if (mapped?.name === 'RecordNotFound') {
        return res.status(404).json({ error: errorMessage, code: 'RecordNotFound' });
      }
      if (mapped?.name === 'AlreadyRevoked') {
        return res.status(409).json({ error: errorMessage, code: 'AlreadyRevoked' });
      }
      res.status(500).json({ error: errorMessage });
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
// GET /vaccination/:wallet — fetch paginated records for a wallet
router.get('/:wallet', authMiddleware, validateStellarPublicKey('params', 'wallet'), async (req, res) => {
  const { wallet } = req.params;

  const rawPage = req.query.page !== undefined ? Number(req.query.page) : 1;
  const rawLimit = req.query.limit !== undefined ? Number(req.query.limit) : 20;

  if (!Number.isInteger(rawPage) || rawPage < 1) {
    return res.status(400).json({ error: 'page must be a positive integer' });
  }
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
    return res.status(400).json({ error: 'limit must be an integer between 1 and 100' });
  }

  try {
    const args = [StellarSdk.Address.fromString(wallet).toScVal()];
    const result = await simulateContract('verify_vaccination', args);
    const [vaccinated, allRecords] = StellarSdk.scValToNative(result);

    // Revocation is record-level: expose per-record status so verifiers can
    // ignore revoked records while still trusting the wallet's remaining ones.
    const records = allRecords.map((record) => ({
      ...record,
      revoked: Boolean(record.revoked),
    }));

    const total = records.length;
    const start = (rawPage - 1) * rawLimit;
    const data = records.slice(start, start + rawLimit);

    res.json({ data, total, page: rawPage, limit: rawLimit, vaccinated: Boolean(vaccinated) });
  } catch (err) {
    if (err instanceof SorobanTimeoutError) return sendRpcTimeout(res);
    const errorMessage = resolveContractErrorMessage(err);
    res.status(500).json({ error: errorMessage });
  }
});

module.exports = router;
