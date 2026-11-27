require('dotenv').config();
const { initializeSecrets } = require('./secrets');
const config = require('./config');
const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const logger = require('./logger');
const { initDb } = require('./indexer/db');
const { startPoller, stopPoller } = require('./indexer/poller');
const swaggerSpec = require('./swagger');

const authRoutes = require('./routes/auth');
const vaccinationRoutes = require('./routes/vaccination');
const verifyRoutes = require('./routes/verify');
const adminRoutes = require('./routes/admin');
const eventsRoutes = require('./routes/events');
const patientRoutes = require('./routes/patient');
const consentRoutes = require('./routes/consent');
const onboardingRoutes = require('./routes/onboarding');
const analyticsProxyRoutes = require('./routes/analyticsProxy');
const apiVersion = require('./middleware/apiVersion');
const securityHeaders = require('./middleware/securityHeaders');
const { getRpcServer } = require('./stellar/soroban');
const { getHealthStatus, getReadinessStatus, startHealthProbe } = require('./health');
const { runStartup, isReady } = require('./startup');

const requestId = require('./middleware/requestId');
const { sanitizeInputs } = require('./middleware/sanitize');
const errorHandler = require('./middleware/errorHandler');

const app = express();
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);

// --- Graceful shutdown / in-flight request tracking -------------------------
const DEFAULT_DRAIN_TIMEOUT_MS = 10000;

let shuttingDown = false;
let inFlightRequests = 0;
let drainResolve = null;
let drainPromise = null;

/**
 * Begin draining: reject new requests with 503 and resolve once all in-flight
 * requests have completed or the timeout expires.
 *
 * @param {number} [timeoutMs] - Maximum time to wait for in-flight requests.
 * @returns {Promise<{drained: boolean, remaining: number}>}
 */
function beginDrain(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS) {
  if (drainPromise) return drainPromise;

  shuttingDown = true;
  logger.info('Draining in-flight requests...', { inFlight: inFlightRequests, timeoutMs });

  drainPromise = new Promise((resolve) => {
    let settled = false;
    const finish = (drained) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      drainResolve = null;
      resolve({ drained, remaining: inFlightRequests });
    };

    const timer = setTimeout(() => {
      logger.warn('Drain timeout reached; remaining requests will be terminated', {
        remaining: inFlightRequests,
      });
      finish(false);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    drainResolve = () => {
      if (inFlightRequests === 0) finish(true);
    };

    // Nothing in flight — resolve immediately.
    if (inFlightRequests === 0) finish(true);
  });

  return drainPromise;
}

/** Whether the app is currently draining / shutting down. */
function isShuttingDown() {
  return shuttingDown;
}

// Registered early so every request (including rejected ones) is accounted for.
app.use((req, res, next) => {
  if (shuttingDown) {
    res.setHeader('Connection', 'close');
    res.setHeader('Retry-After', '5');
    return res.status(503).json({ error: 'Service Unavailable', message: 'Server is shutting down' });
  }

  inFlightRequests += 1;
  let finished = false;
  const onDone = () => {
    if (finished) return;
    finished = true;
    inFlightRequests -= 1;
    if (drainResolve) drainResolve();
  };

  res.on('finish', onDone);
  res.on('close', onDone);

  next();
});
// ---------------------------------------------------------------------------

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  credentials: true,
  optionsSuccessStatus: 204,
}));
app.use(securityHeaders);
app.use(express.json({ limit: config.BODY_LIMIT }));
app.use(requestId);
// Sanitize all string inputs at the API boundary (strips HTML tags, control chars, null bytes)
app.use(sanitizeInputs);

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('request', {
      requestId: req.requestId,
      method: req.method,
      route: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - start,
    });
  });
  next();
});

app.use('/auth', authRoutes);
app.use('/vaccination', vaccinationRoutes);
app.use('/verify', verifyRoutes);
app.use('/admin', adminRoutes);
app.use('/events', eventsRoutes);

// v1 routes — all API endpoints are versioned under /v1/
const v1 = express.Router();
v1.use(apiVersion);
v1.use('/auth', authRoutes);
v1.use('/vaccination', vaccinationRoutes);
v1.use('/verify', verifyRoutes);
v1.use('/admin', adminRoutes);
v1.use('/patient', patientRoutes);
v1.use('/patient', consentRoutes);
v1.use('/events', eventsRoutes);
v1.use('/onboarding', onboardingRoutes);
v1.use('/analytics', analyticsProxyRoutes);
app.use('/v1', v1);

// Legacy unversioned routes — 308 redirect to /v1/ with Deprecation header
app.use(['/auth', '/vaccination', '/verify', '/admin', '/patient', '/events'], (req, res) => {
  res.setHeader('Deprecation', 'true');
  res.redirect(308, `/v1${req.originalUrl}`);
});

// Global error handler — must be registered after all routes
app.use(errorHandler);


/**
 * Health check endpoint.
 *
 * @route GET /health
 * @returns {Object} 200 - { status: "ok", uptime }
 * @returns {Object} 503 - { status: "degraded", uptime }
 */
app.get('/health', async (_req, res) => {
  const body = { ...getHealthStatus(), ready: isReady() };
  if (!body.ready) {
    body.status = 'degraded';
  }
  res.status(body.status === 'ok' ? 200 : 503).json(body);
});

/**
 * Readiness check endpoint for ECS container health checks and target groups.
 *
 * Returns 200 only when all dependencies (database, secrets, poller) are ready;
 * otherwise 503 so the task is removed from traffic without masking crashes.
 *
 * @route GET /ready
 * @returns {Object} 200 - { status: "ready", checks: {...} }
 * @returns {Object} 503 - { status: "not_ready", checks: {...} }
 */
app.get('/ready', async (_req, res) => {
  const body = getReadinessStatus();
  res.status(body.status === 'ready' ? 200 : 503).json(body);
});

if (require.main === module) {
  runStartup()
    .then(() => {
      startHealthProbe();
      const server = app.listen(config.PORT, () => {
        logger.info(`Backend running on port ${config.PORT}`);
      });

      const gracefulShutdown = (signal) => {
        logger.info(`${signal} received. Starting graceful shutdown...`);

        stopPoller();

        server.close(() => {
          logger.info('Http server closed.');
          process.exit(0);
        });

        // Force exit after 10 seconds
        setTimeout(() => {
          logger.error('Could not close connections in time, forcefully shutting down');
          process.exit(1);
        }, 10000);
      };

      process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
      process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    })
    .catch((error) => {
      logger.error('Startup failed', {
        step: error && error.step,
        code: error && error.code,
        message: error && error.message,
      });
      process.exit(1);
    });
}

module.exports = app;
module.exports.beginDrain = beginDrain;
module.exports.isShuttingDown = isShuttingDown;
module.exports.getInFlightCount = () => inFlightRequests;
