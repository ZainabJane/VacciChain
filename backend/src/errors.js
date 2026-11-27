/**
 * Standard API error shape (#42) — see docs/api-errors.md.
 *
 *   { "error": "<safe message>", "code": "<STABLE_CODE>", "requestId": "<id>" }
 *
 * `error` stays a string so existing clients keep working; `code` is the
 * stable value clients should branch on. 5xx responses never carry internal
 * details (stack traces, RPC payloads, secrets) — only a generic message.
 */

const ERROR_CODES = Object.freeze({
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  RPC_ERROR: 'RPC_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

const DEFAULT_CODE_BY_STATUS = {
  400: ERROR_CODES.VALIDATION_FAILED,
  401: ERROR_CODES.UNAUTHENTICATED,
  403: ERROR_CODES.FORBIDDEN,
  404: ERROR_CODES.NOT_FOUND,
  429: ERROR_CODES.RATE_LIMITED,
  502: ERROR_CODES.RPC_ERROR,
};

const GENERIC_5XX_MESSAGE = 'Internal Server Error';

/** Error carrying an HTTP status and stable code; its message is safe to return for 4xx. */
class ApiError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function codeForStatus(status) {
  return DEFAULT_CODE_BY_STATUS[status] || (status >= 500 ? ERROR_CODES.INTERNAL_ERROR : ERROR_CODES.VALIDATION_FAILED);
}

/** Build the standard body. For 5xx the message is always replaced with a generic one. */
function errorBody(req, status, code, message, details) {
  const body = {
    error: status >= 500 ? GENERIC_5XX_MESSAGE : message,
    code: code || codeForStatus(status),
    requestId: req?.requestId,
  };
  if (details !== undefined && status < 500) body.details = details;
  return body;
}

function sendError(req, res, status, code, message, details) {
  return res.status(status).json(errorBody(req, status, code, message, details));
}

module.exports = { ERROR_CODES, ApiError, GENERIC_5XX_MESSAGE, codeForStatus, errorBody, sendError };
