const { z } = require('zod');

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
=======

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

  // Retention / purge policies (off-chain data)
  // Indexed event records
  RETENTION_EVENTS_DAYS: z.coerce.number().int().positive().default(365),
  // Operational data (caches, job state, transient records)
  RETENTION_OPERATIONAL_DAYS: z.coerce.number().int().positive().default(30),
  // Audit logs (must be retained; purge only beyond this window)
  RETENTION_AUDIT_DAYS: z.coerce.number().int().positive().default(1825),
  // How often automated retention jobs run
  RETENTION_JOB_INTERVAL_MS: z.coerce.number().int().positive().default(3600000),
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
