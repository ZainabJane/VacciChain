const { z } = require('zod');

/**
 * Validation schemas for vaccination routes.
 * Co-located with vaccination.js for easy maintenance.
 */

const MAX_ADDRESS_LENGTH = 128;
const MAX_VACCINE_NAME_LENGTH = 256;
const MAX_DATE_LENGTH = 64;
const MAX_TOKEN_ID_LENGTH = 128;

const boundedString = (max, fieldName) =>
  z.string()
    .min(1, `${fieldName} is required`)
    .max(max, `${fieldName} must not exceed ${max} characters`);

const issueSchema = z.object({
  patient_address: boundedString(MAX_ADDRESS_LENGTH, 'patient_address')
    .describe('Stellar address of patient'),
  vaccine_name: boundedString(MAX_VACCINE_NAME_LENGTH, 'vaccine_name')
    .describe('Name of the vaccine'),
  date_administered: boundedString(MAX_DATE_LENGTH, 'date_administered')
    .refine((val) => !isNaN(Date.parse(val)), {
      message: 'date_administered must be a valid ISO date string',
    })
    .describe('ISO date string of when vaccine was administered'),
  dose_number: z.number()
    .int('dose_number must be an integer')
    .min(1, 'dose_number must be at least 1')
    .optional()
    .describe('Dose number in series'),
  dose_series: z.number()
    .int('dose_series must be an integer')
    .min(1, 'dose_series must be at least 1')
    .optional()
    .describe('Total doses in series'),
});

const revokeSchema = z.object({
  token_id: z.union([
    boundedString(MAX_TOKEN_ID_LENGTH, 'token_id'),
    z.number().int('token_id must be an integer'),
  ])
    .transform((val) => String(val))
    .describe('Token ID to revoke'),
});

const paginationQuerySchema = z.object({
  page: z.coerce.number()
    .int('page must be an integer')
    .min(1, 'page must be at least 1')
    .max(1000000, 'page must not exceed 1000000')
    .optional()
    .default(1),
  limit: z.coerce.number()
    .int('limit must be an integer')
    .min(1, 'limit must be at least 1')
    .max(100, 'limit must not exceed 100')
    .optional()
    .default(20),
});

module.exports = {
  issueSchema,
  revokeSchema,
  paginationQuerySchema,
};