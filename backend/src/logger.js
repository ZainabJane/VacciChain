const { createLogger, format, transports } = require('winston');
const { AsyncLocalStorage } = require('async_hooks');

const isProd = process.env.NODE_ENV === 'production';

// Async-local storage holding the per-request context (e.g. correlation ID).
// Consumers can run work inside `requestContext.run({ correlationId }, fn)`
// so that any log emitted within that scope automatically carries the ID.
const requestContext = new AsyncLocalStorage();

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: !isProd }),
    format.json()
  ),
  defaultMeta: { service: 'backend' },
  transports: [new transports.Console()],
});

// Mixin reads the current async-local request context (if any) and merges the
// correlation identifier into every log entry's metadata.
logger.mixin = () => {
  const store = requestContext.getStore();
  if (store && store.correlationId) {
    return { correlationId: store.correlationId };
  }
  return {};
};

// Expose the context so callers (e.g. Stellar retry/exhaustion logging) can
// bind a correlation ID to the current async execution scope.
logger.requestContext = requestContext;

// Convenience helper to run a function within a correlation-ID scope.
logger.withCorrelationId = (correlationId, fn) =>
  requestContext.run({ correlationId }, fn);

module.exports = logger;