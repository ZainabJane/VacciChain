/**
 * Request validation middleware factories.
 *
 * Provides middleware for validating request bodies and query parameters
 * against Zod schemas. Strips unknown fields and returns detailed, stable
 * validation errors. Also exports reusable bounded Zod primitives so routes
 * can enforce consistent size, range, and depth limits.
 *
 * @module middleware/validate
 */
const { z } = require('zod');

/**
 * Default limits applied by the bounded primitives.
 */
const LIMITS = {
  STRING_MAX: 1000,
  ARRAY_MAX: 100,
  PAGINATION_MAX: 1000,
  OBJECT_DEPTH: 5,
};

/**
 * Build a stable 400 validation error response payload.
 *
 * @param {Object} err - A Zod error (has `issues`)
 * @returns {{error: string, details: Array<{path: string, message: string}>}}
 */
const buildValidationError = (err) => ({
  error: 'Validation failed',
  details: err.issues.map((e) => ({
    path: e.path.join('.'),
    message: e.message,
  })),
});

/**
 * Bounded string primitive.
 *
 * @param {Object} [options]
 * @param {number} [options.min=0] - Minimum length
 * @param {number} [options.max=LIMITS.STRING_MAX] - Maximum length
 * @returns {import('zod').ZodString}
 */
const boundedString = (options = {}) => {
  const { min = 0, max = LIMITS.STRING_MAX } = options;
  return z.string().min(min).max(max);
};

/**
 * Bounded array primitive.
 *
 * @param {import('zod').ZodTypeAny} itemSchema - Schema for array items
 * @param {Object} [options]
 * @param {number} [options.min=0] - Minimum length
 * @param {number} [options.max=LIMITS.ARRAY_MAX] - Maximum length
 * @returns {import('zod').ZodArray}
 */
const boundedArray = (itemSchema, options = {}) => {
  const { min = 0, max = LIMITS.ARRAY_MAX } = options;
  return z.array(itemSchema).min(min).max(max);
};

/**
 * Bounded pagination primitive.
 *
 * Accepts numeric strings (as they arrive in query params) or numbers and
 * coerces them to integers within a safe range.
 *
 * @param {Object} [options]
 * @param {number} [options.defaultPage=1] - Default page value
 * @param {number} [options.defaultLimit=20] - Default limit value
 * @param {number} [options.maxLimit=LIMITS.PAGINATION_MAX] - Maximum limit
 * @returns {import('zod').ZodObject}
 */
const boundedPagination = (options = {}) => {
  const {
    defaultPage = 1,
    defaultLimit = 20,
    maxLimit = LIMITS.PAGINATION_MAX,
  } = options;

  return z.object({
    page: z.coerce
      .number()
      .int()
      .min(1)
      .max(LIMITS.PAGINATION_MAX)
      .default(defaultPage),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(maxLimit)
      .default(defaultLimit),
  });
};

/**
 * Compute the maximum nesting depth of a plain object/array value.
 *
 * @param {*} value - Value to inspect
 * @returns {number} Depth (0 for primitives)
 */
const computeDepth = (value) => {
  if (value === null || typeof value !== 'object') {
    return 0;
  }
  if (Array.isArray(value)) {
    return 1 + value.reduce((max, v) => Math.max(max, computeDepth(v)), 0);
  }
  return (
    1 +
    Object.values(value).reduce((max, v) => Math.max(max, computeDepth(v)), 0)
  );
};

/**
 * Depth-limited object helper.
 *
 * Wraps a Zod object schema with a refinement that rejects values nested
 * deeper than the configured maximum depth.
 *
 * @param {import('zod').ZodObject} schema - The object schema to constrain
 * @param {Object} [options]
 * @param {number} [options.maxDepth=LIMITS.OBJECT_DEPTH] - Maximum nesting depth
 * @returns {import('zod').ZodEffects}
 */
const boundedObject = (schema, options = {}) => {
  const { maxDepth = LIMITS.OBJECT_DEPTH } = options;
  return schema.refine((value) => computeDepth(value) <= maxDepth, {
    message: `Object nesting exceeds maximum depth of ${maxDepth}`,
  });
};

/**
 * Request body validation middleware factory.
 *
 * Creates a middleware that validates the request body against a Zod schema.
 * Strips unknown fields and returns detailed validation errors.
 *
 * @param {Object} schema - A Zod schema object for validation
 *
 * @returns {Function} Express middleware function
 *
 * @example
 * const schema = z.object({
 *   email: z.string().email(),
 *   age: z.number().min(0),
 * });
 * app.post('/users', validate(schema), (req, res) => {
 *   // req.body is now validated and typed
 * });
 *
 * @throws {Error} 400 - Validation failed with detailed error messages
 *
 * @side-effects Modifies req.body to contain only validated fields
 */
const validate = (schema) => (req, res, next) => {
  try {
    // parse and strip unknown fields
    const validated = schema.parse(req.body);
    req.body = validated;
    next();
  } catch (err) {
    if (err.issues) {
      return res.status(400).json(buildValidationError(err));
    }
    next(err);
  }
};

/**
 * Query parameter validation middleware factory.
 *
 * Creates a middleware that validates the request query against a Zod schema.
 * Returns the same stable 400 error shape as {@link validate}.
 *
 * @param {Object} schema - A Zod schema object for query validation
 *
 * @returns {Function} Express middleware function
 *
 * @example
 * const schema = boundedPagination();
 * app.get('/items', validateQuery(schema), (req, res) => {
 *   // req.query is now validated and typed
 * });
 *
 * @throws {Error} 400 - Validation failed with detailed error messages
 *
 * @side-effects Replaces req.query with the validated values
 */
const validateQuery = (schema) => (req, res, next) => {
  try {
    const validated = schema.parse(req.query);
    // req.query may be a getter-only property on some Express versions;
    // assign defensively.
    try {
      req.query = validated;
    } catch (assignErr) {
      Object.defineProperty(req, 'query', {
        value: validated,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
    next();
  } catch (err) {
    if (err.issues) {
      return res.status(400).json(buildValidationError(err));
    }
    next(err);
  }
};

module.exports = validate;
module.exports.validate = validate;
module.exports.validateQuery = validateQuery;
module.exports.boundedString = boundedString;
module.exports.boundedArray = boundedArray;
module.exports.boundedPagination = boundedPagination;
module.exports.boundedObject = boundedObject;
module.exports.LIMITS = LIMITS;