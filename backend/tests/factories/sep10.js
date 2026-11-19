const StellarSdk = require('@stellar/stellar-sdk');

/**
 * Generates a mock SEP-10 challenge transaction.
 *
 * By default the nonce is registered in the provided nonce store so tests can
 * exercise real single-use consume semantics (replay detection, expiry, etc.)
 * instead of bypassing the store. Pass `{ register: false }` to skip
 * registration when a test needs an unregistered/unknown nonce.
 *
 * @param {string} clientPublicKey - The public key of the client.
 * @param {Object} overrides - Overrides for the challenge.
 * @param {Object} [overrides.nonceStore] - Async nonce store exposing `set`.
 * @param {number} [overrides.ttlSeconds] - TTL used when registering the nonce.
 * @param {boolean} [overrides.register=true] - Whether to register the nonce.
 * @returns {Promise<Object>} An object containing the transaction XDR and nonce.
 */
const sep10ChallengeFactory = async (clientPublicKey, overrides = {}) => {
  const serverKeypair = StellarSdk.Keypair.fromSecret(
    process.env.SEP10_SERVER_KEY || 'SAZF5P4T56653E656665666566656665666566656665666566656665'
  );
  
  const nonce = overrides.nonce || StellarSdk.Keypair.random().publicKey();

  const {
    nonceStore,
    ttlSeconds = 300,
    register = true,
  } = overrides;

  // Register the nonce in the real store so consume semantics are exercised.
  if (register && nonceStore && typeof nonceStore.set === 'function') {
    await nonceStore.set(nonce, { clientPublicKey, ttlSeconds });
  }
  
  // Create a minimal transaction that satisfies SEP-10 for tests
  // Note: In real scenarios, you'd use TransactionBuilder, but for a factory
  // we might just want to return what the backend expects or a valid XDR.
  
  const networkPassphrase = process.env.STELLAR_NETWORK === 'mainnet'
    ? StellarSdk.Networks.PUBLIC
    : StellarSdk.Networks.TESTNET;

  const sourceAccount = new StellarSdk.Account(serverKeypair.publicKey(), '0');
  
  const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      StellarSdk.Operation.manageData({
        name: 'vaccichain auth',
        value: nonce,
        source: clientPublicKey,
      })
    )
    .setTimeout(300)
    .build();

  tx.sign(serverKeypair);

  return {
    transaction: overrides.transaction || tx.toXDR(),
    nonce,
    ...overrides
  };
};

module.exports = sep10ChallengeFactory;
