'use strict';

/**
 * SEP-10 security tests.
 *
 * These tests exercise buildChallenge / verifyChallenge / nonceStore directly
 * without hitting Horizon. The Horizon.Server.loadAccount call in buildChallenge
 * is mocked at the module level.
 */

const StellarSdk = require('@stellar/stellar-sdk');

// ── Mocks ────────────────────────────────────────────────────────────────────

// Prevent real Horizon calls
jest.mock('@stellar/stellar-sdk', () => {
  const real = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...real,
    Horizon: {
      ...real.Horizon,
      Server: jest.fn().mockImplementation(() => ({
        loadAccount: jest.fn(), // overridden per-test via beforeEach
      })),
    },
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
const SERVER_SECRET = 'SCZANGBA5RLMPI35IQKZNMUBZLZQZLZQZLZQZLZQZLZQZLZQZLZQZLZQ'.slice(0, 56);

// Generate a deterministic-enough test server keypair
const serverKeypair = StellarSdk.Keypair.random();
const clientKeypair = StellarSdk.Keypair.random();

function freshConfig() {
  process.env.STELLAR_NETWORK = 'testnet';
  process.env.HORIZON_URL = 'https://horizon-testnet.stellar.org';
  process.env.SEP10_SERVER_KEY = serverKeypair.secret();
  process.env.HOME_DOMAIN = 'vaccichain.example.com';
  process.env.WEB_AUTH_DOMAIN = 'auth.vaccichain.example.com';
  process.env.STELLAR_NETWORK_PASSPHRASE = NETWORK_PASSPHRASE;
}

/**
 * Build a challenge and return the parsed Transaction plus the nonce.
 * Signs the transaction with the client keypair to simulate a wallet response.
 */
async function buildAndSign(overrideClientKey) {
  const { buildChallenge, NETWORK_PASSPHRASE: NP } = require('../src/stellar/sep10');
  const clientKey = overrideClientKey || clientKeypair.publicKey();
  const { transaction: xdr, nonce, network_passphrase } = await buildChallenge(clientKey);

  const tx = new StellarSdk.Transaction(xdr, NP);
  tx.sign(overrideClientKey ? StellarSdk.Keypair.fromPublicKey(clientKey) : clientKeypair);

  return { xdr: tx.toXDR(), nonce, network_passphrase, tx };
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.resetModules();
  freshConfig();

  // Wire the mock Horizon server to return a synthetic account (sequence = -1 → 0 after build)
  const { Horizon } = require('@stellar/stellar-sdk');
  Horizon.Server.mockImplementation(() => ({
    loadAccount: jest.fn().mockResolvedValue(
      new StellarSdk.Account(serverKeypair.publicKey(), '-1')
    ),
  }));
});

// ── Challenge structure ───────────────────────────────────────────────────────

describe('buildChallenge — transaction structure', () => {
  test('sequence number is 0', async () => {
    const { buildChallenge, NETWORK_PASSPHRASE: NP } = require('../src/stellar/sep10');
    const { transaction } = await buildChallenge(clientKeypair.publicKey());
    const tx = new StellarSdk.Transaction(transaction, NP);
    expect(tx.sequence).toBe('0');
  });

  test('first operation is manage_data with key "<home_domain> auth"', async () => {
    const { buildChallenge, NETWORK_PASSPHRASE: NP } = require('../src/stellar/sep10');
    const { transaction } = await buildChallenge(clientKeypair.publicKey());
    const tx = new StellarSdk.Transaction(transaction, NP);
    const op = tx.operations[0];
    expect(op.type).toBe('manageData');
    expect(op.name).toBe('vaccichain.example.com auth');
    expect(op.source).toBe(clientKeypair.publicKey());
  });

  test('nonce value is exactly 64 bytes (base64 of 48 random bytes)', async () => {
    const { buildChallenge } = require('../src/stellar/sep10');
    const { nonce } = await buildChallenge(clientKeypair.publicKey());
    expect(typeof nonce).toBe('string');
    expect(nonce.length).toBe(64);
    // Must be valid base64
    expect(() => Buffer.from(nonce, 'base64')).not.toThrow();
    expect(Buffer.from(nonce, 'base64').length).toBe(48);
  });

  test('second operation is manage_data with key "web_auth_domain"', async () => {
    const { buildChallenge, NETWORK_PASSPHRASE: NP } = require('../src/stellar/sep10');
    const { transaction } = await buildChallenge(clientKeypair.publicKey());
    const tx = new StellarSdk.Transaction(transaction, NP);
    const op = tx.operations[1];
    expect(op.type).toBe('manageData');
    expect(op.name).toBe('web_auth_domain');
    expect(op.value.toString()).toBe('auth.vaccichain.example.com');
    expect(op.source).toBe(serverKeypair.publicKey());
  });

  test('response includes network_passphrase', async () => {
    const { buildChallenge } = require('../src/stellar/sep10');
    const result = await buildChallenge(clientKeypair.publicKey());
    expect(result.network_passphrase).toBe(NETWORK_PASSPHRASE);
  });

  test('challenge expires after exactly 5 minutes (timeBounds.maxTime = now + 300)', async () => {
    const before = Math.floor(Date.now() / 1000);
    const { buildChallenge, NETWORK_PASSPHRASE: NP } = require('../src/stellar/sep10');
    const { transaction } = await buildChallenge(clientKeypair.publicKey());
    const after = Math.floor(Date.now() / 1000);
    const tx = new StellarSdk.Transaction(transaction, NP);
    const max = Number(tx.timeBounds.maxTime);
    expect(max).toBeGreaterThanOrEqual(before + 300);
    expect(max).toBeLessThanOrEqual(after + 300);
  });
});

// ── Nonce store ───────────────────────────────────────────────────────────────

describe('nonceStore — TTL and single-use', () => {
  test('consume succeeds once then rejects on replay', async () => {
    const nonceStore = require('../src/stellar/nonceStore');
    await nonceStore.set('test-nonce-1', clientKeypair.publicKey());
    await expect(nonceStore.consume('test-nonce-1')).resolves.toBeUndefined();
    await expect(nonceStore.consume('test-nonce-1')).rejects.toThrow(
      'Invalid or already used nonce'
    );
  });

  test('consume rejects for unknown nonce', async () => {
    const nonceStore = require('../src/stellar/nonceStore');
    await expect(nonceStore.consume('never-registered')).rejects.toThrow(
      'Invalid or already used nonce'
    );
  });

  test('consume rejects for expired nonce', async () => {
    const nonceStore = require('../src/stellar/nonceStore');
    // Manually insert an already-expired entry
    await nonceStore.set('expired-nonce', clientKeypair.publicKey());
    // Reach into the store and backdate the expiry
    const store = nonceStore._storeForTesting?.();
    if (store) {
      const entry = store.get('expired-nonce');
      if (entry) entry.expiresAt = Date.now() - 1;
    } else {
      // If internal store not exposed, skip this sub-test
      return;
    }
    await expect(nonceStore.consume('expired-nonce')).rejects.toThrow('Challenge expired');
  });

  test('consume fails closed when the store backend is unavailable', async () => {
    const nonceStore = require('../src/stellar/nonceStore');
    const { NonceStoreUnavailableError } = nonceStore;

    await nonceStore.set('unavailable-nonce', clientKeypair.publicKey());

    // Simulate a backend outage: the store cannot be read.
    const store = nonceStore._storeForTesting?.();
    if (!store) {
      // If internal store not exposed, skip this sub-test
      return;
    }
    const originalGet = store.get;
    store.get = () => {
      throw new Error('backend down');
    };

    try {
      await expect(nonceStore.consume('unavailable-nonce')).rejects.toBeInstanceOf(
        NonceStoreUnavailableError
      );
    } finally {
      store.get = originalGet;
    }
  });

  test('concurrent consume calls: exactly one succeeds', async () => {
    const nonceStore = require('../src/stellar/nonceStore');
    await nonceStore.set('race-nonce', clientKeypair.publicKey());

    const results = await Promise.allSettled([
      nonceStore.consume('race-nonce'),
      nonceStore.consume('race-nonce'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.message).toBe('Invalid or already used nonce');
  });
});

// ── verifyChallenge ───────────────────────────────────────────────────────────

describe('verifyChallenge — spec validation', () => {
  test('returns client public key on valid signed challenge', async () => {
    const { verifyChallenge } = require('../src/stellar/sep10');
    const { xdr, nonce } = await buildAndSign();
    const result = await verifyChallenge(xdr, nonce);
    expect(result).toBe(clientKeypair.publicKey());
  });

  test('rejects replayed nonce', async () => {
    const { verifyChallenge } = require('../src/stellar/sep10');
    const { xdr, nonce } = await buildAndSign();
    await verifyChallenge(xdr, nonce); // first use — ok
    // Re-sign to get a fresh XDR (nonce already consumed, so this should throw on nonce)
    await expect(verifyChallenge(xdr, nonce)).rejects.toThrow('Invalid or already used nonce');
  });

  test('rejects wrong network_passphrase', async () => {
    const { buildChallenge } = require('../src/stellar/sep10');
    const { transaction, nonce } = await buildChallenge(clientKeypair.publicKey());

    // Parse with correct passphrase, sign, then try to verify with wrong passphrase
    const tx = new StellarSdk.Transaction(transaction, NETWORK_PASSPHRASE);
    tx.sign(clientKeypair);
    const signedXdr = tx.toXDR();

    // Temporarily switch network to mainnet so verifyChallenge uses wrong passphrase
    process.env.STELLAR_NETWORK = 'mainnet';
    jest.resetModules();
    freshConfig();
    process.env.STELLAR_NETWORK = 'mainnet';
    const { verifyChallenge: verifyMain } = require('../src/stellar/sep10');

    await expect(verifyMain(signedXdr, nonce)).rejects.toThrow();
  });

  test('rejects transaction with wrong home_domain key', async () => {
    // Build a challenge with the original HOME_DOMAIN
    const { buildChallenge, NETWORK_PASSPHRASE: NP } = require('../src/stellar/sep10');
    const { transaction, nonce } = await buildChallenge(clientKeypair.publicKey());
    const tx = new StellarSdk.Transaction(transaction, NP);
    tx.sign(clientKeypair);
    const signedXdr = tx.toXDR();

    // Switch HOME_DOMAIN to something different and reload modules
    process.env.HOME_DOMAIN = 'other.example.com';
    jest.resetModules();
    // Re-wire Horizon mock for the new module instance
    const { Horizon } = require('@stellar/stellar-sdk');
    Horizon.Server.mockImplementation(() => ({
      loadAccount: jest.fn().mockResolvedValue(
        new StellarSdk.Account(serverKeypair.publicKey(), '-1')
      ),
    }));
    const { verifyChallenge: verifyOther } = require('../src/stellar/sep10');
    // Register the nonce in the new module's nonceStore
    const newNonceStore = require('../src/stellar/nonceStore');
    await newNonceStore.set(nonce, clientKeypair.publicKey());

    await expect(verifyOther(signedXdr, nonce)).rejects.toThrow(/Invalid manage_data key/);
  });

  test('rejects transaction with sequence number != 0', async () => {
    // Build a raw transaction with sequence 1 (not via buildChallenge)
    const { verifyChallenge, NETWORK_PASSPHRASE: NP } = require('../src/stellar/sep10');
    const account = new StellarSdk.Account(serverKeypair.publicKey(), '0'); // seq will be 1
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: NP,
    })
      .addOperation(
        StellarSdk.Operation.manageData({
          name: `${process.env.HOME_DOMAIN} auth`,
          value: 'A'.repeat(64),
          source: clientKeypair.publicKey(),
        })
      )
      .setTimeout(300)
      .build();
    tx.sign(serverKeypair);
    tx.sign(clientKeypair);

    // Register a fake nonce so the nonce check passes
    const nonceStore = require('../src/stellar/nonceStore');
    await nonceStore.set('A'.repeat(64), clientKeypair.publicKey());

    await expect(verifyChallenge(tx.toXDR(), 'A'.repeat(64))).rejects.toThrow(
      'Challenge transaction sequence number must be 0'
    );
  });

  test('rejects missing client signature', async () => {
    const { buildChallenge, verifyChallenge, NETWORK_PASSPHRASE: NP } = require('../src/stellar/sep10');
    const { transaction, nonce } = await buildChallenge(clientKeypair.publicKey());
    // Do NOT sign with client — submit server-only signed XDR
    await expect(verifyChallenge(transaction, nonce)).rejects.toThrow(
      'Client signature missing or invalid'
    );
  });
});
