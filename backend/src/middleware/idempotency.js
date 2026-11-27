const crypto = require('crypto');
const db = require('../db');

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-flight requests keyed by idempotency key, so concurrent requests with the
// same key wait for the first one instead of both executing.
// { key -> Promise<{ status, body } | null> }
const inFlight = new Map();

// Ensure the idempotency table exists. The canonical definition lives in the
// migration; this is a defensive fallback for environments where migrations
// have not yet run.
let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = db
      .query(
        `CREATE TABLE IF NOT EXISTS idempotency_keys (
           key TEXT PRIMARY KEY,
           status INTEGER NOT NULL,
           body JSONB NOT NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           expires_at TIMESTAMPTZ NOT NULL
         )`
      )
      .catch((err) => {
        tableReady = null;
        throw err;
      });
  }
  return tableReady;
}

// Prune expired entries (lazy GC, run opportunistically).
async function prune() {
  try {
    await db.query('DELETE FROM idempotency_keys WHERE expires_at <= NOW()');
  } catch (_err) {
    // Pruning is best-effort; never fail a request because of it.
  }
}

async function getRecord(key) {
  const result = await db.query(
    'SELECT status, body FROM idempotency_keys WHERE key = $1 AND expires_at > NOW()',
    [key]
  );
  if (!result || !result.rows || result.rows.length === 0) return null;
  const row = result.rows[0];
  return { status: row.status, body: row.body };
}

// Persist the idempotency record atomically. Uses an upsert so a concurrent
// writer that raced us does not cause a duplicate-key failure; the first
// committed record wins (ON CONFLICT DO NOTHING).
async function saveRecord(key, status, body) {
  const expiresAt = new Date(Date.now() + TTL_MS);
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO idempotency_keys (key, status, body, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO NOTHING`,
      [key, status, JSON.stringify(body), expiresAt]
    );
  });
}

function idempotency(req, res, next) {
  const key = req.headers['idempotency-key'];
  if (!key) return next(); // missing key — not idempotent, pass through

  // Normalize the key so header casing/whitespace does not create duplicates.
  const normalizedKey = String(key).trim();
  if (!normalizedKey) return next();

  // Opportunistic pruning; do not block the request on it.
  prune();

  const handle = async () => {
    await ensureTable();

    // Check for an already-committed response.
    const cached = await getRecord(normalizedKey);
    if (cached) {
      return { cached };
    }

    // If another request with the same key is in flight, wait for it and
    // reuse its result instead of executing the handler twice.
    const pending = inFlight.get(normalizedKey);
    if (pending) {
      const result = await pending;
      if (result) return { cached: result };
      // The in-flight request failed to produce a cacheable response; fall
      // through and execute this request.
    }

    // Register this request as the in-flight owner.
    let resolveInFlight;
    const inFlightPromise = new Promise((resolve) => {
      resolveInFlight = resolve;
    });
    inFlight.set(normalizedKey, inFlightPromise);

    return { owner: true, resolveInFlight };
  };

  handle()
    .then(({ cached, owner, resolveInFlight }) => {
      if (cached) {
        return res.status(cached.status).json(cached.body);
      }

      // Intercept res.json to persist the first response atomically.
      const originalJson = res.json.bind(res);
      let settled = false;

      const settle = (record) => {
        if (settled) return;
        settled = true;
        inFlight.delete(normalizedKey);
        if (resolveInFlight) resolveInFlight(record);
      };

      res.json = (body) => {
        if (res.statusCode < 500) {
          // Persist before sending so the record is durable even if the
          // client disconnects. On failure we still respond but do not cache.
          saveRecord(normalizedKey, res.statusCode, body)
            .then(() => settle({ status: res.statusCode, body }))
            .catch(() => settle(null))
            .finally(() => originalJson(body));
          return res;
        }
        // Do not cache server errors; release the in-flight slot.
        settle(null);
        return originalJson(body);
      };

      // If the response ends without going through res.json (e.g. res.send,
      // res.end, or an error), release the in-flight slot so waiters are not
      // blocked forever.
      res.on('finish', () => {
        if (!settled) settle(null);
      });
      res.on('close', () => {
        if (!settled) settle(null);
      });

      next();
    })
    .catch((err) => {
      inFlight.delete(normalizedKey);
      next(err);
    });
}

module.exports = idempotency;