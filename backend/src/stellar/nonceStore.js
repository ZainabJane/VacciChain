'use strict';

const TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Distinct error thrown when the underlying nonce store is unavailable.
 * Callers should fail closed (reject the challenge) when this is thrown.
 */
class NonceStoreUnavailableError extends Error {
  constructor(message, cause) {
    super(message || 'Nonce store unavailable');
    this.name = 'NonceStoreUnavailableError';
    this.code = 'NONCE_STORE_UNAVAILABLE';
    if (cause) this.cause = cause;
  }
}

/**
 * Memory backend. Suitable for tests and single-instance deployments.
 * Uses a Map with synchronous, atomic check-and-delete semantics (single
 * threaded event loop guarantees no interleaving within a single call).
 */
class MemoryNonceStore {
  constructor(ttlMs = TTL_MS) {
    this.ttlMs = ttlMs;
    this.store = new Map();
    this._timer = setInterval(() => this._purge(), 60_000);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  _purge() {
    const now = Date.now();
    for (const [nonce, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(nonce);
    }
  }

  async set(nonce, clientPublicKey) {
    // Overwrite semantics: a fresh challenge for the same nonce replaces the
    // previous one. Nonces are expected to be unique random values.
    this.store.set(nonce, {
      clientPublicKey,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  async consume(nonce) {
    const entry = this.store.get(nonce);
    if (!entry) throw new Error('Invalid or already used nonce');
    // Delete immediately to guarantee single-use even before expiry check.
    this.store.delete(nonce);
    if (Date.now() > entry.expiresAt) {
      throw new Error('Challenge expired');
    }
    return entry.clientPublicKey;
  }

  async close() {
    clearInterval(this._timer);
    this.store.clear();
  }

  _storeForTesting() {
    return this.store;
  }
}

/**
 * Redis backend. Uses SET NX PX for set() and an atomic GETDEL (falling back
 * to a Lua script when GETDEL is unavailable) for consume(). This guarantees
 * single-use across concurrent verify requests and multi-instance deployments.
 */
class RedisNonceStore {
  constructor(client, ttlMs = TTL_MS) {
    if (!client) throw new Error('RedisNonceStore requires a redis client');
    this.client = client;
    this.ttlMs = ttlMs;
    this._getdelSupported = typeof client.getdel === 'function';
  }

  _key(nonce) {
    return `sep10:nonce:${nonce}`;
  }

  async set(nonce, clientPublicKey) {
    try {
      const result = await this.client.set(this._key(nonce), clientPublicKey, {
        NX: true,
        PX: this.ttlMs,
      });
      if (result === null) {
        // Nonce already exists. Treat as a collision; do not overwrite.
        throw new Error('Nonce already registered');
      }
    } catch (err) {
      if (err && err.code === 'NONCE_STORE_UNAVAILABLE') throw err;
      if (err && err.message === 'Nonce already registered') throw err;
      throw new NonceStoreUnavailableError('Failed to store nonce', err);
    }
  }

  async consume(nonce) {
    const key = this._key(nonce);
    let value;
    try {
      if (this._getdelSupported) {
        value = await this.client.getdel(key);
      } else {
        // Atomic GET + DEL via Lua for older Redis clients/servers.
        value = await this.client.eval(
          "local v = redis.call('GET', KEYS[1]); " +
            "if v then redis.call('DEL', KEYS[1]) end; " +
            'return v',
          1,
          key
        );
      }
    } catch (err) {
      throw new NonceStoreUnavailableError('Failed to consume nonce', err);
    }

    if (value === null || value === undefined) {
      throw new Error('Invalid or already used nonce');
    }
    // TTL is enforced by Redis (PX); an expired key is already gone, so a
    // successful GETDEL implies the challenge was still valid.
    return value;
  }

  async close() {
    // Client lifecycle is owned by the caller; nothing to do here.
  }
}

function createNonceStore(config = {}) {
  const backend = (config.NONCE_STORE_BACKEND || 'memory').toLowerCase();
  const ttlMs = config.NONCE_TTL_MS || TTL_MS;

  if (backend === 'redis') {
    const client = config.redisClient || config.NONCE_STORE_REDIS_CLIENT;
    if (!client) {
      throw new NonceStoreUnavailableError(
        'Redis nonce store selected but no client provided'
      );
    }
    return new RedisNonceStore(client, ttlMs);
  }

  if (backend === 'memory') {
    return new MemoryNonceStore(ttlMs);
  }

  throw new Error(`Unknown NONCE_STORE_BACKEND: ${backend}`);
}

// Lazily-initialised default store. Kept as a module-level singleton so the
// existing set/consume API continues to work unchanged.
let defaultStore = null;

function getStore() {
  if (!defaultStore) {
    // eslint-disable-next-line global-require
    let config = {};
    try {
      config = require('../config');
    } catch (_err) {
      config = {};
    }
    defaultStore = createNonceStore(config);
  }
  return defaultStore;
}

/**
 * Register a new nonce with a 5-minute TTL.
 * Optionally associates a requestId for log correlation.
 */
async function set(nonce, clientPublicKey) {
  return getStore().set(nonce, clientPublicKey);
}

/**
 * Consume a nonce. Returns clientPublicKey on success.
 * Throws if nonce is unknown, expired, or already used.
 * Throws NonceStoreUnavailableError if the store is unavailable (fail closed).
 */
async function consume(nonce) {
  return getStore().consume(nonce);
}

module.exports = {
  set,
  consume,
  createNonceStore,
  MemoryNonceStore,
  RedisNonceStore,
  NonceStoreUnavailableError,
  TTL_MS,
};

// Exposed only for tests — do not use in production code
/* istanbul ignore next */
if (process.env.NODE_ENV === 'test') {
  module.exports._storeForTesting = () => {
    const store = getStore();
    if (typeof store._storeForTesting === 'function') {
      return store._storeForTesting();
    }
    return store;
  };
  module.exports._resetForTesting = () => {
    if (defaultStore && typeof defaultStore.close === 'function') {
      defaultStore.close();
    }
    defaultStore = null;
  };
}