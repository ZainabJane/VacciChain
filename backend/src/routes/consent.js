const express = require('express');
const authMiddleware = require('../middleware/auth');
const {
  getConsent,
  recordConsent,
  revokeConsent,
  hasConsented,
} = require('../indexer/db');
const validate = require('../middleware/validate');
const { recordConsentSchema } = require('./schemas/consent.schemas');

const router = express.Router();

/**
 * Consent state machine (API boundary)
 * -------------------------------------
 * The consent record is a patient-controlled allowlist flag that gates whether
 * an issuer is permitted to mint credentials for the patient's wallet. It is
 * NOT a privacy guarantee: any credential that is issued and anchored on a
 * public chain is publicly observable. Consent only controls *issuance*.
 *
 * States:
 *   - absent   : no consent record exists. Issuance MUST be rejected.
 *   - granted  : patient explicitly consented. Issuance is allowed.
 *   - revoked  : patient withdrew consent. Issuance MUST be rejected.
 *                Previously issued credentials remain on-chain and public.
 *   - changed  : consent was re-granted after a revocation (or the consent
 *                record was updated). Issuance is allowed again; the
 *                `changed_at` timestamp reflects the most recent transition.
 *
 * Transitions:
 *   absent  -> granted  (POST /patient/consent)
 *   granted -> revoked  (DELETE /patient/consent)
 *   revoked -> changed  (POST /patient/consent, re-grant)
 *   changed -> revoked  (DELETE /patient/consent)
 *
 * Contract allowlist semantics:
 *   The on-chain allowlist mirrors this state. `granted` and `changed` map to
 *   "allowlisted"; `absent` and `revoked` map to "not allowlisted". Issuers
 *   MUST check both the API state and the on-chain allowlist before minting.
 */

const CONSENT_STATES = Object.freeze({
  ABSENT: 'absent',
  GRANTED: 'granted',
  REVOKED: 'revoked',
  CHANGED: 'changed',
});

/**
 * Derive the explicit consent state from a stored consent record.
 * @param {object|null|undefined} consent
 * @returns {{ state: string, allowlisted: boolean, consented_at: string|null, revoked_at: string|null, changed_at: string|null }}
 */
function deriveConsentState(consent) {
  if (!consent) {
    return {
      state: CONSENT_STATES.ABSENT,
      allowlisted: false,
      consented_at: null,
      revoked_at: null,
      changed_at: null,
    };
  }

  const consentedAt = consent.consented_at ?? null;
  const revokedAt = consent.revoked_at ?? null;
  const changedAt = consent.changed_at ?? null;

  if (consent.revoked === true || (revokedAt && !consent.active)) {
    return {
      state: CONSENT_STATES.REVOKED,
      allowlisted: false,
      consented_at: consentedAt,
      revoked_at: revokedAt,
      changed_at: changedAt,
    };
  }

  // Re-granted after a prior revocation => "changed".
  if (changedAt || (revokedAt && consent.active)) {
    return {
      state: CONSENT_STATES.CHANGED,
      allowlisted: true,
      consented_at: consentedAt,
      revoked_at: revokedAt,
      changed_at: changedAt,
    };
  }

  return {
    state: CONSENT_STATES.GRANTED,
    allowlisted: true,
    consented_at: consentedAt,
    revoked_at: null,
    changed_at: null,
  };
}

/**
 * Build the public consent response payload.
 * Includes an explicit privacy notice so callers do not infer that
 * consent/allowlisting makes on-chain data private.
 */
function buildConsentResponse(wallet, consent) {
  const derived = deriveConsentState(consent);
  return {
    wallet,
    state: derived.state,
    consented: derived.allowlisted,
    allowlisted: derived.allowlisted,
    consented_at: derived.consented_at,
    revoked_at: derived.revoked_at,
    changed_at: derived.changed_at,
    privacy_notice:
      'Consent and allowlisting control issuance only. Credentials anchored on a public chain are publicly observable and are not made private by consent.',
  };
}

/**
 * GET /patient/consent/:wallet
 * Returns explicit consent state for a wallet. Public — used by issuers
 * before minting. Callers MUST treat any state other than `granted` or
 * `changed` (i.e. `allowlisted: false`) as a rejection for issuance.
 */
router.get('/consent/:wallet', (req, res) => {
  const { wallet } = req.params;
  const consent = getConsent(wallet);
  res.json(buildConsentResponse(wallet, consent));
});

/**
 * POST /patient/consent
 * Record explicit patient consent. Requires patient JWT.
 *
 * Transitions:
 *   absent  -> granted
 *   revoked -> changed (re-grant)
 *   granted/changed -> no-op (idempotent)
 */
router.post('/consent', authMiddleware, validate(recordConsentSchema), (req, res) => {
  const { publicKey } = req.user;
  const existing = getConsent(publicKey);
  const current = deriveConsentState(existing);

  if (current.state === CONSENT_STATES.GRANTED || current.state === CONSENT_STATES.CHANGED) {
    return res.json({
      success: true,
      ...buildConsentResponse(publicKey, existing),
      already_consented: true,
    });
  }

  // absent -> granted, or revoked -> changed (re-grant).
  const wasRevoked = current.state === CONSENT_STATES.REVOKED;
  recordConsent(publicKey, { regrant: wasRevoked });

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