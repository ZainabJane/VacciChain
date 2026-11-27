const { z } = require('zod');
const crypto = require('crypto');
const { issueRequestV1 } = require('../../schemas/vaccinationRecord');

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
 *   - date_administered: strict YYYY-MM-DD calendar date (timezone-independent)
 *   - dose_number: defaults to 1 when omitted
 * Legitimate repeat doses are distinguished by a different dose_number, so the
 * same vaccine on the same date with a different dose is NOT a duplicate.
 *
 * Date & timezone semantics
 * -------------------------
 * Two distinct kinds of temporal values are accepted:
 *
 * 1. Date-only fields (e.g. `date_administered`)
 *    - Format: strict `YYYY-MM-DD` (ISO 8601 calendar date).
 *    - No time component and no timezone offset are allowed. Values such as
 *      `2024-01-01T00:00:00Z`, `2024-01-01T00:00:00+02:00`, `2024-1-1`,
 *      `01/01/2024`, or `2024-02-30` are rejected as ambiguous or invalid.
 *    - Date-only values are timezone-independent: they represent a calendar
 *      day and are never shifted across time zones. They are stored and
 *      indexed verbatim (as the same `YYYY-MM-DD` string) so that issuer
 *      input, storage, and display always agree.
 *    - Leap dates are validated against the real Gregorian calendar
 *      (e.g. `2024-02-29` is valid, `2023-02-29` is not).
 *
 * 2. Timestamp fields (e.g. any `*_at` / `*_timestamp` field)
 *    - Format: strict ISO 8601 date-time with an explicit timezone designator
 *      (either `Z` or a numeric offset like `+02:00` / `-05:30`).
 *    - Timestamps without an offset (e.g. `2024-01-01T12:00:00`) are rejected
 *      because they are ambiguous across time zones.
 *    - Accepted timestamps are normalized to UTC (`...Z`) so that issuer
 *      input, storage, and indexing cannot shift across time zones.
 */

// Matches a strict calendar date: YYYY-MM-DD with zero-padded month/day.
const DATE_ONLY_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

// Matches a strict ISO 8601 date-time that MUST include a timezone designator
// (either `Z` or a numeric offset `±HH:MM`). Fractional seconds are optional.
const ISO_TIMESTAMP_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Returns true when the given year/month/day form a real Gregorian calendar
 * date. Handles leap years correctly (divisible by 4, except centuries not
 * divisible by 400).
 */
function isValidCalendarDate(year, month, day) {
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;

  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [
    31,
    isLeapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  return day <= daysInMonth[month - 1];
}

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

/**
 * Strict date-only schema: `YYYY-MM-DD`.
 * Rejects timestamps, offsets, non-zero-padded values, and invalid calendar
 * dates (including invalid leap dates). Values are timezone-independent and
 * returned unchanged.
 */
const dateOnlySchema = z
  .string()
  .describe(
    'Date-only value in strict ISO 8601 calendar format YYYY-MM-DD. ' +
      'Must not include a time component or timezone offset. ' +
      'Represents a calendar day and is never shifted across time zones.'
  )
  .superRefine((val, ctx) => {
    const match = DATE_ONLY_REGEX.exec(val);
    if (!match) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'must be a date-only value in YYYY-MM-DD format ' +
          '(timestamps and timezone offsets are not allowed)',
      });
      return;
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);

    if (!isValidCalendarDate(year, month, day)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must be a valid calendar date (e.g. leap dates are checked)',
      });
    }
  });

/**
 * Strict ISO 8601 timestamp schema with an explicit timezone designator.
 * Accepts `Z` or numeric offsets (`±HH:MM`), rejects offset-less timestamps,
 * and normalizes the accepted value to UTC (`...Z`).
 */
const isoUtcTimestampSchema = z
  .string()
  .describe(
    'Timestamp in strict ISO 8601 format with an explicit timezone ' +
      'designator (Z or ±HH:MM offset), e.g. 2024-01-01T12:00:00Z or ' +
      '2024-01-01T14:00:00+02:00. Offset-less timestamps are rejected. ' +
      'Accepted values are normalized to UTC.'
  )
  .superRefine((val, ctx) => {
    const match = ISO_TIMESTAMP_REGEX.exec(val);
    if (!match) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'must be an ISO 8601 timestamp with an explicit timezone ' +
          'designator (Z or ±HH:MM), e.g. 2024-01-01T12:00:00Z',
      });
      return;
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);

    if (!isValidCalendarDate(year, month, day)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must contain a valid calendar date',
      });
      return;
    }

    if (hour > 23 || minute > 59 || second > 59) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must contain a valid time of day (00:00:00–23:59:59)',
      });
      return;
    }

    const offset = match[8];
    if (offset !== 'Z') {
      const offsetHours = Number(offset.slice(1, 3));
      const offsetMinutes = Number(offset.slice(4, 6));
      if (offsetHours > 23 || offsetMinutes > 59) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'must contain a valid timezone offset',
        });
      }
    }
  })
  .transform((val) => {
    // Normalize to UTC. The regex guarantees a valid, offset-qualified
    // timestamp, so Date parsing is deterministic here.
    return new Date(val).toISOString();
  });

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
  date_administered: dateOnlySchema
    .describe(
      'Date-only value (YYYY-MM-DD) of when the vaccine was administered. ' +
        'Timezone-independent; timestamps and offsets are rejected. ' +
        'Part of duplicate key.'
    ),
  dose_number: z.number()
    .int('dose_number must be an integer')
    .min(1, 'dose_number must be at least 1')
    .max(4294967295, 'dose_number must fit in an unsigned 32-bit integer')
    .optional()
    .transform((val) => (val === undefined ? 1 : val))
    .describe('Dose number in series (defaults to 1; part of duplicate key so repeat doses are distinct)'),
  dose_series: z.number()
    .int('dose_series must be an integer')
    .min(1, 'dose_series must be at least 1')
    .max(4294967295, 'dose_series must fit in an unsigned 32-bit integer')
    .optional()
    .describe('Total doses in series'),
}).refine((r) => r.dose_number === undefined || r.dose_series === undefined || r.dose_number <= r.dose_series, {
  message: 'dose_number must not exceed dose_series',
  path: ['dose_number'],
});

const revokeSchema = z.object({
  token_id: z.union([
    boundedString(MAX_TOKEN_ID_LENGTH, 'token_id'),
    z.number().int('token_id must be an integer'),
  ])
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
  issueSchema: issueRequestV1,
  revokeSchema,
  dateOnlySchema,
  normalizeDate,
  isoUtcTimestampSchema,
  paginationQuerySchema,
  idempotencyKeySchema,
  parsePaginationQuery,
  parseIdempotencyKey,
  hashPayload,
  stableStringify,
  VACCINATION_DEFAULT_PAGE_SIZE,
  VACCINATION_MAX_PAGE_SIZE,
};