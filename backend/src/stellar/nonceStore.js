'use strict';

const TTL_MS = 5 * 60 * 1000; // 5 minutes

// nonce → { clientPublicKey, expiresAt, requestId }
const store = new Map();

// Purge expired entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [nonce, entry] of store) {
    if (now > entry.expiresAt) store.delete(nonce);
  }
}, 60_000).unref();

/**
 * Register a new nonce with a 5-minute TTL.
 * Optionally associates a requestId for log correlation.
 */
function set(nonce, clientPublicKey, requestId) {
  store.set(nonce, {
    clientPublicKey,
    expiresAt: Date.now() + TTL_MS,
    requestId: requestId || null,
  });
}

/**
 * Consume a nonce. Returns clientPublicKey on success.
 * Throws if nonce is unknown, expired, or already used.
 * Errors include the associated requestId (if any) for correlation.
 */
function consume(nonce) {
  const entry = store.get(nonce);
  if (!entry) throw new Error('Invalid or already used nonce');
  if (Date.now() > entry.expiresAt) {
    store.delete(nonce);
    const suffix = entry.requestId ? ` (requestId: ${entry.requestId})` : '';
    throw new Error(`Challenge expired${suffix}`);
  }
  store.delete(nonce); // single-use: remove immediately on consume
  return entry.clientPublicKey;
}

module.exports = { set, consume };

// Exposed only for tests — do not use in production code
/* istanbul ignore next */
if (process.env.NODE_ENV === 'test') {
  module.exports._storeForTesting = () => store;
}