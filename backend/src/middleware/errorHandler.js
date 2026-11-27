const logger = require('../logger');
const { errorBody } = require('../errors');

/**
 * Patterns that match sensitive values which must never reach logs.
 * Each entry replaces the matched secret with a redaction marker.
 */
const SENSITIVE_PATTERNS = [
  // JSON Web Tokens (three base64url segments separated by dots)
  {
    regex: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replacement: '[REDACTED_JWT]',
  },
  // Bearer tokens in header-like strings
  {
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
    replacement: 'Bearer [REDACTED_TOKEN]',
  },
  // key=value / key: value pairs for common secret field names
  {
    regex: /\b(secret|secretKey|secret_key|apiKey|api_key|privateKey|private_key|password|passwd|token|accessToken|access_token|refreshToken|refresh_token|authorization)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
    replacement: '$1=[REDACTED]',
  },
  // Signed transaction payloads (hex blobs of 64+ chars)
  {
    regex: /\b0x[0-9a-fA-F]{64,}\b/g,
    replacement: '[REDACTED_SIGNED_PAYLOAD]',
  },
  // Long raw hex blobs (signed payloads without 0x prefix)
  {
    regex: /\b[0-9a-fA-F]{128,}\b/g,
    replacement: '[REDACTED_SIGNED_PAYLOAD]',
  },
];

/**
 * Redact sensitive values (JWTs, secret keys, signed payloads) from a string.
 *
 * @param {unknown} value
 * @returns {unknown} redacted string, or the original value if not a string
 */
function redactSensitive(value) {
  if (typeof value !== 'string') {
    return value;
  }

  let redacted = value;
  for (const { regex, replacement } of SENSITIVE_PATTERNS) {
    redacted = redacted.replace(regex, replacement);
  }
  return redacted;
}

/**
 * Global error handler middleware (#42 — see docs/api-errors.md).
 *
 * Operational errors (statusCode 4xx set on the error object) are returned
 * with their message and stable `code`. Unexpected errors (5xx) log the full
 * stack but only return a generic message, so internals are never exposed.
 *
 * Sensitive values (JWTs, secret keys, signed payloads) are redacted from the
 * logged message and stack. Raw request headers and bodies are never logged.
 *
 * Operational errors (4xx) return their safe message. Unexpected errors
 * (5xx) return a generic message; the full stack is logged server-side and
 * never leaked to the client.
 */
function errorHandler(err, req, res, _next) {
  // express.json() parse failures and body-limit errors carry `status`.
  const raw = Number.isInteger(err.statusCode) ? err.statusCode : err.status;
  const statusCode = Number.isInteger(raw) && raw >= 400 && raw < 600 ? raw : 500;

  logger.error('unhandled error', {
    requestId: req.requestId,
    message: redactSensitive(err.message),
    stack: redactSensitive(err.stack),
    statusCode,
  });

  const code = typeof err.code === 'string' && /^[A-Z_]+$/.test(err.code) ? err.code : undefined;
  res.status(statusCode).json(errorBody(req, statusCode, code, err.message, err.details));
}

module.exports = errorHandler;
module.exports.redactSensitive = redactSensitive;
