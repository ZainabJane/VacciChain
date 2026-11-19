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

let isLeader = false;
let lockRefreshTimer = null;
let leaderRetryTimer = null;
let pollInFlight = false;
let stopping = false;
=======

// Map Soroban symbol_short event topic names to our internal event_type strings
const TOPIC_MAP = {
  minted:  'VaccinationMinted',
  iss_add: 'IssuerAdded',
  iss_rev: 'IssuerRevoked',
};

let timer = null;

function getRpc() {
  return new StellarSdk.SorobanRpc.Server(SOROBAN_RPC_URL);
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

async function poll() {
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
    const startLedger = getLatestLedger() + 1;

    const response = await rpc.getEvents({
      startLedger,
      filters: [{ contractIds: [CONTRACT_ID] }],
    });

    const events = (response.events ?? [])
      .map(parseEvent)
      .filter(Boolean);

    if (events.length) {
      // Re-verify leadership immediately before writing to avoid split-brain
      // writes if the lock was lost while the RPC call was in flight.
      if (!refreshPollerLock(POLLER_ID, LOCK_TTL_MS)) {
        loseLeadership('lock lost before write');
        return;
      }

      upsertEvents(events);
      logInfo(`[indexer] Stored ${events.length} new event(s) from ledger ${startLedger}`);

      // Invalidate issuer cache on relevant events
      for (const e of events) {
        if ((e.event_type === 'IssuerRevoked' || e.event_type === 'IssuerAdded') && e.payload.issuer) {
          invalidateCache(e.payload.issuer);
          logInfo(`[indexer] Invalidated cache for issuer: ${e.payload.issuer}`);
        }
      }
    }
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      console.error('[indexer] Poll error:', err.message);
    }
  } finally {
    pollInFlight = false;
  }
}

/**
 * Start the background polling loop.
 * @param {number} intervalMs
 */
function startPoller(intervalMs) {
  if (timer) return;
  stopping = false;

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
  logInfo(`[indexer] Polling every ${intervalMs}ms`);
}

function stopPoller() {
  stopping = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  releaseLeadership();
}

module.exports = {
  startPoller,
  stopPoller,
  poll,
  parseEvent,
  tryAcquireLeadership,
  releaseLeadership,
  isLeader: () => isLeader,
};
