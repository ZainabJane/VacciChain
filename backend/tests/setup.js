// Set required env vars before any module is loaded in tests
process.env.STELLAR_NETWORK = 'testnet';
process.env.HORIZON_URL = 'https://horizon-testnet.stellar.org';
process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
process.env.VACCINATIONS_CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
process.env.ADMIN_SECRET_KEY = 'STEST000000000000000000000000000000000000000000000000000';
process.env.SEP10_SERVER_KEY = 'STEST000000000000000000000000000000000000000000000000001';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV = 'test';

// Rate limiting / trusted client identity configuration.
// Tests run against an in-memory store so they are deterministic and do not
// require an external Redis instance. TRUST_PROXY is disabled by default so
// spoofed forwarding headers are ignored unless a test opts in explicitly.
process.env.RATE_LIMIT_STORE = 'memory';
process.env.TRUST_PROXY = 'false';
process.env.TRUSTED_PROXY_HOPS = '0';
process.env.RATE_LIMIT_AUTH_MAX = '10';
process.env.RATE_LIMIT_AUTH_WINDOW_MS = '60000';
process.env.RATE_LIMIT_PUBLIC_VERIFY_MAX = '30';
process.env.RATE_LIMIT_PUBLIC_VERIFY_WINDOW_MS = '60000';
process.env.RATE_LIMIT_ONBOARDING_MAX = '5';
process.env.RATE_LIMIT_ONBOARDING_WINDOW_MS = '60000';
process.env.RATE_LIMIT_BATCH_VERIFY_MAX = '5';
process.env.RATE_LIMIT_BATCH_VERIFY_WINDOW_MS = '60000';

// Database integrity / startup check configuration.
// Point at an isolated test database path and keep integrity checks enabled so
// startup/readiness behavior is exercised deterministically.
process.env.DB_PATH = process.env.DB_PATH || ':memory:';
process.env.DB_INTEGRITY_CHECK_ON_STARTUP = 'true';
process.env.DB_SCHEMA_VERSION = process.env.DB_SCHEMA_VERSION || '1';