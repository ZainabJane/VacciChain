const { z } = require('zod');

/**
 * Validation schemas for consent routes.
 * Co-located with consent.js for easy maintenance.
 */

/**
 * Shared helper: builds a strict, depth-limited object schema.
 *
 * Ensures that any payload (including nested objects/arrays) is rejected
 * with a stable 4xx response when it exceeds the allowed nesting depth.
 * This keeps validation consistent across routes, not only for JSON body
 * parsing limits.
 *
 * @param {object} shape - Zod shape for the object.
 * @param {object} [options]
 * @param {number} [options.maxDepth=3] - Maximum allowed nesting depth.
 * @returns {import('zod').ZodTypeAny}
 */
function depthLimitedStrictObject(shape, { maxDepth = 3 } = {}) {
  const base = z.object(shape).strict();

  // Recursively enforce a maximum nesting depth on any value.
  const depthCheck = (value, depth) => {
    if (depth > maxDepth) {
      return false;
    }
    if (Array.isArray(value)) {
      return value.every((item) => depthCheck(item, depth + 1));
    }
    if (value !== null && typeof value === 'object') {
      return Object.values(value).every((item) => depthCheck(item, depth + 1));
    }
    return true;
  };

  return base.superRefine((value, ctx) => {
    if (!depthCheck(value, 1)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Payload exceeds maximum nesting depth of ${maxDepth}`,
      });
    }
  });
}

// POST /patient/consent has no body parameters, but we define an empty schema for consistency.
// Uses the shared depth-limited strict object helper so oversized/nested payloads
// are rejected with a stable 4xx response.
const recordConsentSchema = depthLimitedStrictObject({});

module.exports = {
  recordConsentSchema,
  depthLimitedStrictObject,
};