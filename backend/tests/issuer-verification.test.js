const { isAuthorizedIssuer, invalidateCache } = require('../src/stellar/issuerCache');
const issuerMiddleware = require('../src/middleware/issuer');
const { simulateContract } = require('../src/stellar/soroban');
const config = require('../src/config');
const StellarSdk = require('@stellar/stellar-sdk');

jest.mock('../src/stellar/soroban');

describe('Issuer Verification & Caching', () => {
  const wallet = 'GD6W6X66Z3ND66Z3D7S3Y3A6S2Z6Z2Z6Z2Z6Z2Z6Z2Z6Z2Z6Z2Z6Z2Z'; // Still invalid length
  // Let's use a real one
  const validWallet = 'GDE76K45763M6HEDT26F5D3M5C3U4U5M6X2Z6Z2Z6Z2Z6Z2Z6Z2Z6Z2Z'; // Still not valid
  // I'll use a known valid testnet address format
  const testWallet = 'GB7V7Z57Z57Z57Z57Z57Z57Z57Z57Z57Z57Z57Z57Z57Z57Z57Z57Z57'; // 56 chars
  const realTestWallet = 'GB7V7Z57Z57Z57Z57Z57Z57Z57Z57Z57Z57Z57Z57Z57Z57Z57Z57Z57'; // Actually, let's just use any 56-char G... address
  const gAddress = StellarSdk.Keypair.random().publicKey();

  beforeEach(() => {
    jest.clearAllMocks();
    invalidateCache(); // clear all
  });

  it('isAuthorizedIssuer calls simulateContract and caches result', async () => {
    simulateContract.mockResolvedValue(StellarSdk.xdr.ScVal.scvBool(true));
    
    const res1 = await isAuthorizedIssuer(gAddress);
    expect(res1).toBe(true);
    expect(simulateContract).toHaveBeenCalledTimes(1);

    const res2 = await isAuthorizedIssuer(gAddress);
    expect(res2).toBe(true);
    expect(simulateContract).toHaveBeenCalledTimes(1);
  });

  it('invalidateCache clears the cached value', async () => {
    simulateContract.mockResolvedValue(StellarSdk.xdr.ScVal.scvBool(true));
    
    await isAuthorizedIssuer(gAddress);
    expect(simulateContract).toHaveBeenCalledTimes(1);

    invalidateCache(gAddress);

    await isAuthorizedIssuer(gAddress);
    expect(simulateContract).toHaveBeenCalledTimes(2);
  });

  it('cached authorization expires after the documented TTL', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    const start = 1_000_000;
    nowSpy.mockReturnValue(start);

    simulateContract.mockResolvedValue(StellarSdk.xdr.ScVal.scvBool(true));

    const res1 = await isAuthorizedIssuer(gAddress);
    expect(res1).toBe(true);
    expect(simulateContract).toHaveBeenCalledTimes(1);

    // Within the TTL window the cached value is served.
    nowSpy.mockReturnValue(start + config.ISSUER_CACHE_TTL_MS - 1);
    const res2 = await isAuthorizedIssuer(gAddress);
    expect(res2).toBe(true);
    expect(simulateContract).toHaveBeenCalledTimes(1);

    // After the TTL the cache entry is stale and must be re-queried.
    nowSpy.mockReturnValue(start + config.ISSUER_CACHE_TTL_MS + 1);
    const res3 = await isAuthorizedIssuer(gAddress);
    expect(res3).toBe(true);
    expect(simulateContract).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
  });

  it('revoked issuer cannot mint after the consistency window', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    const start = 2_000_000;
    nowSpy.mockReturnValue(start);

    // Issuer is authorized and gets cached.
    simulateContract.mockResolvedValue(StellarSdk.xdr.ScVal.scvBool(true));
    expect(await isAuthorizedIssuer(gAddress)).toBe(true);
    expect(simulateContract).toHaveBeenCalledTimes(1);

    // Issuer is revoked on-chain; cache still serves the stale value within TTL.
    simulateContract.mockResolvedValue(StellarSdk.xdr.ScVal.scvBool(false));
    nowSpy.mockReturnValue(start + config.ISSUER_CACHE_TTL_MS - 1);
    expect(await isAuthorizedIssuer(gAddress)).toBe(true);
    expect(simulateContract).toHaveBeenCalledTimes(1);

    // After the consistency window the revocation is observed.
    nowSpy.mockReturnValue(start + config.ISSUER_CACHE_TTL_MS + 1);
    expect(await isAuthorizedIssuer(gAddress)).toBe(false);
    expect(simulateContract).toHaveBeenCalledTimes(2);

    // Middleware must now reject the revoked issuer.
    const req = { user: { role: 'issuer', wallet: gAddress } };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };
    const next = jest.fn();

    await issuerMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Issuer authorization revoked or not found on-chain' });
    expect(next).not.toHaveBeenCalled();

    nowSpy.mockRestore();
  });

  it('issuerMiddleware blocks unauthorized issuers', async () => {
    simulateContract.mockResolvedValue(StellarSdk.xdr.ScVal.scvBool(false));
    
    const req = {
      user: { role: 'issuer', wallet: gAddress }
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };
    const next = jest.fn();

    await issuerMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Issuer authorization revoked or not found on-chain' });
    expect(next).not.toHaveBeenCalled();
  });

  it('issuerMiddleware allows authorized issuers', async () => {
    simulateContract.mockResolvedValue(StellarSdk.xdr.ScVal.scvBool(true));
    
    const req = {
      user: { role: 'issuer', wallet: gAddress }
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };
    const next = jest.fn();

    await issuerMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('issuerMiddleware blocks non-issuer role even if authorized on-chain', async () => {
    const req = {
      user: { role: 'patient', wallet: gAddress }
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };
    const next = jest.fn();

    await issuerMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Issuer role required' });
    expect(next).not.toHaveBeenCalled();
    expect(simulateContract).not.toHaveBeenCalled();
  });

  describe('issuer lifecycle state transitions', () => {
    const makeReq = () => ({ user: { role: 'issuer', wallet: gAddress } });
    const makeRes = () => ({
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    });

    it('rejects a revoked issuer after cache invalidation', async () => {
      // Add: issuer is authorized on-chain.
      simulateContract.mockResolvedValue(StellarSdk.xdr.ScVal.scvBool(true));
      const addReq = makeReq();
      const addRes = makeRes();
      const addNext = jest.fn();
      await issuerMiddleware(addReq, addRes, addNext);
      expect(addNext).toHaveBeenCalled();
      expect(addRes.status).not.toHaveBeenCalled();

      // Revoke: on-chain state flips to false and cache is invalidated.
      simulateContract.mockResolvedValue(StellarSdk.xdr.ScVal.scvBool(false));
      invalidateCache(gAddress);

      const revokeReq = makeReq();
      const revokeRes = makeRes();
      const revokeNext = jest.fn();
      await issuerMiddleware(revokeReq, revokeRes, revokeNext);
      expect(revokeRes.status).toHaveBeenCalledWith(403);
      expect(revokeRes.json).toHaveBeenCalledWith({
        error: 'Issuer authorization revoked or not found on-chain'
      });
      expect(revokeNext).not.toHaveBeenCalled();
    });

    it('allows re-adding a previously revoked issuer', async () => {
      // Revoked state.
      simulateContract.mockResolvedValue(StellarSdk.xdr.ScVal.scvBool(false));
      const revokedReq = makeReq();
      const revokedRes = makeRes();
      const revokedNext = jest.fn();
      await issuerMiddleware(revokedReq, revokedRes, revokedNext);
      expect(revokedRes.status).toHaveBeenCalledWith(403);
      expect(revokedNext).not.toHaveBeenCalled();

      // Re-add: on-chain state flips back to true and cache is invalidated.
      simulateContract.mockResolvedValue(StellarSdk.xdr.ScVal.scvBool(true));
      invalidateCache(gAddress);

      const readdReq = makeReq();
      const readdRes = makeRes();
      const readdNext = jest.fn();
      await issuerMiddleware(readdReq, readdRes, readdNext);
      expect(readdNext).toHaveBeenCalled();
      expect(readdRes.status).not.toHaveBeenCalled();
    });

    it('serves stale authorization from cache until invalidated on revoke', async () => {
      simulateContract.mockResolvedValue(StellarSdk.xdr.ScVal.scvBool(true));
      await isAuthorizedIssuer(gAddress);
      expect(simulateContract).toHaveBeenCalledTimes(1);

      // On-chain revoke without cache invalidation: cached value still returned.
      simulateContract.mockResolvedValue(StellarSdk.xdr.ScVal.scvBool(false));
      const stale = await isAuthorizedIssuer(gAddress);
      expect(stale).toBe(true);
      expect(simulateContract).toHaveBeenCalledTimes(1);

      // After invalidation the revoked state is observed.
      invalidateCache(gAddress);
      const fresh = await isAuthorizedIssuer(gAddress);
      expect(fresh).toBe(false);
      expect(simulateContract).toHaveBeenCalledTimes(2);
    });

    it('treats repeated invalidation as idempotent', async () => {
      simulateContract.mockResolvedValue(StellarSdk.xdr.ScVal.scvBool(true));
      await isAuthorizedIssuer(gAddress);
      expect(simulateContract).toHaveBeenCalledTimes(1);

      invalidateCache(gAddress);
      invalidateCache(gAddress);
      invalidateCache(gAddress);

      await isAuthorizedIssuer(gAddress);
      expect(simulateContract).toHaveBeenCalledTimes(2);
    });

    it('repeated revoke checks remain rejected without re-adding', async () => {
      simulateContract.mockResolvedValue(StellarSdk.xdr.ScVal.scvBool(false));

      for (let i = 0; i < 2; i += 1) {
        invalidateCache(gAddress);
        const req = makeReq();
        const res = makeRes();
        const next = jest.fn();
        await issuerMiddleware(req, res, next);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
      }
    });
  });
});
