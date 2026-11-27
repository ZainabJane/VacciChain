const { z } = require('zod');

const schema = z.object({
  // Stellar / Soroban
  STELLAR_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet'),
  HORIZON_URL: z.string().url(),
  SOROBAN_RPC_URL: z.string().url(),
  SOROBAN_RPC_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
  SOROBAN_RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  STELLAR_NETWORK_PASSPHRASE: z.string().min(1),

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

  // Indexer
  EVENT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
  // Maximum number of consecutive failed poll attempts before giving up (bounded retries)
  EVENT_POLL_MAX_RETRIES: z.coerce.number().int().nonnegative().default(5),
  // Base delay for exponential backoff between failed poll attempts
  EVENT_POLL_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(500),
  // Upper bound for exponential backoff delay between failed poll attempts
  EVENT_POLL_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(30000),
  DATABASE_PATH: z.string().default('/data/vaccichain.db'),

  // Autoscaling / capacity (backlog #116)
  ENABLE_AUTOSCALING: z.coerce.boolean().default(false),
  MIN_TASKS: z.coerce.number().int().positive().default(1),
  MAX_TASKS: z.coerce.number().int().positive().default(1),
  // Cooldown between scaling actions, in seconds
  SCALING_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(60),
  // Maximum number of concurrent backend writers allowed against shared storage
  MAX_CONCURRENT_WRITERS: z.coerce.number().int().positive().default(1),

  // Storage / multi-task write safety (backlog #117)
  // When true, only a single backend task may write to the shared database.
  SINGLE_WRITER_MODE: z.coerce.boolean().default(true),

  // Network egress allowlist (backlog #114)
  // Comma-separated list of allowed egress hostnames (e.g. horizon-testnet.stellar.org).
  EGRESS_ALLOWLIST: z.string().default(''),
  // When true, outbound requests to hosts outside the allowlist are rejected.
  ENFORCE_EGRESS_ALLOWLIST: z.coerce.boolean().default(false),

  // Database migrations directory (repeatable, reversible schema upgrades)
  MIGRATIONS_DIR: z.string().min(1).default('./migrations'),

  // Graceful shutdown: maximum time to drain in-flight work before forcing exit
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
}).superRefine((val, ctx) => {
  if (val.MIN_TASKS > val.MAX_TASKS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MIN_TASKS'],
      message: 'MIN_TASKS must be less than or equal to MAX_TASKS',
    });
  }
  if (val.ENABLE_AUTOSCALING && val.MAX_TASKS < 2) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MAX_TASKS'],
      message: 'MAX_TASKS must be at least 2 when ENABLE_AUTOSCALING is true',
    });
  }
  if (val.SINGLE_WRITER_MODE && val.MAX_CONCURRENT_WRITERS !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MAX_CONCURRENT_WRITERS'],
      message: 'MAX_CONCURRENT_WRITERS must be 1 when SINGLE_WRITER_MODE is true',
    });
  }
  if (val.ENFORCE_EGRESS_ALLOWLIST) {
    const hosts = val.EGRESS_ALLOWLIST.split(',').map(h => h.trim()).filter(Boolean);
    if (hosts.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EGRESS_ALLOWLIST'],
        message: 'EGRESS_ALLOWLIST must list at least one host when ENFORCE_EGRESS_ALLOWLIST is true',
      });
    }
  }
});

function validateEnv(env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    const missing = result.error.issues.map(i => `  ${i.path[0]}: ${i.message}`).join('\n');
    throw new Error(`[config] Missing or invalid environment variables:\n${missing}`);
  }
  const data = result.data;
  // Derived helpers consumed by the backend to adjust runtime behavior.
  data.egressAllowlist = data.EGRESS_ALLOWLIST
    .split(',')
    .map(h => h.trim().toLowerCase())
    .filter(Boolean);
  // Effective writer limit: single-writer mode constrains writers to one instance.
  data.effectiveMaxWriters = data.SINGLE_WRITER_MODE ? 1 : data.MAX_CONCURRENT_WRITERS;
  return data;
}

const config = (() => {
  try {
    return validateEnv(process.env);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
})();

module.exports = config;
module.exports.validateEnv = validateEnv;