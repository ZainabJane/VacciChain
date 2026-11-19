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
  DATABASE_PATH: z.string().default('/data/vaccichain.db'),

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
});

function validateEnv(env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    const missing = result.error.issues.map(i => `  ${i.path[0]}: ${i.message}`).join('\n');
    throw new Error(`[config] Missing or invalid environment variables:\n${missing}`);
  }
  return result.data;
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
