/**
 * OpenAPI documentation for routes whose handlers don't carry their own
 * swagger-jsdoc block (#43). Picked up by `apis` in src/swagger.js and enforced by
 * `npm run docs:check`. All paths are served under /v1; the unversioned forms
 * 308-redirect there and are deprecated (`Deprecation: true`).
 *
 * Every error response uses the standard shape — see docs/api-errors.md.
 */

/**
 * @swagger
 * components:
 *   responses:
 *     Unauthenticated:
 *       description: Missing, invalid, expired, or wrong-issuer/audience JWT (UNAUTHENTICATED / TOKEN_INVALID)
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/Error' }
 *     Forbidden:
 *       description: Authenticated but not allowed (FORBIDDEN)
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/Error' }
 *     ValidationFailed:
 *       description: Invalid request body, params, or query (VALIDATION_FAILED)
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/Error' }
 *     NotFound:
 *       description: Resource not found (NOT_FOUND)
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/Error' }
 *     InternalError:
 *       description: Unexpected failure; the message is always generic (INTERNAL_ERROR)
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/Error' }
 *     RpcError:
 *       description: Stellar/Soroban dependency failed (RPC_ERROR)
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/Error' }
 *
 * /patient/register:
 *   post:
 *     summary: Register the caller's wallet in the on-chain patient allowlist
 *     tags: [Patient]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema: { type: object, additionalProperties: false, description: Empty body; the wallet comes from the JWT }
 *     responses:
 *       200:
 *         description: Registered
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 wallet: { type: string }
 *       400: { $ref: '#/components/responses/ValidationFailed' }
 *       401: { $ref: '#/components/responses/Unauthenticated' }
 *       500: { $ref: '#/components/responses/InternalError' }
 *
 * /patient/consent:
 *   post:
 *     summary: Record the caller's explicit consent to receive records
 *     tags: [Patient]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema: { type: object, additionalProperties: false }
 *     responses:
 *       200:
 *         description: Consent already on file
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 wallet: { type: string }
 *                 already_consented: { type: boolean }
 *       201:
 *         description: Consent recorded
 *       400: { $ref: '#/components/responses/ValidationFailed' }
 *       401: { $ref: '#/components/responses/Unauthenticated' }
 *
 * /patient/consent/{wallet}:
 *   get:
 *     summary: Consent status for a wallet
 *     description: >
 *       Patients may read only their own wallet. Issuers (re-verified against the
 *       on-chain allowlist on every call) and admins may read any wallet (#45).
 *       Previously unauthenticated.
 *     tags: [Patient]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: wallet, required: true, schema: { type: string }, description: Stellar public key }
 *     responses:
 *       200:
 *         description: Consent status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 wallet: { type: string }
 *                 consented: { type: boolean }
 *                 consented_at: { type: string, nullable: true }
 *       401: { $ref: '#/components/responses/Unauthenticated' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       502: { $ref: '#/components/responses/RpcError' }
 *
 * /events:
 *   get:
 *     summary: Recent indexed contract events
 *     tags: [Events]
 *     responses:
 *       200:
 *         description: Events
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 events: { type: array, items: { type: object } }
 *                 count: { type: integer }
 *
 * /onboarding/apply:
 *   post:
 *     summary: Apply to become an authorized issuer
 *     tags: [Onboarding]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, license_number, country, wallet]
 *             properties:
 *               name: { type: string }
 *               license_number: { type: string }
 *               country: { type: string }
 *               wallet: { type: string }
 *     responses:
 *       201:
 *         description: Application submitted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string }
 *                 status: { type: string, enum: [pending] }
 *                 message: { type: string }
 *       400: { $ref: '#/components/responses/ValidationFailed' }
 *       401: { $ref: '#/components/responses/Unauthenticated' }
 *       409: { description: A pending application already exists for this wallet }
 *
 * /onboarding/applications:
 *   get:
 *     summary: List issuer applications (admin)
 *     tags: [Onboarding]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: status, schema: { type: string, enum: [pending, approved, rejected] } }
 *     responses:
 *       200: { description: Applications }
 *       400: { $ref: '#/components/responses/ValidationFailed' }
 *       401: { $ref: '#/components/responses/Unauthenticated' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /onboarding/applications/{id}/review:
 *   post:
 *     summary: Approve or reject an issuer application (admin, multi-sig)
 *     tags: [Onboarding]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [decision]
 *             properties:
 *               decision: { type: string, enum: [approved, rejected] }
 *               reviewer_note: { type: string }
 *     responses:
 *       200:
 *         description: Reviewed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string }
 *                 status: { type: string }
 *                 wallet: { type: string }
 *       202: { description: Multi-sig approval pending }
 *       401: { $ref: '#/components/responses/Unauthenticated' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { description: Application already reviewed }
 *       502: { $ref: '#/components/responses/RpcError' }
 *
 * /admin/issuers:
 *   get:
 *     summary: List authorized issuers (admin)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Issuers
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { issuers: { type: array, items: { type: object } } } }
 *       401: { $ref: '#/components/responses/Unauthenticated' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       500: { $ref: '#/components/responses/InternalError' }
 *   post:
 *     summary: Authorize an issuer on-chain (admin)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [address], properties: { address: { type: string } } }
 *     responses:
 *       201:
 *         description: Authorized
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address: { type: string }
 *                 authorized: { type: boolean }
 *                 hash: { type: string }
 *       400: { $ref: '#/components/responses/ValidationFailed' }
 *       401: { $ref: '#/components/responses/Unauthenticated' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       500: { $ref: '#/components/responses/InternalError' }
 *
 * /admin/issuers/{wallet}:
 *   delete:
 *     summary: Revoke an issuer on-chain (admin)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: wallet, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Revoked
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 wallet: { type: string }
 *                 authorized: { type: boolean }
 *                 hash: { type: string }
 *       400: { $ref: '#/components/responses/ValidationFailed' }
 *       401: { $ref: '#/components/responses/Unauthenticated' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       500: { $ref: '#/components/responses/InternalError' }
 *
 * /admin/audit:
 *   get:
 *     summary: Paginated audit log (admin)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: from, schema: { type: string, format: date-time } }
 *       - { in: query, name: to, schema: { type: string, format: date-time } }
 *       - { in: query, name: offset, schema: { type: integer, minimum: 0 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1 } }
 *     responses:
 *       200:
 *         description: Audit entries
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 total: { type: integer }
 *                 offset: { type: integer }
 *                 limit: { type: integer }
 *                 entries: { type: array, items: { type: object } }
 *       400: { $ref: '#/components/responses/ValidationFailed' }
 *       401: { $ref: '#/components/responses/Unauthenticated' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /admin/api-keys:
 *   get:
 *     summary: List verifier API keys (admin; raw keys are never returned)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: API key metadata }
 *       401: { $ref: '#/components/responses/Unauthenticated' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   post:
 *     summary: Create a verifier API key (admin; raw key shown once)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [label], properties: { label: { type: string } } }
 *     responses:
 *       201:
 *         description: Created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string }
 *                 label: { type: string }
 *                 key: { type: string }
 *       400: { $ref: '#/components/responses/ValidationFailed' }
 *       401: { $ref: '#/components/responses/Unauthenticated' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /admin/api-keys/{id}:
 *   delete:
 *     summary: Revoke a verifier API key (admin)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Revoked
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { revoked: { type: boolean } } }
 *       401: { $ref: '#/components/responses/Unauthenticated' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /admin/jwt/rotate:
 *   post:
 *     summary: Rotate the JWT signing key at runtime (admin)
 *     description: See docs/jwt-key-rotation.md. The previous key keeps verifying for JWT_ROTATION_OVERLAP_SECONDS.
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               new_secret: { type: string, minLength: 32 }
 *               new_kid: { type: string }
 *               reload_from_env: { type: boolean }
 *     responses:
 *       200:
 *         description: Rotated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 rotated: { type: boolean }
 *                 method: { type: string, enum: [inline, env_reload] }
 *                 kid: { type: string }
 *       400: { $ref: '#/components/responses/ValidationFailed' }
 *       401: { $ref: '#/components/responses/Unauthenticated' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       500: { $ref: '#/components/responses/InternalError' }
 *
 * /admin/multisig/approve:
 *   post:
 *     summary: Approve a pending multi-sig proposal (admin key holder)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [proposal_id], properties: { proposal_id: { type: string } } }
 *     responses:
 *       200: { description: Approval recorded; includes approval count and status }
 *       400: { $ref: '#/components/responses/ValidationFailed' }
 *       401: { $ref: '#/components/responses/Unauthenticated' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /admin/multisig/proposals/{id}:
 *   get:
 *     summary: Multi-sig proposal status (admin)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Proposal }
 *       401: { $ref: '#/components/responses/Unauthenticated' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
module.exports = {};
