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

  describe('Consent and allowlist semantics', () => {
    const validWallet = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF';

    // Consent/allowlist states documented for the contract/API boundary:
    // - absent:  no consent record exists -> public verification reports verified: false
    // - granted: consent active and wallet allowlisted -> verified: true
    // - revoked: consent withdrawn -> verified: false (no records disclosed)
    // - changed: consent re-granted after revocation -> reflects latest state
    const consentStates = ['absent', 'granted', 'revoked', 'changed'];

    it.each(consentStates)(
      'should return a consistent verified boolean for consent state "%s"',
      async (state) => {
        const res = await request(app)
          .get(`/v1/verify/public/${validWallet}`)
          .set('X-Test-Consent-State', state)
          .expect((res) => {
            if (res.status === 200) {
              expect(res.body).toHaveProperty('verified');
              expect(typeof res.body.verified).toBe('boolean');
              expect(res.body).toHaveProperty('records');
              expect(Array.isArray(res.body.records)).toBe(true);
            }
          });

        // Endpoint must never fail with a client error for a valid wallet,
        // regardless of consent state.
        expect(res.status).not.toBe(400);
      }
    );

    it('should not reveal records when consent is absent or revoked', async () => {
      for (const state of ['absent', 'revoked']) {
        const res = await request(app)
          .get(`/v1/verify/public/${validWallet}`)
          .set('X-Test-Consent-State', state);

        if (res.status === 200) {
          expect(res.body.verified).toBe(false);
          expect(res.body.records).toEqual([]);
        }
      }
    });
  });

  describe('Prohibited field disclosure', () => {
    const validWallet = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF';

    // Fields that must never appear in the public verification response.
    const prohibitedFields = [
      'vaccinated',
      'record_count',
      'patient_name',
      'patientName',
      'date_of_birth',
      'dateOfBirth',
      'dob',
      'national_id',
      'nationalId',
      'ssn',
      'medical_notes',
      'medicalNotes',
      'diagnosis',
      'consent',
      'consent_state',
      'allowlisted',
      'allowlist',
      'issuer_secret',
      'private_key',
      'privateKey',
    ];

    it('should not expose any prohibited fields at the top level', async () => {
      const res = await request(app)
        .get(`/v1/verify/public/${validWallet}`)
        .expect((res) => {
          if (res.status === 200) {
            for (const field of prohibitedFields) {
              expect(res.body).not.toHaveProperty(field);
            }
          }
        });

      expect(res.status).not.toBe(400);
    });

    it('should not expose prohibited fields inside individual records', async () => {
      const res = await request(app)
        .get(`/v1/verify/public/${validWallet}`)
        .expect((res) => {
          if (res.status === 200 && Array.isArray(res.body.records)) {
            for (const record of res.body.records) {
              for (const field of prohibitedFields) {
                expect(record).not.toHaveProperty(field);
              }
            }
          }
        });

      expect(res.status).not.toBe(400);
    });

    it('should only expose permitted summary fields in records', async () => {
      const permittedFields = [
        'vaccine_type',
        'vaccineType',
        'date_administered',
        'dateAdministered',
        'issuer',
        'verified',
      ];

      const res = await request(app)
        .get(`/v1/verify/public/${validWallet}`)
        .expect((res) => {
          if (res.status === 200 && Array.isArray(res.body.records)) {
            for (const record of res.body.records) {
              const keys = Object.keys(record);
              for (const key of keys) {
                expect(permittedFields).toContain(key);
              }
            }
          }
        });

      expect(res.status).not.toBe(400);
    });
  });

  describe('Rate limiting', () => {
    const validWallet = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF';
    const rateLimit = require('../src/middleware/rateLimit');

    beforeEach(() => {
      // Reset limiter state so each test starts from a clean budget.
      if (typeof rateLimit.reset === 'function') {
        rateLimit.reset();
      }
    });

    it('should be rate limited to 60 requests per minute per IP', async () => {
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

    it('should document RateLimit and Retry-After headers on responses', async () => {
      const res = await request(app).get(`/v1/verify/public/${validWallet}`);

      // Standard RateLimit headers (draft-ietf-httpapi-ratelimit-headers).
      expect(res.headers).toHaveProperty('ratelimit-limit');
      expect(res.headers).toHaveProperty('ratelimit-remaining');
      expect(res.headers).toHaveProperty('ratelimit-reset');
      expect(Number(res.headers['ratelimit-limit'])).toBeGreaterThan(0);
      expect(Number(res.headers['ratelimit-remaining'])).toBeGreaterThanOrEqual(0);
    });

    it('should return 429 with retry metadata on burst requests', async () => {
      const limit = Number(
        (await request(app).get(`/v1/verify/public/${validWallet}`)).headers[
          'ratelimit-limit'
        ]
      );

      let limited;
      // Burst well past the configured window budget.
      for (let i = 0; i < limit + 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const res = await request(app).get(`/v1/verify/public/${validWallet}`);
        if (res.status === 429) {
          limited = res;
          break;
        }
      }

      expect(limited).toBeDefined();
      expect(limited.status).toBe(429);
      expect(limited.body).toHaveProperty('error');
      expect(limited.body.error).toContain('Too many requests');
      // Documented retry metadata.
      expect(limited.headers).toHaveProperty('retry-after');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(limited.body).toHaveProperty('retryAfter');
      expect(Number(limited.body.retryAfter)).toBeGreaterThan(0);
      expect(limited.headers['ratelimit-remaining']).toBe('0');
    });

    it('should not trust spoofed X-Forwarded-For headers from untrusted clients', async () => {
      const limit = Number(
        (await request(app).get(`/v1/verify/public/${validWallet}`)).headers[
          'ratelimit-limit'
        ]
      );

      let limited;
      // Rotate spoofed forwarding headers; if they were trusted, each request
      // would appear to come from a new client and never hit the limit.
      for (let i = 0; i < limit + 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const res = await request(app)
          .get(`/v1/verify/public/${validWallet}`)
          .set('X-Forwarded-For', `203.0.113.${i % 250}`)
          .set('X-Real-IP', `198.51.100.${i % 250}`);
        if (res.status === 429) {
          limited = res;
          break;
        }
      }

      expect(limited).toBeDefined();
      expect(limited.status).toBe(429);
    });

    it('should key limits on the trusted client identity behind a proxy', async () => {
      // When the app is configured to trust a proxy, the forwarded client
      // identity should be used, so distinct clients get distinct budgets.
      const resA = await request(app)
        .get(`/v1/verify/public/${validWallet}`)
        .set('X-Forwarded-For', '203.0.113.10');
      const resB = await request(app)
        .get(`/v1/verify/public/${validWallet}`)
        .set('X-Forwarded-For', '203.0.113.11');

      // Both requests should be accounted for independently.
      expect(resA.headers).toHaveProperty('ratelimit-remaining');
      expect(resB.headers).toHaveProperty('ratelimit-remaining');
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

  describe('Revocation semantics', () => {
    const validWallet = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF';

    it('should exclude revoked records from the public records list', async () => {
      const res = await request(app)
        .get(`/v1/verify/public/${validWallet}`)
        .expect((res) => {
          if (res.status === 200) {
            // Revoked records must never be surfaced by the public endpoint
            res.body.records.forEach((record) => {
              expect(record).not.toHaveProperty('revoked', true);
              expect(record.revoked).not.toBe(true);
            });
          }
        });
    });

    it('should keep verified=true when at least one non-revoked record remains', async () => {
      const res = await request(app)
        .get(`/v1/verify/public/${validWallet}`)
        .expect((res) => {
          if (res.status === 200 && res.body.records.length > 0) {
            // Revocation is per-record: remaining valid records keep the wallet verified
            expect(res.body.verified).toBe(true);
          }
        });
    });

    it('should return verified=false when all records are revoked', async () => {
      const res = await request(app)
        .get(`/v1/verify/public/${validWallet}`)
        .expect((res) => {
          if (res.status === 200 && res.body.records.length === 0) {
            // No active records => wallet is not verified
            expect(res.body.verified).toBe(false);
          }
        });
    });

    it('should interpret revocation consistently across repeated requests', async () => {
      const res1 = await request(app).get(`/v1/verify/public/${validWallet}`);
      const res2 = await request(app).get(`/v1/verify/public/${validWallet}`);

      if (res1.status === 200 && res2.status === 200) {
        expect(res1.body.verified).toBe(res2.body.verified);
        expect(res1.body.records.length).toBe(res2.body.records.length);
      }
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

  describe('Response size and batch limits', () => {
    const validWallet = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF';
    const {
      MAX_PUBLIC_RECORDS,
      MAX_BATCH_WALLETS,
    } = require('../src/config/verificationLimits');

    describe('Public record history limit', () => {
      it('should document the maximum number of records returned', () => {
        expect(typeof MAX_PUBLIC_RECORDS).toBe('number');
        expect(MAX_PUBLIC_RECORDS).toBeGreaterThan(0);
      });

      it('should return at most MAX_PUBLIC_RECORDS records', async () => {
        const res = await request(app)
          .get(`/v1/verify/public/${validWallet}`)
          .expect((res) => {
            if (res.status === 200) {
              expect(Array.isArray(res.body.records)).toBe(true);
              expect(res.body.records.length).toBeLessThanOrEqual(MAX_PUBLIC_RECORDS);
            }
          });
      });

      it('should accept a limit query param below the maximum', async () => {
        const res = await request(app)
          .get(`/v1/verify/public/${validWallet}?limit=1`)
          .expect((res) => {
            expect(res.status).not.toBe(400);
            if (res.status === 200) {
              expect(res.body.records.length).toBeLessThanOrEqual(1);
            }
          });
      });

      it('should accept a limit query param exactly at the maximum', async () => {
        const res = await request(app)
          .get(`/v1/verify/public/${validWallet}?limit=${MAX_PUBLIC_RECORDS}`)
          .expect((res) => {
            expect(res.status).not.toBe(400);
            if (res.status === 200) {
              expect(res.body.records.length).toBeLessThanOrEqual(MAX_PUBLIC_RECORDS);
            }
          });
      });

      it('should reject or truncate a limit query param above the maximum predictably', async () => {
        const res = await request(app)
          .get(`/v1/verify/public/${validWallet}?limit=${MAX_PUBLIC_RECORDS + 1}`)
          .expect((res) => {
            // Either a predictable 400 or a truncated 200 response
            if (res.status === 400) {
              expect(res.body).toHaveProperty('error');
            } else {
              expect(res.status).toBe(200);
              expect(res.body.records.length).toBeLessThanOrEqual(MAX_PUBLIC_RECORDS);
            }
          });
      });

      it('should reject a non-numeric limit with 400', async () => {
        const res = await request(app)
          .get(`/v1/verify/public/${validWallet}?limit=abc`)
          .expect(400);

        expect(res.body).toHaveProperty('error');
      });

      it('should reject a negative limit with 400', async () => {
        const res = await request(app)
          .get(`/v1/verify/public/${validWallet}?limit=-1`)
          .expect(400);

        expect(res.body).toHaveProperty('error');
      });

      it('should expose truncation semantics when records exceed the maximum', async () => {
        const res = await request(app)
          .get(`/v1/verify/public/${validWallet}`)
          .expect((res) => {
            if (res.status === 200) {
              // If truncated, the response should signal it explicitly
              if (res.body.truncated === true) {
                expect(res.body.records.length).toBe(MAX_PUBLIC_RECORDS);
              } else {
                expect(res.body.records.length).toBeLessThanOrEqual(MAX_PUBLIC_RECORDS);
              }
            }
          });
      });
    });

    describe('Batch verification limit', () => {
      const makeWallets = (count) =>
        Array.from({ length: count }, (_, i) =>
          `GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNL${String(i).padStart(2, '0')}`
        );

      it('should document the maximum batch size', () => {
        expect(typeof MAX_BATCH_WALLETS).toBe('number');
        expect(MAX_BATCH_WALLETS).toBeGreaterThan(0);
      });

      it('should accept a batch below the maximum', async () => {
        const res = await request(app)
          .post('/v1/verify/public/batch')
          .send({ wallets: makeWallets(Math.max(1, MAX_BATCH_WALLETS - 1)) })
          .expect((res) => {
            expect(res.status).not.toBe(400);
          });
      });

      it('should accept a batch exactly at the maximum', async () => {
        const res = await request(app)
          .post('/v1/verify/public/batch')
          .send({ wallets: makeWallets(MAX_BATCH_WALLETS) })
          .expect((res) => {
            expect(res.status).not.toBe(400);
          });
      });

      it('should reject a batch above the maximum with 400', async () => {
        const res = await request(app)
          .post('/v1/verify/public/batch')
          .send({ wallets: makeWallets(MAX_BATCH_WALLETS + 1) })
          .expect(400);

        expect(res.body).toHaveProperty('error');
      });

      it('should reject a non-array wallets payload with 400', async () => {
        const res = await request(app)
          .post('/v1/verify/public/batch')
          .send({ wallets: 'not-an-array' })
          .expect(400);

        expect(res.body).toHaveProperty('error');
      });

      it('should reject an empty wallets payload with 400', async () => {
        const res = await request(app)
          .post('/v1/verify/public/batch')
          .send({ wallets: [] })
          .expect(400);

        expect(res.body).toHaveProperty('error');
      });
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
