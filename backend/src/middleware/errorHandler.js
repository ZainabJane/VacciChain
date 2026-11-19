const logger = require('../logger');

/**
 * Global error handler middleware.
 *
 * Operational errors (statusCode 4xx set on the error object) are returned
 * with their message. Unexpected errors (5xx) log the full stack but only
 * return a generic message so internals are never exposed in production.
 *
 * Validation and payload-size failures are normalized to a stable shape:
 *   { error, details?, requestId }
 *
 * @param {Error} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} _next
 */
function errorHandler(err, req, res, _next) {
  // Normalize the status code, defaulting to 500 for anything unexpected.
  let statusCode = Number.isInteger(err.statusCode) && err.statusCode >= 400 && err.statusCode < 600
    ? err.statusCode
    : 500;

  let message = err.message;
  let details;

  // --- Zod validation errors -> 400 with { error, details } ---
  if (err && (err.name === 'ZodError' || Array.isArray(err.issues))) {
    statusCode = 400;
    message = 'Validation failed';
    details = Array.isArray(err.issues)
      ? err.issues.map((issue) => ({
        path: Array.isArray(issue.path) ? issue.path.join('.') : issue.path,
        message: issue.message,
        code: issue.code,
      }))
      : undefined;
  }

  // --- body-parser payload-too-large -> 413 ---
  if (err && (err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE')) {
    statusCode = 413;
    message = 'Payload Too Large';
  }

  // --- body-parser malformed / unsupported body -> 400 ---
  if (err && (err.type === 'entity.parse.failed' || err.type === 'encoding.unsupported' || err.type === 'charset.unsupported')) {
    statusCode = 400;
    message = 'Malformed request body';
  }

  // --- body-parser unsupported media type -> 415 ---
  if (err && err.type === 'entity.verify.failed') {
    statusCode = 400;
    message = 'Invalid request body';
  }

  // --- Explicit payload/limit violations -> 413 ---
  if (err && (err.code === 'PAYLOAD_TOO_LARGE' || err.code === 'LIMIT_EXCEEDED')) {
    statusCode = 413;
    message = message || 'Payload Too Large';
  }

  // --- Semantic validation failures (oversized arrays/strings, range, nesting) -> 422 ---
  if (err && (err.code === 'VALIDATION_FAILED' || err.code === 'UNPROCESSABLE_ENTITY')) {
    statusCode = 422;
    message = message || 'Unprocessable Entity';
    if (err.details !== undefined) {
      details = err.details;
    }
  }

  const isOperational = statusCode >= 400 && statusCode < 500;

  logger.error('unhandled error', {
    requestId: req.requestId,
    message: err && err.message,
    stack: err && err.stack,
    statusCode,
  });

  const body = {
    error: isOperational ? message : 'Internal Server Error',
    requestId: req.requestId,
  };

  if (isOperational && details !== undefined) {
    body.details = details;
  }

  res.status(statusCode).json(body);
}

module.exports = errorHandler;