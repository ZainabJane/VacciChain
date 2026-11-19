const { z } = require('zod');

/**
 * Validation schemas for admin routes.
 * Co-located with admin.js for easy maintenance.
 *
 * All schemas apply consistent size/range constraints:
 * - strings are bounded (min/max length)
 * - arrays are bounded (max items)
 * - pagination values are bounded (limit/offset ranges)
 * - nested objects are depth-limited
 */

// ---------------------------------------------------------------------------
// Shared limit constants
// ---------------------------------------------------------------------------

const LIMITS = {
  // String lengths
  SHORT_STRING_MAX: 255,
  MEDIUM_STRING_MAX: 1024,
  LONG_STRING_MAX: 4096,
  SECRET_MIN: 32,
  SECRET_MAX: 4096,

  // Arrays
  ARRAY_MAX: 100,

  // Pagination
  PAGE_LIMIT_MIN: 1,
  PAGE_LIMIT_MAX: 100,
  PAGE_LIMIT_DEFAULT: 20,
  PAGE_OFFSET_MIN: 0,
  PAGE_OFFSET_MAX: 1000000,

  // Nested object depth
  MAX_DEPTH: 5,
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Bounded string schema.
 * @param {object} opts
 * @param {number} [opts.min]
 * @param {number} [opts.max]
 * @param {string} [opts.label]
 */
function boundedString(opts = {}) {
  const { min = 1, max = LIMITS.SHORT_STRING_MAX, label = 'value' } = opts;
  return z.string()
    .min(min, `${label} must be at least ${min} character(s)`)
    .max(max, `${label} must not exceed ${max} characters`);
}

/**
 * Bounded array schema.
 * @param {import('zod').ZodTypeAny} itemSchema
 * @param {object} opts
 * @param {number} [opts.max]
 * @param {string} [opts.label]
 */
function boundedArray(itemSchema, opts = {}) {
  const { max = LIMITS.ARRAY_MAX, label = 'items' } = opts;
  return z.array(itemSchema)
    .max(max, `${label} must not exceed ${max} entries`);
}

/**
 * Pagination limit schema.
 */
const paginationLimitSchema = z.coerce.number()
  .int('limit must be an integer')
  .min(LIMITS.PAGE_LIMIT_MIN, `limit must be at least ${LIMITS.PAGE_LIMIT_MIN}`)
  .max(LIMITS.PAGE_LIMIT_MAX, `limit must not exceed ${LIMITS.PAGE_LIMIT_MAX}`)
  .default(LIMITS.PAGE_LIMIT_DEFAULT);

/**
 * Pagination offset schema.
 */
const paginationOffsetSchema = z.coerce.number()
  .int('offset must be an integer')
  .min(LIMITS.PAGE_OFFSET_MIN, `offset must be at least ${LIMITS.PAGE_OFFSET_MIN}`)
  .max(LIMITS.PAGE_OFFSET_MAX, `offset must not exceed ${LIMITS.PAGE_OFFSET_MAX}`)
  .default(LIMITS.PAGE_OFFSET_MIN);

/**
 * Compute the depth of a value (objects/arrays only).
 * @param {*} value
 * @param {number} [current]
 * @returns {number}
 */
function valueDepth(value, current = 0) {
  if (value === null || typeof value !== 'object') {
    return current;
  }
  let maxChild = current;
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    const childDepth = valueDepth(child, current + 1);
    if (childDepth > maxChild) {
      maxChild = childDepth;
    }
  }
  return maxChild;
}

/**
 * Refine a schema so nested objects do not exceed the max depth.
 * @param {import('zod').ZodTypeAny} schema
 * @param {number} [maxDepth]
 */
function withDepthLimit(schema, maxDepth = LIMITS.MAX_DEPTH) {
  return schema.refine(
    (data) => valueDepth(data) <= maxDepth,
    { message: `nested object depth must not exceed ${maxDepth}` }
  );
}

// ---------------------------------------------------------------------------
// Write schemas
// ---------------------------------------------------------------------------

const addIssuerSchema = withDepthLimit(z.object({
  address: boundedString({
    min: 1,
    max: LIMITS.SHORT_STRING_MAX,
    label: 'address',
  }).describe('Stellar public key of issuer to authorize'),
}).strict());

const createApiKeySchema = withDepthLimit(z.object({
  label: boundedString({
    min: 1,
    max: LIMITS.SHORT_STRING_MAX,
    label: 'label',
  }).describe('Human-readable label for the API key'),
}).strict());

const rotateJwtSchema = withDepthLimit(z.object({
  new_secret: boundedString({
    min: LIMITS.SECRET_MIN,
    max: LIMITS.SECRET_MAX,
    label: 'new_secret',
  })
    .optional()
    .describe('New JWT signing secret (min 32 chars)'),
  new_kid: boundedString({
    min: 1,
    max: LIMITS.SHORT_STRING_MAX,
    label: 'new_kid',
  })
    .optional()
    .describe('Optional key ID for the new secret'),
  reload_from_env: z.boolean()
    .optional()
    .describe('If true, reload JWT secret from environment'),
}).strict().refine(
  (data) => data.new_secret || data.reload_from_env,
  { message: 'Either new_secret or reload_from_env must be provided' }
));

const approveProposalSchema = withDepthLimit(z.object({
  proposal_id: boundedString({
    min: 1,
    max: LIMITS.SHORT_STRING_MAX,
    label: 'proposal_id',
  })
    .uuid('proposal_id must be a valid UUID')
    .describe('UUID of the multi-sig proposal to approve'),
}).strict());

// ---------------------------------------------------------------------------
// Query schemas (admin list endpoints)
// ---------------------------------------------------------------------------

const auditLogQuerySchema = withDepthLimit(z.object({
  limit: paginationLimitSchema,
  offset: paginationOffsetSchema,
  action: boundedString({
    min: 1,
    max: LIMITS.SHORT_STRING_MAX,
    label: 'action',
  }).optional(),
  actor: boundedString({
    min: 1,
    max: LIMITS.SHORT_STRING_MAX,
    label: 'actor',
  }).optional(),
  from: boundedString({
    min: 1,
    max: LIMITS.MEDIUM_STRING_MAX,
    label: 'from',
  }).optional(),
  to: boundedString({
    min: 1,
    max: LIMITS.MEDIUM_STRING_MAX,
    label: 'to',
  }).optional(),
}).strict());

const apiKeysQuerySchema = withDepthLimit(z.object({
  limit: paginationLimitSchema,
  offset: paginationOffsetSchema,
  label: boundedString({
    min: 1,
    max: LIMITS.SHORT_STRING_MAX,
    label: 'label',
  }).optional(),
  active: z.enum(['true', 'false'])
    .optional()
    .describe('Filter by active status'),
}).strict());

module.exports = {
  // limits & helpers (exported for reuse/testing)
  LIMITS,
  boundedString,
  boundedArray,
  paginationLimitSchema,
  paginationOffsetSchema,
  withDepthLimit,

  // write schemas
  addIssuerSchema,
  createApiKeySchema,
  rotateJwtSchema,
  approveProposalSchema,

  // query schemas
  auditLogQuerySchema,
  apiKeysQuerySchema,
};