const { z } = require('zod');

/**
 * Validation schemas for vaccination routes.
 * Co-located with vaccination.js for easy maintenance.
 *
 * Duplicate key definition (must match the on-chain contract):
 * A vaccination record is considered a duplicate when the normalized tuple
 * (patient_address, vaccine_name, date_administered, dose_number) matches an
 * existing record. Normalization rules:
 *   - patient_address: trimmed (case preserved; Stellar addresses are case-sensitive)
 *   - vaccine_name: trimmed and lowercased
 *   - date_administered: parsed and normalized to a canonical ISO-8601 UTC string
 *   - dose_number: defaults to 1 when omitted
 * Legitimate repeat doses are distinguished by a different dose_number, so the
 * same vaccine on the same date with a different dose is NOT a duplicate.
 */

/**
 * Normalize a date string to a canonical ISO-8601 UTC representation.
 * Returns the original value if it cannot be parsed (validation handles errors).
 */
function normalizeDate(val) {
  const parsed = Date.parse(val);
  if (isNaN(parsed)) {
    return val;
  }
  return new Date(parsed).toISOString();
}

const issueSchema = z.object({
  patient_address: z.string()
    .min(1, 'patient_address is required')
    .transform((val) => val.trim())
    .describe('Stellar address of patient (trimmed; part of duplicate key)'),
  vaccine_name: z.string()
    .min(1, 'vaccine_name is required')
    .max(256, 'vaccine_name must not exceed 256 characters')
    .transform((val) => val.trim().toLowerCase())
    .describe('Name of the vaccine (trimmed and lowercased; part of duplicate key)'),
  date_administered: z.string()
    .min(1, 'date_administered is required')
    .refine((val) => !isNaN(Date.parse(val)), {
      message: 'date_administered must be a valid ISO date string',
    })
    .transform((val) => normalizeDate(val))
    .describe('ISO date string of when vaccine was administered (normalized to UTC ISO-8601; part of duplicate key)'),
  dose_number: z.number()
    .int('dose_number must be an integer')
    .min(1, 'dose_number must be at least 1')
    .optional()
    .transform((val) => (val === undefined ? 1 : val))
    .describe('Dose number in series (defaults to 1; part of duplicate key so repeat doses are distinct)'),
  dose_series: z.number()
    .int('dose_series must be an integer')
    .min(1, 'dose_series must be at least 1')
    .optional()
    .describe('Total doses in series'),
});

const revokeSchema = z.object({
  token_id: z.union([z.string(), z.number()])
    .transform((val) => String(val))
    .describe('Token ID to revoke'),
});

module.exports = {
  issueSchema,
  revokeSchema,
  normalizeDate,
};