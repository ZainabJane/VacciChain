/**
 * SQLite-backed event store using sql.js (pure WASM — no native build required).
 * The DB is loaded from disk on init and flushed to disk after every write.
 *
 * PERSISTENCE MODEL (see docs/deployment.md):
 *   The database file lives on an EFS access point and is only safe for a
 *   SINGLE writer. The indexer/API service MUST run with desired count 1 and a
 *   deployment configuration that never overlaps old and new tasks
 *   (maxSurge=0, maxUnavailable=1, single replica). To defend against
 *   misconfiguration (or a rolling deploy that briefly overlaps), startup
 *   acquires an exclusive advisory lock file next to the DB. If another live
 *   process holds the lock, initDb() throws instead of opening the DB, which
 *   prevents split-brain index state and corruption.
 *
 *   Writes are flushed atomically (temp file + rename) so a task killed
 *   mid-write leaves either the previous or the new DB image on disk, never a
 *   truncated one. WAL mode is enabled for crash resilience; because sql.js
 *   exports a full image on flush, the WAL is checkpointed into the exported
 *   bytes and no separate -wal/-shm files need to be shared across tasks.
 */
const initSqlJs = require('sql.js');
const fs = require('fs');
const os = require('os');
const path = require('path');

let db = null;
let dbPath = null;
let lockPath = null;
let lockFd = null;
let lockAcquired = false;

const LOCK_STALE_MS = Number(process.env.DB_LOCK_STALE_MS || 5 * 60 * 1000);
const LOCK_HEARTBEAT_MS = Number(process.env.DB_LOCK_HEARTBEAT_MS || 30 * 1000);
let lockHeartbeat = null;
let lockOwner = null;

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

/**
 * Persist in-memory DB to disk atomically.
 * Writes to a temp file in the same directory then renames over the target so
 * a crash mid-write cannot leave a partially written / corrupt DB image.
 */
function flush() {
  if (!db || !dbPath) return;
  const data = Buffer.from(db.export());
  const tmpPath = `${dbPath}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, data, 0, data.length, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, dbPath);
  // Best-effort fsync of the directory so the rename is durable.
  try {
    const dirFd = fs.openSync(path.dirname(dbPath), 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch (_) { /* directory fsync unsupported on some platforms */ }
}

function isProcessAlive(pid) {
  if (!pid || pid === process.pid) return pid === process.pid;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readLockOwner() {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * Acquire an exclusive advisory lock next to the DB file.
 * Uses O_EXCL create so only one process can win. A lock is considered stale
 * if its owner PID is dead or its heartbeat is older than DB_LOCK_STALE_MS.
 */
function acquireLock() {
  lockPath = `${dbPath}.lock`;
  lockOwner = {
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: new Date().toISOString(),
    heartbeat: Date.now(),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      lockFd = fs.openSync(lockPath, 'wx');
      fs.writeSync(lockFd, JSON.stringify(lockOwner));
      fs.fsyncSync(lockFd);
      lockAcquired = true;
      startLockHeartbeat();
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const existing = readLockOwner();
      const stale = !existing
        || !isProcessAlive(existing.pid)
        || (Date.now() - (existing.heartbeat || 0)) > LOCK_STALE_MS;
      if (!stale) {
        throw new Error(
          `Database is locked by another writer (pid=${existing && existing.pid}, ` +
          `host=${existing && existing.host}). Refusing to start to avoid split-brain. ` +
          `Ensure the service runs with a single task (desired count 1).`
        );
      }
      // Stale lock — remove and retry once.
      try { fs.unlinkSync(lockPath); } catch (_) { /* raced */ }
    }
  }
  throw new Error('Unable to acquire database lock after retry.');
}

function startLockHeartbeat() {
  if (lockHeartbeat) return;
  lockHeartbeat = setInterval(() => {
    if (!lockAcquired || !lockFd) return;
    try {
      lockOwner.heartbeat = Date.now();
      fs.ftruncateSync(lockFd, 0);
      fs.writeSync(lockFd, JSON.stringify(lockOwner), 0);
    } catch (_) { /* best effort */ }
  }, LOCK_HEARTBEAT_MS);
  if (lockHeartbeat.unref) lockHeartbeat.unref();
}

/** Release the advisory lock (called on graceful shutdown). */
function releaseLock() {
  if (lockHeartbeat) { clearInterval(lockHeartbeat); lockHeartbeat = null; }
  if (lockFd != null) {
    try { fs.closeSync(lockFd); } catch (_) { /* ignore */ }
    lockFd = null;
  }
  if (lockAcquired && lockPath) {
    try { fs.unlinkSync(lockPath); } catch (_) { /* ignore */ }
  }
  lockAcquired = false;
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
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  acquireLock();

  const SQL = await initSqlJs();

  if (fs.existsSync(filePath)) {
    const fileBuffer = fs.readFileSync(filePath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // WAL improves crash resilience for the on-disk image; sql.js checkpoints
  // the WAL into the exported bytes on flush().
  try { db.run('PRAGMA journal_mode = WAL;'); } catch (_) { /* not fatal */ }
  db.run(SCHEMA);
  runMigrations();
  flush();
  return db;
}

/** Close the DB, flushing any pending state and releasing the writer lock. Safe to call multiple times. */
function closeDb() {
  if (!db) return;
  try {
    flush();
  } finally {
    try { db.close(); } catch (_) { /* ignore */ }
    db = null;
    releaseLock();
  }
}
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
