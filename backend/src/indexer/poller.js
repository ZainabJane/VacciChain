/**
 * Polls the Soroban RPC for contract events and stores them in SQLite.
 *
 * Soroban RPC: getEvents({ startLedger, filters: [{ contractIds, topics }] })
 * Indexed event types: VaccinationMinted, IssuerAdded, IssuerRevoked
 */
const StellarSdk = require('@stellar/stellar-sdk');
const { upsertEvents, getLatestLedger, checkDatabaseIntegrity } = require('./db');
const { toIndexedMint } = require('../schemas/vaccinationRecord');
const { invalidateCache } = require('../stellar/issuerCache');
const { setGauge } = require('../metrics');
const config = require('../config');


const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const CONTRACT_ID = process.env.VACCINATIONS_CONTRACT_ID;

// Single-writer constraint: only the task holding the poller lock may poll and
// write to the EFS-backed SQLite database. Other tasks stay idle (standby) and
// periodically attempt to acquire the lock so they can take over if the leader
// is replaced or dies.
const POLLER_ID =
  process.env.POLLER_ID ||
  `${process.env.HOSTNAME || 'local'}-${process.pid}`;
const LOCK_TTL_MS = Number(process.env.POLLER_LOCK_TTL_MS) || 30_000;
// Refresh the lock well before it expires to avoid losing leadership spuriously.
const LOCK_REFRESH_MS = Math.max(1_000, Math.floor(LOCK_TTL_MS / 3));
// How often a standby task retries acquiring the lock.
const LEADER_RETRY_MS = Number(process.env.POLLER_LEADER_RETRY_MS) || 5_000;

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

// Map Soroban symbol_short event topic names to our internal event_type strings.
// Versioned symbols (e.g. minted_v1, minted_v2) map to the same internal
// event_type; the version is preserved in the payload as `schema_version`.
const TOPIC_MAP = {
  minted:     'VaccinationMinted',
  minted_v1:  'VaccinationMinted',
  minted_v2:  'VaccinationMinted',
  iss_add:    'IssuerAdded',
  iss_add_v1: 'IssuerAdded',
  iss_add_v2: 'IssuerAdded',
  iss_rev:    'IssuerRevoked',
  iss_rev_v1: 'IssuerRevoked',
  iss_rev_v2: 'IssuerRevoked',
};

// Default schema version for unversioned (legacy) topic symbols.
const DEFAULT_SCHEMA_VERSION = 1;

/** Extract the schema version encoded in a topic symbol, or the default. */
function extractSchemaVersion(topicStr) {
  const match = /_v(\d+)$/.exec(topicStr ?? '');
  return match ? Number(match[1]) : DEFAULT_SCHEMA_VERSION;
}

let timer = null;
let running = false;
let inFlight = null;
let stopped = true;
let lastCommittedLedger = null;

// Retry configuration for lock contention / transient DB failures.
// Multiple backend tasks may poll concurrently; SQLite serialises writers, so
// a contended write surfaces as SQLITE_BUSY. We retry with backoff instead of
// dropping the batch (which would leave gaps in the index).
const MAX_WRITE_RETRIES = Number(process.env.INDEXER_WRITE_RETRIES || 5);
const BASE_RETRY_DELAY_MS = Number(process.env.INDEXER_RETRY_BASE_MS || 100);

function getRpc() {
  return new StellarSdk.SorobanRpc.Server(SOROBAN_RPC_URL);
}

/** Yield control back to the event loop so other handlers are not starved. */
function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Persist a batch of events with retry-on-lock-contention.
 * Returns true if the batch was written, false if it was abandoned.
 */
async function persistEventsWithRetry(events) {
  for (let attempt = 0; attempt <= MAX_WRITE_RETRIES; attempt++) {
    try {
      upsertEvents(events);
      return true;
    } catch (err) {
      const contention = isLockContentionError(err);
      if (!contention || attempt === MAX_WRITE_RETRIES) {
        if (process.env.NODE_ENV !== 'test') {
          console.error(
            `[indexer] Failed to persist ${events.length} event(s) after ${attempt + 1} attempt(s):`,
            err.message
          );
        }
        return false;
      }
      // Exponential backoff with jitter to de-synchronise competing writers.
      const delay = BASE_RETRY_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * BASE_RETRY_DELAY_MS);
      if (process.env.NODE_ENV !== 'test') {
        console.warn(
          `[indexer] Lock contention writing events (attempt ${attempt + 1}/${MAX_WRITE_RETRIES}); retrying in ${delay}ms`
        );
      }
      await sleep(delay);
    }
  }
  return false;
}

