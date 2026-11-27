/**
 * errors — standardized API error representation (#42).
 *
 * AppError carries a stable, client-safe `code` plus an HTTP status and an
 * optional safe `message`. Stack traces and internal details are never
 * included in the response body; they are logged server-side by the global
 * error handler.
 */

class AppError extends Error {
  /**
   * @param {string} code        Stable machine-readable error code (e.g. 'validation_failed')
   * @param {string} message     Client-safe human-readable message
   * @param {number} statusCode  HTTP status code (4xx by default)
   */
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = { AppError };
