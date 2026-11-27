const jwt = require('jsonwebtoken');
const jwtKeys = require('../jwtKeys');
const { ERROR_CODES, sendError } = require('../errors');

const REQUIRED_CLAIMS = ['sub', 'role', 'wallet', 'exp'];

/**
 * Verify a bearer token against the active keys (#47).
 *
 * The matching `kid` is tried first, then the other active keys so tokens
 * issued before a rotation stay valid during the overlap window. Algorithm,
 * issuer and audience are pinned via `verifyOptions()`, and identity comes
 * only from verified claims: `sub` must equal `wallet`.
 *
 * @returns {{ user: object } | { status: number, code: string, message: string }}
 */
function verifyBearer(req, allowedRoles) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return { status: 401, code: ERROR_CODES.UNAUTHENTICATED, message: 'Missing authorization header' };
  }
  const token = header.slice(7);

  let preferredKid = null;
  try {
    preferredKid = jwt.decode(token, { complete: true })?.header?.kid || null;
  } catch (_) {
    // malformed — verification below fails
  }

  const keys = jwtKeys.getVerificationKeys();
  const ordered = preferredKid ? [...keys].sort((a) => (a.kid === preferredKid ? -1 : 1)) : keys;
  // Older test doubles of jwtKeys only stub the key getters.
  const options = typeof jwtKeys.verifyOptions === 'function' ? jwtKeys.verifyOptions() : { algorithms: ['HS256'] };

  let decoded = null;
  for (const key of ordered) {
    try {
      decoded = jwt.verify(token, key.secret, options);
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!decoded) {
    return { status: 401, code: ERROR_CODES.TOKEN_INVALID, message: 'Invalid or expired token' };
  }

  for (const claim of REQUIRED_CLAIMS) {
    if (!decoded[claim]) {
      return { status: 401, code: ERROR_CODES.TOKEN_INVALID, message: `Missing or empty claim: ${claim}` };
    }
  }
  if (decoded.sub !== decoded.wallet) {
    return { status: 401, code: ERROR_CODES.TOKEN_INVALID, message: 'Token subject does not match wallet claim' };
  }
  if (!allowedRoles.includes(decoded.role)) {
    return { status: 401, code: ERROR_CODES.TOKEN_INVALID, message: 'Invalid role claim' };
  }

  // `publicKey` is kept as an alias of the verified wallet for existing route code.
  return { user: { ...decoded, publicKey: decoded.wallet } };
}

function middlewareFor(allowedRoles) {
  return function authenticate(req, res, next) {
    const result = verifyBearer(req, allowedRoles);
    if (!result.user) return sendError(req, res, result.status, result.code, result.message);
    req.user = result.user;
    next();
  };
}

/** JWT authentication for patient and issuer routes. */
const authMiddleware = middlewareFor(['patient', 'issuer']);

/** Variant that also accepts the 'admin' role. Use only on admin-only routes. */
const adminAuthMiddleware = middlewareFor(['patient', 'issuer', 'admin']);

/**
 * Object-level authorization (#45): the wallet in `req.params[param]` must be
 * the caller's own verified wallet, unless the caller's role is listed in
 * `privilegedRoles`. Never trusts a wallet sent by the client.
 */
function requireWalletAccess(param = 'wallet', privilegedRoles = ['issuer', 'admin']) {
  return async function walletAccess(req, res, next) {
    if (!req.user) {
      return sendError(req, res, 401, ERROR_CODES.UNAUTHENTICATED, 'Missing authorization header');
    }
    if (req.params[param] === req.user.wallet) return next();
    if (!privilegedRoles.includes(req.user.role)) {
      return sendError(req, res, 403, ERROR_CODES.FORBIDDEN, "You don't have access to this wallet's records");
    }
    if (req.user.role !== 'issuer') return next();

    // An issuer token can outlive the issuer's on-chain authorization, so the
    // allowlist is re-checked on every cross-wallet read.
    try {
      const { isAuthorizedIssuer } = require('../stellar/issuerCache');
      if (await isAuthorizedIssuer(req.user.wallet)) return next();
      return sendError(req, res, 403, ERROR_CODES.FORBIDDEN, 'Issuer authorization revoked or not found on-chain');
    } catch (_) {
      return sendError(req, res, 502, ERROR_CODES.RPC_ERROR, 'Failed to verify issuer authorization');
    }
  };
}

/**
 * Strict admin-only middleware for sensitive transitions (e.g. onboarding review).
 * Requires the token role to be exactly 'admin' — no other role is accepted.
 * Propagates the request correlation ID onto req.user for audit logging.
 */
function requireAdmin(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }

  const token = header.slice(7);
  const keys = getVerificationKeys();
  let decoded = null;

  let preferredKid = null;
  try {
    const unverified = jwt.decode(token, { complete: true });
    preferredKid = unverified?.header?.kid || null;
  } catch (_) {}

  const ordered = preferredKid
    ? [...keys].sort((a) => (a.kid === preferredKid ? -1 : 1))
    : keys;

  for (const key of ordered) {
    try {
      decoded = jwt.verify(token, key.secret);
      break;
    } catch (_) {}
  }

  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const requiredClaims = ['sub', 'role', 'wallet', 'exp'];
  for (const claim of requiredClaims) {
    if (!decoded[claim]) {
      return res.status(401).json({ error: `Missing or empty claim: ${claim}` });
    }
  }

  if (decoded.role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required' });
  }

  req.user = decoded;
  if (req.requestId) {
    req.user.requestId = req.requestId;
  }
  next();
}

module.exports = authMiddleware;
module.exports.adminAuthMiddleware = adminAuthMiddleware;
module.exports.requireWalletAccess = requireWalletAccess;
module.exports.verifyBearer = verifyBearer;
