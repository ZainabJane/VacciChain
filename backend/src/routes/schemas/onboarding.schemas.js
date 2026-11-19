const { z } = require('zod');

/**
 * Validation schemas for onboarding routes.
 * Co-located with onboarding.js for easy maintenance.
 */

/**
 * Bounded string helper: enforces min/max length and rejects
 * oversized inputs with a stable 4xx validation error.
 */
const boundedString = ({ min = 0, max, message } = {}) => {
  let schema = z.string();
  if (min > 0) {
    schema = schema.min(min, message || `must be at least ${min} characters`);
  }
  if (typeof max === 'number') {
    schema = schema.max(max, message || `must not exceed ${max} characters`);
  }
  return schema;
};

const applySchema = z.object({
  name: boundedString({
    min: 2,
    max: 120,
    message: 'name must be between 2 and 120 characters',
  }).describe('Organization name'),
  license_number: boundedString({
    min: 1,
    max: 60,
    message: 'license_number must be between 1 and 60 characters',
  }).describe('Healthcare provider license number'),
  country: boundedString({
    min: 2,
    max: 60,
    message: 'country must be between 2 and 60 characters',
  }).describe('Country of operation'),
  wallet: boundedString({
    min: 56,
    max: 56,
    message: 'wallet must be exactly 56 characters (Stellar address)',
  }).describe('Stellar public key for the issuer'),
});

const reviewSchema = z.object({
  decision: z.enum(['approved', 'rejected'])
    .describe('Approval decision'),
  reviewer_note: boundedString({
    max: 500,
    message: 'reviewer_note must not exceed 500 characters',
  })
    .optional()
    .describe('Optional note from reviewer'),
});

/**
 * Query schema for GET /applications.
 * Bounds the status filter and pagination values so oversized or
 * invalid query parameters return a stable 4xx response.
 */
const listApplicationsQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected'])
    .optional()
    .describe('Filter applications by status'),
  limit: z.coerce.number()
    .int('limit must be an integer')
    .min(1, 'limit must be at least 1')
    .max(100, 'limit must not exceed 100')
    .optional()
    .describe('Maximum number of results to return'),
  offset: z.coerce.number()
    .int('offset must be an integer')
    .min(0, 'offset must be at least 0')
    .max(100000, 'offset must not exceed 100000')
    .optional()
    .describe('Number of results to skip'),
});

module.exports = {
  boundedString,
  applySchema,
  reviewSchema,
  listApplicationsQuerySchema,
};