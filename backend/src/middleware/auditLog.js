const fs = require('fs');
const path = require('path');
const db = require('../db');

const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH || path.join(__dirname, '../../audit.log');

/**
 * Append a single audit entry to the append-only NDJSON log file.
 * This is the only write path — there is no update or delete.
 *
 * Kept for backward compatibility; database audit entries are the
 * authoritative, transactionally-committed record.
 */
function writeAuditEntry(entry) {
  const line = JSON.stringify(entry) + '\n';
  // appendFileSync keeps writes atomic enough for a single-process server
  fs.appendFileSync(AUDIT_LOG_PATH, line, 'utf8');
}

/**
 * Insert an audit entry into the database using the supplied client.
 *
 * The caller is responsible for the surrounding transaction (BEGIN/COMMIT/
 * ROLLBACK) so that the audit record commits atomically with the other
 * writes it accompanies. If no client is supplied, a standalone connection
 * is used and the insert is committed on its own.
 *
 * @param {object} entry
 * @param {object} [client] - pg client participating in an existing transaction
 * @returns {Promise<object>} the persisted entry
 */
async function writeAuditEntryTx(entry, client) {
  const sql = `
    INSERT INTO audit_log (timestamp, actor, action, target, result, meta)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, timestamp, actor, action, target, result, meta
  `;
  const params = [
    entry.timestamp,
    entry.actor,
    entry.action,
    entry.target,
    entry.result,
    JSON.stringify(entry.meta || {}),
  ];

  if (client) {
    const { rows } = await client.query(sql, params);
    return rows[0];
  }

  // Standalone: run inside its own transaction so the insert is atomic.
  const ownClient = await db.getClient();
  try {
    await ownClient.query('BEGIN');
    const { rows } = await ownClient.query(sql, params);
    await ownClient.query('COMMIT');
    return rows[0];
  } catch (err) {
    await ownClient.query('ROLLBACK');
    throw err;
  } finally {
    ownClient.release();
  }
}

/**
 * Build and persist an audit log entry.
 *
 * @param {object} opts
 * @param {string} opts.actor   - Stellar public key of the acting wallet
 * @param {string} opts.action  - e.g. 'vaccination.issue', 'auth.login'
 * @param {string} [opts.target] - Subject of the action (patient wallet, etc.)
 * @param {string} opts.result  - 'success' | 'failure'
 * @param {object} [opts.meta]  - Any extra context (token_id, error message, …)
 */
function audit({ actor, action, target = null, result, meta = {} }) {
  const entry = {
    timestamp: new Date().toISOString(),
    actor,
    action,
    target,
    result,
    meta,
  };
  writeAuditEntry(entry);
}

/**
 * Persist an audit entry atomically alongside other writes.
 *
 * When a transaction client is provided, the audit row is inserted using that
 * client so it commits (or rolls back) together with the surrounding
 * multi-step operation. The append-only NDJSON log is still written for
 * backward compatibility, but only after the database insert succeeds so a
 * failed transaction does not leave a phantom file entry.
 *
 * @param {object} opts - same shape as `audit`
 * @param {object} [client] - pg client participating in an existing transaction
 * @returns {Promise<object>} the persisted database entry
 */
async function auditTx({ actor, action, target = null, result, meta = {} }, client) {
  const entry = {
    timestamp: new Date().toISOString(),
    actor,
    action,
    target,
    result,
    meta,
  };
  const persisted = await writeAuditEntryTx(entry, client);
  writeAuditEntry(entry);
  return persisted;
}

/**
 * Read all audit entries, optionally filtered by actor and/or date range.
 *
 * @param {object} filters
 * @param {string} [filters.actor]  - exact wallet match
 * @param {string} [filters.from]   - ISO date string (inclusive)
 * @param {string} [filters.to]     - ISO date string (inclusive)
 * @returns {object[]}
 */
function queryAuditLog({ actor, from, to } = {}) {
  if (!fs.existsSync(AUDIT_LOG_PATH)) return [];

  const fromMs = from ? new Date(from).getTime() : null;
  const toMs   = to   ? new Date(to).getTime()   : null;

  const raw = fs.readFileSync(AUDIT_LOG_PATH, 'utf8');
  const entries = raw
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);

  return entries.filter(e => {
    if (actor && e.actor !== actor) return false;
    const ts = new Date(e.timestamp).getTime();
    if (fromMs && ts < fromMs) return false;
    if (toMs   && ts > toMs)   return false;
    return true;
  });
}

module.exports = { audit, auditTx, writeAuditEntryTx, queryAuditLog };
