const StellarSdk = require('@stellar/stellar-sdk');
const { simulateContract } = require('./soroban');

const cache = new Map();
const TTL = 30 * 1000; // 30 seconds

/**
 * Issuer lifecycle states.
 * - ACTIVE: wallet is an authorized issuer.
 * - REVOKED: wallet was an issuer but has been revoked.
 */
const IssuerState = Object.freeze({
  ACTIVE: 'active',
  REVOKED: 'revoked'
});

/**
 * Check if a wallet address is an authorized issuer on-chain.
 * Results are cached for 30 seconds.
 *
 * Cache semantics:
 * - Cached entries store the full issuer state (active/revoked) so that
 *   re-add after revoke is reflected once the cache is invalidated or expires.
 * - On simulation failure nothing is cached, allowing retries.
 *
 * @param {string} wallet
 * @returns {Promise<boolean>}
 */
async function isAuthorizedIssuer(wallet) {
  const now = Date.now();
  const cached = cache.get(wallet);

  if (cached && (now - cached.timestamp < TTL)) {
    return cached.state === IssuerState.ACTIVE;
  }

  try {
    const args = [StellarSdk.Address.fromString(wallet).toScVal()];
    const result = await simulateContract('is_issuer', args);
    const isAuthorized = !!StellarSdk.scValToNative(result);

    cache.set(wallet, {
      state: isAuthorized ? IssuerState.ACTIVE : IssuerState.REVOKED,
      value: isAuthorized,
      timestamp: now
    });

    return isAuthorized;
  } catch (error) {
    // If simulation fails, we don't cache to allow retry
    throw error;
  }
}

/**
 * Get the cached issuer state for a wallet without hitting the chain.
 * Returns null if there is no fresh cached entry.
 * @param {string} wallet
 * @returns {{ state: string, value: boolean, timestamp: number } | null}
 */
function getCachedIssuerState(wallet) {
  const now = Date.now();
  const cached = cache.get(wallet);

  if (cached && (now - cached.timestamp < TTL)) {
    return cached;
  }

  return null;
}

/**
 * Invalidate the cache for a specific wallet or clear the entire cache.
 * Should be called on any issuer lifecycle change (add, revoke, re-add,
 * administrator handoff) so subsequent reads reflect the new state.
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
 * Invalidate the cache after an issuer lifecycle transition.
 * Accepts one or more affected wallets (e.g. the issuer being added/revoked
 * and, for administrator handoff, the previous and new administrators).
 * @param {string|string[]} [wallets]
 */
function invalidateOnLifecycleChange(wallets) {
  if (!wallets) {
    cache.clear();
    return;
  }

  const list = Array.isArray(wallets) ? wallets : [wallets];
  for (const wallet of list) {
    if (wallet) {
      cache.delete(wallet);
    }
  }
}

module.exports = {
  isAuthorizedIssuer,
  getCachedIssuerState,
  invalidateCache,
  invalidateOnLifecycleChange,
  IssuerState,
  TTL
};