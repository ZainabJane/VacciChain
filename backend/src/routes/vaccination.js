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
const { issueSchema, revokeSchema, vaccinationListQuerySchema } = require('./schemas/vaccination.schemas');
const idempotency = require('../middleware/idempotency');

const MAX_PAGE_SIZE = Number(process.env.VACCINATION_MAX_PAGE_SIZE) || 100;
const DEFAULT_PAGE_SIZE = Math.min(Number(process.env.VACCINATION_DEFAULT_PAGE_SIZE) || 20, MAX_PAGE_SIZE);

const router = express.Router();

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

  // Enforce patient consent unless jurisdiction config waives it
  if (process.env.REQUIRE_PATIENT_CONSENT !== 'false' && !hasConsented(patient_address)) {
    return res.status(403).json({ error: 'Patient has not provided consent. They must consent before a record can be issued.' });
  }

  try {
    const result = await mintVaccination(
      patient_address,
      vaccine_name,
      date_administered,
      process.env.ISSUER_SECRET_KEY,
      { doseNumber: dose_number, doseSeries: dose_series }
    );
    const timestamp = new Date().toISOString();

    audit({
      actor: req.user.publicKey,
      action: 'vaccination.issue',
      target: patient_address,
      result: 'success',
      meta: { token_id: result.tokenId, vaccine_name, date_administered, dose_number, dose_series },
    });

    res.json({
      success: true,
      tokenId: result.tokenId,
      transactionHash: result.hash,
      ledger: result.ledger,
      timestamp,
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
      return res.status(409).json({ error: errorMessage });
    }
    res.status(500).json({ error: errorMessage });
  }
});

/**
 * @swagger
 * /vaccination/revoke:
 *   post:
 *     summary: Revoke a vaccination record (issuer only)
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
 *                 description: Token ID to revoke
 *             required:
 *               - token_id
 *     responses:
 *       200:
 *         description: Vaccination record revoked
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 token_id:
 *                   type: string
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - issuer role required
 *       500:
 *         description: Contract invocation failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// POST /vaccination/revoke — revoke a vaccination record (issuer or admin only)
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
        meta: { token_id },
      });

      res.json({ success: true, token_id });
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
router.get(
  '/:wallet',
  authMiddleware,
  validateStellarPublicKey('params', 'wallet'),
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

      const total = sorted.length;
      const start = (rawPage - 1) * rawLimit;
      const data = sorted.slice(start, start + rawLimit);
      const hasMore = start + data.length < total;

      res.json({
        data,
        total,
        page: rawPage,
        limit: rawLimit,
        has_more: hasMore,
        next_page: hasMore ? rawPage + 1 : null,
      });
    } catch (err) {
      if (err instanceof SorobanTimeoutError) return sendRpcTimeout(res);
      const errorMessage = resolveContractErrorMessage(err);
      res.status(500).json({ error: errorMessage });
    }
  }
);

module.exports = router;
