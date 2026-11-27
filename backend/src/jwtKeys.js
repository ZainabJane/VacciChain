/**
 * JWT signing keys, claims policy and rotation (#47, docs/jwt-key-rotation.md).
 *
 * - One current key signs new tokens; up to MAX_PREVIOUS_KEYS previous keys
 *   still verify during the overlap window.
 * - Each previous key carries a `retiredAt` cutoff: once
 *   `JWT_ROTATION_OVERLAP_SECONDS` (default: token lifetime, 1h) has passed
 *   since rotation, the key is rejected even if still configured.
 * - Algorithm, issuer and audience are pinned so a token from another
 *   service or an `alg: none` token is never accepted.
 */

const MAX_PREVIOUS_KEYS = 5;
const JWT_ALGORITHM = 'HS256';
const TOKEN_TTL_SECONDS = 60 * 60;

function issuer() {
  return process.env.JWT_ISSUER || process.env.HOME_DOMAIN || 'localhost';
}

function audience() {
  return process.env.JWT_AUDIENCE || 'vaccichain-api';
}

function overlapSeconds() {
  const raw = Number(process.env.JWT_ROTATION_OVERLAP_SECONDS);
  return Number.isFinite(raw) && raw >= 0 ? raw : TOKEN_TTL_SECONDS;
}

let current = null;
let previous = [];

function loadFromEnv() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not configured');
  current = { kid: process.env.JWT_KEY_ID || '1', secret };
  // Previous keys from env have no known rotation time: they are accepted
  // until removed from JWT_PREVIOUS_KEYS (operator-controlled cutoff).
  previous = (process.env.JWT_PREVIOUS_KEYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_PREVIOUS_KEYS)
    .map((s, i) => ({ kid: `prev-${i + 1}`, secret: s, retiredAt: null }));
}

function ensureLoaded() {
  if (!current) loadFromEnv();
}

/** Key used to sign new tokens. */
function getSigningKey() {
  ensureLoaded();
  return { ...current };
}

/** Keys accepted for verification: the current key plus previous keys still inside their overlap window. */
function getVerificationKeys(now = Date.now()) {
  ensureLoaded();
  const cutoffMs = overlapSeconds() * 1000;
  const active = previous.filter((k) => k.retiredAt === null || now - k.retiredAt < cutoffMs);
  return [{ ...current }, ...active.map((k) => ({ kid: k.kid, secret: k.secret }))];
}

/**
 * Rotate at runtime: the current key is demoted to previous with a
 * `retiredAt` timestamp, so it stops verifying after the overlap period.
 */
function rotateKey({ newSecret, newKid } = {}) {
  ensureLoaded();
  if (!newSecret || newSecret.length < 32) {
    throw new Error('new_secret must be at least 32 characters');
  }
  const kid = newKid || String(Number.parseInt(current.kid, 10) + 1 || Date.now());
  if (kid === current.kid || previous.some((k) => k.kid === kid)) {
    throw new Error(`kid "${kid}" is already in use`);
  }
  previous = [{ ...current, retiredAt: Date.now() }, ...previous].slice(0, MAX_PREVIOUS_KEYS);
  current = { kid, secret: newSecret };
  return { kid };
}

/** Re-read keys from the environment (e.g. after a secrets-manager refresh). */
function reloadFromEnv() {
  loadFromEnv();
}

/** Options passed to jwt.sign for every issued token. */
function signOptions() {
  const key = getSigningKey();
  return {
    algorithm: JWT_ALGORITHM,
    expiresIn: TOKEN_TTL_SECONDS,
    issuer: issuer(),
    audience: audience(),
    keyid: key.kid,
  };
}

/** Options passed to jwt.verify: algorithm, issuer and audience are pinned. */
function verifyOptions() {
  return { algorithms: [JWT_ALGORITHM], issuer: issuer(), audience: audience() };
}

module.exports = {
  JWT_ALGORITHM,
  TOKEN_TTL_SECONDS,
  MAX_PREVIOUS_KEYS,
  getSigningKey,
  getVerificationKeys,
  rotateKey,
  reloadFromEnv,
  signOptions,
  verifyOptions,
};
