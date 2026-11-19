const { createLogger, format, transports } = require('winston');

const isProd = process.env.NODE_ENV === 'production';

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

/**
 * Create a request-scoped child logger that binds the given requestId
 * to every log entry. Falls back to the base logger when no requestId
 * is provided.
 *
 * @param {string} [requestId] - Safe, validated request identifier.
 * @returns {import('winston').Logger}
 */
function createRequestLogger(requestId) {
  if (!requestId) {
    return logger;
  }
  return logger.child({ requestId });
}

module.exports = logger;
module.exports.createRequestLogger = createRequestLogger;
module.exports.logger = logger;