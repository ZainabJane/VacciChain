/**
 * Request validation middleware factory.
 *
 * Creates a middleware that validates part of the request (body, query, or
 * params) against a Zod schema. Strips unknown fields and returns detailed
 * validation errors.
 *
 * @param {Object} schema - A Zod schema object for validation
 * @param {string} [source='body'] - Which request property to validate:
 *   'body', 'query', or 'params'
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
 * @example
 * const paginationSchema = z.object({
 *   page: z.coerce.number().int().min(1).default(1),
 *   limit: z.coerce.number().int().min(1).max(100).default(20),
 * });
 * app.get('/vaccinations', validate(paginationSchema, 'query'), (req, res) => {
 *   // req.query is now validated and typed
 * });
 *
 * @throws {Error} 400 - Validation failed with detailed error messages
 *
 * @side-effects Modifies req[source] to contain only validated fields
 */
const validate = (schema, source = 'body') => (req, res, next) => {
  try {
    // parse and strip unknown fields
    const validated = schema.parse(req[source]);
    req[source] = validated;
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
