const { z } = require('zod');

/**
 * Validation schemas for admin routes.
 * Co-located with admin.js for easy maintenance.
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
  new_kid: z.string()
    .optional()
    .describe('Optional key ID for the new secret'),
  reload_from_env: z.boolean()
    .optional()
    .describe('If true, reload JWT secret from environment'),
}).refine(
  (data) => data.new_secret || data.reload_from_env,
  { message: 'Either new_secret or reload_from_env must be provided' }
);

const approveProposalSchema = z.object({
  proposal_id: z.string()
    .min(1, 'proposal_id is required')
    .uuid('proposal_id must be a valid UUID')
    .describe('UUID of the multi-sig proposal to approve'),
});

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
  addIssuerSchema,
  createApiKeySchema,
  rotateJwtSchema,
  approveProposalSchema,
  proposeAdminRotationSchema,
  acceptAdminRotationSchema,
  cancelAdminRotationSchema,
};