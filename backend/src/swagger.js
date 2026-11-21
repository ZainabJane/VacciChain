const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'VacciChain Backend API',
      version: '1.0.0',
      description: 'Blockchain-based vaccination records on Stellar — soulbound, verifiable, tamper-proof.',
    },
    servers: [
      {
        url: 'http://localhost:4000',
        description: 'Development server',
      },
      {
        url: 'http://backend:4000',
        description: 'Docker server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
        apiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'string',
            },
          },
        },
        VaccinationRecord: {
          type: 'object',
          properties: {
            vaccine_name: {
              type: 'string',
            },
            date_administered: {
              type: 'string',
              format: 'date-time',
            },
            issuer: {
              type: 'string',
            },
            timestamp: {
              type: 'string',
              format: 'date-time',
            },
            revoked: {
              type: 'boolean',
              description:
                'Whether this individual record has been revoked. Revocation is record-level and irreversible.',
            },
            revoked_at: {
              type: 'string',
              format: 'date-time',
              nullable: true,
              description: 'Timestamp of revocation, if revoked.',
            },
            revocation_reason: {
              type: 'string',
              nullable: true,
              description: 'Reason recorded for the revocation, if revoked.',
            },
          },
        },
        RevocationEvent: {
          type: 'object',
          description:
            'Emitted when a single vaccination record is revoked. Revocation affects only the targeted record; it does not revoke the wallet or the issuer. Revocation is irreversible.',
          properties: {
            record_id: {
              type: 'string',
              description: 'Identifier of the revoked record.',
            },
            issuer: {
              type: 'string',
              description: 'Issuer that originally issued the record.',
            },
            revoked_at: {
              type: 'string',
              format: 'date-time',
            },
            reason: {
              type: 'string',
            },
          },
        },
        DuplicateKey: {
          type: 'object',
          description:
            'Normalized uniqueness key for a vaccination record. Values are normalized (trimmed, lowercased, whitespace-collapsed) before comparison so formatting variants cannot bypass duplicate detection. Legitimate repeat doses are distinguished by dose number and date_administered.',
          properties: {
            patient_id: {
              type: 'string',
            },
            vaccine_name: {
              type: 'string',
              description: 'Normalized vaccine name.',
            },
            dose_number: {
              type: 'integer',
            },
            date_administered: {
              type: 'string',
              format: 'date',
            },
          },
        },
        IssuerState: {
          type: 'string',
          enum: ['pending', 'active', 'revoked'],
          description:
            'Issuer lifecycle state. Allowed transitions: pending -> active, active -> revoked, revoked -> active (re-add). Repeated identical operations are idempotent; disallowed transitions return an error.',
        },
        Issuer: {
          type: 'object',
          properties: {
            address: {
              type: 'string',
            },
            name: {
              type: 'string',
            },
            state: {
              $ref: '#/components/schemas/IssuerState',
            },
            updated_at: {
              type: 'string',
              format: 'date-time',
            },
          },
        },
        AdminRotationProposal: {
          type: 'object',
          description:
            'Proposal to rotate the administrator key. Requires threshold approval and a delay before acceptance; can be cancelled before acceptance.',
          properties: {
            proposal_id: {
              type: 'string',
            },
            proposed_admin: {
              type: 'string',
            },
            proposed_by: {
              type: 'string',
            },
            approvals: {
              type: 'integer',
            },
            threshold: {
              type: 'integer',
            },
            created_at: {
              type: 'string',
              format: 'date-time',
            },
            expires_at: {
              type: 'string',
              format: 'date-time',
            },
            status: {
              type: 'string',
              enum: ['pending', 'accepted', 'cancelled', 'expired'],
            },
          },
        },
        AdminRotationRequest: {
          type: 'object',
          required: ['proposed_admin'],
          properties: {
            proposed_admin: {
              type: 'string',
            },
            reason: {
              type: 'string',
            },
          },
        },
      },
    },
  },
  apis: ['./src/routes/*.js'],
};

const specs = swaggerJsdoc(options);

module.exports = specs;
