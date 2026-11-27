/**
 * Unit tests for backend/src/middleware/issuer.js (Issue #97)
 *
 * Covers:
 * - Authorized issuer passes through
 * - Revoked / unauthorized issuer rejected
 * - Non-issuer role rejected (patient, missing role)
 * - Missing wallet in token rejected
 * - Contract allowlist check error handled gracefully
 */

// Mock the on-chain allowlist check and logger before requiring the middleware
jest.mock('../src/stellar/issuerCache', () => ({
  isAuthorizedIssuer: jest.fn(),
  invalidateCache: jest.fn(),
}));

jest.mock('../src/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../src/config', () => ({
  ISSUER_CACHE_TTL_MS: 60000,
}));

const { isAuthorizedIssuer, invalidateCache } = require('../src/stellar/issuerCache');
const logger = require('../src/logger');
const config = require('../src/config');
const issuerMiddleware = require('../src/middleware/issuer');
const StellarSdk = require('@stellar/stellar-sdk');

const WALLET = StellarSdk.Keypair.random().publicKey();

function makeReq(overrides = {}) {
  return {
    user: {
      role: 'issuer',
      wallet: WALLET,
      ...overrides,
    },
  };
}

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('issuerMiddleware — authorized issuer', () => {
  it('calls next() when role is issuer and wallet is on-chain authorized', async () => {
    isAuthorizedIssuer.mockResolvedValue(true);
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await issuerMiddleware(req, res, next);

    expect(isAuthorizedIssuer).toHaveBeenCalledWith(WALLET);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('accepts wallet from req.user.publicKey when wallet field is absent', async () => {
    isAuthorizedIssuer.mockResolvedValue(true);
    const req = { user: { role: 'issuer', publicKey: WALLET } };
    const res = makeRes();
    const next = jest.fn();

    await issuerMiddleware(req, res, next);

    expect(isAuthorizedIssuer).toHaveBeenCalledWith(WALLET);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('issuerMiddleware — revoked / unauthorized issuer', () => {
  it('returns 403 when wallet is not authorized on-chain', async () => {
    isAuthorizedIssuer.mockResolvedValue(false);
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await issuerMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Issuer authorization revoked or not found on-chain',
    });
    expect(next).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('rejects a revoked issuer on every request (no stale allow after revoke)', async () => {
    isAuthorizedIssuer.mockResolvedValue(false);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const req = makeReq();
      const res = makeRes();
      const next = jest.fn();

      await issuerMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    }

    // The allowlist is consulted per request so revocation takes effect immediately
    expect(isAuthorizedIssuer).toHaveBeenCalledTimes(3);
  });

  it('rejects a revoked issuer even when the token still carries the issuer role', async () => {
    isAuthorizedIssuer.mockResolvedValue(false);
    const req = makeReq({ role: 'issuer' });
    const res = makeRes();
    const next = jest.fn();

    await issuerMiddleware(req, res, next);

    expect(isAuthorizedIssuer).toHaveBeenCalledWith(WALLET);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Issuer authorization revoked or not found on-chain',
    });
    expect(next).not.toHaveBeenCalled();
  });
});

describe('issuerMiddleware — re-added issuer', () => {
  it('allows access again after a revoked issuer is re-added on-chain', async () => {
    // Revoked state
    isAuthorizedIssuer.mockResolvedValueOnce(false);
    const revokedRes = makeRes();
    const revokedNext = jest.fn();

    await issuerMiddleware(makeReq(), revokedRes, revokedNext);

    expect(revokedRes.status).toHaveBeenCalledWith(403);
    expect(revokedNext).not.toHaveBeenCalled();

    // Re-added state
    isAuthorizedIssuer.mockResolvedValueOnce(true);
    const readdedRes = makeRes();
    const readdedNext = jest.fn();

    await issuerMiddleware(makeReq(), readdedRes, readdedNext);

    expect(readdedNext).toHaveBeenCalledTimes(1);
    expect(readdedRes.status).not.toHaveBeenCalled();
    expect(isAuthorizedIssuer).toHaveBeenCalledTimes(2);
  });

  it('treats repeated authorized checks as idempotent (next called once per request)', async () => {
    isAuthorizedIssuer.mockResolvedValue(true);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = makeRes();
      const next = jest.fn();

      await issuerMiddleware(makeReq(), res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    }

    expect(isAuthorizedIssuer).toHaveBeenCalledTimes(3);
  });
});

describe('issuerMiddleware — non-issuer role', () => {
  it('returns 403 when role is patient', async () => {
    const req = makeReq({ role: 'patient' });
    const res = makeRes();
    const next = jest.fn();

    await issuerMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Issuer role required' });
    expect(next).not.toHaveBeenCalled();
    // Should not even reach the on-chain check
    expect(isAuthorizedIssuer).not.toHaveBeenCalled();
  });

  it('returns 403 when req.user is undefined', async () => {
    const req = {};
    const res = makeRes();
    const next = jest.fn();

    await issuerMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Issuer role required' });
    expect(next).not.toHaveBeenCalled();
    expect(isAuthorizedIssuer).not.toHaveBeenCalled();
  });

  it('returns 403 when role is missing', async () => {
    const req = { user: { wallet: WALLET } };
    const res = makeRes();
    const next = jest.fn();

    await issuerMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Issuer role required' });
    expect(next).not.toHaveBeenCalled();
  });
});

describe('issuerMiddleware — missing wallet in token', () => {
  it('returns 401 when both wallet and publicKey are absent', async () => {
    const req = { user: { role: 'issuer' } };
    const res = makeRes();
    const next = jest.fn();

    await issuerMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Wallet address missing in token' });
    expect(next).not.toHaveBeenCalled();
    expect(isAuthorizedIssuer).not.toHaveBeenCalled();
  });
});

describe('issuerMiddleware — contract allowlist check error', () => {
  it('returns 500 when isAuthorizedIssuer throws', async () => {
    isAuthorizedIssuer.mockRejectedValue(new Error('RPC timeout'));
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await issuerMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Failed to verify issuer authorization' });
    expect(next).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('issuerMiddleware — revocation window', () => {
  it('rejects mint attempts after invalidateCache(wallet) following a revoke', async () => {
    // Initially authorized
    isAuthorizedIssuer.mockResolvedValue(true);
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await issuerMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    // Issuer is revoked on-chain and the cache entry is invalidated
    invalidateCache(WALLET);
    expect(invalidateCache).toHaveBeenCalledWith(WALLET);

    // Next call must re-query and observe the revocation
    isAuthorizedIssuer.mockResolvedValue(false);
    const res2 = makeRes();
    const next2 = jest.fn();

    await issuerMiddleware(req, res2, next2);

    expect(isAuthorizedIssuer).toHaveBeenCalledTimes(2);
    expect(res2.status).toHaveBeenCalledWith(403);
    expect(res2.json).toHaveBeenCalledWith({
      error: 'Issuer authorization revoked or not found on-chain',
    });
    expect(next2).not.toHaveBeenCalled();
  });

  it('cached true values expire after config.ISSUER_CACHE_TTL_MS', async () => {
    jest.useFakeTimers();
    try {
      isAuthorizedIssuer.mockResolvedValue(true);
      const req = makeReq();
      const res = makeRes();
      const next = jest.fn();

      await issuerMiddleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);

      // Advance past the documented revocation window
      jest.advanceTimersByTime(config.ISSUER_CACHE_TTL_MS + 1);

      // After TTL expiry the cache must re-query and see the revocation
      isAuthorizedIssuer.mockResolvedValue(false);
      const res2 = makeRes();
      const next2 = jest.fn();

      await issuerMiddleware(req, res2, next2);

      expect(isAuthorizedIssuer).toHaveBeenCalledTimes(2);
      expect(res2.status).toHaveBeenCalledWith(403);
      expect(next2).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
