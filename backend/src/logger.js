const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger, format, transports } = require('winston');
const { AsyncLocalStorage } = require('async_hooks');

const isProd = process.env.NODE_ENV === 'production';

const REDACTED = '[REDACTED]';

// Header names whose values must never reach logs.
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'x-access-token',
  'x-secret',
  'x-secret-key',
  'secret-key',
  'x-csrf-token',
  'x-xsrf-token',
]);

// Object keys whose values must never reach logs.
const SENSITIVE_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'password',
  'passwd',
  'pwd',
  'secret',
  'secretkey',
  'clientsecret',
  'apikey',
  'api_key',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'idtoken',
  'id_token',
  'token',
  'jwt',
  'bearer',
  'privatekey',
  'private_key',
  'signingkey',
  'signing_key',
  'mnemonic',
  'seed',
  'seedphrase',
  'xdr',
  'signedxdr',
  'signed_xdr',
  'signedtransaction',
  'signed_transaction',
  'signedpayload',
  'signed_payload',
  'transactionenvelope',
  'transaction_envelope',
  'envelope',
  'signature',
  'signatures',
  'credential',
  'credentials',
  'auth',
  'session',
  'sessionid',
  'session_id',
]);

// Health-related fields that are unnecessary in logs.
const HEALTH_KEYS = new Set([
  'health',
  'healthcheck',
  'health_check',
  'healthinfo',
  'health_info',
  'healthdetails',
  'health_details',
  'diagnostics',
  'vitals',
  'uptime',
  'memoryusage',
  'memory_usage',
  'cpuusage',
  'cpu_usage',
  'freememory',
  'free_memory',
  'totalmemory',
  'total_memory',
  'loadaverage',
  'load_average',
]);

// Patterns for inline secrets embedded in strings.
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\b/g;
const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const API_KEY_PATTERN = /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g;
const SIGNED_XDR_PATTERN = /\b(?:AAAAA[A-Za-z0-9+/=]{20,}|[A-Za-z0-9+/=]{100,})\b/g;

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[-_\s]/g, '');
}

function isSensitiveKey(key) {
  const normalized = normalizeKey(key);
  return (
    SENSITIVE_KEYS.has(normalized) ||
    SENSITIVE_HEADERS.has(String(key).toLowerCase()) ||
    HEALTH_KEYS.has(normalized)
  );
}

function redactString(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(BEARER_PATTERN, (match, scheme) => `${scheme} ${REDACTED}`)
    .replace(JWT_PATTERN, REDACTED)
    .replace(API_KEY_PATTERN, REDACTED)
    .replace(SIGNED_XDR_PATTERN, REDACTED);
}

function redactSensitive(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return redactString(value);
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, seen));
  }

  if (value instanceof Error) {
    const redactedError = {
      name: value.name,
      message: redactString(value.message),
    };
    if (value.stack) {
      redactedError.stack = redactString(value.stack);
    }
    for (const key of Object.keys(value)) {
      if (key === 'name' || key === 'message' || key === 'stack') continue;
      redactedError[key] = isSensitiveKey(key)
        ? REDACTED
        : redactSensitive(value[key], seen);
    }
    return redactedError;
  }

  const result = {};
  for (const key of Object.keys(value)) {
    if (isSensitiveKey(key)) {
      result[key] = REDACTED;
    } else {
      result[key] = redactSensitive(value[key], seen);
    }
  }
  return result;
}

// Winston format that redacts sensitive data from every emitted record.
const redactFormat = format((info) => {
  const redacted = redactSensitive(info);
  // Preserve level/symbol properties required by winston.
  if (info.level !== undefined) redacted.level = info.level;
  if (info[Symbol.for('level')] !== undefined) {
    redacted[Symbol.for('level')] = info[Symbol.for('level')];
  }
  if (info[Symbol.for('message')] !== undefined) {
    redacted[Symbol.for('message')] = info[Symbol.for('message')];
  }
  if (info[Symbol.for('splat')] !== undefined) {
    redacted[Symbol.for('splat')] = redactSensitive(info[Symbol.for('splat')]);
  }
  return redacted;
});

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    redactFormat(),
    format.timestamp(),
    format.errors({ stack: !isProd }),
    format.json()
  ),
  defaultMeta: { service: 'backend' },
  transports: [new transports.Console()],
});

module.exports = logger;
module.exports.redactSensitive = redactSensitive;
module.exports.redactString = redactString;
module.exports.REDACTED = REDACTED;
