const { randomUUID } = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const asyncLocalStorage = new AsyncLocalStorage();

module.exports = function requestId(req, res, next) {
  const id = req.headers['x-request-id'] || randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-ID', id);
  asyncLocalStorage.run({ requestId: id }, () => {
    next();
  });
};

module.exports.asyncLocalStorage = asyncLocalStorage;
module.exports.getRequestId = function getRequestId() {
  const store = asyncLocalStorage.getStore();
  return store ? store.requestId : undefined;
};