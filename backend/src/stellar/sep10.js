'use strict';

const crypto = require('crypto');
const StellarSdk = require('@stellar/stellar-sdk');
const config = require('../config');
const nonceStore = require('./nonceStore');
const stellarClient = require('./client');

const NETWORK_PASSPHRASE =
  config.STELLAR_NETWORK === 'mainnet'
    ? StellarSdk.Networks.PUBLIC
    : StellarSdk.Networks.TESTNET;

// All Horizon access goes through the shared client wrapper so calls get
// bounded timeouts, safe retries, and classified errors with correlation IDs.
const server = stellarClient.getHorizonServer();

/**
 * Build a SEP-10 challenge transaction.
 *
 * Spec compliance (SEP-10 v3.4.1):
 *  - sequence number 0 (invalid — cannot be submitted to the network)
 *  - first op: manage_data, source=client, key='<home_domain> auth',
 *              value=base64(48 random bytes) = 64 bytes
 *  - second op: manage_data, source=server, key='web_auth_domain',
 *               value=WEB_AUTH_DOMAIN
 *  - timeBounds: [now, now+300] (5-minute window)
 *  - signed by server keypair
 *
 * Returns { transaction, nonce, network_passphrase }.
 *
 * @param {string} clientPublicKey - Client Stellar account (G...)
 * @param {string} [requestId] - Correlation ID for tracing (defaults to the
 *   current request context, if any)
 */
async function buildChallenge(clientPublicKey, requestId) {
  const correlationId = requestId || getRequestId();
  const serverKeypair = StellarSdk.Keypair.fromSecret(config.SEP10_SERVER_KEY);

  // SEP-10 requires sequence number 0. Use a synthetic account so the builder
  // does not fetch the real sequence from Horizon.
  const serverAccount = new StellarSdk.Account(serverKeypair.publicKey(), '-1');

  // 48 cryptographic-quality random bytes → base64 → exactly 64 bytes
  const nonce = crypto.randomBytes(48).toString('base64');

  const tx = new StellarSdk.TransactionBuilder(serverAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    // First op: client account, key = '<home_domain> auth', value = 64-byte nonce
    .addOperation(
      StellarSdk.Operation.manageData({
        name: `${config.HOME_DOMAIN} auth`,
        value: nonce,
        source: clientPublicKey,
      })
    )
    // Second op: server account, key = 'web_auth_domain'
    .addOperation(
      StellarSdk.Operation.manageData({
        name: 'web_auth_domain',
        value: config.WEB_AUTH_DOMAIN,
        source: serverKeypair.publicKey(),
      })
    )
    .setTimeout(300) // 5-minute expiry
    .build();

  tx.sign(serverKeypair);

  // Persist the nonce before returning the challenge. If the store is
  // unavailable this throws (fail closed) so no unverifiable challenge is issued.
  await nonceStore.set(nonce, clientPublicKey);

  return { transaction: tx.toXDR(), nonce, network_passphrase: NETWORK_PASSPHRASE };
}

/**
 * Verify a signed SEP-10 challenge transaction.
 *
 * Checks (SEP-10 v3.4.1):
 *  1. Nonce is valid, unexpired, and single-use
 *  2. network_passphrase matches server config
 *  3. sequence number is 0
 *  4. Server signature is present and valid
 *  5. First op is manage_data with key '<home_domain> auth'
 *  6. Client signature is present and valid
 *
 * Returns the verified client public key on success.
 *
 * @param {string} transactionXDR - Base64-encoded challenge transaction
 * @param {string} nonce - Nonce issued by buildChallenge
 * @param {string} [requestId] - Correlation ID for tracing (defaults to the
 *   current request context, if any)
 */
async function verifyChallenge(transactionXDR, nonce) {
  // 1. Consume nonce atomically before any other checks. This is the single
  //    point of truth for replay protection: it throws if the nonce is
  //    unknown, expired, or already used, and is safe under concurrent
  //    verification attempts and multi-instance deployment. The nonce is
  //    consumed even if later signature checks fail, so a failed attempt
  //    cannot be retried with the same challenge.
  try {
    await nonceStore.consume(nonce);
  } catch (err) {
    if (err && err.name === 'NonceStoreUnavailableError') {
      // Fail closed: if we cannot prove the nonce is unused, reject.
      throw new Error('Challenge verification unavailable: nonce store error');
    }
    throw err;
  }

  const serverKeypair = StellarSdk.Keypair.fromSecret(config.SEP10_SERVER_KEY);

  // 2. Parse with the expected network passphrase (rejects wrong-network transactions)
  const tx = new StellarSdk.Transaction(transactionXDR, NETWORK_PASSPHRASE);

  // 3. Sequence number must be 0
  if (tx.sequence !== '0') {
    throw new Error('Challenge transaction sequence number must be 0');
  }

  // Validate time bounds
  const now = Math.floor(Date.now() / 1000);
  if (tx.timeBounds && (now < Number(tx.timeBounds.minTime) || now > Number(tx.timeBounds.maxTime))) {
    throw new Error('Challenge transaction has expired');
  }

  // 4. Verify server signature
  const txHash = tx.hash();
  const serverSigned = tx.signatures.some((sig) =>
    serverKeypair.verify(txHash, sig.signature())
  );
  if (!serverSigned) throw new Error('Invalid server signature');

  // 5. First op must be manage_data with key '<home_domain> auth'
  const op = tx.operations[0];
  if (!op || op.type !== 'manageData') throw new Error('Invalid challenge format');
  const expectedKey = `${config.HOME_DOMAIN} auth`;
  if (op.name !== expectedKey) {
    throw new Error(`Invalid manage_data key: expected "${expectedKey}", got "${op.name}"`);
  }

  // 6. Verify client signature
  const clientPublicKey = op.source;
  const clientKeypair = StellarSdk.Keypair.fromPublicKey(clientPublicKey);
  const clientSigned = tx.signatures.some((sig) => {
    try {
      return clientKeypair.verify(txHash, sig.signature());
    } catch {
      return false;
    }
  });
  if (!clientSigned) throw new Error('Client signature missing or invalid');

  return clientPublicKey;
}

module.exports = { buildChallenge, verifyChallenge, NETWORK_PASSPHRASE };
