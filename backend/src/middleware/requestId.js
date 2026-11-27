const { randomUUID } = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const asyncLocalStorage = new AsyncLocalStorage();

const MAX_REQUEST_ID_LENGTH = 128;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:\-]+$/;

function sanitizeRequestId(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_REQUEST_ID_LENGTH) {
    return null;
  }
  if (!REQUEST_ID_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function getLogger() {
  try {
    // Route logging through the redaction-aware logger so sensitive values
    // (JWTs, secret keys, signed payloads) never reach log records.
    return require('../lib/logger');
  } catch (err) {
    return null;
  }
}

// Accept only well-formed, bounded request IDs from clients. Anything else is
// replaced with a freshly generated UUID so that untrusted input cannot inject
// control characters, forge log correlation, or bloat audit records.
const MAX_REQUEST_ID_LENGTH = 128;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

function isValidRequestId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_REQUEST_ID_LENGTH &&
    REQUEST_ID_PATTERN.test(value)
  );
}

function normalizeHeaderValue(value) {
  // Node may surface repeated headers as an array; only accept a single value.
  if (Array.isArray(value)) {
    return value.length === 1 ? value[0] : undefined;
  }
  return value;
}

module.exports = function requestId(req, res, next) {
  const incoming = sanitizeRequestId(req.headers['x-request-id']);
  const id = incoming || randomUUID();
  req.requestId = id;
  req.id = id;

  // Echo the sanitized ID back so clients can correlate their requests.
  res.setHeader('X-Request-ID', id);

  const logger = getLogger();
  if (logger && typeof logger.debug === 'function') {
    try {
      logger.debug({ requestId: id }, 'request received');
    } catch (err) {
      // Logging must never break request handling.
    }
  }

  next();
};

module.exports.sanitizeRequestId = sanitizeRequestId;
module.exports.MAX_REQUEST_ID_LENGTH = MAX_REQUEST_ID_LENGTH;
