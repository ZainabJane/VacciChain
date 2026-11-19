const config = require('./config');
const { getRpcServer } = require('./stellar/soroban');
const logger = require('./logger');

let sorobanHealthy = true;
let lastProbeAt = null;
let lastProbeDurationMs = null;
let lastProbeError = null;
let probeSuccessCount = 0;
let probeFailureCount = 0;

function getHealthStatus() {
  const status = sorobanHealthy ? 'ok' : 'degraded';
  return {
    status,
    uptime: Number(process.uptime().toFixed(3)),
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
    logger.warn('Soroban health probe failed', {
      message: error.message,
      code: error.code,
    });
  } finally {
    lastProbeDurationMs = Date.now() - startedAt;
    lastProbeAt = new Date();
  }
}

function startHealthProbe() {
  // Run an initial probe immediately, then refresh at the configured interval.
  probeSorobanHealth().catch((error) => {
    logger.error('Initial Soroban health probe failed', { message: error.message });
  });

  const interval = setInterval(() => {
    probeSorobanHealth().catch((error) => {
      logger.error('Soroban health probe failed', { message: error.message });
    });
  }, config.HEALTH_POLL_INTERVAL_MS);

  return () => clearInterval(interval);
}

function setSorobanHealthy(value) {
  sorobanHealthy = value;
  lastProbeAt = new Date();
}

module.exports = {
  getHealthStatus,
  getHealthMetrics,
  startHealthProbe,
  setSorobanHealthy,
  _getLastProbeAt: () => lastProbeAt,
};