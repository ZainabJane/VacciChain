const { z } = require('zod');
const crypto = require('crypto');

/**
 * Validation schemas for vaccination routes.
 * Co-located with vaccination.js for easy maintenance.
 */

const issueSchema = z.object({
  patient_address: z.string()
    .min(1, 'patient_address is required')
    .describe('Stellar address of patient'),
  vaccine_name: z.string()
    .min(1, 'vaccine_name is required')
    .max(256, 'vaccine_name must not exceed 256 characters')
    .describe('Name of the vaccine'),
  date_administered: z.string()
    .min(1, 'date_administered is required')
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
  token_id: z.union([z.string(), z.number()])
    .transform((val) => String(val))
    .describe('Token ID to revoke'),
});

/**
 * Pagination constants for vaccination list endpoints.
 * A single source of truth so routes and tests agree on defaults/limits.
 */
const VACCINATION_DEFAULT_PAGE_SIZE = 20;
const VACCINATION_MAX_PAGE_SIZE = 100;

/**
 * Coerce a query-string value into a positive integer.
 * Returns undefined when the value is absent or empty so defaults apply.
 */
function coercePositiveInt(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (Array.isArray(value)) {
    // Reject repeated query params (e.g. ?page=1&page=2) as ambiguous.
    return NaN;
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : NaN;
  }
  if (typeof value !== 'string') {
    return NaN;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  // Only allow plain decimal integers; reject "1.5", "1e3", "0x10", "+1", etc.
  if (!/^\d+$/.test(trimmed)) {
    return NaN;
  }
  return parseInt(trimmed, 10);
}

const paginationQuerySchema = z.object({
  page: z.preprocess(
    coercePositiveInt,
    z.number()
      .int('page must be an integer')
      .min(1, 'page must be at least 1')
      .default(1)
  ),
  limit: z.preprocess(
    coercePositiveInt,
    z.number()
      .int('limit must be an integer')
      .min(1, 'limit must be at least 1')
      .max(
        VACCINATION_MAX_PAGE_SIZE,
        `limit must not exceed ${VACCINATION_MAX_PAGE_SIZE}`
      )
      .default(VACCINATION_DEFAULT_PAGE_SIZE)
  ),
});

/**
 * Parse pagination params from req.query.
 *
 * @param {object} query - Express req.query object.
 * @returns {{ ok: true, page: number, limit: number }
 *          | { ok: false, status: number, error: string, details: Array }}
 */
function parsePaginationQuery(query) {
  const result = paginationQuerySchema.safeParse(query || {});
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    return {
      ok: false,
      status: 400,
      error: 'Invalid pagination parameters',
      details,
    };
  }
  return {
    ok: true,
    page: result.data.page,
    limit: result.data.limit,
  };
}

/**
 * Idempotency-Key header schema (#49).
 * Keys are opaque client-generated strings; we bound length and charset
 * to keep them safe for storage and logging.
 */
const idempotencyKeySchema = z.object({
  'idempotency-key': z.string()
    .min(1, 'Idempotency-Key header must not be empty')
    .max(255, 'Idempotency-Key header must not exceed 255 characters')
    .regex(
      /^[\x21-\x7E]+$/,
      'Idempotency-Key header must contain only printable ASCII characters'
    ),
});

/**
 * Parse and validate the Idempotency-Key header.
 *
 * @param {object} headers - Express req.headers object.
 * @returns {{ ok: true, key: string }
 *          | { ok: false, status: number, error: string }}
 */
function parseIdempotencyKey(headers) {
  const raw = headers || {};
  const value = raw['idempotency-key'] !== undefined
    ? raw['idempotency-key']
    : raw['Idempotency-Key'];
  const result = idempotencyKeySchema.safeParse({
    'idempotency-key': value,
  });
  if (!result.success) {
    return {
      ok: false,
      status: 400,
      error: result.error.issues[0]?.message || 'Invalid Idempotency-Key header',
    };
  }
  return { ok: true, key: result.data['idempotency-key'] };
}

/**
 * Deterministically serialize a value for hashing.
 * Sorts object keys recursively so semantically identical payloads
 * produce identical hashes regardless of key order.
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map(
    (key) => JSON.stringify(key) + ':' + stableStringify(value[key])
  );
  return '{' + parts.join(',') + '}';
}

/**
 * Compute a stable sha256 hash of a request payload.
 * Used by the idempotency middleware (#49) to detect key reuse
 * with a different payload.
 *
 * @param {*} payload - Request body (or any JSON-serializable value).
 * @returns {string} Hex-encoded sha256 digest.
 */
function hashPayload(payload) {
  const serialized = stableStringify(payload === undefined ? null : payload);
  return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
}

module.exports = {
  issueSchema,
  revokeSchema,
  paginationQuerySchema,
  idempotencyKeySchema,
  parsePaginationQuery,
  parseIdempotencyKey,
  hashPayload,
  stableStringify,
  VACCINATION_DEFAULT_PAGE_SIZE,
  VACCINATION_MAX_PAGE_SIZE,
};