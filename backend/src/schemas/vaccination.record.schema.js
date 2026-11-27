const { z } = require('zod');

/**
 * Versioned vaccination record schema + mapping layer (#41).
 *
 * Keeps API request payloads, stored index data, and contract record
 * representations aligned as fields evolve. Each version defines required,
 * optional and legacy fields; `normalizeVaccinationRecord` maps older records
 * forward to the current version while `validateVaccinationRecord` rejects
 * records that carry unknown or invalid fields.
 */

const SCHEMA_VERSIONS = ['1', '2'];
const CURRENT_VERSION = '2';

// Fields allowed on any record version. Anything not in this set is rejected.
const ALLOWED_FIELDS = new Set([
  'token_id',
  'patient_address',
  'vaccine_name',
  'date_administered',
  'dose_number',
  'dose_series',
  'issuer',
  'timestamp',
  'version',
]);

// Legacy v1 record shape (pre-versioning).
const LegacyRecordSchema = z.object({
  token_id: z.string().min(1),
  patient_address: z.string().min(1),
  vaccine_name: z.string().min(1).max(256),
  date_administered: z.string().datetime({ offset: true }),
  issuer: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
  version: z.literal('1').optional(),
});

// Current v2 record shape.
const RecordSchema = z.object({
  token_id: z.string().min(1),
  patient_address: z.string().min(1),
  vaccine_name: z.string().min(1).max(256),
  date_administered: z.string().datetime({ offset: true }),
  dose_number: z.number().int().min(1).optional(),
  dose_series: z.number().int().min(1).optional(),
  issuer: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
  version: z.union([z.literal('1'), z.literal('2')]).optional(),
});

/**
 * Normalize a stored/ingested record to the current schema version.
 * v1 records gain the optional v2 fields as null and are marked version 2.
 * @param {Object} raw - raw record object
 * @returns {Object} normalized record
 */
function normalizeVaccinationRecord(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const normalized = { ...raw, version: CURRENT_VERSION };
  if (normalized.version === '1' || raw.version === '1') {
    normalized.dose_number = normalized.dose_number ?? null;
    normalized.dose_series = normalized.dose_series ?? null;
  }
  return normalized;
}

/**
 * Validate a vaccination record and normalize it to the current version.
 * Rejects unknown fields and records that fail the current shape.
 * @param {Object} raw - raw record object
 * @returns {{ valid: boolean, data?: Object, error?: string | string[] }}
 */
function validateVaccinationRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, error: 'Record must be a non-null object' };
  }

  const unknown = Object.keys(raw).filter(key => !ALLOWED_FIELDS.has(key));
  if (unknown.length) {
    return { valid: false, error: `Unknown field(s): ${unknown.join(', ')}` };
  }

  const parsed = RecordSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      valid: false,
      error: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`),
    };
  }

  return { valid: true, data: normalizeVaccinationRecord(parsed.data) };
}

module.exports = {
  SCHEMA_VERSIONS,
  CURRENT_VERSION,
  ALLOWED_FIELDS,
  LegacyRecordSchema,
  RecordSchema,
  normalizeVaccinationRecord,
  validateVaccinationRecord,
};
