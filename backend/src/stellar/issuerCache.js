const StellarSdk = require('@stellar/stellar-sdk');
const { simulateContract } = require('./soroban');
const config = require('../config');

/**
 * Issuer authorization cache.
 *
 * Revocation consistency window:
 *   Cached issuer authorizations are only trusted for `ISSUER_CACHE_TTL_MS`
 *   (default 30s). After that window, the on-chain state is re-simulated, so a
 *   revoked issuer can never mint past the documented consistency window.
 *
 * Invalidation contract:
 *   - On issuer ADD: call `invalidateCache(wallet)` (or `invalidateAllIssuers()`)
 *     so the new authorization is picked up immediately.
 *   - On issuer REVOKE: call `invalidateCache(wallet)` (or
 *     `invalidateAllIssuers()`) so the revoked issuer is rejected immediately,
 *     without waiting for the TTL to elapse.
 *   - Entries are never served past their TTL, even if invalidation is missed.
 */
const TTL = Number.isFinite(config.ISSUER_CACHE_TTL_MS)
  ? config.ISSUER_CACHE_TTL_MS
  : 30 * 1000; // 30 seconds default revocation consistency window

const cache = new Map();

/**
 * Check if a wallet address is an authorized issuer on-chain.
 * Results are cached for `ISSUER_CACHE_TTL_MS` (the revocation consistency window).
 * @param {string} wallet 
 * @returns {Promise<boolean>}
 */
async function isAuthorizedIssuer(wallet) {
  const now = Date.now();
  const cached = cache.get(wallet);

  if (cached) {
    const age = now - cached.cachedAt;
    if (age >= 0 && age < TTL) {
      return cached.value;
    }
    // Expired entry: never serve past the TTL.
    cache.delete(wallet);
  }

  try {
    const args = [StellarSdk.Address.fromString(wallet).toScVal()];
    const result = await simulateContract('is_issuer', args);
    const isAuthorized = StellarSdk.scValToNative(result);

    cache.set(wallet, {
      value: !!isAuthorized,
      cachedAt: Date.now()
    });

    return !!isAuthorized;
  } catch (error) {
    // If simulation fails, we don't cache to allow retry
    throw error;
  }
}

/**
 * Invalidate the cache for a specific wallet or clear the entire cache.
 * Call this on issuer add/revoke events to apply changes immediately.
 * @param {string} [wallet] 
 */
function invalidateCache(wallet) {
  if (wallet) {
    cache.delete(wallet);
  } else {
    cache.clear();
  }
}

/**
 * Clear the entire issuer authorization cache.
 * Use on bulk issuer add/revoke events or configuration changes.
 */
function invalidateAllIssuers() {
  cache.clear();
}

module.exports = {
  isAuthorizedIssuer,
  invalidateCache,
  invalidateAllIssuers,
  ISSUER_CACHE_TTL_MS: TTL
};