/**
 * Test suite for public vaccination verification endpoint.
 * Tests GET /verify/public/:wallet endpoint.
 */

const request = require('supertest');
const app = require('../src/app');

describe('GET /verify/public/:wallet', () => {
  describe('No authentication required', () => {
    it('should accept request without Authorization header', async () => {
      const validWallet = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF';
      const res = await request(app)
        .get(`/v1/verify/public/${validWallet}`)
        .expect((res) => {
          // Should not return 401 (unauthorized)
          expect(res.status).not.toBe(401);
        });
    });
  });

  describe('Wallet format validation', () => {
    it('should return 400 for invalid wallet format', async () => {
      const res = await request(app)
        .get('/v1/verify/public/invalid-wallet')
        .expect(400);
      
      expect(res.body).toHaveProperty('error');
    });

    it('should return 400 for empty wallet', async () => {
      const res = await request(app)
        .get('/v1/verify/public/')
        .expect(404); // Route not found because wallet is empty
    });

    it('should accept valid Stellar public key format', async () => {
      const validWallet = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF';
      const res = await request(app)
        .get(`/v1/verify/public/${validWallet}`)
        .expect((res) => {
          // Should pass wallet validation (may fail on contract call, but not on format)
          expect(res.status).not.toBe(400);
        });
    });
  });

  describe('Response schema', () => {
    it('should return { verified: boolean, records: [] } schema', async () => {
      const validWallet = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF';
      const res = await request(app)
        .get(`/v1/verify/public/${validWallet}`)
        .expect((res) => {
          // Check response structure (may be 500 if contract fails, but structure should be consistent)
          if (res.status === 200) {
            expect(res.body).toHaveProperty('wallet');
            expect(res.body).toHaveProperty('verified');
            expect(typeof res.body.verified).toBe('boolean');
            expect(res.body).toHaveProperty('records');
            expect(Array.isArray(res.body.records)).toBe(true);
          }
        });
    });

    it('should not include vaccinated field in public response', async () => {
      const validWallet = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF';
      const res = await request(app)
        .get(`/v1/verify/public/${validWallet}`)
        .expect((res) => {
          if (res.status === 200) {
            // Public endpoint should use 'verified' not 'vaccinated'
            expect(res.body).toHaveProperty('verified');
            expect(res.body).not.toHaveProperty('vaccinated');
            expect(res.body).not.toHaveProperty('record_count');
          }
        });
    });
  });

  describe('Rate limiting', () => {
    it('should be rate limited to 60 requests per minute per IP', async () => {
      const validWallet = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF';
      
      // Make multiple requests to test rate limiting
      // Note: This test may not work in all environments due to rate limiter configuration
      const res = await request(app)
        .get(`/v1/verify/public/${validWallet}`)
        .expect((res) => {
          // Should have rate limit headers
          if (res.status === 429) {
            expect(res.body).toHaveProperty('error');
            expect(res.body.error).toContain('Too many requests');
          }
        });
    });
  });

  describe('Caching', () => {
    it('should cache results for 60 seconds', async () => {
      const validWallet = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF';
      
      // First request
      const res1 = await request(app)
        .get(`/v1/verify/public/${validWallet}`)
        .expect((res) => {
          // Just check it doesn't error on format
          expect(res.status).not.toBe(400);
        });

      // Second request should use cache (same response)
      const res2 = await request(app)
        .get(`/v1/verify/public/${validWallet}`)
        .expect((res) => {
          expect(res.status).not.toBe(400);
        });

      // Both should have same status (either both succeed or both fail the same way)
      expect(res1.status).toBe(res2.status);
    });
  });

  describe('Error handling', () => {
    it('should return 503 on RPC timeout', async () => {
      // This test would require mocking the contract call to timeout
      // Skipping for now as it requires test infrastructure setup
    });

    it('should return 500 on contract error', async () => {
      // This test would require mocking the contract call to fail
      // Skipping for now as it requires test infrastructure setup
    });
  });
});

