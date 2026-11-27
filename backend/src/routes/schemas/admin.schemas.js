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

/**
 * Stellar public key: 56-character StrKey starting with 'G' (ed25519 public key).
 * Base32 alphabet (A-Z, 2-7).
 */
const stellarPublicKeySchema = z.string()
  .regex(/^G[A-Z2-7]{55}$/, 'must be a valid Stellar public key')
  .describe('Stellar public key (56-char StrKey starting with G)');

const addIssuerSchema = z.object({
  address: z.string()
    .min(1, 'address is required')
    .describe('Stellar public key of issuer to authorize'),
});

const createApiKeySchema = z.object({
  label: z.string()
    .min(1, 'label is required')
    .max(255, 'label must not exceed 255 characters')
    .describe('Human-readable label for the API key'),
});

const rotateJwtSchema = z.object({
  new_secret: z.string()
    .min(32, 'new_secret must be at least 32 characters')
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

/**
 * Propose an admin key rotation / recovery.
 * Requires the new admin address, the approval threshold, and the
 * activation delay (in seconds) before the rotation can be accepted.
 */
const proposeAdminRotationSchema = z.object({
  new_admin: stellarPublicKeySchema
    .describe('Stellar public key of the proposed new admin'),
  threshold: z.number()
    .int('threshold must be an integer')
    .min(1, 'threshold must be at least 1')
    .max(10, 'threshold must not exceed 10')
    .describe('Number of approvals required to accept the rotation'),
  delay_seconds: z.number()
    .int('delay_seconds must be an integer')
    .min(0, 'delay_seconds must be non-negative')
    .max(30 * 24 * 60 * 60, 'delay_seconds must not exceed 30 days')
    .describe('Activation delay in seconds before the rotation can be accepted'),
  emergency: z.boolean()
    .optional()
    .default(false)
    .describe('If true, marks the rotation as an emergency recovery request'),
  reason: z.string()
    .max(1024, 'reason must not exceed 1024 characters')
    .optional()
    .describe('Optional human-readable justification for the rotation'),
});

/**
 * Accept an admin rotation proposal once its delay has elapsed and
 * the threshold of approvals has been met.
 */
const acceptAdminRotationSchema = z.object({
  proposal_id: z.string()
    .min(1, 'proposal_id is required')
    .uuid('proposal_id must be a valid UUID')
    .describe('UUID of the admin rotation proposal to accept'),
});

/**
 * Cancel a pending admin rotation proposal.
 */
const cancelAdminRotationSchema = z.object({
  proposal_id: z.string()
    .min(1, 'proposal_id is required')
    .uuid('proposal_id must be a valid UUID')
    .describe('UUID of the admin rotation proposal to cancel'),
  reason: z.string()
    .min(1, 'reason is required')
    .max(1024, 'reason must not exceed 1024 characters')
    .describe('Human-readable reason for cancelling the rotation'),
});

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
  proposeAdminRotationSchema,
  acceptAdminRotationSchema,
  cancelAdminRotationSchema,
};