const rateLimit = require('express-rate-limit');

/**
 * Trusted client identity resolver.
 *
 * Behind a proxy, `req.ip` is only trustworthy when Express' `trust proxy`
 * setting is configured correctly (see `config/trustedProxy.js`). This helper
 * centralises that decision so every limiter keys off the same identity and
 * spoofed forwarding headers cannot be used to bypass limits.
 */
const resolveClientIdentity = (req) => {
  // Prefer an authenticated principal when available so limits follow the
  // account rather than a rotating IP.
  if (req.verifier?.id) return `verifier:${req.verifier.id}`;
  if (req.user?.id) return `user:${req.user.id}`;
  if (req.apiKey?.id) return `apikey:${req.apiKey.id}`;
  // Fall back to the trusted client IP (honours `trust proxy` config).
  return `ip:${req.ip}`;
};

/**
 * Optional shared store for distributed deployments (e.g. Redis).
 * When unset, express-rate-limit falls back to its in-memory store, which is
 * only appropriate for single-instance deployments.
 */
const sharedStore = process.env.RATE_LIMIT_STORE === 'redis'
  ? require('../config/rateLimitStore')
  : undefined;

const make = (maxEnvVar, defaultMax, keyGen = resolveClientIdentity) => {
  const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? 60 * 1000, 10);
  return rateLimit({
    windowMs,
    max: parseInt(process.env[maxEnvVar] ?? defaultMax, 10),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: keyGen,
    store: sharedStore,
    handler: (_req, res, _next, options) => {
      const retryAfter = Math.ceil(options.windowMs / 1000);
      res.set('Retry-After', String(retryAfter));
      res.status(429).json({
        error: 'Too many requests',
        retryAfter,
      });
    },
  });
};

// Derive the client IP safely. Express resolves req.ip according to the
// configured `trust proxy` setting, so forwarded headers (X-Forwarded-For,
// etc.) are only honored when the deployment topology says they should be.
// This prevents spoofed forwarded headers from bypassing rate limits.
const clientIp = (req) => {
  const ip = req.ip;
  if (typeof ip === 'string' && ip.length > 0) return ip;
  // Fall back to the raw socket address if req.ip is unavailable.
  const socketIp = req.socket?.remoteAddress;
  if (typeof socketIp === 'string' && socketIp.length > 0) return socketIp;
  // Last-resort fallback so requests are still bucketed rather than sharing
  // an undefined key.
  return 'unknown';
};

module.exports = {
  resolveClientIdentity,
  // Authentication (SEP-10 challenge issuance)
  sep10Limiter: make('RATE_LIMIT_SEP10', 10),
  // Public verification
  verifyLimiter: make('RATE_LIMIT_VERIFY', 60),
  // Onboarding application submission
  onboardingLimiter: make('RATE_LIMIT_ONBOARDING', 5),
  // Batch verification (keyed by verifier API key id so each third-party has
  // its own bucket)
  verifierKeyLimiter: make('RATE_LIMIT_VERIFIER_KEY', 120, (req) =>
    req.verifier?.id ? `verifier:${req.verifier.id}` : resolveClientIdentity(req)
  ),
  // Batch verification endpoint
  batchVerifyLimiter: make('RATE_LIMIT_BATCH_VERIFY', 30),
};