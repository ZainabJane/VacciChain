/**
 * Test suite for request body validation schemas.
 * Verifies that all POST endpoints have proper validation.
 */

const { sep10Schema, verifySchema } = require('../src/routes/schemas/auth.schemas');
const { issueSchema, revokeSchema } = require('../src/routes/schemas/vaccination.schemas');
const { addIssuerSchema, createApiKeySchema, rotateJwtSchema, approveProposalSchema } = require('../src/routes/schemas/admin.schemas');
const { registerSchema } = require('../src/routes/schemas/patient.schemas');
const { recordConsentSchema } = require('../src/routes/schemas/consent.schemas');
const { applySchema, reviewSchema } = require('../src/routes/schemas/onboarding.schemas');
const { paginationSchema } = require('../src/routes/schemas/common.schemas');

describe('Request Body Validation Schemas', () => {
  describe('Auth Schemas', () => {
    describe('sep10Schema', () => {
      it('should accept valid Stellar public key', () => {
        const result = sep10Schema.safeParse({
          public_key: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF',
        });
        expect(result.success).toBe(true);
      });

      it('should reject missing public_key', () => {
        const result = sep10Schema.safeParse({});
        expect(result.success).toBe(false);
        expect(result.error.issues[0].message).toContain('required');
      });

      it('should reject invalid Stellar public key', () => {
        const result = sep10Schema.safeParse({
          public_key: 'invalid-key',
        });
        expect(result.success).toBe(false);
      });

      it('should reject empty public_key', () => {
        const result = sep10Schema.safeParse({
          public_key: '',
        });
        expect(result.success).toBe(false);
      });
    });

    describe('verifySchema', () => {
      it('should accept valid transaction and nonce', () => {
        const result = verifySchema.safeParse({
          transaction: 'AAAAAgAAAABIW8...',
          nonce: 'abc123',
        });
        expect(result.success).toBe(true);
      });

      it('should reject missing transaction', () => {
        const result = verifySchema.safeParse({
          nonce: 'abc123',
        });
        expect(result.success).toBe(false);
        expect(result.error.issues[0].message).toContain('required');
      });

      it('should reject missing nonce', () => {
        const result = verifySchema.safeParse({
          transaction: 'AAAAAgAAAABIW8...',
        });
        expect(result.success).toBe(false);
        expect(result.error.issues[0].message).toContain('required');
      });

      it('should reject empty transaction', () => {
        const result = verifySchema.safeParse({
          transaction: '',
          nonce: 'abc123',
        });
        expect(result.success).toBe(false);
      });
    });
  });

  describe('Vaccination Schemas', () => {
    describe('issueSchema', () => {
      it('should accept valid vaccination issue request', () => {
        const result = issueSchema.safeParse({
          patient_address: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF',
          vaccine_name: 'Pfizer-BioNTech',
          date_administered: '2024-01-15T10:30:00Z',
          dose_number: 1,
          dose_series: 2,
        });
        expect(result.success).toBe(true);
      });

      it('should reject missing patient_address', () => {
        const result = issueSchema.safeParse({
          vaccine_name: 'Pfizer-BioNTech',
          date_administered: '2024-01-15T10:30:00Z',
        });
        expect(result.success).toBe(false);
        expect(result.error.issues[0].message).toContain('required');
      });

      it('should reject missing vaccine_name', () => {
        const result = issueSchema.safeParse({
          patient_address: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF',
          date_administered: '2024-01-15T10:30:00Z',
        });
        expect(result.success).toBe(false);
      });

      it('should reject missing date_administered', () => {
        const result = issueSchema.safeParse({
          patient_address: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF',
          vaccine_name: 'Pfizer-BioNTech',
        });
        expect(result.success).toBe(false);
      });

      it('should reject invalid date format', () => {
        const result = issueSchema.safeParse({
          patient_address: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF',
          vaccine_name: 'Pfizer-BioNTech',
          date_administered: 'not-a-date',
        });
        expect(result.success).toBe(false);
      });

      it('should reject non-integer dose_number', () => {
        const result = issueSchema.safeParse({
          patient_address: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF',
          vaccine_name: 'Pfizer-BioNTech',
          date_administered: '2024-01-15T10:30:00Z',
          dose_number: 1.5,
        });
        expect(result.success).toBe(false);
      });

      it('should reject dose_number less than 1', () => {
        const result = issueSchema.safeParse({
          patient_address: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF',
          vaccine_name: 'Pfizer-BioNTech',
          date_administered: '2024-01-15T10:30:00Z',
          dose_number: 0,
        });
        expect(result.success).toBe(false);
      });

      it('should reject dose_number greater than dose_series', () => {
        expect(issueSchema.safeParse({
          patient_address: 'GABC', vaccine_name: 'MMR', date_administered: '2024-01-15', dose_number: 3, dose_series: 2,
        }).success).toBe(false);
      });

      it('should allow optional dose fields', () => {
        const result = issueSchema.safeParse({
          patient_address: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF',
          vaccine_name: 'Pfizer-BioNTech',
          date_administered: '2024-01-15T10:30:00Z',
        });
        expect(result.success).toBe(true);
      });

      describe('date and timezone normalization', () => {
        const base = {
          patient_address: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF',
          vaccine_name: 'Pfizer-BioNTech',
        };

        const parseDate = (date_administered) =>
          issueSchema.safeParse({ ...base, date_administered });

        it('should accept a UTC timestamp at the start-of-day boundary', () => {
          const result = parseDate('2024-01-15T00:00:00Z');
          expect(result.success).toBe(true);
          expect(new Date(result.data.date_administered).toISOString()).toBe(
            '2024-01-15T00:00:00.000Z'
          );
        });

        it('should accept a UTC timestamp at the end-of-day boundary', () => {
          const result = parseDate('2024-01-15T23:59:59Z');
          expect(result.success).toBe(true);
          expect(new Date(result.data.date_administered).toISOString()).toBe(
            '2024-01-15T23:59:59.000Z'
          );
        });

        it('should accept a leap-day timestamp', () => {
          const result = parseDate('2024-02-29T12:00:00Z');
          expect(result.success).toBe(true);
          expect(new Date(result.data.date_administered).toISOString()).toBe(
            '2024-02-29T12:00:00.000Z'
          );
        });

        it('should reject a non-leap-year February 29th', () => {
          const result = parseDate('2023-02-29T12:00:00Z');
          expect(result.success).toBe(false);
        });

        it('should accept an explicit positive offset and normalize to UTC', () => {
          const result = parseDate('2024-01-15T10:30:00+05:30');
          expect(result.success).toBe(true);
          expect(new Date(result.data.date_administered).toISOString()).toBe(
            '2024-01-15T05:00:00.000Z'
          );
        });

        it('should accept an explicit negative offset and normalize to UTC', () => {
          const result = parseDate('2024-01-15T10:30:00-08:00');
          expect(result.success).toBe(true);
          expect(new Date(result.data.date_administered).toISOString()).toBe(
            '2024-01-15T18:30:00.000Z'
          );
        });

        it('should not shift an offset timestamp across a UTC day boundary', () => {
          const result = parseDate('2024-01-15T23:30:00-05:00');
          expect(result.success).toBe(true);
          expect(new Date(result.data.date_administered).toISOString()).toBe(
            '2024-01-16T04:30:00.000Z'
          );
        });

        it('should reject a timestamp without timezone information', () => {
          const result = parseDate('2024-01-15T10:30:00');
          expect(result.success).toBe(false);
        });

        it('should reject a date-only value for the timestamp field', () => {
          const result = parseDate('2024-01-15');
          expect(result.success).toBe(false);
        });

        it('should reject an ambiguous non-ISO date string', () => {
          const result = parseDate('01/15/2024');
          expect(result.success).toBe(false);
        });

        it('should preserve historical records without timezone shift', () => {
          const result = parseDate('1970-01-01T00:00:00Z');
          expect(result.success).toBe(true);
          expect(new Date(result.data.date_administered).toISOString()).toBe(
            '1970-01-01T00:00:00.000Z'
          );
        });

        it('should preserve pre-epoch historical records without timezone shift', () => {
          const result = parseDate('1960-06-15T08:15:00Z');
          expect(result.success).toBe(true);
          expect(new Date(result.data.date_administered).toISOString()).toBe(
            '1960-06-15T08:15:00.000Z'
          );
        });
      });
    });

    describe('revokeSchema', () => {
      it('should accept string token_id', () => {
        const result = revokeSchema.safeParse({
          token_id: '12345',
        });
        expect(result.success).toBe(true);
        expect(result.data.token_id).toBe('12345');
      });

      it('should accept number token_id and convert to string', () => {
        const result = revokeSchema.safeParse({
          token_id: 12345,
        });
        expect(result.success).toBe(true);
        expect(result.data.token_id).toBe('12345');
      });

      it('should reject missing token_id', () => {
        const result = revokeSchema.safeParse({});
        expect(result.success).toBe(false);
      });
    });
  });

  describe('Admin Schemas', () => {
    describe('addIssuerSchema', () => {
      it('should accept valid address', () => {
        const result = addIssuerSchema.safeParse({
          address: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF',
        });
        expect(result.success).toBe(true);
      });

      it('should reject missing address', () => {
        const result = addIssuerSchema.safeParse({});
        expect(result.success).toBe(false);
      });

      it('should reject empty address', () => {
        const result = addIssuerSchema.safeParse({
          address: '',
        });
        expect(result.success).toBe(false);
      });
    });

    describe('createApiKeySchema', () => {
      it('should accept valid label', () => {
        const result = createApiKeySchema.safeParse({
          label: 'My API Key',
        });
        expect(result.success).toBe(true);
      });

      it('should reject missing label', () => {
        const result = createApiKeySchema.safeParse({});
        expect(result.success).toBe(false);
      });

      it('should reject empty label', () => {
        const result = createApiKeySchema.safeParse({
          label: '',
        });
        expect(result.success).toBe(false);
      });

      it('should reject label exceeding max length', () => {
        const result = createApiKeySchema.safeParse({
          label: 'a'.repeat(256),
        });
        expect(result.success).toBe(false);
      });
    });

    describe('rotateJwtSchema', () => {
      it('should accept new_secret', () => {
        const result = rotateJwtSchema.safeParse({
          new_secret: 'a'.repeat(32),
        });
        expect(result.success).toBe(true);
      });

      it('should accept reload_from_env', () => {
        const result = rotateJwtSchema.safeParse({
          reload_from_env: true,
        });
        expect(result.success).toBe(true);
      });

      it('should reject both missing', () => {
        const result = rotateJwtSchema.safeParse({});
        expect(result.success).toBe(false);
      });

      it('should reject new_secret less than 32 chars', () => {
        const result = rotateJwtSchema.safeParse({
          new_secret: 'short',
        });
        expect(result.success).toBe(false);
      });
    });

    describe('approveProposalSchema', () => {
      it('should accept valid UUID proposal_id', () => {
        const result = approveProposalSchema.safeParse({
          proposal_id: '550e8400-e29b-41d4-a716-446655440000',
        });
        expect(result.success).toBe(true);
      });

      it('should reject missing proposal_id', () => {
        const result = approveProposalSchema.safeParse({});
        expect(result.success).toBe(false);
      });

      it('should reject invalid UUID', () => {
        const result = approveProposalSchema.safeParse({
          proposal_id: 'not-a-uuid',
        });
        expect(result.success).toBe(false);
      });
    });
  });

  describe('Patient Schemas', () => {
    describe('registerSchema', () => {
      it('should accept empty body', () => {
        const result = registerSchema.safeParse({});
        expect(result.success).toBe(true);
      });

      it('should reject unknown fields', () => {
        const result = registerSchema.safeParse({
          unknown_field: 'value',
        });
        expect(result.success).toBe(false);
      });
    });
  });

  describe('Consent Schemas', () => {
    describe('recordConsentSchema', () => {
      it('should accept empty body', () => {
        const result = recordConsentSchema.safeParse({});
        expect(result.success).toBe(true);
      });

      it('should reject unknown fields', () => {
        const result = recordConsentSchema.safeParse({
          unknown_field: 'value',
        });
        expect(result.success).toBe(false);
      });
    });
  });

  describe('Onboarding Schemas', () => {
    describe('applySchema', () => {
      it('should accept valid application', () => {
        const result = applySchema.safeParse({
          name: 'Health Clinic',
          license_number: 'HC-12345',
          country: 'US',
          wallet: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF',
        });
        expect(result.success).toBe(true);
      });

      it('should reject name too short', () => {
        const result = applySchema.safeParse({
          name: 'A',
          license_number: 'HC-12345',
          country: 'US',
          wallet: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF',
        });
        expect(result.success).toBe(false);
      });

      it('should reject name too long', () => {
        const result = applySchema.safeParse({
          name: 'a'.repeat(121),
          license_number: 'HC-12345',
          country: 'US',
          wallet: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF',
        });
        expect(result.success).toBe(false);
      });

      it('should reject wallet not 56 chars', () => {
        const result = applySchema.safeParse({
          name: 'Health Clinic',
          license_number: 'HC-12345',
          country: 'US',
          wallet: 'short',
        });
        expect(result.success).toBe(false);
      });

      it('should reject missing required fields', () => {
        const result = applySchema.safeParse({
          name: 'Health Clinic',
        });
        expect(result.success).toBe(false);
      });
    });

    describe('reviewSchema', () => {
      it('should accept approved decision', () => {
        const result = reviewSchema.safeParse({
          decision: 'approved',
        });
        expect(result.success).toBe(true);
      });

      it('should accept rejected decision', () => {
        const result = reviewSchema.safeParse({
          decision: 'rejected',
        });
        expect(result.success).toBe(true);
      });

      it('should accept with reviewer_note', () => {
        const result = reviewSchema.safeParse({
          decision: 'approved',
          reviewer_note: 'Looks good',
        });
        expect(result.success).toBe(true);
      });

      it('should reject invalid decision', () => {
        const result = reviewSchema.safeParse({
          decision: 'pending',
        });
        expect(result.success).toBe(false);
      });

      it('should reject missing decision', () => {
        const result = reviewSchema.safeParse({});
        expect(result.success).toBe(false);
      });

      it('should reject reviewer_note exceeding max length', () => {
        const result = reviewSchema.safeParse({
          decision: 'approved',
          reviewer_note: 'a'.repeat(501),
        });
        expect(result.success).toBe(false);
      });
    });
  });

  describe('Boundary Limits', () => {
    const VALID_WALLET = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF';

    const expectStable4xx = (result) => {
      expect(result.success).toBe(false);
      expect(result.error.issues.length).toBeGreaterThan(0);
      expect(result.error.issues[0].code).toBeTruthy();
    };

    describe('oversized strings', () => {
      it('rejects oversized vaccine_name in issueSchema', () => {
        expectStable4xx(issueSchema.safeParse({
          patient_address: VALID_WALLET,
          vaccine_name: 'a'.repeat(10000),
          date_administered: '2024-01-15T10:30:00Z',
        }));
      });

      it('rejects oversized transaction in verifySchema', () => {
        expectStable4xx(verifySchema.safeParse({
          transaction: 'A'.repeat(100000),
          nonce: 'abc123',
        }));
      });

      it('rejects oversized nonce in verifySchema', () => {
        expectStable4xx(verifySchema.safeParse({
          transaction: 'AAAAAgAAAABIW8...',
          nonce: 'a'.repeat(10000),
        }));
      });

      it('rejects oversized token_id in revokeSchema', () => {
        expectStable4xx(revokeSchema.safeParse({
          token_id: '1'.repeat(10000),
        }));
      });

      it('rejects oversized license_number in applySchema', () => {
        expectStable4xx(applySchema.safeParse({
          name: 'Health Clinic',
          license_number: 'L'.repeat(10000),
          country: 'US',
          wallet: VALID_WALLET,
        }));
      });

      it('rejects oversized new_secret in rotateJwtSchema', () => {
        expectStable4xx(rotateJwtSchema.safeParse({
          new_secret: 'a'.repeat(100000),
        }));
      });
    });

    describe('oversized arrays', () => {
      it('rejects array where string expected in createApiKeySchema', () => {
        expectStable4xx(createApiKeySchema.safeParse({
          label: new Array(1000).fill('a'),
        }));
      });

      it('rejects array where string expected in addIssuerSchema', () => {
        expectStable4xx(addIssuerSchema.safeParse({
          address: new Array(1000).fill(VALID_WALLET),
        }));
      });

      it('rejects array where string expected in sep10Schema', () => {
        expectStable4xx(sep10Schema.safeParse({
          public_key: new Array(1000).fill(VALID_WALLET),
        }));
      });
    });

    describe('nested objects', () => {
      it('rejects nested object where string expected in issueSchema', () => {
        expectStable4xx(issueSchema.safeParse({
          patient_address: VALID_WALLET,
          vaccine_name: { nested: { deep: 'value' } },
          date_administered: '2024-01-15T10:30:00Z',
        }));
      });

      it('rejects deeply nested object in applySchema', () => {
        let nested = 'value';
        for (let i = 0; i < 100; i += 1) {
          nested = { child: nested };
        }
        expectStable4xx(applySchema.safeParse({
          name: 'Health Clinic',
          license_number: 'HC-12345',
          country: 'US',
          wallet: nested,
        }));
      });

      it('rejects nested object in reviewSchema decision', () => {
        expectStable4xx(reviewSchema.safeParse({
          decision: { nested: 'approved' },
        }));
      });
    });

    describe('pagination values', () => {
      it('rejects negative page', () => {
        expectStable4xx(paginationSchema.safeParse({ page: -1, limit: 10 }));
      });

      it('rejects zero page', () => {
        expectStable4xx(paginationSchema.safeParse({ page: 0, limit: 10 }));
      });

      it('rejects oversized limit', () => {
        expectStable4xx(paginationSchema.safeParse({ page: 1, limit: 100000 }));
      });

      it('rejects non-integer limit', () => {
        expectStable4xx(paginationSchema.safeParse({ page: 1, limit: 10.5 }));
      });

      it('rejects string pagination values', () => {
        expectStable4xx(paginationSchema.safeParse({ page: 'abc', limit: 'xyz' }));
      });

      it('accepts boundary pagination values', () => {
        expect(paginationSchema.safeParse({ page: 1, limit: 1 }).success).toBe(true);
        expect(paginationSchema.safeParse({ page: 1, limit: 100 }).success).toBe(true);
      });
    });

    describe('boundary inputs accepted', () => {
      it('accepts max-length label in createApiKeySchema', () => {
        expect(createApiKeySchema.safeParse({ label: 'a'.repeat(255) }).success).toBe(true);
      });

      it('accepts max-length name in applySchema', () => {
        expect(applySchema.safeParse({
          name: 'a'.repeat(120),
          license_number: 'HC-12345',
          country: 'US',
          wallet: VALID_WALLET,
        }).success).toBe(true);
      });

      it('accepts max-length reviewer_note in reviewSchema', () => {
        expect(reviewSchema.safeParse({
          decision: 'approved',
          reviewer_note: 'a'.repeat(500),
        }).success).toBe(true);
      });
    });
  });
});
