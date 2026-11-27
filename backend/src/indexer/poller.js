/**
 * Polls the Soroban RPC for contract events and stores them in SQLite.
 *
 * Soroban RPC: getEvents({ startLedger, filters: [{ contractIds, topics }] })
 * Indexed event types: VaccinationMinted, IssuerAdded, IssuerRevoked
 */
const StellarSdk = require('@stellar/stellar-sdk');
const {
  upsertEvents,
  getLatestLedger,
  getEventsInLedgerRange,
  deleteEventsByIds,
  recordAuditEvent,
} = require('./db');
const { invalidateCache } = require('../stellar/issuerCache');
const config = require('../config');


const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const CONTRACT_ID = process.env.VACCINATIONS_CONTRACT_ID;

// Bounded exponential backoff for transient RPC failures.
const RPC_MAX_RETRIES = Number.isFinite(config.SOROBAN_RPC_MAX_RETRIES)
  ? config.SOROBAN_RPC_MAX_RETRIES
  : 5;
const RPC_BACKOFF_BASE_MS = Number.isFinite(config.SOROBAN_RPC_BACKOFF_BASE_MS)
  ? config.SOROBAN_RPC_BACKOFF_BASE_MS
  : 250;
const RPC_BACKOFF_MAX_MS = Number.isFinite(config.SOROBAN_RPC_BACKOFF_MAX_MS)
  ? config.SOROBAN_RPC_BACKOFF_MAX_MS
  : 30_000;

// Map Soroban symbol_short event topic names to our internal event_type strings
const TOPIC_MAP = {
  minted:  'VaccinationMinted',
  iss_add: 'IssuerAdded',
  iss_rev: 'IssuerRevoked',
};

let timer = null;
let inFlight = null;
let stopped = true;
let lastCommittedLedger = null;

// Operational state for the background poller, exposed via getPollerStatus().
const pollerState = {
  running: false,
  paused: false,
  lastProcessedLedger: null,
  lastPollAt: null,
  lastError: null,
  intervalMs: null,
};

function getRpc() {
  return new StellarSdk.SorobanRpc.Server(SOROBAN_RPC_URL);
}

