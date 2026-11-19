const { z } = require('zod');
const StellarSdk = require('@stellar/stellar-sdk');

/**
 * Validation schemas for auth routes.
 * Co-located with auth.js for easy maintenance.
 */

// Stable, reusable bounded string helper. Rejects oversized strings with a
// stable 400 before they reach downstream logic.
const boundedString = (max, label) =>
  z.string()
    .min(1, `${label} is required`)
    .max(max, `${label} exceeds maximum length of ${max} characters`);

// Stellar public keys (StrKey ed25519 public key) are 56 characters.
const PUBLIC_KEY_MAX_LENGTH = 56;
// SEP-10 challenge transactions are base64-encoded XDR envelopes; cap well
// above realistic sizes while still rejecting oversized payloads.
const TRANSACTION_MAX_LENGTH = 10000;
// Nonces are short opaque tokens.
const NONCE_MAX_LENGTH = 256;

const sep10Schema = z.object({
  public_key: boundedString(PUBLIC_KEY_MAX_LENGTH, 'public_key')
    .refine((val) => {
      try {
        StellarSdk.Keypair.fromPublicKey(val);
        return true;
      } catch {
        return false;
      }
    }, { message: 'Invalid Stellar public key format' }),
});

const verifySchema = z.object({
  transaction: boundedString(TRANSACTION_MAX_LENGTH, 'transaction')
    .describe('Signed SEP-10 challenge transaction (XDR)'),
  nonce: boundedString(NONCE_MAX_LENGTH, 'nonce')
    .describe('Nonce returned by POST /auth/sep10'),
});

module.exports = {
  sep10Schema,
  verifySchema,
};