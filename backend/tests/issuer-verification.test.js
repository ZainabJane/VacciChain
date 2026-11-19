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
});