function isTest() {
  return process.env.NODE_ENV === 'test';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Compute bounded exponential backoff delay for a given attempt (0-based). */
function backoffDelay(attempt) {
  const delay = RPC_BACKOFF_BASE_MS * Math.pow(2, attempt);
  return Math.min(delay, RPC_BACKOFF_MAX_MS);
}

/**
 * Load the last committed checkpoint from storage. Falls back to 0 when no
 * checkpoint exists yet. Called on startup so restarts resume correctly.
 */
function loadCheckpoint() {
  const latest = getLatestLedger();
  lastCommittedLedger = Number.isFinite(latest) ? latest : 0;
  return lastCommittedLedger;
}

function getCheckpoint() {
  if (lastCommittedLedger === null) loadCheckpoint();
  return lastCommittedLedger;
}

/**
 * Call getEvents with bounded exponential backoff on transient failures.
 * Throws the last error once retries are exhausted.
 */
async function fetchEventsWithRetry(rpc, params) {
  let lastErr;
  for (let attempt = 0; attempt <= RPC_MAX_RETRIES; attempt++) {
    try {
      return await rpc.getEvents(params);
    } catch (err) {
      lastErr = err;
      if (attempt === RPC_MAX_RETRIES) break;
      const delay = backoffDelay(attempt);
      if (!isTest()) {
        console.warn(
          `[indexer] getEvents failed (attempt ${attempt + 1}/${RPC_MAX_RETRIES + 1}): ${err.message} — retrying in ${delay}ms`
        );
      }
      await sleep(delay);
    }
  }
  throw lastErr;
}

/** Parse a raw Soroban event into our storage shape. Returns null if unrecognised. */
function parseEvent(raw) {
  try {
    const topicVal = raw.topic?.[0];
    if (!topicVal) return null;

    // topic[0] is a ScVal symbol — extract the string value
    const topicStr = topicVal.value?.toString?.() ?? topicVal.toString();
    const event_type = TOPIC_MAP[topicStr];
    if (!event_type) return null;

    const parsed = {
      id: raw.id,
      event_type,
      ledger: raw.ledger,
      timestamp: raw.ledgerClosedAt
        ? Math.floor(new Date(raw.ledgerClosedAt).getTime() / 1000)
        : 0,
      contract_id: raw.contractId ?? CONTRACT_ID,
      payload: raw.value ?? {},
    };

    // Extract issuer address from topics for IssuerAdded/Revoked events
    if (parsed.event_type === 'IssuerAdded' || parsed.event_type === 'IssuerRevoked') {
      const issuerScVal = raw.topic?.[1];
      if (issuerScVal) {
        parsed.payload.issuer = StellarSdk.scValToNative(issuerScVal);
      }
    }

    return parsed;

  } catch {
    return null;
  }
}

async function poll() {
  if (pollerState.paused) {
    if (!isTest()) {
      console.log('[indexer] Poll skipped — poller is paused');
    }
    return;
  }

  await runPoll();
}

async function runPoll() {
  if (!CONTRACT_ID) {
    if (!isTest()) {
      console.warn('[indexer] VACCINATIONS_CONTRACT_ID not set — skipping poll');
    }
    return;
  }

  const rpc = getRpc();
  const startLedger = getCheckpoint() + 1;

  let response;
  try {
    response = await fetchEventsWithRetry(rpc, {
      startLedger,
      filters: [{ contractIds: [CONTRACT_ID] }],
    });
  } catch (err) {
    // Do NOT advance the checkpoint on RPC failure — the next poll retries
    // from the same startLedger so no ledger events are silently skipped.
    if (process.env.NODE_ENV !== 'test') {
      console.error('[indexer] Poll error (checkpoint unchanged):', err.message);
    }
    return;
  }

  const rawEvents = response.events ?? [];

  // Validate and quarantine malformed payloads. Malformed events are dropped
  // from persistence but the checkpoint is NOT advanced past them, so they are
  // re-examined on the next poll rather than silently skipped.
  const valid = [];
  const seenIds = new Set();
  let malformed = 0;
  let maxLedger = startLedger - 1;

  for (const raw of rawEvents) {
    if (Number.isFinite(raw?.ledger) && raw.ledger > maxLedger) {
      maxLedger = raw.ledger;
    }
    const parsed = parseEvent(raw);
    if (!parsed || !parsed.id) {
      malformed++;
      continue;
    }
    if (seenIds.has(parsed.id)) continue; // dedupe duplicate delivery
    seenIds.add(parsed.id);
    valid.push(parsed);
  }

  if (malformed > 0 && process.env.NODE_ENV !== 'test') {
    console.warn(`[indexer] Quarantined ${malformed} malformed event(s) at ledger ${startLedger}`);
  }

  if (valid.length) {
    try {
      upsertEvents(valid);
      if (!isTest()) {
        console.log(`[indexer] Stored ${valid.length} new event(s) from ledger ${startLedger}`);
      }
    } catch (err) {
      // Persistence failed — leave the checkpoint untouched so events are
      // retried on the next poll instead of being lost.
      if (process.env.NODE_ENV !== 'test') {
        console.error('[indexer] Persistence error (checkpoint unchanged):', err.message);
      }
      return;
    }

    if (!isTest()) {
      console.log(`[indexer] Stored ${valid.length} new event(s) from ledger ${startLedger}`);
    }

    // Invalidate issuer cache on relevant events
    for (const e of valid) {
      if ((e.event_type === 'IssuerRevoked' || e.event_type === 'IssuerAdded') && e.payload.issuer) {
        invalidateCache(e.payload.issuer);
        if (!isTest()) {
          console.log(`[indexer] Invalidated cache for issuer: ${e.payload.issuer}`);
        }
      }
    }

    // Track progress even when no events were returned.
    const latest = getLatestLedger();
    pollerState.lastProcessedLedger = latest;
    pollerState.lastPollAt = Date.now();
    pollerState.lastError = null;
  } catch (err) {
    pollerState.lastError = err.message;
    pollerState.lastPollAt = Date.now();
    if (!isTest()) {
      console.error('[indexer] Poll error:', err.message);
    }
  }

  // Advance the checkpoint only after successful persistence. When malformed
  // events were quarantined we hold the checkpoint so they are re-examined.
  if (malformed === 0 && maxLedger >= startLedger) {
    lastCommittedLedger = maxLedger;
  }
}

/**
 * Run a single poll, tracking the in-flight promise so shutdown can await it.
 * Concurrent calls are coalesced onto the same in-flight promise.
 */
function poll() {
  if (stopped && timer === null && inFlight === null) {
    // Allow explicit one-off polls (e.g. tests) even when the loop is stopped.
  }
  if (inFlight) return inFlight;
  inFlight = runPoll().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Fetch a bounded ledger range of contract events from Soroban RPC.
 * @param {number} fromLedger inclusive
 * @param {number} toLedger inclusive
 * @returns {Promise<Array>} parsed events
 */
async function fetchLedgerRange(fromLedger, toLedger) {
  if (!CONTRACT_ID) {
    throw new Error('VACCINATIONS_CONTRACT_ID not set — cannot reconcile');
  }
  if (!Number.isInteger(fromLedger) || !Number.isInteger(toLedger)) {
    throw new Error('fromLedger and toLedger must be integers');
  }
  if (fromLedger < 1 || toLedger < fromLedger) {
    throw new Error('Invalid ledger range');
  }

  const rpc = getRpc();
  const response = await rpc.getEvents({
    startLedger: fromLedger,
    endLedger: toLedger,
    filters: [{ contractIds: [CONTRACT_ID] }],
  });

  return (response.events ?? [])
    .map(parseEvent)
    .filter(Boolean)
    .filter((e) => e.ledger >= fromLedger && e.ledger <= toLedger);
}

/**
 * Compare a bounded ledger range against persisted indexed events and emit
 * actionable differences. Optionally applies idempotent repairs.
 *
 * Differences reported:
 *  - missing:   on-chain event not present in the index
 *  - duplicate: same event id persisted more than once
 *  - stale:     indexed event in range that no longer exists on-chain
 *
 * @param {object} opts
 * @param {number} opts.fromLedger inclusive
 * @param {number} opts.toLedger inclusive
 * @param {boolean} [opts.repair=false] apply idempotent repairs
 * @param {string} [opts.actor='system'] actor recorded in audit events
 * @returns {Promise<object>} reconciliation report
 */
async function reconcileLedgerRange(opts = {}) {
  const { fromLedger, toLedger, repair = false, actor = 'system' } = opts;

  const chainEvents = await fetchLedgerRange(fromLedger, toLedger);
  const indexedEvents = getEventsInLedgerRange(fromLedger, toLedger);

  const chainById = new Map();
  for (const e of chainEvents) {
    chainById.set(e.id, e);
  }

  const indexedById = new Map();
  const duplicateIds = new Set();
  for (const e of indexedEvents) {
    if (indexedById.has(e.id)) {
      duplicateIds.add(e.id);
    } else {
      indexedById.set(e.id, e);
    }
  }

  const missing = [];
  for (const [id, e] of chainById) {
    if (!indexedById.has(id)) missing.push(e);
  }

  const stale = [];
  for (const [id, e] of indexedById) {
    if (!chainById.has(id)) stale.push(e);
  }

  const duplicates = [];
  for (const id of duplicateIds) {
    const rows = indexedEvents.filter((e) => e.id === id);
    duplicates.push({ id, count: rows.length, ledger: rows[0].ledger });
  }

  const report = {
    fromLedger,
    toLedger,
    chainCount: chainEvents.length,
    indexedCount: indexedEvents.length,
    missing,
    duplicates,
    stale,
    repaired: false,
    repairedCount: 0,
  };

  const hasDifferences = missing.length || duplicates.length || stale.length;

  if (hasDifferences && !isTest()) {
    console.warn(
      `[indexer] Reconciliation differences in ledgers ${fromLedger}-${toLedger}: ` +
        `${missing.length} missing, ${duplicates.length} duplicate, ${stale.length} stale`
    );
  }

  if (repair && hasDifferences) {
    // Idempotent repair: re-upsert missing events (upsert is keyed by id) and
    // remove stale / duplicate rows. Running this repeatedly converges.
    let repairedCount = 0;

    if (missing.length) {
      upsertEvents(missing);
      repairedCount += missing.length;
    }

    const staleIds = stale.map((e) => e.id);
    if (staleIds.length) {
      deleteEventsByIds(staleIds);
      repairedCount += staleIds.length;
    }

    // Duplicates are collapsed by re-upserting the canonical chain event.
    const duplicateCanonical = duplicates
      .map((d) => chainById.get(d.id))
      .filter(Boolean);
    if (duplicateCanonical.length) {
      upsertEvents(duplicateCanonical);
      repairedCount += duplicateCanonical.length;
    }

    // Invalidate issuer cache for repaired issuer events.
    for (const e of [...missing, ...duplicateCanonical]) {
      if ((e.event_type === 'IssuerRevoked' || e.event_type === 'IssuerAdded') && e.payload?.issuer) {
        invalidateCache(e.payload.issuer);
      }
    }

    report.repaired = true;
    report.repairedCount = repairedCount;

    recordAuditEvent({
      action: 'indexer.reconcile.repair',
      actor,
      details: {
        fromLedger,
        toLedger,
        missing: missing.length,
        duplicates: duplicates.length,
        stale: stale.length,
        repairedCount,
      },
    });

    if (!isTest()) {
      console.log(
        `[indexer] Reconciliation repair applied for ledgers ${fromLedger}-${toLedger}: ` +
          `${repairedCount} record(s) repaired`
      );
    }
  } else if (hasDifferences) {
    recordAuditEvent({
      action: 'indexer.reconcile.detect',
      actor,
      details: {
        fromLedger,
        toLedger,
        missing: missing.length,
        duplicates: duplicates.length,
        stale: stale.length,
      },
    });
  }

  return report;
}

/**
 * Operational status snapshot for the poller.
 * @returns {object}
 */
function getPollerStatus() {
  const latestLedger = getLatestLedger();
  const lag =
    pollerState.lastProcessedLedger != null
      ? Math.max(0, latestLedger - pollerState.lastProcessedLedger)
      : null;

  return {
    running: pollerState.running,
    paused: pollerState.paused,
    intervalMs: pollerState.intervalMs,
    lastProcessedLedger: pollerState.lastProcessedLedger,
    latestLedger,
    lag,
    lastPollAt: pollerState.lastPollAt,
    lastError: pollerState.lastError,
  };
}

/**
 * Pause the poller. Subsequent polls are skipped until resumed.
 * @param {string} [actor='system']
 */
function pausePoller(actor = 'system') {
  if (pollerState.paused) return getPollerStatus();
  pollerState.paused = true;
  recordAuditEvent({ action: 'indexer.poller.pause', actor, details: {} });
  if (!isTest()) console.log('[indexer] Poller paused');
  return getPollerStatus();
}

/**
 * Resume the poller.
 * @param {string} [actor='system']
 */
function resumePoller(actor = 'system') {
  if (!pollerState.paused) return getPollerStatus();
  pollerState.paused = false;
  recordAuditEvent({ action: 'indexer.poller.resume', actor, details: {} });
  if (!isTest()) console.log('[indexer] Poller resumed');
  return getPollerStatus();
}

/**
 * Start the background polling loop.
 * @param {number} intervalMs
 */
function startPoller(intervalMs) {
  if (timer) return;
  pollerState.running = true;
  pollerState.intervalMs = intervalMs;
  stopped = false;
  loadCheckpoint();
  poll(); // immediate first run
  timer = setInterval(() => {
    if (!stopped) poll();
  }, intervalMs);
  if (!isTest()) {
    console.log(`[indexer] Polling every ${intervalMs}ms from ledger ${getCheckpoint()}`);
  }
}

/**
 * Stop the background polling loop and await any in-flight poll.
 * Prevents new polls from starting.
 */
async function stopPoller() {
  stopped = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (inFlight) {
    try {
      await inFlight;
    } catch {
      // in-flight errors are already handled inside runPoll
    }
  }

  pollerState.running = false;
}

// Register a shutdown hook so the poller stops cleanly during deploys.
if (typeof process !== 'undefined' && typeof process.on === 'function') {
  const shutdown = () => {
    stopPoller().catch(() => {});
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
module.exports = {
  startPoller,
  stopPoller,
  poll,
  parseEvent,
  reconcileLedgerRange,
  fetchLedgerRange,
  getPollerStatus,
  pausePoller,
  resumePoller,
  loadCheckpoint,
  getCheckpoint,
  backoffDelay,
};