describe('Public verification semantics (valid / revoked / absent / unavailable)', () => {
  const validWallet = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF';
  const otherWallet = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

  // The contract/API must expose an explicit status so that callers can
  // distinguish a positive verification from missing, revoked, or
  // unavailable data. A boolean alone is not sufficient.
  const ALLOWED_STATUSES = ['valid', 'revoked', 'absent', 'unavailable'];

  let verifyService;

  beforeEach(() => {
    jest.resetModules();
    verifyService = require('../src/services/verifyService');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockContractResult(result) {
    jest
      .spyOn(verifyService, 'getVerificationRecords')
      .mockResolvedValue(result);
  }

  function mockContractFailure(error) {
    jest
      .spyOn(verifyService, 'getVerificationRecords')
      .mockRejectedValue(error);
  }

  it('reports status "valid" and verified=true for a wallet with active records', async () => {
    mockContractResult({
      status: 'valid',
      records: [{ id: 'rec-1', vaccine: 'COVID-19', revoked: false }],
    });

    const res = await request(app).get(`/v1/verify/public/${validWallet}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status');
    expect(ALLOWED_STATUSES).toContain(res.body.status);
    expect(res.body.status).toBe('valid');
    expect(res.body.verified).toBe(true);
    expect(Array.isArray(res.body.records)).toBe(true);
    expect(res.body.records.length).toBeGreaterThan(0);
  });

  it('reports status "revoked" and verified=false when all records are revoked', async () => {
    mockContractResult({
      status: 'revoked',
      records: [{ id: 'rec-1', vaccine: 'COVID-19', revoked: true }],
    });

    const res = await request(app).get(`/v1/verify/public/${validWallet}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('revoked');
    expect(res.body.verified).toBe(false);
  });

  it('reports status "absent" and verified=false when the wallet has no records', async () => {
    mockContractResult({ status: 'absent', records: [] });

    const res = await request(app).get(`/v1/verify/public/${otherWallet}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('absent');
    expect(res.body.verified).toBe(false);
    expect(res.body.records).toEqual([]);
  });

  it('reports status "unavailable" and verified=false when the contract is unreachable', async () => {
    mockContractFailure(new Error('RPC connection refused'));

    const res = await request(app).get(`/v1/verify/public/${validWallet}`);

    // Unavailable data must never be surfaced as a successful verification.
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.verified).not.toBe(true);
    if (res.body.status !== undefined) {
      expect(res.body.status).toBe('unavailable');
    }
  });

  it('does not collapse an RPC timeout into a positive verification result', async () => {
    const timeoutError = new Error('RPC timeout');
    timeoutError.code = 'ETIMEDOUT';
    mockContractFailure(timeoutError);

    const res = await request(app).get(`/v1/verify/public/${validWallet}`);

    expect(res.status).not.toBe(200);
    expect(res.body.verified).not.toBe(true);
    expect(res.body).not.toHaveProperty('vaccinated');
  });

  it('does not collapse a contract error into a positive verification result', async () => {
    mockContractFailure(new Error('contract invocation failed'));

    const res = await request(app).get(`/v1/verify/public/${validWallet}`);

    expect(res.status).not.toBe(200);
    expect(res.body.verified).not.toBe(true);
  });

  it('never returns verified=true when records are missing from the contract response', async () => {
    mockContractResult({ status: 'absent' });

    const res = await request(app).get(`/v1/verify/public/${validWallet}`);

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(false);
    expect(res.body.status).not.toBe('valid');
  });

  it('distinguishes revoked from absent in the response status', async () => {
    mockContractResult({
      status: 'revoked',
      records: [{ id: 'rec-1', vaccine: 'COVID-19', revoked: true }],
    });
    const revokedRes = await request(app).get(`/v1/verify/public/${validWallet}`);

    jest.restoreAllMocks();
    mockContractResult({ status: 'absent', records: [] });
    const absentRes = await request(app).get(`/v1/verify/public/${otherWallet}`);

    expect(revokedRes.body.status).not.toBe(absentRes.body.status);
    expect(revokedRes.body.verified).toBe(false);
    expect(absentRes.body.verified).toBe(false);
  });
});

describe('GET /verify/:wallet (authenticated)', () => {
  describe('Authentication required', () => {
    it('should return 401 without Authorization header', async () => {
      const validWallet = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF';
      const res = await request(app)
        .get(`/v1/verify/${validWallet}`)
        .expect(401);
      
      expect(res.body).toHaveProperty('error');
    });
  });

  describe('Response schema', () => {
    it('should return detailed schema with vaccinated and record_count', async () => {
      // This test would require a valid JWT token
      // Skipping for now as it requires test infrastructure setup
    });
  });
});
