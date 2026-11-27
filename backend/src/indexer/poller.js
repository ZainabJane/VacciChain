/**
 * Polls the Soroban RPC for contract events and stores them in SQLite.
 *
 * Soroban RPC: getEvents({ startLedger, filters: [{ contractIds, topics }] })
 * Indexed event types: VaccinationMinted, IssuerAdded, IssuerRevoked
 */
const StellarSdk = require('@stellar/stellar-sdk');
const { upsertEvents, getLatestLedger } = require('./db');
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

async function runPoll() {
  if (!CONTRACT_ID) {
    if (process.env.NODE_ENV !== 'test') {
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
    } catch (err) {
      // Persistence failed — leave the checkpoint untouched so events are
      // retried on the next poll instead of being lost.
      if (process.env.NODE_ENV !== 'test') {
        console.error('[indexer] Persistence error (checkpoint unchanged):', err.message);
      }
      return;
    }

    if (process.env.NODE_ENV !== 'test') {
      console.log(`[indexer] Stored ${valid.length} new event(s) from ledger ${startLedger}`);
    }

    // Invalidate issuer cache on relevant events
    for (const e of valid) {
      if ((e.event_type === 'IssuerRevoked' || e.event_type === 'IssuerAdded') && e.payload.issuer) {
        invalidateCache(e.payload.issuer);
        if (process.env.NODE_ENV !== 'test') {
          console.log(`[indexer] Invalidated cache for issuer: ${e.payload.issuer}`);
        }
      }
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
 * Start the background polling loop.
 * @param {number} intervalMs
 */
function startPoller(intervalMs) {
  if (timer) return;
  stopped = false;
  loadCheckpoint();
  poll(); // immediate first run
  timer = setInterval(() => {
    if (!stopped) poll();
  }, intervalMs);
  if (process.env.NODE_ENV !== 'test') {
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
  loadCheckpoint,
  getCheckpoint,
  backoffDelay,
};
