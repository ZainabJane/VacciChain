/**
 * Shared redaction utility for client-side diagnostics.
 *
 * Strips access tokens, patient identifiers, and vaccination record details
 * from objects/strings before logging or transmission. Handles nested objects,
 * arrays, and Error instances safely.
 */

const REDACTED = '[REDACTED]';

// Keys whose values must always be redacted (case-insensitive, matched as
// substrings so e.g. "accessToken", "auth_token", "idToken" all match).
const SENSITIVE_KEY_PATTERNS = [
  'token',
  'authorization',
  'auth',
  'password',
  'passwd',
  'secret',
  'apikey',
  'api_key',
  'cookie',
  'session',
  'credential',
  'bearer',
  // Patient identifiers
  'patientid',
  'patient_id',
  'patientname',
  'patient_name',
  'mrn',
  'ssn',
  'socialsecurity',
  'social_security',
  'dob',
  'dateofbirth',
  'date_of_birth',
  'birthdate',
  'birth_date',
  'email',
  'phone',
  'phonenumber',
  'phone_number',
  'address',
  'firstname',
  'first_name',
  'lastname',
  'last_name',
  'fullname',
  'full_name',
  // Vaccination record details
  'vaccine',
  'vaccination',
  'immunization',
  'lotnumber',
  'lot_number',
  'lot',
  'dose',
  'dosage',
  'manufacturer',
  'administered',
  'administereddate',
  'administered_date',
  'expiration',
  'expiry',
  'record',
  'medicalrecord',
  'medical_record',
  'diagnosis',
  'medication',
  'prescription',
];

// Patterns for redacting sensitive values embedded in free-form strings.
const STRING_PATTERNS = [
  // Bearer tokens
  { regex: /(bearer\s+)[A-Za-z0-9._\-+/=]+/gi, replacement: `$1${REDACTED}` },
  // JWT-like tokens
  {
    regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replacement: REDACTED,
  },
  // key=value / key: value pairs for sensitive keys
  {
    regex:
      /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|token|authorization|password|secret|api[_-]?key|session[_-]?id)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
    replacement: `$1$2${REDACTED}`,
  },
  // Email addresses
  {
    regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    replacement: REDACTED,
  },
  // Phone numbers (loose match)
  {
    regex: /(?:\+?\d[\d\s().-]{7,}\d)/g,
    replacement: REDACTED,
  },
];

const MAX_DEPTH = 8;

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[\s-]/g, '_');
}

function isSensitiveKey(key) {
  const normalized = normalizeKey(key);
  const compact = normalized.replace(/_/g, '');
  return SENSITIVE_KEY_PATTERNS.some((pattern) => {
    const p = pattern.replace(/_/g, '');
    return normalized.includes(pattern) || compact.includes(p);
  });
}

/**
 * Redact sensitive substrings from a plain string.
 * @param {string} value
 * @returns {string}
 */
export function redactString(value) {
  if (typeof value !== 'string') {
    return value;
  }
  let result = value;
  for (const { regex, replacement } of STRING_PATTERNS) {
    result = result.replace(regex, replacement);
  }
  return result;
}

/**
 * Recursively redact sensitive fields from a value.
 * @param {*} value
 * @param {number} [depth]
 * @param {WeakSet} [seen]
 * @returns {*}
 */
export function redact(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) {
    return value;
  }

  if (depth > MAX_DEPTH) {
    return '[MaxDepth]';
  }

  const type = typeof value;

  if (type === 'string') {
    return redactString(value);
  }

  if (type === 'number' || type === 'boolean' || type === 'bigint') {
    return value;
  }

  if (type === 'function') {
    return '[Function]';
  }

  if (type === 'symbol') {
    return value.toString();
  }

  // Errors: preserve name/message/stack but redact their contents.
  if (value instanceof Error) {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    const redactedError = {
      name: redactString(value.name || 'Error'),
      message: redactString(value.message || ''),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
    // Include own enumerable custom properties (e.g. error.cause, error.code).
    for (const key of Object.keys(value)) {
      if (key === 'name' || key === 'message' || key === 'stack') {
        continue;
      }
      redactedError[key] = isSensitiveKey(key)
        ? REDACTED
        : redact(value[key], depth + 1, seen);
    }
    if (value.cause !== undefined) {
      redactedError.cause = redact(value.cause, depth + 1, seen);
    }
    return redactedError;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    return value.map((item) => redact(item, depth + 1, seen));
  }

  if (type === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);

    // Handle Map
    if (value instanceof Map) {
      const out = {};
      for (const [k, v] of value.entries()) {
        const key = String(k);
        out[key] = isSensitiveKey(key) ? REDACTED : redact(v, depth + 1, seen);
      }
      return out;
    }

    // Handle Set
    if (value instanceof Set) {
      return Array.from(value).map((item) => redact(item, depth + 1, seen));
    }

    const out = {};
    for (const key of Object.keys(value)) {
      if (isSensitiveKey(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = redact(value[key], depth + 1, seen);
      }
    }
    return out;
  }

  return value;
}

/**
 * Produce a redacted, JSON-safe string suitable for logging or transmission.
 * @param {*} value
 * @returns {string}
 */
export function redactToString(value) {
  try {
    return JSON.stringify(redact(value));
  } catch (err) {
    return `[Unserializable: ${redactString(String(err && err.message))}]`;
  }
}

/**
 * Convenience wrapper that redacts arguments and forwards to console.
 * Use instead of console.* for diagnostics that may contain sensitive data.
 */
export const safeConsole = {
  log: (...args) => console.log(...args.map((a) => redact(a))),
  info: (...args) => console.info(...args.map((a) => redact(a))),
  warn: (...args) => console.warn(...args.map((a) => redact(a))),
  error: (...args) => console.error(...args.map((a) => redact(a))),
  debug: (...args) => console.debug(...args.map((a) => redact(a))),
};

export default redact;