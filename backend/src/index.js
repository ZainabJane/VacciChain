'use strict';

const http = require('http');
const config = require('./config');
const logger = require('./logger');
const secrets = require('./secrets');
const database = require('./database');
const poller = require('./poller');
const { createApp } = require('./app');
const { createDatabase } = require('./db');
const { createPoller } = require('./poller');

/**
 * Readiness state. Remains false until all required initialization steps
 * have completed successfully.
 */
let ready = false;

/**
 * Returns whether the service has completed all required initialization steps.
 * @returns {boolean}
 */
function isReady() {
  return ready === true;
}

/**
 * Sanitizes an error into a structured, secret-free diagnostic.
 * @param {string} step - Name of the initialization step.
 * @param {Error|*} err - The error that occurred.
 * @returns {{step: string, name: string, message: string, code: (string|number|null)}}
 */
function sanitizeError(step, err) {
  const safe = {
    step: String(step),
    name: 'Error',
    message: 'Initialization failed',
    code: null,
  };

  if (err && typeof err === 'object') {
    if (typeof err.name === 'string' && err.name.length > 0) {
      safe.name = err.name;
    }
    if (typeof err.message === 'string' && err.message.length > 0) {
      safe.message = err.message;
    }
    if (typeof err.code === 'string' || typeof err.code === 'number') {
      safe.code = err.code;
    }
  } else if (typeof err === 'string' && err.length > 0) {
    safe.message = err;
  }

  return safe;
}

/**
 * Runs a single initialization step, capturing failures as structured
 * diagnostics rather than throwing.
 * @param {string} name - Step name.
 * @param {Function} fn - Step function (may be async).
 * @returns {Promise<{ok: boolean, step: string, error?: object}>}
 */
async function runStep(name, fn) {
  try {
    await fn();
    logger.info({ step: name }, 'Startup step succeeded');
    return { ok: true, step: name };
  } catch (err) {
    const diagnostic = sanitizeError(name, err);
    logger.error({ diagnostic }, 'Startup step failed');
    return { ok: false, step: name, error: diagnostic };
  }
}

/**
 * Ordered list of required initialization steps.
 * Each entry has a name and an async function.
 */
function getRequiredSteps() {
  return [
    {
      name: 'config',
      run: async () => {
        if (typeof config.validate === 'function') {
          config.validate();
        } else if (typeof config.load === 'function') {
          await config.load();
        }
      },
    },
    {
      name: 'secrets',
      run: async () => {
        if (typeof secrets.initialize === 'function') {
          await secrets.initialize();
        } else if (typeof secrets.load === 'function') {
          await secrets.load();
        }
      },
    },
    {
      name: 'database',
      run: async () => {
        if (typeof database.connect === 'function') {
          await database.connect();
        } else if (typeof database.initialize === 'function') {
          await database.initialize();
        }
      },
    },
    {
      name: 'poller',
      run: async () => {
        if (typeof poller.start === 'function') {
          await poller.start();
        } else if (typeof poller.initialize === 'function') {
          await poller.initialize();
        }
      },
    },
  ];
}

/**
 * Runs all required initialization steps in order. Sets readiness to true
 * only after every step succeeds. On failure, logs a sanitized structured
 * diagnostic and exits the process with a non-zero code.
 *
 * @param {Object} [options]
 * @param {Function} [options.exit] - Exit function (defaults to process.exit).
 * @param {Array} [options.steps] - Override steps (for testing).
 * @returns {Promise<{ok: boolean, diagnostics: Array}>}
 */
async function runStartup(options = {}) {
  const exit = typeof options.exit === 'function' ? options.exit : process.exit;
  const steps = Array.isArray(options.steps) ? options.steps : getRequiredSteps();

  ready = false;

  const diagnostics = [];

  for (const step of steps) {
    const result = await runStep(step.name, step.run);
    if (!result.ok) {
      diagnostics.push(result.error);
      const summary = {
        event: 'startup_failed',
        failedStep: result.step,
        diagnostics,
      };
      logger.error(summary, 'Startup failed; exiting with non-zero code');
      ready = false;
      exit(1);
      return { ok: false, diagnostics };
    }
  }

  ready = true;
  logger.info({ event: 'startup_complete' }, 'All startup steps succeeded; service ready');
  return { ok: true, diagnostics };
}

