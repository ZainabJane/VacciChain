const crypto = require('crypto');
const config = require('../config');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const TTL_MS = (config && config.IDEMPOTENCY_TTL_MS) || DEFAULT_TTL_MS;

// Durable store backed by SQLite. We lazily require the db module so that
// tests can inject/mock it and so that requiring this middleware does not
// force a db connection at import time.
let db = null;

function getDb() {
  if (db) return db;
  // Prefer the existing indexer db module if available.
  try {
    // eslint-disable-next-line global-require
    const indexerDb = require('../db');
    if (indexerDb && typeof indexerDb.prepare === 'function') {
      db = indexerDb;
    } else if (indexerDb && indexerDb.db && typeof indexerDb.db.prepare === 'function') {
      db = indexerDb.db;
    }
  } catch (e) {
    // fall through to dedicated db
  }

  if (!db) {
    // eslint-disable-next-line global-require
    const Database = require('better-sqlite3');
    const path = require('path');
    const dbPath =
      (config && config.IDEMPOTENCY_DB_PATH) ||
      path.join(__dirname, '..', '..', 'data', 'idempotency.sqlite');
    db = new Database(dbPath);
  }

  ensureSchema(db);
  return db;
}

let schemaReady = false;
function ensureSchema(conn) {
  if (schemaReady) return;
  conn.exec(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      issuer TEXT NOT NULL,
      key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      status INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (issuer, key)
    );
    CREATE INDEX IF NOT EXISTS idx_idempotency_expires_at
      ON idempotency_keys (expires_at);
  `);
  schemaReady = true;
}

function prune(conn) {
  const now = Date.now();
  try {
    conn.prepare('DELETE FROM idempotency_keys WHERE expires_at <= ?').run(now);
  } catch (e) {
    // Non-fatal: pruning is best-effort.
  }
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function hashPayload(req) {
  const payload = {
    method: req.method,
    path: req.originalUrl || req.url,
    body: req.body === undefined ? null : req.body,
  };
  return sha256(stableStringify(payload));
}

function resolveIssuer(req) {
  if (req.user && req.user.wallet) return String(req.user.wallet);
  if (req.user && req.user.address) return String(req.user.address);
  if (req.issuer) return String(req.issuer);
  return 'anonymous';
}

function idempotency(req, res, next) {
  const rawKey = req.headers['idempotency-key'];
  if (!rawKey) return next(); // missing key — not idempotent, pass through

  const key = Array.isArray(rawKey) ? rawKey[0] : String(rawKey);
  if (!key) return next();

  let conn;
  try {
    conn = getDb();
  } catch (e) {
    // If the durable store is unavailable, fail closed to avoid duplicate
    // records being created without idempotency protection.
    return res.status(503).json({ error: 'Idempotency store unavailable' });
  }

  prune(conn);

  const issuer = resolveIssuer(req);
  const payloadHash = hashPayload(req);

  let existing;
  try {
    existing = conn
      .prepare(
        'SELECT payload_hash, status, body, expires_at FROM idempotency_keys WHERE issuer = ? AND key = ?'
      )
      .get(issuer, key);
  } catch (e) {
    return res.status(503).json({ error: 'Idempotency store unavailable' });
  }

  if (existing) {
    if (existing.expires_at <= Date.now()) {
      // Expired entry — treat as absent and remove it.
      try {
        conn
          .prepare('DELETE FROM idempotency_keys WHERE issuer = ? AND key = ?')
          .run(issuer, key);
      } catch (e) {
        // ignore
      }
    } else if (existing.payload_hash !== payloadHash) {
      // Key reuse with a different payload.
      return res.status(409).json({
        error: 'Idempotency key reused with a different payload',
      });
    } else {
      // Replay: return the original outcome.
      let body;
      try {
        body = JSON.parse(existing.body);
      } catch (e) {
        body = existing.body;
      }
      return res.status(existing.status).json(body);
    }
  }

  // Intercept res.json to persist the first response.
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    // Only persist successful / client-visible outcomes, not server errors,
    // so that transient failures can be retried.
    if (res.statusCode < 500) {
      try {
        const now = Date.now();
        conn
          .prepare(
            `INSERT INTO idempotency_keys
               (issuer, key, payload_hash, status, body, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(issuer, key) DO UPDATE SET
               payload_hash = excluded.payload_hash,
               status = excluded.status,
               body = excluded.body,
               created_at = excluded.created_at,
               expires_at = excluded.expires_at`
          )
          .run(
            issuer,
            key,
            payloadHash,
            res.statusCode,
            JSON.stringify(body),
            now,
            now + TTL_MS
          );
      } catch (e) {
        // Persistence failure should not break the response, but log it.
        // eslint-disable-next-line no-console
        console.error('Failed to persist idempotency record:', e.message);
      }
    }
    return originalJson(body);
  };

  next();
}

// Test helpers -------------------------------------------------------------

function clearStore() {
  const conn = getDb();
  conn.prepare('DELETE FROM idempotency_keys').run();
}

function getRecord(issuer, key) {
  const conn = getDb();
  return conn
    .prepare(
      'SELECT issuer, key, payload_hash, status, body, created_at, expires_at FROM idempotency_keys WHERE issuer = ? AND key = ?'
    )
    .get(issuer, key);
}

function setDb(conn) {
  db = conn;
  schemaReady = false;
  if (conn) ensureSchema(conn);
}

module.exports = idempotency;
module.exports.idempotency = idempotency;
module.exports.clearStore = clearStore;
module.exports.getRecord = getRecord;
module.exports.setDb = setDb;
module.exports.hashPayload = hashPayload;
module.exports.TTL_MS = TTL_MS;