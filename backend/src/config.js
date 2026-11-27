const { z } = require('zod');
const fs = require('fs');
const path = require('path');

const schema = z.object({
  // Stellar / Soroban
  STELLAR_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet'),
  HORIZON_URL: z.string().url(),
  SOROBAN_RPC_URL: z.string().url(),
  SOROBAN_RPC_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
  SOROBAN_RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  STELLAR_NETWORK_PASSPHRASE: z.string().min(1),

  // Stellar call timeouts and retry policy (Horizon + Soroban RPC)
  // Only idempotent/read operations are retried; transaction submissions are not.
  STELLAR_RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  STELLAR_RPC_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
  STELLAR_RETRY_BASE_DELAY_MS: z.coerce.number().int().nonnegative().default(250),
  STELLAR_RETRY_MAX_DELAY_MS: z.coerce.number().int().nonnegative().default(5000),

  // Contract
  VACCINATIONS_CONTRACT_ID: z.string().min(1),

  // Backend
  ADMIN_SECRET_KEY: z.string().min(1).refine(v => v.startsWith('S'), {
    message: 'ADMIN_SECRET_KEY must start with S',
  }),
  SEP10_SERVER_KEY: z.string().min(1),
  JWT_SECRET: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(4000),
  // Comma-separated list of allowed origins, e.g. https://app.example.com,https://admin.example.com
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),

  // SEP-10: home domain used as the manage_data key prefix ('<HOME_DOMAIN> auth')
  HOME_DOMAIN: z.string().min(1).default('localhost'),
  // SEP-10: domain of this auth server, included in the web_auth_domain manage_data op
  WEB_AUTH_DOMAIN: z.string().min(1).default('localhost'),

  // Transaction fees (stroops; 1 XLM = 10_000_000 stroops)
  SOROBAN_FEE: z.coerce.number().int().positive().default(100),
  SOROBAN_TIP: z.coerce.number().int().min(0).default(0),

  // Health probe interval for cached dependency status
  HEALTH_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(15000),

  // Request limits
  BODY_LIMIT: z.string().default('10kb'),

  // Rate limiting / trusted proxy configuration.
  // TRUST_PROXY accepts either a boolean ('true'/'false') or a comma-separated
  // list of trusted proxy CIDRs/IPs. When false, forwarding headers are ignored.
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform(v => {
      const trimmed = v.trim();
      if (trimmed === 'true') return true;
      if (trimmed === 'false' || trimmed === '') return false;
      return trimmed
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    }),
  RATE_LIMIT_ONBOARDING: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_BATCH_VERIFY: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_STORE: z.enum(['memory', 'redis']).default('memory'),

  // Indexer
  EVENT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
  // Maximum number of consecutive failed poll attempts before giving up (bounded retries)
  EVENT_POLL_MAX_RETRIES: z.coerce.number().int().nonnegative().default(5),
  // Base delay for exponential backoff between failed poll attempts
  EVENT_POLL_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(500),
  // Upper bound for exponential backoff delay between failed poll attempts
  EVENT_POLL_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(30000),
  DATABASE_PATH: z.string().default('/data/vaccichain.db'),

  // Persistence strategy (see docs/persistence-strategy.md)
  // 'sqlite' = single-writer SQLite index; 'postgres' = multi-writer database
  DB_BACKEND: z.enum(['sqlite', 'postgres']).default('sqlite'),
  // Connection string for the multi-writer backend (required when DB_BACKEND=postgres)
  DATABASE_URL: z.string().optional(),
  // Milliseconds to wait for a write lock before failing the operation
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  // Interval between automatic index backups (0 disables scheduled backups)
  DB_BACKUP_INTERVAL_MS: z.coerce.number().int().nonnegative().default(3600000),
  // Directory where index backups are written
  DB_BACKUP_PATH: z.string().default('/data/backups'),
  // Number of most recent backups to retain
  DB_BACKUP_RETENTION: z.coerce.number().int().positive().default(7),
  // Run pending schema migrations on startup
  DB_MIGRATE_ON_START: z.coerce.boolean().default(true),
  // Fail startup instead of continuing when migrations cannot be applied
  DB_MIGRATE_STRICT: z.coerce.boolean().default(true),

  // Public verification response limits
  // Maximum number of history entries returned for a single record
  MAX_RECORD_HISTORY: z.coerce.number().int().positive().default(100),
  // Default page size for paginated record/history responses
  DEFAULT_PAGE_SIZE: z.coerce.number().int().positive().default(20),
  // Maximum number of items accepted in a single batch verification request
  MAX_BATCH_SIZE: z.coerce.number().int().positive().default(50),

  // Proxy / client IP derivation
  // Express trust-proxy setting: 'false', 'true', a hop count, or a subnet list
  TRUST_PROXY: z.string().default('false'),

  // Audit logging
  AUDIT_LOG_PATH: z.string().default('/data/audit/audit.log'),
  // Maximum size of a single audit log file before rotation, in bytes
  AUDIT_LOG_MAX_BYTES: z.coerce.number().int().positive().default(10485760),
  // Number of rotated audit log files to retain
  AUDIT_LOG_RETENTION: z.coerce.number().int().positive().default(10),
  // Secret used to compute the tamper-evident hash chain over audit entries
  AUDIT_LOG_INTEGRITY_KEY: z.string().min(1).optional(),

  // Vaccination list pagination (#44)
  // Hard upper bound on page size; requests above this are rejected/clamped.
  VACCINATION_MAX_PAGE_SIZE: z.coerce.number().int().positive().default(100),
  // Page size used when the client does not specify a limit.
  VACCINATION_DEFAULT_PAGE_SIZE: z.coerce.number().int().positive().default(20),

  // Issuer authorization cache (#48)
  // TTL of cached issuer permissions. This is also the documented revocation
  // consistency window: a revoked issuer may be accepted for at most this long.
  ISSUER_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(30000),

  // Mint idempotency (#49)
  // How long idempotency records are retained (and persisted) so retries after
  // timeouts or restarts return the original outcome.
  IDEMPOTENCY_TTL_MS: z.coerce.number().int().positive().default(86400000),

  // SEP-10 challenge nonce store (#46)
  // 'memory' is single-instance only; 'redis' is required for multi-instance.
  NONCE_STORE_BACKEND: z.enum(['memory', 'redis']).default('memory'),
  NONCE_STORE_REDIS_URL: z.string().url().optional(),

  // Database migrations directory (repeatable, reversible schema upgrades)
  MIGRATIONS_DIR: z.string().min(1).default('./migrations'),

  // Graceful shutdown: maximum time to drain in-flight work before forcing exit
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
}).superRefine((val, ctx) => {
  if (val.VACCINATION_DEFAULT_PAGE_SIZE > val.VACCINATION_MAX_PAGE_SIZE) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['VACCINATION_DEFAULT_PAGE_SIZE'],
      message: 'must be less than or equal to VACCINATION_MAX_PAGE_SIZE',
    });
  }
  if (val.NONCE_STORE_BACKEND === 'redis' && !val.NONCE_STORE_REDIS_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['NONCE_STORE_REDIS_URL'],
      message: 'is required when NONCE_STORE_BACKEND is "redis"',
    });
  }
  if (val.DB_BACKEND === 'postgres' && !val.DATABASE_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DATABASE_URL'],
      message: 'DATABASE_URL is required when DB_BACKEND=postgres',
    });
  }
  if (val.DEFAULT_PAGE_SIZE > val.MAX_RECORD_HISTORY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DEFAULT_PAGE_SIZE'],
      message: 'DEFAULT_PAGE_SIZE must not exceed MAX_RECORD_HISTORY',
    });
  }
});