/** Log the current schema/migration state so operators can detect drift after failover. */
function logMigrationState() {
  if (process.env.NODE_ENV === 'test') return;
  try {
    const state = getMigrationState();
    console.log(
      `[indexer] DB migration state: version=${state.version} applied=${state.applied} pending=${state.pending}`
    );
    if (state.pending > 0) {
      console.warn(
        `[indexer] ${state.pending} pending migration(s) detected — run migrations before scaling backend tasks`
      );
    }
  } catch (err) {
    console.error('[indexer] Unable to read migration state:', err.message);
  }
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
      if (process.env.NODE_ENV !== 'test') {
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
      payload: event_type === 'VaccinationMinted' ? toIndexedMint(raw.value) : (raw.value ?? {}),
    };

    // Preserve the event schema version so indexers can distinguish payloads
    // emitted before and after contract upgrades.
    parsed.payload.schema_version = extractSchemaVersion(topicStr);

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

function logInfo(...args) {
  if (process.env.NODE_ENV !== 'test') {
    console.log(...args);
  }
}

  // Refuse to process new events if the database failed its integrity check.
  // Never silently initialize an empty replacement database over a corrupt one.
  const integrity = checkDatabaseIntegrity();
  if (!integrity.ok) {
    console.error(
      '[indexer] OPERATOR ALERT: database integrity check failed — refusing to process events. ' +
      'Investigate and repair the index database before restarting the poller. ' +
      `Reason: ${integrity.reason}`
    );
    return;
  }

  const rpc = getRpc();
  const startLedger = getCheckpoint() + 1;

/**
 * Attempt to become the single polling writer.
 * Returns true if this task holds (or just acquired) the lock.
 */
function tryAcquireLeadership() {
  try {
    // Read-only call: safe to retry. The shared client applies bounded
    // timeouts and a retry policy, and classifies exhausted failures.
    response = await getEvents({
      startLedger,
      filters: [{ contractIds: [CONTRACT_ID] }],
    });
  } catch (err) {
    // Do NOT advance the checkpoint on RPC failure — the next poll retries
    // from the same startLedger so no ledger events are silently skipped.
    if (process.env.NODE_ENV !== 'test') {
      const correlationId = err.correlationId || 'n/a';
      const classification = err.classification || 'unknown';
      console.error(
        `[indexer] Poll error (classification=${classification}, correlationId=${correlationId}):`,
        err.message,
      );
    }
  }, LOCK_REFRESH_MS);
  if (lockRefreshTimer.unref) lockRefreshTimer.unref();
}

