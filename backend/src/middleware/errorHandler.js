const logger = require('../logger');

/**
 * Global error handler middleware.
 *
 * Operational errors (statusCode 4xx set on the error object) are returned
 * with their message. Unexpected errors (5xx) log the full stack but only
 * return a generic message so internals are never exposed in production.
 *
 * The request ID (validated/generated upstream) is always included in the
 * response body and in structured logs so operators can trace failures.
 *
 * @param {Error} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} _next
 */
function errorHandler(err, req, res, _next) {
  const statusCode = Number.isInteger(err.statusCode) && err.statusCode >= 400 && err.statusCode < 600
    ? err.statusCode
    : 500;

  const isOperational = statusCode >= 400 && statusCode < 500;

  const requestId = req.requestId;

  // Prefer a request-scoped logger (which already carries the requestId) when
  // available; otherwise fall back to the shared logger with explicit context.
  const log = req.logger && typeof req.logger.error === 'function' ? req.logger : logger;

  log.error('unhandled error', {
    requestId,
    message: err.message,
    stack: err.stack,
    statusCode,
  });

  // Only expose the message for operational (4xx) errors. Unexpected errors
  // return a generic message so stack traces and internals never leak.
  const body = {
    error: isOperational ? err.message : 'Internal Server Error',
    requestId,
  };

  // Expose the request ID as a response header as well, for client-side tracing.
  if (requestId) {
    res.setHeader('X-Request-Id', requestId);
  }

  res.status(statusCode).json(body);
}

module.exports = errorHandler;