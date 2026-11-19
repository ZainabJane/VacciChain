const fs = require('fs');
const path = require('path');

const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH || path.join(__dirname, '../../audit.log');

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
 */
function writeAuditEntry(entry) {
  const line = JSON.stringify(entry) + '\n';
  // appendFileSync keeps writes atomic enough for a single-process server
  fs.appendFileSync(AUDIT_LOG_PATH, line, 'utf8');
}

/**
 * Build and persist an audit log entry.
 *
 * @param {object} opts
 * @param {string} opts.actor   - Stellar public key of the acting wallet
 *                                (or 'system' for automated operations)
 * @param {string} opts.action  - e.g. 'vaccination.issue', 'auth.login',
 *                                'indexer.pause', 'indexer.resume',
 *                                'indexer.reconcile'
 * @param {string} [opts.target] - Subject of the action (patient wallet,
 *                                poller id, reconciled ledger range, …)
 * @param {string} opts.result  - 'success' | 'failure'
 * @param {object} [opts.meta]  - Any extra context (token_id, error message,
 *                                fromLedger, toLedger, repaired, differences, …)
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
 * Read all audit entries, optionally filtered by actor, action and/or date range.
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

module.exports = { audit, queryAuditLog, ACCEPTED_ACTIONS };