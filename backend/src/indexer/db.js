/**
 * SQLite-backed event store using sql.js (pure WASM — no native build required).
 * The DB is loaded from disk on init and flushed to disk after every write.
 */
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

let db = null;
let dbPath = null;
let inTransaction = false;

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Ordered migration list. Each entry has a version, a name, and up/down SQL.
 * Migrations are applied in ascending version order and recorded in
 * schema_version inside the same transaction as the schema change.
 */
const MIGRATIONS = [
  {
    version: 1,
    name: 'initial_schema',
    up: `
      CREATE TABLE IF NOT EXISTS events (
        id          TEXT PRIMARY KEY,
        event_type  TEXT NOT NULL,
        ledger      INTEGER NOT NULL,
        timestamp   INTEGER NOT NULL,
        contract_id TEXT NOT NULL,
        payload     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
      CREATE INDEX IF NOT EXISTS idx_events_ledger ON events(ledger);

      CREATE TABLE IF NOT EXISTS api_keys (
        id          TEXT PRIMARY KEY,
        key_hash    TEXT NOT NULL UNIQUE,
        label       TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        revoked     INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS patient_consent (
        wallet       TEXT PRIMARY KEY,
        consented_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS issuer_applications (
        id             TEXT PRIMARY KEY,
        wallet         TEXT NOT NULL UNIQUE,
        name           TEXT NOT NULL,
        license_number TEXT NOT NULL,
        country        TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'pending',
        submitted_at   TEXT NOT NULL,
        reviewed_at    TEXT,
        reviewer_note  TEXT
      );
    `,
    down: `
      DROP TABLE IF EXISTS issuer_applications;
      DROP TABLE IF EXISTS patient_consent;
      DROP TABLE IF EXISTS api_keys;
      DROP INDEX IF EXISTS idx_events_ledger;
      DROP INDEX IF EXISTS idx_events_type;
      DROP TABLE IF EXISTS events;
    `,
  },
  {
    version: 2,
    name: 'checkpoints_and_dedup',
    up: `
      CREATE TABLE IF NOT EXISTS checkpoints (
        name       TEXT PRIMARY KEY,
        ledger     INTEGER NOT NULL DEFAULT 0,
        version    INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS processed_events (
        id           TEXT PRIMARY KEY,
        ledger       INTEGER NOT NULL,
        processed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_processed_events_ledger ON processed_events(ledger);

      CREATE TABLE IF NOT EXISTS audit_log (
        id         TEXT PRIMARY KEY,
        action     TEXT NOT NULL,
        subject    TEXT,
        detail     TEXT,
        created_at TEXT NOT NULL
      );
    `,
    down: `
      DROP TABLE IF EXISTS audit_log;
      DROP INDEX IF EXISTS idx_processed_events_ledger;
      DROP TABLE IF EXISTS processed_events;
      DROP TABLE IF EXISTS checkpoints;
    `,
  },
];

/** Persist in-memory DB to disk. */
function flush() {
  if (!db || !dbPath) return;
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

/**
 * Run `fn` inside an explicit transaction. Commits and flushes on success,
 * rolls back on any thrown error, and rethrows so callers can react.
 * Nested calls join the outer transaction.
 */
function withTransaction(fn) {
  if (inTransaction) return fn();
  db.run('BEGIN');
  inTransaction = true;
  try {
    const result = fn();
    db.run('COMMIT');
    inTransaction = false;
    flush();
    return result;
  } catch (err) {
    try { db.run('ROLLBACK'); } catch (_) { /* already rolled back */ }
    inTransaction = false;
    throw err;
  }
}

/** Read the current schema version (0 if the table does not exist yet). */
function getSchemaVersion() {
  const exists = db.exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
  );
  if (!exists.length || !exists[0].values.length) return 0;
  const res = db.exec('SELECT MAX(version) FROM schema_version');
  if (!res.length || res[0].values[0][0] == null) return 0;
  return res[0].values[0][0];
}

/** Apply all pending migrations in order, each in its own transaction. */
function runMigrations() {
  db.run(
    'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)'
  );
  const current = getSchemaVersion();
  const pending = MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  for (const migration of pending) {
    withTransaction(() => {
      db.run(migration.up);
      db.run('INSERT INTO schema_version (version, name, applied_at) VALUES (?,?,?)', [
        migration.version,
        migration.name,
        new Date().toISOString(),
      ]);
    });
  }
  return getSchemaVersion();
}

