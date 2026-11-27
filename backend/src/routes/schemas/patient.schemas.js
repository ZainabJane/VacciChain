const { z } = require('zod');

/**
 * Validation schemas for patient routes.
 * Co-located with patient.js for easy maintenance.
 */

// Shared limits for request bodies (kept in sync with global body limits).
const MAX_DEPTH = 5;
const MAX_KEYS = 50;

/**
 * Builds a strict, depth-limited object schema.
 * Rejects nested objects/arrays beyond MAX_DEPTH and objects with more than
 * MAX_KEYS keys, producing stable 4xx validation errors.
 */
function depthLimitedObject(shape = {}, depth = 0) {
  if (depth > MAX_DEPTH) {
    return z.never();
  }

  const builtShape = {};
  for (const [key, value] of Object.entries(shape)) {
    builtShape[key] = value;
  }

  return z
    .object(builtShape)
    .strict()
    .superRefine((value, ctx) => {
      const keys = Object.keys(value);
      if (keys.length > MAX_KEYS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Object must not have more than ${MAX_KEYS} keys`,
        });
      }
      for (const key of keys) {
        const field = value[key];
        if (field && typeof field === 'object') {
          if (Array.isArray(field)) {
            if (depth + 1 > MAX_DEPTH) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [key],
                message: `Nesting depth must not exceed ${MAX_DEPTH}`,
              });
            }
          } else if (depth + 1 > MAX_DEPTH) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [key],
              message: `Nesting depth must not exceed ${MAX_DEPTH}`,
            });
          }
        }
      }
    });
}

// POST /patient/register has no body parameters, but we define an empty schema for consistency
const registerSchema = depthLimitedObject({});

module.exports = {
  registerSchema,
  depthLimitedObject,
};