/**
 * Shutdown coordinator.
 *
 * Responsibilities:
 *  - Flip the server into "draining" mode so new requests are rejected with 503.
 *  - Wait for in-flight requests to finish, bounded by SHUTDOWN_TIMEOUT_MS.
 *  - Stop the poller.
 *  - Close the database.
 *  - Close the HTTP server and exit the process.
 *
 * The order is defined and idempotent: multiple signals only trigger one shutdown.
 */
function createShutdownCoordinator({ server, poller, db, timeoutMs, log = logger }) {
  let shuttingDown = false;
  let finished = false;
  let inFlight = 0;
  let drainTimer = null;
  let resolveDrained = null;
  const drained = new Promise((resolve) => {
    resolveDrained = resolve;
  });

  function trackRequest(req, res) {
    inFlight += 1;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      inFlight -= 1;
      if (inFlight <= 0) {
        resolveDrained();
      }
    };
    res.on('finish', done);
    res.on('close', done);
  }

  function isShuttingDown() {
    return shuttingDown;
  }

  function rejectNewRequests(req, res) {
    if (!shuttingDown) return false;
    if (res.headersSent) return false;
    res.statusCode = 503;
    res.setHeader('Connection', 'close');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Server is shutting down' }));
    return true;
  }

  async function shutdown(signal) {
    if (shuttingDown) {
      log.info({ signal }, 'Shutdown already in progress');
      return;
    }
    shuttingDown = true;
    log.info({ signal, inFlight }, 'Shutdown initiated, draining in-flight requests');

    // 1. Stop accepting new requests: the drain middleware rejects them with 503.
    //    Wait for in-flight requests, bounded by the timeout.
    if (inFlight > 0) {
      drainTimer = setTimeout(() => {
        log.warn({ inFlight }, 'Shutdown timeout reached, failing remaining in-flight requests');
        resolveDrained();
      }, timeoutMs);
      if (drainTimer.unref) drainTimer.unref();
      await drained;
    }
    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }
    log.info({ inFlight }, 'In-flight requests drained');

    // 2. Stop the poller.
    if (poller && typeof poller.stop === 'function') {
      try {
        await poller.stop();
        log.info('Poller stopped');
      } catch (err) {
        log.error({ err }, 'Error stopping poller');
      }
    }

    // 3. Close the database.
    if (db && typeof db.close === 'function') {
      try {
        await db.close();
        log.info('Database closed');
      } catch (err) {
        log.error({ err }, 'Error closing database');
      }
    }

    // 4. Close the HTTP server.
    await new Promise((resolve) => {
      if (!server || typeof server.close !== 'function') {
        resolve();
        return;
      }
      server.close(() => {
        log.info('HTTP server closed');
        resolve();
      });
      // Force-close lingering keep-alive connections.
      if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
      }
    });

    finished = true;
    log.info('Shutdown complete');
  }

  function isFinished() {
    return finished;
  }

  return {
    shutdown,
    trackRequest,
    isShuttingDown,
    rejectNewRequests,
    isFinished,
  };
}

function main() {
  const db = createDatabase(config);
  const poller = createPoller({ config, db, logger });

  const app = createApp({ config, db, logger });

  const server = http.createServer(app);

  const coordinator = createShutdownCoordinator({
    server,
    poller,
    db,
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    log: logger,
  });

  // Drain middleware: reject new requests once shutdown has begun.
  server.on('request', (req, res) => {
    if (coordinator.rejectNewRequests(req, res)) return;
    coordinator.trackRequest(req, res);
  });

  let exiting = false;
  const handleSignal = (signal) => {
    if (exiting) return;
    exiting = true;
    coordinator
      .shutdown(signal)
      .catch((err) => {
        logger.error({ err }, 'Error during shutdown');
      })
      .finally(() => {
        process.exit(0);
      });
  };

  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));

  server.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, 'Server listening');
    if (poller && typeof poller.start === 'function') {
      poller.start();
    }
  });

  return { server, poller, db, coordinator };
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  createShutdownCoordinator,
  runStartup,
  isReady,
  sanitizeError,
  getRequiredSteps,
};