/** Initialize (or load) the database and bring the schema up to date. */
async function initDb(filePath) {
  dbPath = filePath;
  const SQL = await initSqlJs();

  if (fs.existsSync(filePath)) {
    const fileBuffer = fs.readFileSync(filePath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  runMigrations();
  flush();
  return db;
}

/** Close the database, flushing any pending state. Safe to call twice. */
function closeDb() {
  if (!db) return;
  try {
    flush();
  } finally {
    db.close();
    db = null;
  }
}

/**
 * Upsert a batch of events and advance the checkpoint atomically.
 * Deduplicates by id (PRIMARY KEY conflict = ignore) and records each id in
 * processed_events so duplicate deliveries are detectable.
 * @param {Array<{id, event_type, ledger, timestamp, contract_id, payload}>} events
 * @param {{ checkpoint?: string, ledger?: number }} [opts]
 */
function upsertEvents(events, opts = {}) {
  if (!events.length && !opts.checkpoint) return;
  withTransaction(() => {
    if (events.length) {
      const stmt = db.prepare(
        'INSERT OR IGNORE INTO events (id, event_type, ledger, timestamp, contract_id, payload) VALUES (?,?,?,?,?,?)'
      );
      const markStmt = db.prepare(
        'INSERT OR IGNORE INTO processed_events (id, ledger, processed_at) VALUES (?,?,?)'
      );
      const now = new Date().toISOString();
      for (const e of events) {
        stmt.run([e.id, e.event_type, e.ledger, e.timestamp, e.contract_id, JSON.stringify(e.payload)]);
        markStmt.run([e.id, e.ledger, now]);
      }
      stmt.free();
      markStmt.free();
    }
    if (opts.checkpoint) {
      setCheckpoint(opts.checkpoint, opts.ledger != null ? opts.ledger : getLatestLedger());
    }
  });
}

/** Return true if the event id has already been processed. */
function isEventProcessed(id) {
  const res = db.exec('SELECT 1 FROM processed_events WHERE id = ?', [id]);
  return res.length > 0 && res[0].values.length > 0;
}

/** Read a named checkpoint, or null if unset. */
function getCheckpoint(name) {
  const res = db.exec('SELECT name, ledger, version, updated_at FROM checkpoints WHERE name = ?', [name]);
  if (!res.length || !res[0].values.length) return null;
  const { columns, values } = res[0];
  const obj = {};
  columns.forEach((col, i) => { obj[col] = values[0][i]; });
  return obj;
}

/**
 * Advance a named checkpoint. Uses an optimistic version check when
 * `expectedVersion` is supplied; throws on conflict so the caller can retry.
 */
function setCheckpoint(name, ledger, expectedVersion) {
  return withTransaction(() => {
    const existing = getCheckpoint(name);
    if (!existing) {
      db.run(
        'INSERT INTO checkpoints (name, ledger, version, updated_at) VALUES (?,?,0,?)',
        [name, ledger, new Date().toISOString()]
      );
      return;
    }
    if (expectedVersion != null && existing.version !== expectedVersion) {
      throw new Error(`checkpoint conflict for ${name}: expected version ${expectedVersion}, found ${existing.version}`);
    }
    db.run(
      'UPDATE checkpoints SET ledger = ?, version = version + 1, updated_at = ? WHERE name = ? AND version = ?',
      [ledger, new Date().toISOString(), name, existing.version]
    );
  });
}

/** Append an audit entry. */
function recordAudit({ id, action, subject, detail, created_at }) {
  withTransaction(() => {
    db.run(
      'INSERT INTO audit_log (id, action, subject, detail, created_at) VALUES (?,?,?,?,?)',
      [id, action, subject || null, detail ? JSON.stringify(detail) : null, created_at || new Date().toISOString()]
    );
  });
}

/**
 * Query events with optional filters.
 * @param {{ event_type?: string, limit?: number, offset?: number }} opts
 */
function queryEvents({ event_type, limit = 100, offset = 0 } = {}) {
  let sql = 'SELECT * FROM events';
  const params = [];
  if (event_type) {
    sql += ' WHERE event_type = ?';
    params.push(event_type);
  }
  sql += ' ORDER BY ledger DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const results = db.exec(sql, params);
  if (!results.length) return [];

  const { columns, values } = results[0];
  return values.map((row) => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    obj.payload = JSON.parse(obj.payload);
    return obj;
  });
}

/** Return the highest ledger sequence we've indexed (0 if none). */
function getLatestLedger() {
  const res = db.exec('SELECT MAX(ledger) as max_ledger FROM events');
  if (!res.length || res[0].values[0][0] == null) return 0;
  return res[0].values[0][0];
}

// ── API key CRUD ──────────────────────────────────────────────────────────────

function insertApiKey({ id, key_hash, label, created_at }) {
  withTransaction(() => {
    db.run(
      'INSERT INTO api_keys (id, key_hash, label, created_at, revoked) VALUES (?,?,?,?,0)',
      [id, key_hash, label, created_at]
    );
  });
}

function getApiKeyByHash(key_hash) {
  const res = db.exec('SELECT * FROM api_keys WHERE key_hash = ?', [key_hash]);
  if (!res.length) return null;
  const { columns, values } = res[0];
  const obj = {};
  columns.forEach((col, i) => { obj[col] = values[0][i]; });
  return obj;
}

function listApiKeys() {
  const res = db.exec('SELECT id, label, created_at, revoked FROM api_keys ORDER BY created_at DESC');
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

function revokeApiKey(id) {
  withTransaction(() => {
    db.run('UPDATE api_keys SET revoked = 1 WHERE id = ?', [id]);
  });
}

// ── Reconciliation between chain and index ───────────────────────────────────

/**
 * Return all persisted events whose ledger falls within [fromLedger, toLedger].
 * @param {number} fromLedger inclusive lower bound
 * @param {number} toLedger inclusive upper bound
 */
function getEventsInLedgerRange(fromLedger, toLedger) {
  const res = db.exec(
    'SELECT * FROM events WHERE ledger >= ? AND ledger <= ? ORDER BY ledger ASC, id ASC',
    [fromLedger, toLedger]
  );
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map((row) => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    obj.payload = JSON.parse(obj.payload);
    return obj;
  });
}

/** Normalize a canonical event into the shape persisted in the DB. */
function normalizeEvent(e) {
  return {
    id: e.id,
    event_type: e.event_type,
    ledger: e.ledger,
    timestamp: e.timestamp,
    contract_id: e.contract_id,
    payload: e.payload,
  };
}

/** Stable comparison key for an event's content (ignores ordering). */
function eventFingerprint(e) {
  return JSON.stringify([
    e.event_type,
    e.ledger,
    e.timestamp,
    e.contract_id,
    e.payload,
  ]);
}

/**
 * Compare a bounded ledger range of canonical (on-chain) events against the
 * persisted index and emit actionable differences.
 *
 * @param {Array} canonicalEvents events sourced from the chain
 * @param {{ fromLedger: number, toLedger: number }} range
 * @returns {{ range, missing: Array, stale: Array, duplicates: Array, outOfOrder: Array, ok: boolean }}
 */
function reconcileEvents(canonicalEvents, { fromLedger, toLedger }) {
  const inRange = (e) => e.ledger >= fromLedger && e.ledger <= toLedger;
  const canonical = canonicalEvents.filter(inRange).map(normalizeEvent);
  const persisted = getEventsInLedgerRange(fromLedger, toLedger);

  // Detect duplicate ids within the canonical feed.
  const canonicalById = new Map();
  const duplicates = [];
  for (const e of canonical) {
    if (canonicalById.has(e.id)) {
      duplicates.push({ id: e.id, ledger: e.ledger, reason: 'duplicate_in_chain_feed' });
    } else {
      canonicalById.set(e.id, e);
    }
  }

  // Detect duplicate rows persisted in the index (should not happen with PK,
  // but guard against corrupted stores).
  const persistedById = new Map();
  for (const e of persisted) {
    if (persistedById.has(e.id)) {
      duplicates.push({ id: e.id, ledger: e.ledger, reason: 'duplicate_in_index' });
    } else {
      persistedById.set(e.id, e);
    }
  }

  // Missing: canonical events absent from the index.
  const missing = [];
  for (const [id, e] of canonicalById) {
    if (!persistedById.has(id)) missing.push(e);
  }

  // Stale: indexed events whose content differs from the canonical record.
  const stale = [];
  for (const [id, e] of persistedById) {
    const canon = canonicalById.get(id);
    if (canon && eventFingerprint(canon) !== eventFingerprint(e)) {
      stale.push({ id, ledger: e.ledger, indexed: e, canonical: canon });
    }
  }

  // Out-of-order: canonical feed not sorted ascending by ledger.
  const outOfOrder = [];
  for (let i = 1; i < canonical.length; i++) {
    if (canonical[i].ledger < canonical[i - 1].ledger) {
      outOfOrder.push({ id: canonical[i].id, ledger: canonical[i].ledger });
    }
  }

  const ok = missing.length === 0 && stale.length === 0 && duplicates.length === 0;

  return { range: { fromLedger, toLedger }, missing, stale, duplicates, outOfOrder, ok };
}

/**
 * Idempotently repair the index for a bounded ledger range using canonical
 * events. Missing and stale records are upserted; duplicates are collapsed by
 * the primary key. Safe to run repeatedly.
 *
 * @param {Array} canonicalEvents events sourced from the chain
 * @param {{ fromLedger: number, toLedger: number }} range
 * @returns {{ range, repaired: number, inserted: number, updated: number, skipped: number, report }}
 */
function repairEvents(canonicalEvents, { fromLedger, toLedger }) {
  const report = reconcileEvents(canonicalEvents, { fromLedger, toLedger });

  // Build the canonical set to write: missing + stale canonical records.
  const toWrite = new Map();
  for (const e of report.missing) toWrite.set(e.id, e);
  for (const s of report.stale) toWrite.set(s.id, s.canonical);

  let inserted = 0;
  let updated = 0;

  if (toWrite.size) {
    const existing = new Set(
      getEventsInLedgerRange(fromLedger, toLedger).map((e) => e.id)
    );
    const stmt = db.prepare(
      `INSERT INTO events (id, event_type, ledger, timestamp, contract_id, payload)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         event_type = excluded.event_type,
         ledger = excluded.ledger,
         timestamp = excluded.timestamp,
         contract_id = excluded.contract_id,
         payload = excluded.payload`
    );
    for (const e of toWrite.values()) {
      stmt.run([e.id, e.event_type, e.ledger, e.timestamp, e.contract_id, JSON.stringify(e.payload)]);
      if (existing.has(e.id)) updated += 1;
      else inserted += 1;
    }
    stmt.free();
    flush();
  }

  const skipped = report.duplicates.length + report.outOfOrder.length;

  return {
    range: report.range,
    repaired: inserted + updated,
    inserted,
    updated,
    skipped,
    report,
  };
}

module.exports = { initDb, upsertEvents, queryEvents, getLatestLedger, getEventsInLedgerRange, reconcileEvents, repairEvents, insertApiKey, getApiKeyByHash, listApiKeys, revokeApiKey, getConsent, recordConsent, hasConsented, insertIssuerApplication, getIssuerApplication, listIssuerApplications, updateIssuerApplicationStatus };
// ── Patient consent ───────────────────────────────────────────────────────────

function recordConsent(wallet) {
  withTransaction(() => {
    db.run(
      'INSERT OR IGNORE INTO patient_consent (wallet, consented_at) VALUES (?, ?)',
      [wallet, new Date().toISOString()]
    );
  });
}

function getConsent(wallet) {
  const res = db.exec('SELECT wallet, consented_at FROM patient_consent WHERE wallet = ?', [wallet]);
  if (!res.length) return null;
  const { columns, values } = res[0];
  const obj = {};
  columns.forEach((col, i) => { obj[col] = values[0][i]; });
  return obj;
}

function hasConsented(wallet) {
  return !!getConsent(wallet);
}

// ── Issuer onboarding applications ───────────────────────────────────────────

function insertIssuerApplication({ id, wallet, name, license_number, country, submitted_at }) {
  withTransaction(() => {
    db.run(
      `INSERT INTO issuer_applications (id, wallet, name, license_number, country, status, submitted_at)
       VALUES (?,?,?,?,?,'pending',?)`,
      [id, wallet, name, license_number, country, submitted_at]
    );
  });
}

function getIssuerApplication(id) {
  const res = db.exec('SELECT * FROM issuer_applications WHERE id = ?', [id]);
  if (!res.length) return null;
  const { columns, values } = res[0];
  const obj = {};
  columns.forEach((col, i) => { obj[col] = values[0][i]; });
  return obj;
}

function listIssuerApplications({ status } = {}) {
  let sql = 'SELECT * FROM issuer_applications';
  const params = [];
  if (status) { sql += ' WHERE status = ?'; params.push(status); }
  sql += ' ORDER BY submitted_at DESC';
  const res = db.exec(sql, params);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

function updateIssuerApplicationStatus(id, { status, reviewer_note }) {
  withTransaction(() => {
    db.run(
      'UPDATE issuer_applications SET status = ?, reviewed_at = ?, reviewer_note = ? WHERE id = ?',
      [status, new Date().toISOString(), reviewer_note || null, id]
    );
  });
}

module.exports = {
  initDb,
  closeDb,
  withTransaction,
  runMigrations,
  getSchemaVersion,
  upsertEvents,
  queryEvents,
  getLatestLedger,
  isEventProcessed,
  getCheckpoint,
  setCheckpoint,
  recordAudit,
  insertApiKey,
  getApiKeyByHash,
  listApiKeys,
  revokeApiKey,
  getConsent,
  recordConsent,
  hasConsented,
  insertIssuerApplication,
  getIssuerApplication,
  listIssuerApplications,
  updateIssuerApplicationStatus,
};
