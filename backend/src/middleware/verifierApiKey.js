const crypto = require('crypto');
const { getApiKeyByHash } = require('../indexer/db');
const auditLog = require('../auditLog');

/**
 * Middleware: validate X-API-Key header against the api_keys table.
 *
 * Lifecycle behavior:
 *  - Provisioning: keys are stored as SHA-256 hashes; the raw key is never persisted.
 *  - Rotation: rotating a key creates a new hashed record; the old record is revoked.
 *  - Scopes: each key carries a list of scopes; the route may declare req.requiredScope.
 *  - Revocation: revoked or expired keys are rejected.
 *
 * On success, attaches req.verifier = { id, label, scopes } and calls next().
 * On failure, returns 401 (missing/invalid/revoked/expired) or 403 (insufficient scope).
 * Every accepted and rejected attempt emits an audit entry with action
 * 'verifier.api_key.auth'.
 */
function verifierApiKey(req, res, next) {
  const raw = req.headers['x-api-key'];

  const emitAudit = (outcome, extra = {}) => {
    try {
      auditLog.audit({
        action: 'verifier.api_key.auth',
        outcome,
        ip: req.ip,
        method: req.method,
        path: req.originalUrl || req.url,
        ...extra,
      });
    } catch (err) {
      // Auditing must never break request handling.
    }
  };

  if (!raw) {
    emitAudit('rejected', { reason: 'missing_key' });
    return res.status(401).json({ error: 'Missing X-API-Key header' });
  }

  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const record = getApiKeyByHash(hash);

  if (!record) {
    emitAudit('rejected', { reason: 'invalid_key' });
    return res.status(401).json({ error: 'Invalid or revoked API key' });
  }

  if (record.revoked) {
    emitAudit('rejected', { reason: 'revoked_key', keyId: record.id });
    return res.status(401).json({ error: 'Invalid or revoked API key' });
  }

  if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
    emitAudit('rejected', { reason: 'expired_key', keyId: record.id });
    return res.status(401).json({ error: 'Invalid or revoked API key' });
  }

  const scopes = Array.isArray(record.scopes) ? record.scopes : [];

  const requiredScope = req.requiredScope;
  if (requiredScope && !scopes.includes(requiredScope)) {
    emitAudit('rejected', {
      reason: 'insufficient_scope',
      keyId: record.id,
      requiredScope,
    });
    return res.status(403).json({ error: 'Insufficient scope for this API key' });
  }

  req.verifier = { id: record.id, label: record.label, scopes };

  emitAudit('accepted', {
    keyId: record.id,
    label: record.label,
    requiredScope: requiredScope || null,
  });

  next();
}

module.exports = verifierApiKey;