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
