'use strict';

const http = require('http');
const config = require('./config');
const logger = require('./logger');
const { createApp } = require('./app');
const { createDatabase } = require('./db');
const { createPoller } = require('./poller');

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

module.exports = { main, createShutdownCoordinator };