// Expected network passphrases for each Stellar network.
const NETWORK_PASSPHRASES = {
  testnet: 'Test SDF Network ; September 2015',
  mainnet: 'Public Global Stellar Network ; September 2015',
};

// Hostname fragments that identify a network's Horizon / Soroban RPC endpoints.
const NETWORK_HOST_HINTS = {
  testnet: ['testnet', 'horizon-testnet', 'soroban-testnet', 'futurenet'],
  mainnet: ['horizon.stellar.org', 'soroban.stellar.org', 'mainnet'],
};

// Sane ranges for numeric limits.
const NUMERIC_RANGES = {
  PORT: [1, 65535],
  SOROBAN_RPC_MAX_RETRIES: [0, 20],
  SOROBAN_RPC_TIMEOUT_MS: [100, 300000],
  SOROBAN_FEE: [1, 10000000],
  SOROBAN_TIP: [0, 10000000],
  HEALTH_POLL_INTERVAL_MS: [1000, 3600000],
  EVENT_POLL_INTERVAL_MS: [1000, 3600000],
};

function hostMatchesNetwork(url, network) {
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const hints = NETWORK_HOST_HINTS[network] || [];
  return hints.some(hint => hostname.includes(hint));
}

function isWritableDir(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Enforce cross-field constraints on an already Zod-parsed config object.
 * Throws a single aggregated, actionable error if any constraint fails.
 */
function validateConfig(cfg) {
  const errors = [];

  // --- Network / contract consistency ---
  const network = cfg.STELLAR_NETWORK;
  const expectedPassphrase = NETWORK_PASSPHRASES[network];
  if (expectedPassphrase && cfg.STELLAR_NETWORK_PASSPHRASE !== expectedPassphrase) {
    errors.push(
      `STELLAR_NETWORK_PASSPHRASE does not match STELLAR_NETWORK="${network}". ` +
        `Expected "${expectedPassphrase}".`
    );
  }

  for (const key of ['HORIZON_URL', 'SOROBAN_RPC_URL']) {
    if (!hostMatchesNetwork(cfg[key], network)) {
      errors.push(
        `${key}="${cfg[key]}" does not look like a ${network} endpoint. ` +
          `Expected host to contain one of: ${(NETWORK_HOST_HINTS[network] || []).join(', ')}.`
      );
    }
  }

  if (cfg.VACCINATIONS_CONTRACT_ID && !/^C[A-Z0-9]{55}$/.test(cfg.VACCINATIONS_CONTRACT_ID)) {
    errors.push(
      `VACCINATIONS_CONTRACT_ID="${cfg.VACCINATIONS_CONTRACT_ID}" is not a valid Soroban contract ID ` +
        `(expected "C" followed by 55 uppercase alphanumeric characters).`
    );
  }

  // --- Secret combination checks ---
  if (cfg.ADMIN_SECRET_KEY === cfg.SEP10_SERVER_KEY) {
    errors.push('ADMIN_SECRET_KEY and SEP10_SERVER_KEY must be distinct keys.');
  }
  if (cfg.JWT_SECRET === cfg.ADMIN_SECRET_KEY || cfg.JWT_SECRET === cfg.SEP10_SERVER_KEY) {
    errors.push('JWT_SECRET must not reuse ADMIN_SECRET_KEY or SEP10_SERVER_KEY.');
  }

  // --- Numeric limit ranges ---
  for (const [key, [min, max]] of Object.entries(NUMERIC_RANGES)) {
    const value = cfg[key];
    if (typeof value === 'number' && (value < min || value > max)) {
      errors.push(`${key}=${value} is out of range (expected ${min}..${max}).`);
    }
  }

  // --- ALLOWED_ORIGINS entries must be valid URLs ---
  const origins = String(cfg.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    errors.push('ALLOWED_ORIGINS must contain at least one origin.');
  }
  for (const origin of origins) {
    try {
      // eslint-disable-next-line no-new
      new URL(origin);
    } catch {
      errors.push(`ALLOWED_ORIGINS entry "${origin}" is not a valid URL.`);
    }
  }

  // --- DATABASE_PATH parent directory must be writable ---
  const dbPath = cfg.DATABASE_PATH;
  if (dbPath) {
    const parent = path.dirname(dbPath);
    if (!fs.existsSync(parent)) {
      errors.push(`DATABASE_PATH parent directory "${parent}" does not exist.`);
    } else if (!isWritableDir(parent)) {
      errors.push(`DATABASE_PATH parent directory "${parent}" is not writable.`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `[config] Invalid configuration:\n${errors.map(e => `  - ${e}`).join('\n')}`
    );
  }

  return cfg;
}

function validateEnv(env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    const missing = result.error.issues.map(i => `  ${i.path[0]}: ${i.message}`).join('\n');
    throw new Error(`[config] Missing or invalid environment variables:\n${missing}`);
  }
  return validateConfig(result.data);
}

const config = (() => {
  try {
    return validateEnv(process.env);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
})();

/**
 * Normalise an IP address for comparison (strips IPv4-mapped IPv6 prefix).
 */
function normalizeIp(ip) {
  if (!ip) return '';
  let value = String(ip).trim();
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length);
  return value;
}

/**
 * Parse a CIDR or plain IP into { base, bits } for IPv4, or null if unsupported.
 */
function parseCidr(entry) {
  const [addr, bitsRaw] = entry.split('/');
  const ip = normalizeIp(addr);
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some(p => !/^\d+$/.test(p) || Number(p) > 255)) {
    return null;
  }
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const base =
    ((Number(parts[0]) << 24) |
      (Number(parts[1]) << 16) |
      (Number(parts[2]) << 8) |
      Number(parts[3])) >>>
    0;
  return { base, bits };
}

