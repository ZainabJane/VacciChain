const express = require('express');
const { ERROR_CODES, sendError } = require('../errors');
const jwt = require('jsonwebtoken');
const StellarSdk = require('@stellar/stellar-sdk');
const { buildChallenge, verifyChallenge } = require('../stellar/sep10');
const { sep10Limiter, verifyLimiter } = require('../middleware/rateLimiter');
const { audit } = require('../middleware/auditLog');
const validate = require('../middleware/validate');
const { bruteForceGuard, recordFailure, recordSuccess } = require('../middleware/bruteForce');
const { getSigningKey, signOptions } = require('../jwtKeys');
const { isAuthorizedIssuer } = require('../stellar/issuerCache');
const { sep10Schema, verifySchema } = require('./schemas/auth.schemas');

const router = express.Router();

/**
 * @swagger
 * /auth/sep10:
 *   post:
 *     summary: Generate a SEP-10 authentication challenge
 *     tags:
 *       - Auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - public_key
 *             properties:
 *               public_key:
 *                 type: string
 *                 description: Stellar public key (starts with G) requesting a challenge
 *     responses:
 *       200:
 *         description: Challenge generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 transaction:
 *                   type: string
 *                   description: Unsigned SEP-10 challenge transaction (XDR)
 *                 nonce:
 *                   type: string
 *                   description: Single-use nonce tied to this challenge
 *       400:
 *         description: Invalid Stellar public key format
 *       429:
 *         description: >
 *           Rate limit exceeded (max 10 requests per trusted client per minute).
 *           The response body is `{ "error": "...", "retryAfter": <seconds> }`
 *           and the `RateLimit` and `Retry-After` headers are set.
 *         headers:
 *           RateLimit:
 *             description: Rate limit policy and remaining quota
 *             schema:
 *               type: string
 *           Retry-After:
 *             description: Seconds until the client may retry
 *             schema:
 *               type: integer
 *       500:
 *         description: Internal server error
 */
router.post('/sep10', sep10Limiter, validate(sep10Schema), async (req, res, next) => {
  const { public_key } = req.body;

  try {
    const { transaction, nonce } = await buildChallenge(public_key);
    res.json({ transaction, nonce });
  } catch (err) {
    sendError(req, res, 500, ERROR_CODES.INTERNAL_ERROR, err.message);
  }
});

/**
 * @swagger
 * /auth/verify:
 *   post:
 *     summary: Verify a signed SEP-10 challenge and issue a JWT
 *     description: >
 *       The client signs the challenge transaction from POST /auth/sep10 with
 *       their Stellar wallet and submits it here. On success a short-lived JWT
 *       (1 hour) is returned scoped to the caller's role.
 *     tags:
 *       - Auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - transaction
 *               - nonce
 *             properties:
 *               transaction:
 *                 type: string
 *                 description: Signed SEP-10 challenge transaction (XDR)
 *               nonce:
 *                 type: string
 *                 description: Nonce returned by POST /auth/sep10 (must match)
 *     responses:
 *       200:
 *         description: Authentication successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                   description: JWT (expires in 1 hour)
 *                 wallet:
 *                   type: string
 *                   description: Authenticated Stellar public key
 *                 role:
 *                   type: string
 *                   enum: [admin, issuer, patient]
 *                   description: Role derived from the authenticated key
 *       400:
 *         description: Missing or malformed parameters
 *       401:
 *         description: Invalid signature or nonce mismatch
 *       429:
 *         description: >
 *           Rate limit exceeded (max 10 verification attempts per trusted
 *           client per minute). The response body is
 *           `{ "error": "...", "retryAfter": <seconds> }` and the `RateLimit`
 *           and `Retry-After` headers are set.
 *         headers:
 *           RateLimit:
 *             description: Rate limit policy and remaining quota
 *             schema:
 *               type: string
 *           Retry-After:
 *             description: Seconds until the client may retry
 *             schema:
 *               type: integer
 */
router.post('/verify', verifyLimiter, validate(verifySchema), bruteForceGuard, async (req, res) => {
  const { transaction, nonce } = req.body;
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';

  try {
    const publicKey = verifyChallenge(transaction, nonce);

    // #47: the role is derived only from server-side sources — the configured
    // admin key and the on-chain issuer allowlist — never from client input.
    let role = 'patient';
    if (publicKey === process.env.ADMIN_PUBLIC_KEY) {
      role = 'admin';
    } else {
      try {
        if (await isAuthorizedIssuer(publicKey)) role = 'issuer';
      } catch (_) {
        // Allowlist unavailable: fall back to the least-privileged role.
      }
    }
    const now = Math.floor(Date.now() / 1000);
    const signingKey = getSigningKey();

    // iss/aud/alg/exp/kid come from jwtKeys.signOptions() so issuing and
    // verifying share one policy (see docs/jwt-key-rotation.md).
    const token = jwt.sign(
      {
        sub: publicKey,
        iat: now,
        wallet: publicKey,
        role,
      },
      signingKey.secret,
      signOptions()
    );

    audit({ actor: publicKey, action: 'auth.login', result: 'success', meta: { role } });

    res.json({ token, wallet: publicKey, role });
  } catch (err) {
    // Attempt to extract wallet from the transaction for per-wallet tracking
    let wallet = null;
    try {
      const tx = StellarSdk.TransactionBuilder.fromXDR(transaction, process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015');
      wallet = tx.source;
    } catch (_) { /* ignore parse errors */ }

    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    recordFailure(`ip:${ip}`, { ip, wallet });
    if (wallet) recordFailure(`wallet:${wallet}`, { ip, wallet });

    audit({ actor: wallet || 'unknown', action: 'auth.login', result: 'failure', meta: { error: err.message } });
    next(new AppError('unauthorized', 'Invalid signature or nonce mismatch', 401));
  }
});

module.exports = router;
