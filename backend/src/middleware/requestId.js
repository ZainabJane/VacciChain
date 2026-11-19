const { randomUUID } = require('crypto');

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

module.exports = function requestId(req, res, next) {
  const incoming = req.headers['x-request-id'];
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  const id =
    typeof candidate === 'string' && SAFE_REQUEST_ID.test(candidate)
      ? candidate
      : randomUUID();

  req.requestId = id;
  res.requestId = id;
  res.setHeader('X-Request-ID', id);

  if (req.logger && typeof req.logger === 'object') {
    req.logger.requestId = id;
  }

  next();
};