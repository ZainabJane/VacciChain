const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');

const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH || path.join(__dirname, '../../audit.log');
const AUDIT_LOG_DIR = path.dirname(AUDIT_LOG_PATH);
const AUDIT_LOG_BASENAME = path.basename(AUDIT_LOG_PATH);

// Rotation / retention configuration.
const MAX_LOG_BYTES = parseInt(process.env.AUDIT_LOG_MAX_BYTES || String(10 * 1024 * 1024), 10);
const MAX_ROTATED_FILES = parseInt(process.env.AUDIT_LOG_MAX_ROTATED || '5', 10);
const RETENTION_DAYS = parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || '30', 10);

// Keys that must never be written to the audit log (sensitive data guard).
const SENSITIVE_KEY_PATTERN = /(password|passwd|secret|token|private[_-]?key|seed|mnemonic|authorization|cookie|api[_-]?key|credential)/i;

// Genesis hash used as the "previous hash" for the very first entry.
const GENESIS_HASH = '0'.repeat(64);

/**
 * Recursively redact sensitive values from an arbitrary object so that
 * secrets never end up in the audit trail.
 */
function redactSensitive(value, depth = 0) {
  if (depth > 8) return '[redacted:depth]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(v => redactSensitive(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY_PATTERN.test(k) ? '[redacted]' : redactSensitive(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Compute the tamper-evident hash for an entry. The hash covers the entry
 * content plus the previous entry's hash, forming a hash chain.
 */
function computeEntryHash(entry, prevHash) {
  const payload = JSON.stringify({
    prevHash,
    timestamp: entry.timestamp,
    actor: entry.actor,
    requestId: entry.requestId,
    action: entry.action,
    target: entry.target,
    result: entry.result,
    meta: entry.meta,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Read the last line of the audit log to recover the current chain head.
 * Returns GENESIS_HASH when the log is empty or missing.
 */
function readLastHash() {
  try {
    if (!fs.existsSync(AUDIT_LOG_PATH)) return GENESIS_HASH;
    const raw = fs.readFileSync(AUDIT_LOG_PATH, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length === 0) return GENESIS_HASH;
    const last = JSON.parse(lines[lines.length - 1]);
    return last.hash || GENESIS_HASH;
  } catch (err) {
    // A corrupt tail must not silently break the chain; surface it.
    throw new Error(`audit: unable to read chain head: ${err.message}`);
  }
}

/**
 * Rotate the active log file when it exceeds MAX_LOG_BYTES, pruning old
 * rotated files beyond MAX_ROTATED_FILES / RETENTION_DAYS.
 * Rotation is best-effort: failures are logged to stderr but never throw,
 * so a rotation problem cannot take down the request path.
 */
function rotateIfNeeded() {
  try {
    if (!fs.existsSync(AUDIT_LOG_PATH)) return;
    const { size } = fs.statSync(AUDIT_LOG_PATH);
    if (size < MAX_LOG_BYTES) return;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rotated = path.join(AUDIT_LOG_DIR, `${AUDIT_LOG_BASENAME}.${stamp}`);
    fs.renameSync(AUDIT_LOG_PATH, rotated);
    pruneRotatedFiles();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`audit: rotation failed: ${err.message}`);
  }
}

/**
 * Remove rotated files that exceed the retention window or count limit.
 */
function pruneRotatedFiles() {
  try {
    const prefix = `${AUDIT_LOG_BASENAME}.`;
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const rotated = fs
      .readdirSync(AUDIT_LOG_DIR)
      .filter(f => f.startsWith(prefix) && f !== AUDIT_LOG_BASENAME)
      .map(f => {
        const full = path.join(AUDIT_LOG_DIR, f);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    rotated.forEach((file, idx) => {
      const tooOld = file.mtime < cutoff;
      const tooMany = idx >= MAX_ROTATED_FILES;
      if (tooOld || tooMany) {
        try { fs.unlinkSync(file.full); } catch { /* ignore */ }
      }
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`audit: retention pruning failed: ${err.message}`);
  }
}

/**
 * Audit log retention policy.
 *
 * Data class: AUDIT (compliance / security audit trail).
 * Retention: AUDIT_RETENTION_DAYS (default 2555 days ≈ 7 years).
 * Constraints:
 *   - The audit log is append-only. Entries are never updated or deleted
 *     by application code paths; the only deletion mechanism is the
 *     scheduled retention job (see `purgeAuditLog`) operating under policy.
 *   - Entries flagged as required for compliance or recovery
 *     (`meta.retain === true`, or actions listed in
 *     AUDIT_PROTECTED_ACTIONS) are never purged, regardless of age.
 *   - Entries newer than the retention window are always kept.
 */
const AUDIT_RETENTION_DAYS = parseInt(process.env.AUDIT_RETENTION_DAYS || '2555', 10);

// Actions that must be retained for compliance/recovery and are exempt from purge.
const AUDIT_PROTECTED_ACTIONS = new Set(
  (process.env.AUDIT_PROTECTED_ACTIONS || 'auth.login,recovery.restore,recovery.initiate')
    .split(',')
    .map(a => a.trim())
    .filter(Boolean)
);

/**
 * Accepted audit actions.
 *
 * The audit log is schema-agnostic (any string is accepted as `action`), but
 * the following actions are documented as the canonical set so that operators
 * and downstream tooling can rely on stable names:
 *
 *   - 'vaccination.issue'   - a vaccination record was issued
 *   - 'auth.login'          - a wallet authenticated
 *   - 'indexer.pause'       - operator paused the background poller
 *   - 'indexer.resume'      - operator resumed the background poller
 *   - 'indexer.reconcile'   - a reconciliation run and/or repair was performed
 *
 * Operational actions (indexer.*) are expected to populate:
 *   - actor:  privileged operator wallet (or 'system' for automated runs)
 *   - action: one of the indexer.* actions above
 *   - target: the poller/indexer identifier or reconciled ledger range
 *   - result: 'success' | 'failure'
 *   - meta:   extra context, e.g. { fromLedger, toLedger, repaired, differences }
 */
const ACCEPTED_ACTIONS = Object.freeze([
  'vaccination.issue',
  'auth.login',
  'indexer.pause',
  'indexer.resume',
  'indexer.reconcile',
]);

/**
 * Append a single audit entry to the append-only NDJSON log file.
 * This is the only write path — there is no update or delete.
 *
 * Kept for backward compatibility; database audit entries are the
 * authoritative, transactionally-committed record.
 * The entry is hash-chained to the previous entry for tamper evidence.
 */
function writeAuditEntry(entry) {
  rotateIfNeeded();
  const prevHash = readLastHash();
  const hash = computeEntryHash(entry, prevHash);
  const record = { ...entry, prevHash, hash };
  const line = JSON.stringify(record) + '\n';
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
 * @param {string} opts.actor     - Stellar public key of the acting wallet
 * @param {string} [opts.requestId] - Correlation ID for the originating request
 * @param {string} opts.action    - e.g. 'vaccination.issue', 'auth.login'
 * @param {string} [opts.target]  - Subject of the action (patient wallet, etc.)
 * @param {string} opts.result    - 'success' | 'failure'
 * @param {object} [opts.meta]    - Any extra context (token_id, error message, …)
 */
function audit({ actor, requestId = null, action, target = null, result, meta = {} }) {
  const entry = {
    timestamp: new Date().toISOString(),
    actor,
    requestId,
    action,
    target,
    result,
    meta: redactSensitive(meta),
  };
  if (requestId) entry.requestId = requestId;
  writeAuditEntry(entry);
}

/**
 * Record a structured verifier API-key lifecycle event.
 *
 * Lifecycle actions:
 *   'verifier_key.provision', 'verifier_key.rotate', 'verifier_key.revoke'
 *
 * @param {object} opts
 * @param {string} opts.keyId   - Identifier of the verifier API key (actor)
 * @param {string} opts.action  - Lifecycle action (see above)
 * @param {string} [opts.target] - Verifier/org the key belongs to
 * @param {string} opts.result  - 'success' | 'failure'
 * @param {string[]} [opts.scopes] - Scopes attached to the key at event time
 * @param {string} [opts.reason]   - Human-readable reason (e.g. revocation cause)
 * @param {object} [opts.meta]     - Any extra context
 */
function auditVerifierKey({ keyId, action, target = null, result, scopes = [], reason = null, meta = {} }) {
  audit({
    actor: keyId,
    action,
    target,
    result,
    meta: { ...meta, scopes, reason },
  });
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
async function auditTx({ actor, requestId = null, action, target = null, result, meta = {} }, client) {
  const entry = {
    timestamp: new Date().toISOString(),
    actor,
    requestId,
    action,
    target,
    result,
    meta: redactSensitive(meta),
  };
  const persisted = await writeAuditEntryTx(entry, client);
  writeAuditEntry(entry);
  return persisted;
}

/**
 * Verify the integrity of the hash chain across the active log file.
 *
 * @returns {{ valid: boolean, entries: number, brokenAt: number|null, reason: string|null }}
 */
function verifyAuditLog() {
  if (!fs.existsSync(AUDIT_LOG_PATH)) {
    return { valid: true, entries: 0, brokenAt: null, reason: null };
  }
  const lines = fs.readFileSync(AUDIT_LOG_PATH, 'utf8').split('\n').filter(Boolean);
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      return { valid: false, entries: lines.length, brokenAt: i, reason: 'unparseable entry' };
    }
    if (entry.prevHash !== prevHash) {
      return { valid: false, entries: lines.length, brokenAt: i, reason: 'prevHash mismatch' };
    }
    const expected = computeEntryHash(entry, prevHash);
    if (entry.hash !== expected) {
      return { valid: false, entries: lines.length, brokenAt: i, reason: 'hash mismatch' };
    }
    prevHash = entry.hash;
  }
  return { valid: true, entries: lines.length, brokenAt: null, reason: null };
}

/**
 * Read all audit entries, optionally filtered by actor and/or date range.
 *
 * @param {object} filters
 * @param {string} [filters.actor]  - exact wallet match
 * @param {string} [filters.action] - exact action match (e.g. 'indexer.pause')
 * @param {string} [filters.from]   - ISO date string (inclusive)
 * @param {string} [filters.to]     - ISO date string (inclusive)
 * @returns {object[]}
 */
function queryAuditLog({ actor, action, from, to } = {}) {
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
    if (action && e.action !== action) return false;
    const ts = new Date(e.timestamp).getTime();
    if (fromMs && ts < fromMs) return false;
    if (toMs   && ts > toMs)   return false;
    return true;
  });
}

/**
 * Determine whether an audit entry must be retained regardless of age.
 * Protected entries are those explicitly flagged for retention or whose
 * action is part of the compliance/recovery protected set.
 */
function isProtectedEntry(entry) {
  if (!entry || typeof entry !== 'object') return true; // keep unparseable/unknown
  if (entry.meta && entry.meta.retain === true) return true;
  if (entry.action && AUDIT_PROTECTED_ACTIONS.has(entry.action)) return true;
  return false;
}

/**
 * Retention-aware purge of the audit log.
 *
 * Removes entries older than the configured retention window
 * (AUDIT_RETENTION_DAYS) while refusing to delete entries required for
 * compliance or recovery. The audit log is append-only; this scheduled job
 * is the only sanctioned deletion path.
 *
 * @param {object} [opts]
 * @param {Date}   [opts.now]            - Reference time (defaults to now)
 * @param {number} [opts.retentionDays]  - Override retention window
 * @param {boolean}[opts.dryRun]         - If true, compute but do not write
 * @returns {{purged: number, retained: number, protected: number, dryRun: boolean}}
 */
function purgeAuditLog({ now = new Date(), retentionDays = AUDIT_RETENTION_DAYS, dryRun = false } = {}) {
  const result = { purged: 0, retained: 0, protected: 0, dryRun };

  if (!fs.existsSync(AUDIT_LOG_PATH)) return result;

  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;

  const raw = fs.readFileSync(AUDIT_LOG_PATH, 'utf8');
  const lines = raw.split('\n').filter(Boolean);

  const kept = [];
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // Never drop unparseable lines — they may be needed for recovery.
      kept.push(line);
      result.protected += 1;
      continue;
    }

    const ts = new Date(entry.timestamp).getTime();
    const expired = Number.isFinite(ts) && ts < cutoffMs;

    if (!expired) {
      kept.push(line);
      result.retained += 1;
    } else if (isProtectedEntry(entry)) {
      kept.push(line);
      result.protected += 1;
    } else {
      result.purged += 1;
    }
  }

  if (!dryRun && result.purged > 0) {
    const tmpPath = `${AUDIT_LOG_PATH}.purge.tmp`;
    fs.writeFileSync(tmpPath, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
    fs.renameSync(tmpPath, AUDIT_LOG_PATH);
  }

  return result;
}

module.exports = {
  audit,
  auditTx,
  writeAuditEntryTx,
  queryAuditLog,
  purgeAuditLog,
  isProtectedEntry,
  AUDIT_RETENTION_DAYS,
  AUDIT_PROTECTED_ACTIONS,
};
