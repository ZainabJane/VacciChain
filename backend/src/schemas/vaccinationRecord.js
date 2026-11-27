/**
 * Versioned vaccination record schema, shared by the API, indexer and contract readers.
 * See docs/vaccination-record-schema.md for the field table.
 */
const StellarSdk = require('@stellar/stellar-sdk');
const { z } = require('zod');
const logger = require('../logger');

const CURRENT_SCHEMA_VERSION = 1;
// Mirrors MAX_STRING_LENGTH in contracts/src/lib.rs, which counts UTF-8 bytes.
const MAX_STRING_BYTES = 100;
const MAX_U32 = 0xffffffff;

// Old field name -> canonical (contract) field name.
const LEGACY_ALIASES = {
  patient_address: 'patient',
  issuer_address: 'issuer',
  tokenId: 'token_id',
};

const contractString = (field) => z.string({ error: `${field} is required` })
  .min(1, `${field} is required`)
  .refine((v) => Buffer.byteLength(v, 'utf8') <= MAX_STRING_BYTES, {
    message: `${field} must not exceed ${MAX_STRING_BYTES} bytes`,
  });

const dateString = contractString('date_administered')
  .refine((v) => !Number.isNaN(Date.parse(v)), {
    message: 'date_administered must be a valid ISO date string',
  });

const dose = (field) => z.number()
  .int(`${field} must be an integer`)
  .min(1, `${field} must be at least 1`)
  .max(MAX_U32, `${field} must fit in a u32`);

/** POST /v1/vaccination/issue. Unknown fields are rejected, not dropped. */
const issueRequestV1 = z.strictObject({
  schema_version: z.literal(CURRENT_SCHEMA_VERSION).optional(),
  patient_address: z.string({ error: 'patient_address is required' })
    .min(1, 'patient_address is required'),
  vaccine_name: contractString('vaccine_name'),
  date_administered: dateString,
  dose_number: dose('dose_number').optional(),
  dose_series: dose('dose_series').optional(),
}).refine((r) => r.dose_number === undefined || r.dose_series === undefined
  || r.dose_number <= r.dose_series, {
  path: ['dose_number'],
  message: 'dose_number must not exceed dose_series',
});

const u64 = z.union([z.string().min(1), z.number().int().nonnegative()]);

/** Canonical record, as returned by the API. Legacy extras are optional. */
const recordV1 = z.strictObject({
  schema_version: z.literal(CURRENT_SCHEMA_VERSION),
  token_id: u64,
  patient: z.string().min(1),
  vaccine_name: z.string().min(1),
  // Not a parsed date: the contract never validated it, so older values may be free text.
  date_administered: z.string(),
  issuer: z.string().min(1),
  timestamp: z.number().int().nonnegative().nullable(),
  revoked: z.boolean(),
  dose_number: z.number().int().nonnegative().nullable(),
  dose_series: z.number().int().nonnegative().nullable(),
  lot_number: z.string().optional(),
  tx_hash: z.string().optional(),
});

/** Make SDK-native values JSON safe. u64 values become strings. */
function jsonSafe(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  }
  return value;
}

function applyAliases(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const name = LEGACY_ALIASES[key] || key;
    // A canonical field always wins over its alias.
    if (name !== key && raw[name] !== undefined) continue;
    out[name] = value;
  }
  return out;
}

/** Map a contract or older record to the current schema. Throws ZodError if invalid. */
function toRecord(raw) {
  const r = jsonSafe(applyAliases(raw));
  return recordV1.parse({
    ...r,
    // Records without a version predate versioning and share the v1 layout.
    schema_version: r.schema_version ?? CURRENT_SCHEMA_VERSION,
    timestamp: r.timestamp == null ? null : Number(r.timestamp),
    revoked: r.revoked ?? false,
    dose_number: r.dose_number ?? null,
    dose_series: r.dose_series ?? null,
  });
}

/**
 * Map contract records for a response. A record that does not match is still
 * returned (JSON safe) and logged, so on-chain data is never hidden from its owner.
 */
function toApiRecords(records) {
  return (Array.isArray(records) ? records : []).map((raw) => {
    try {
      return toRecord(raw);
    } catch (err) {
      logger.warn('vaccination record does not match schema', { issues: err.issues?.map((i) => i.path.join('.')) });
      return jsonSafe(raw);
    }
  });
}

/**
 * Map a mint event payload to its indexed form. Accepts the contract tuple
 * (patient, vaccine_name, issuer, timestamp) as an ScVal or array, the older
 * positional object ({"0": ..., "1": ...}), and named objects.
 */
function toIndexedMint(value) {
  let v = value;
  if (v instanceof StellarSdk.xdr.ScVal) v = StellarSdk.scValToNative(v);
  v = v ?? {};
  if (Array.isArray(v) || (typeof v === 'object' && '1' in v)) {
    v = { patient: v[0], vaccine_name: v[1], issuer: v[2], timestamp: v[3] };
  }
  const mapped = jsonSafe(applyAliases(v));
  if (mapped.timestamp != null) mapped.timestamp = Number(mapped.timestamp);
  return { ...mapped, schema_version: mapped.schema_version ?? CURRENT_SCHEMA_VERSION };
}

module.exports = {
  CURRENT_SCHEMA_VERSION, issueRequestV1, recordV1, toRecord, toApiRecords, toIndexedMint,
};