function stopLockRefresh() {
  if (lockRefreshTimer) {
    clearInterval(lockRefreshTimer);
    lockRefreshTimer = null;
  }
}

  running = true;
  const runStart = Date.now();
  jobStatus.lastRunAt = new Date(runStart).toISOString();
  jobStatus.lastEventCount = 0;
  jobStatus.lastBatchCount = 0;

  try {
    const rpc = getRpc();
    const startLedger = getCheckpoint() + 1;

  // Record successful poll timestamp and latest indexed ledger for SLO alerting
  // (poller lag / data freshness).
  setGauge('indexer_last_successful_poll_timestamp_seconds', Math.floor(Date.now() / 1000));
  setGauge('indexer_latest_indexed_ledger', getLatestLedger());

  if (valid.length) {
    const stored = await persistEventsWithRetry(valid);
    if (!stored) {
      // Do not advance past this batch: the next poll re-reads from the same
      // startLedger so no events are lost when a write is abandoned.
      return;
    }
    jobStatus.lastGetEventsMs = Date.now() - getStart;

    setGauge('indexer_latest_indexed_ledger', getLatestLedger());

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

    jobStatus.lastEventCount = valid.length;

    if (valid.length) {
      let upsertMs = 0;

      // Process events in bounded batches, yielding between batches so the
      // event loop stays responsive for request handlers.
      for (let i = 0; i < valid.length; i += BATCH_SIZE) {
        const batch = valid.slice(i, i + BATCH_SIZE);

        const upsertStart = Date.now();
        try {
          upsertEvents(batch);
        } catch (err) {
          // Persistence failed — leave the checkpoint untouched so events are
          // retried on the next poll instead of being lost.
          jobStatus.errors += 1;
          jobStatus.lastError = err.message;
          jobStatus.lastErrorAt = new Date().toISOString();
          if (process.env.NODE_ENV !== 'test') {
            console.error('[indexer] Persistence error (checkpoint unchanged):', err.message);
          }
          return;
        }
        upsertMs += Date.now() - upsertStart;

        // Invalidate issuer cache on relevant events
        for (const e of batch) {
          if ((e.event_type === 'IssuerRevoked' || e.event_type === 'IssuerAdded') && e.payload.issuer) {
            invalidateCache(e.payload.issuer);
            if (process.env.NODE_ENV !== 'test') {
              console.log(`[indexer] Invalidated cache for issuer: ${e.payload.issuer}`);
            }
          }
        }

        jobStatus.lastBatchCount += 1;

        // Yield to the event loop between batches (skip after the last one).
        if (i + BATCH_SIZE < valid.length) {
          await yieldToEventLoop();
        }
      }

      jobStatus.lastUpsertMs = upsertMs;

      if (process.env.NODE_ENV !== 'test') {
        console.log(`[indexer] Stored ${valid.length} new event(s) from ledger ${startLedger} in ${jobStatus.lastBatchCount} batch(es)`);
      }
    } else {
      jobStatus.lastUpsertMs = 0;
    }

    // Advance the checkpoint only after successful persistence. When malformed
    // events were quarantined we hold the checkpoint so they are re-examined.
    if (malformed === 0 && maxLedger >= startLedger) {
      lastCommittedLedger = maxLedger;
    }

    jobStatus.runs += 1;
  } catch (err) {
    jobStatus.errors += 1;
    jobStatus.lastError = err.message;
    jobStatus.lastErrorAt = new Date().toISOString();
    if (process.env.NODE_ENV !== 'test') {
      console.error('[indexer] Poll error:', err.message);
    }
  } finally {
    jobStatus.lastDurationMs = Date.now() - runStart;
    running = false;
  }
}

/**
 * Run a single poll, tracking the in-flight promise so shutdown can await it.
 * Concurrent calls are coalesced onto the same in-flight promise.
 */
function poll() {
  if (inFlight) return inFlight;
  inFlight = runPoll().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Start the background polling loop.
 * @param {number} intervalMs
 */
function startPoller(intervalMs) {
  if (timer) return;
  stopping = false;
  stopped = false;
  logMigrationState();
  loadCheckpoint();

  // Attempt to become the leader; if another task holds the lock we run as a
  // standby and retry periodically until leadership is available.
  if (!tryAcquireLeadership()) {
    logInfo(
      `[indexer] Not the leader (id=${POLLER_ID}); running in standby, retrying every ${LEADER_RETRY_MS}ms`
    );
    startLeaderRetry();
  }

  poll(); // immediate first run (no-op unless leader)
  timer = setInterval(poll, intervalMs);
  logInfo(`[indexer] Polling every ${intervalMs}ms from ledger ${getCheckpoint()}`);
}

/**
 * Stop the background polling loop and await any in-flight poll.
 * Prevents new polls from starting.
 */
async function stopPoller() {
  stopping = true;
  stopped = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  releaseLeadership();
  if (inFlight) {
    try {
      await inFlight;
    } catch {
      // in-flight errors are already handled inside runPoll
    }
  }
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
  TOPIC_MAP,
  extractSchemaVersion,
  loadCheckpoint,
  getCheckpoint,
  backoffDelay,
  persistEventsWithRetry,
  logMigrationState,
};