function ipToInt(ip) {
  const parts = normalizeIp(ip).split('.');
  if (parts.length !== 4 || parts.some(p => !/^\d+$/.test(p) || Number(p) > 255)) {
    return null;
  }
  return (
    ((Number(parts[0]) << 24) |
      (Number(parts[1]) << 16) |
      (Number(parts[2]) << 8) |
      Number(parts[3])) >>>
    0
  );
}

/**
 * Determine whether an IP matches the configured trusted proxy list.
 */
function isTrustedProxy(ip, trustProxy) {
  if (trustProxy === true) return true;
  if (!Array.isArray(trustProxy) || trustProxy.length === 0) return false;
  const target = ipToInt(ip);
  if (target === null) return false;
  return trustProxy.some(entry => {
    const cidr = parseCidr(entry);
    if (!cidr) return false;
    if (cidr.bits === 0) return true;
    const mask = cidr.bits === 32 ? 0xffffffff : (0xffffffff << (32 - cidr.bits)) >>> 0;
    return (target & mask) === (cidr.base & mask);
  });
}

/**
 * Resolve the trusted client identity for a request.
 *
 * Forwarding headers (X-Forwarded-For / X-Real-IP) are only honoured when the
 * immediate peer (req.socket.remoteAddress) is a trusted proxy. The right-most
 * untrusted hop in X-Forwarded-For is used, so spoofed left-most entries from
 * untrusted clients are ignored.
 *
 * @param {object} req Express-style request
 * @param {boolean|string[]} [trustProxy] Override for config.TRUST_PROXY
 * @returns {string} resolved client IP (or '' when unknown)
 */
function resolveClientIp(req, trustProxy = config.TRUST_PROXY) {
  if (!req) return '';
  const socket = req.socket || req.connection || {};
  const peer = normalizeIp(socket.remoteAddress || req.ip || '');
  if (!isTrustedProxy(peer, trustProxy)) {
    return peer;
  }

  const forwarded = req.headers && req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const hops = forwarded
      .split(',')
      .map(h => normalizeIp(h))
      .filter(Boolean);
    // Walk from the closest hop to the client, stopping at the first
    // untrusted address; that address is the real client.
    for (let i = hops.length - 1; i >= 0; i -= 1) {
      if (!isTrustedProxy(hops[i], trustProxy)) return hops[i];
    }
    if (hops.length > 0) return hops[0];
  }

  const realIp = req.headers && req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return normalizeIp(realIp);
  }

  return peer;
}

module.exports = config;
module.exports.validateEnv = validateEnv;
module.exports.resolveClientIp = resolveClientIp;
module.exports.isTrustedProxy = isTrustedProxy;
