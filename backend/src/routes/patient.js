const express = require('express');
const StellarSdk = require('@stellar/stellar-sdk');
const authMiddleware = require('../middleware/auth');
const { invokeContract } = require('../stellar/soroban');
const { resolveContractErrorMessage } = require('../stellar/contractErrors');
const { audit } = require('../middleware/auditLog');
const validate = require('../middleware/validate');
const { registerSchema } = require('./schemas/patient.schemas');

const router = express.Router();

/**
 * @swagger
 * /v1/patient/register:
 *   post:
 *     summary: Self-register a wallet into the on-chain patient allowlist
 *     tags:
 *       - Patient
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
 *       200:
 *         description: Patient registered
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Contract invocation failed
 */

// POST /patient/register — self-register wallet into the on-chain allowlist.
// Requires a valid patient JWT (SEP-10 authenticated).
router.post('/register', authMiddleware, validate(registerSchema), async (req, res) => {
  const { publicKey } = req.user;

  try {
    const args = [StellarSdk.Address.fromString(publicKey).toScVal()];
    await invokeContract(process.env.ADMIN_SECRET_KEY, 'register_patient', args);

    audit({
      actor: publicKey,
      action: 'patient.register',
      target: publicKey,
      result: 'success',
    });

    res.json({ success: true, wallet: publicKey });
  } catch (err) {
    const errorMessage = resolveContractErrorMessage(err);
    audit({
      actor: publicKey,
      action: 'patient.register',
      target: publicKey,
      result: 'failure',
      meta: { error: errorMessage },
    });
    res.status(500).json({ error: errorMessage });
  }
});

module.exports = router;
