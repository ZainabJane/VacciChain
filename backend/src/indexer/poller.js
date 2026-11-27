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
  acquirePollerLock,
  releasePollerLock,
  refreshPollerLock,
} = require('./db');
const { invalidateCache } = require('../stellar/issuerCache');
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

let isLeader = false;
let lockRefreshTimer = null;
let leaderRetryTimer = null;
let pollInFlight = false;
let stopping = false;

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

function getRpc() {
  return new StellarSdk.SorobanRpc.Server(SOROBAN_RPC_URL);
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

function logInfo(...args) {
  if (process.env.NODE_ENV !== 'test') {
    console.log(...args);
  }
}

function logWarn(...args) {
  if (process.env.NODE_ENV !== 'test') {
    console.warn(...args);
  }
}

/**
 * Attempt to become the single polling writer.
 * Returns true if this task holds (or just acquired) the lock.
 */
function tryAcquireLeadership() {
  try {
    const acquired = acquirePollerLock(POLLER_ID, LOCK_TTL_MS);
    if (acquired && !isLeader) {
      isLeader = true;
      logInfo(`[indexer] Acquired poller lock as leader (id=${POLLER_ID})`);
      startLockRefresh();
      stopLeaderRetry();
    }
    return isLeader;
  } catch (err) {
    logWarn('[indexer] Failed to acquire poller lock:', err.message);
    return false;
  }
}

function startLockRefresh() {
  if (lockRefreshTimer) return;
  lockRefreshTimer = setInterval(() => {
    try {
      const stillLeader = refreshPollerLock(POLLER_ID, LOCK_TTL_MS);
      if (!stillLeader && isLeader) {
        loseLeadership('lock refresh failed');
      }
    } catch (err) {
      logWarn('[indexer] Poller lock refresh error:', err.message);
      loseLeadership('lock refresh error');
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

function startLeaderRetry() {
  if (leaderRetryTimer || stopping) return;
  leaderRetryTimer = setInterval(() => {
    if (!isLeader) tryAcquireLeadership();
  }, LEADER_RETRY_MS);
  if (leaderRetryTimer.unref) leaderRetryTimer.unref();
}

function stopLeaderRetry() {
  if (leaderRetryTimer) {
    clearInterval(leaderRetryTimer);
    leaderRetryTimer = null;
  }
}

function loseLeadership(reason) {
  if (!isLeader) return;
  isLeader = false;
  stopLockRefresh();
  logWarn(`[indexer] Lost poller leadership (${reason}); entering standby mode`);
  startLeaderRetry();
}

/**
 * Release leadership on shutdown so a replacement task can take over quickly.
 */
function releaseLeadership() {
  stopLockRefresh();
  stopLeaderRetry();
  if (isLeader) {
    try {
      releasePollerLock(POLLER_ID);
      logInfo(`[indexer] Released poller lock (id=${POLLER_ID})`);
    } catch (err) {
      logWarn('[indexer] Failed to release poller lock:', err.message);
    }
  }
  isLeader = false;
}

async function runPoll() {
  if (!CONTRACT_ID) {
    logWarn('[indexer] VACCINATIONS_CONTRACT_ID not set — skipping poll');
    return;
  }

  // Respect the single-writer constraint: only the leader may poll and write.
  if (!isLeader && !tryAcquireLeadership()) {
    logInfo(`[indexer] Not the leader (id=${POLLER_ID}) — skipping poll`);
    return;
  }

  // Guard against overlapping polls within the same task.
  if (pollInFlight) {
    logInfo('[indexer] Previous poll still in flight — skipping this tick');
    return;
  }
  pollInFlight = true;

  try {
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
      // Re-verify leadership immediately before writing to avoid split-brain
      // writes if the lock was lost while the RPC call was in flight.
      if (!refreshPollerLock(POLLER_ID, LOCK_TTL_MS)) {
        loseLeadership('lock lost before write');
        return;
      }

      try {
        upsertEvents(valid);
      } catch (err) {
        // Persistence failed — leave the checkpoint untouched so events are
        // retried on the next poll instead of being lost.
        if (process.env.NODE_ENV !== 'test') {
          console.error('[indexer] Persistence error (checkpoint unchanged):', err.message);
        }
        return;
      }

      logInfo(`[indexer] Stored ${valid.length} new event(s) from ledger ${startLedger}`);

      // Invalidate issuer cache on relevant events
      for (const e of valid) {
        if ((e.event_type === 'IssuerRevoked' || e.event_type === 'IssuerAdded') && e.payload.issuer) {
          invalidateCache(e.payload.issuer);
          logInfo(`[indexer] Invalidated cache for issuer: ${e.payload.issuer}`);
        }
      }
    }

    // Advance the checkpoint only after successful persistence. When malformed
    // events were quarantined we hold the checkpoint so they are re-examined.
    if (malformed === 0 && maxLedger >= startLedger) {
      lastCommittedLedger = maxLedger;
    }
  } finally {
    pollInFlight = false;
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
  tryAcquireLeadership,
  releaseLeadership,
  isLeader: () => isLeader,
  loadCheckpoint,
  getCheckpoint,
  backoffDelay,
};
