const config = require('./config');
const { getRpcServer } = require('./stellar/soroban');
const logger = require('./logger');
const { getDatabaseIntegrityStatus } = require('./db/integrity');

let sorobanHealthy = true;
let databaseHealthy = true;
let lastProbeAt = null;
let lastProbeDurationMs = null;
let lastProbeError = null;
let probeSuccessCount = 0;
let probeFailureCount = 0;
let dbInitialized = false;

function getHealthStatus() {
  const status = sorobanHealthy ? 'ok' : 'degraded';
  const dbIntegrity = getDatabaseIntegrityStatus();
  return {
    status: 'ok',
    uptime: Number(process.uptime().toFixed(3)),
    database: dbIntegrity.status,
    soroban: {
      healthy: sorobanHealthy,
      lastProbeAt: lastProbeAt ? lastProbeAt.toISOString() : null,
      lastProbeTimestamp: lastProbeAt ? lastProbeAt.getTime() : null,
      lastProbeDurationMs,
      lastProbeError,
      probeSuccessCount,
      probeFailureCount,
    },
  };
}

function getHealthMetrics() {
  // Structured metrics suitable for scraping by a metrics collector.
  // Exposes gauges for probe success/failure and last probe timestamp,
  // plus counters that support latency and error-rate SLIs.
  return {
    timestamp: new Date().toISOString(),
    gauges: {
      soroban_probe_healthy: sorobanHealthy ? 1 : 0,
      soroban_probe_last_timestamp_seconds: lastProbeAt
        ? Number((lastProbeAt.getTime() / 1000).toFixed(3))
        : 0,
      soroban_probe_last_duration_ms: lastProbeDurationMs === null ? 0 : lastProbeDurationMs,
    },
    counters: {
      soroban_probe_success_total: probeSuccessCount,
      soroban_probe_failure_total: probeFailureCount,
    },
  };
}

function redactProbeError(error) {
  // Only surface a coarse, non-sensitive classification of the failure.
  // Never log raw error messages, codes, or payloads that may contain secrets.
  if (!error) {
    return { reason: 'unknown' };
  }
  return { reason: 'probe_failed' };
}

function getReadinessStatus() {
  const ready = databaseHealthy && sorobanHealthy;
  return {
    status: ready ? 'ok' : 'degraded',
    ready,
    dependencies: {
      database: databaseHealthy,
      sorobanRpc: sorobanHealthy,
    },
    checks: {
      db: dbInitialized ? 'ok' : 'unavailable',
      soroban: sorobanHealthy ? 'ok' : 'unavailable',
    },
    uptime: Number(process.uptime().toFixed(3)),
    lastProbeAt: lastProbeAt ? lastProbeAt.toISOString() : null,
  };
}

/**
 * Backwards-compatible aggregate health status. Reports 'ok' only when all
 * required dependencies are healthy.
 */
function getHealthStatus() {
  return getReadinessStatus();
}

async function probeSorobanHealth() {
  const startedAt = Date.now();
  try {
    await getRpcServer().getHealth();
    sorobanHealthy = true;
    lastProbeError = null;
    probeSuccessCount += 1;
  } catch (error) {
    sorobanHealthy = false;
    lastProbeError = error.message || String(error);
    probeFailureCount += 1;
    logger.warn('Soroban health probe failed', redactProbeError(error));
  } finally {
    lastProbeDurationMs = Date.now() - startedAt;
    lastProbeAt = new Date();
  }
}

async function probeDatabaseHealth() {
  try {
    // Lazy-require to avoid a hard dependency at module load time and to keep
    // the probe resilient if the DB module is unavailable.
    const db = require('./db');
    if (db && typeof db.healthCheck === 'function') {
      await db.healthCheck();
    } else if (db && typeof db.query === 'function') {
      await db.query('SELECT 1');
    }
    databaseHealthy = true;
  } catch (error) {
    databaseHealthy = false;
    logger.warn('Database health probe failed', {
      message: error.message,
      code: error.code,
    });
  } finally {
    lastProbeAt = new Date();
  }
}

async function probeDependencies() {
  await Promise.all([
    probeSorobanHealth(),
    probeDatabaseHealth(),
  ]);
}

function startHealthProbe() {
  // Run an initial probe immediately, then refresh at the configured interval.
  probeSorobanHealth().catch((error) => {
    logger.error('Initial Soroban health probe failed', redactProbeError(error));
  });

  const interval = setInterval(() => {
    probeSorobanHealth().catch((error) => {
      logger.error('Soroban health probe failed', redactProbeError(error));
    });
  }, config.HEALTH_POLL_INTERVAL_MS);

  return () => clearInterval(interval);
}

function setSorobanHealthy(value) {
  sorobanHealthy = value;
  lastProbeAt = new Date();
}

function setDatabaseHealthy(value) {
  databaseHealthy = value;
  lastProbeAt = new Date();
}

function setDbInitialized(value) {
  dbInitialized = Boolean(value);
}

module.exports = {
  getHealthStatus,
  getHealthMetrics,
  getReadinessStatus,
  getHealthStatus,
  startHealthProbe,
  setSorobanHealthy,
  setDatabaseHealthy,
  setDbInitialized,
  _getLastProbeAt: () => lastProbeAt,
};