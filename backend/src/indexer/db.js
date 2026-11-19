/**
 * SQLite-backed event store using sql.js (pure WASM — no native build required).
 * The DB is loaded from disk on init and flushed to disk after every write.
 */
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

let db = null;
let dbPath = null;

/**
 * Retention policy for off-chain data classes.
 *
 * - indexed_events: raw indexed event rows. Retained for EVENT_RETENTION_DAYS.
 *   Never purged below the last recovery checkpoint ledger (see
 *   `setRecoveryCheckpoint`) so the indexer can always resume/replay.
 * - operational_data: transient operational rows (e.g. revoked API keys).
 *   Retained for OPERATIONAL_RETENTION_DAYS.
 * - audit_logs / patient_consent / issuer_applications: audit, consent and
 *   recovery-critical records. NEVER purged by automated jobs.
 */
const RETENTION_POLICY = Object.freeze({
  indexed_events: { retentionDays: 90, purgeable: true, protectedByCheckpoint: true },
  operational_data: { retentionDays: 30, purgeable: true, protectedByCheckpoint: false },
  audit_logs: { retentionDays: null, purgeable: false },
  patient_consent: { retentionDays: null, purgeable: false },
  issuer_applications: { retentionDays: null, purgeable: false },
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** Ledger sequence below which indexed events must never be purged. */
let recoveryCheckpointLedger = 0;

/** Record the last recovery checkpoint; events at/below it are protected. */
function setRecoveryCheckpoint(ledger) {
  if (typeof ledger === 'number' && ledger > recoveryCheckpointLedger) {
    recoveryCheckpointLedger = ledger;
  }
}

function getRecoveryCheckpoint() {
  return recoveryCheckpointLedger;
}

function getRetentionPolicy() {
  return RETENTION_POLICY;
}

const SCHEMA = `
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
`;

/** Persist in-memory DB to disk. */
function flush() {
  if (!db || !dbPath) return;
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

/** Initialize (or load) the database. */
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

  db.run(SCHEMA);
  flush();
  return db;
}

/**
 * Upsert a batch of events. Deduplicates by id (PRIMARY KEY conflict = ignore).
 * @param {Array<{id, event_type, ledger, timestamp, contract_id, payload}>} events
 */
function upsertEvents(events) {
  if (!events.length) return;
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO events (id, event_type, ledger, timestamp, contract_id, payload) VALUES (?,?,?,?,?,?)'
  );
  for (const e of events) {
    stmt.run([e.id, e.event_type, e.ledger, e.timestamp, e.contract_id, JSON.stringify(e.payload)]);
  }
  stmt.free();
  flush();
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
  db.run(
    'INSERT INTO api_keys (id, key_hash, label, created_at, revoked) VALUES (?,?,?,?,0)',
    [id, key_hash, label, created_at]
  );
  flush();
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
  db.run('UPDATE api_keys SET revoked = 1 WHERE id = ?', [id]);
  flush();
}

// ── Retention / purge jobs ───────────────────────────────────────────────────

/**
 * Delete indexed event rows older than the configured retention period.
 * Rows at or below the recovery checkpoint ledger are always preserved.
 * @param {{ now?: number, retentionDays?: number }} opts
 * @returns {{ deleted: number, cutoff: number, protectedLedger: number }}
 */
function purgeIndexedEvents({ now = Date.now(), retentionDays } = {}) {
  const days = retentionDays != null
    ? retentionDays
    : RETENTION_POLICY.indexed_events.retentionDays;
  const cutoff = now - days * DAY_MS;

  const before = db.exec('SELECT COUNT(*) FROM events')[0].values[0][0];
  db.run(
    'DELETE FROM events WHERE timestamp < ? AND ledger > ?',
    [cutoff, recoveryCheckpointLedger]
  );
  const after = db.exec('SELECT COUNT(*) FROM events')[0].values[0][0];
  flush();
  return { deleted: before - after, cutoff, protectedLedger: recoveryCheckpointLedger };
}

/**
 * Purge transient operational data (revoked API keys older than retention).
 * Audit, consent and issuer records are never touched.
 * @param {{ now?: number, retentionDays?: number }} opts
 * @returns {{ deleted: number, cutoff: number }}
 */
function purgeOperationalData({ now = Date.now(), retentionDays } = {}) {
  const days = retentionDays != null
    ? retentionDays
    : RETENTION_POLICY.operational_data.retentionDays;
  const cutoffIso = new Date(now - days * DAY_MS).toISOString();

  const before = db.exec('SELECT COUNT(*) FROM api_keys')[0].values[0][0];
  db.run(
    'DELETE FROM api_keys WHERE revoked = 1 AND created_at < ?',
    [cutoffIso]
  );
  const after = db.exec('SELECT COUNT(*) FROM api_keys')[0].values[0][0];
  flush();
  return { deleted: before - after, cutoff: now - days * DAY_MS };
}

/**
 * Entry point for the scheduled retention job. Runs all purgeable data-class
 * jobs and returns a per-class summary.
 * @param {{ now?: number }} opts
 */
function runRetentionJobs({ now = Date.now() } = {}) {
  return {
    ranAt: new Date(now).toISOString(),
    indexed_events: purgeIndexedEvents({ now }),
    operational_data: purgeOperationalData({ now }),
  };
}

module.exports = { initDb, upsertEvents, queryEvents, getLatestLedger, insertApiKey, getApiKeyByHash, listApiKeys, revokeApiKey, getConsent, recordConsent, hasConsented, insertIssuerApplication, getIssuerApplication, listIssuerApplications, updateIssuerApplicationStatus, getRetentionPolicy, setRecoveryCheckpoint, getRecoveryCheckpoint, purgeIndexedEvents, purgeOperationalData, runRetentionJobs };

// ── Patient consent ───────────────────────────────────────────────────────────

function recordConsent(wallet) {
  db.run(
    'INSERT OR IGNORE INTO patient_consent (wallet, consented_at) VALUES (?, ?)',
    [wallet, new Date().toISOString()]
  );
  flush();
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
  db.run(
    `INSERT INTO issuer_applications (id, wallet, name, license_number, country, status, submitted_at)
     VALUES (?,?,?,?,?,'pending',?)`,
    [id, wallet, name, license_number, country, submitted_at]
  );
  flush();
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
  db.run(
    'UPDATE issuer_applications SET status = ?, reviewed_at = ?, reviewer_note = ? WHERE id = ?',
    [status, new Date().toISOString(), reviewer_note || null, id]
  );
  flush();
}
