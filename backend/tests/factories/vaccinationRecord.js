const { faker } = require('@faker-js/faker');
const StellarSdk = require('@stellar/stellar-sdk');

/**
 * Generates a mock vaccination record.
 *
 * Duplicate key definition (see backlog #80):
 * A vaccination record is considered a duplicate when the normalized tuple
 * (patient_address, vaccine_name, date_administered, dose_number, dose_series)
 * matches an existing record. Normalization rules:
 *  - patient_address / issuer_address: trimmed, case-preserved (Stellar keys are case-sensitive)
 *  - vaccine_name: trimmed, lowercased, internal whitespace collapsed
 *  - date_administered: normalized to ISO date (YYYY-MM-DD)
 *  - dose_number: coerced to integer
 *  - dose_series: trimmed, lowercased
 *
 * Legitimate repeat doses are distinguished by dose_number / dose_series, so
 * the same patient may receive the same vaccine on the same date with a
 * different dose number without being flagged as a duplicate.
 *
 * @param {Object} overrides - Values to override in the generated record.
 * @returns {Object} A vaccination record object.
 */
const vaccinationRecordFactory = (overrides = {}) => {
  const record = {
    patient_address: overrides.patient_address || StellarSdk.Keypair.random().publicKey(),
    vaccine_name: overrides.vaccine_name || faker.helpers.arrayElement(['MMR', 'COVID-19', 'Hepatitis B', 'Influenza']),
    date_administered: overrides.date_administered || faker.date.recent().toISOString().split('T')[0],
    issuer_address: overrides.issuer_address || StellarSdk.Keypair.random().publicKey(),
    lot_number: overrides.lot_number || faker.string.alphanumeric(8).toUpperCase(),
    dose_number: overrides.dose_number !== undefined ? overrides.dose_number : 1,
    dose_series: overrides.dose_series || faker.helpers.arrayElement(['primary', 'booster', 'annual']),
    ...overrides
  };

  return record;
};

/**
 * Normalizes a vaccination record's duplicate-key fields consistently with the
 * API and contract definitions. Used by tests to assert that formatting
 * variants collapse to the same duplicate key.
 *
 * @param {Object} record - A vaccination record.
 * @returns {Object} The normalized duplicate key tuple.
 */
const normalizeVaccinationRecordKey = (record = {}) => {
  const normalizeString = (value) =>
    typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : value;

  const normalizeDate = (value) => {
    if (!value) return value;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toISOString().split('T')[0];
  };

  const normalizeDoseNumber = (value) => {
    if (value === undefined || value === null || value === '') return value;
    const num = Number(value);
    return Number.isNaN(num) ? value : Math.trunc(num);
  };

  return {
    patient_address: typeof record.patient_address === 'string' ? record.patient_address.trim() : record.patient_address,
    vaccine_name: normalizeString(record.vaccine_name),
    date_administered: normalizeDate(record.date_administered),
    dose_number: normalizeDoseNumber(record.dose_number),
    dose_series: normalizeString(record.dose_series)
  };
};

/**
 * Produces a formatting variant of a vaccination record that is semantically
 * equivalent under normalization (e.g. different casing/whitespace in
 * vaccine_name, alternate date format, string dose_number).
 *
 * @param {Object} record - Base vaccination record.
 * @returns {Object} A semantically equivalent variant.
 */
const vaccinationRecordVariantFactory = (record = {}) => {
  const base = vaccinationRecordFactory(record);
  const variant = { ...base };

  if (typeof base.vaccine_name === 'string') {
    variant.vaccine_name = `  ${base.vaccine_name.toUpperCase().replace(/\s+/g, '   ')}  `;
  }

  if (typeof base.date_administered === 'string') {
    const parsed = new Date(base.date_administered);
    if (!Number.isNaN(parsed.getTime())) {
      variant.date_administered = parsed.toISOString();
    }
  }

  if (base.dose_number !== undefined && base.dose_number !== null) {
    variant.dose_number = String(base.dose_number);
  }

  if (typeof base.dose_series === 'string') {
    variant.dose_series = ` ${base.dose_series.toUpperCase()} `;
  }

  return variant;
};

module.exports = vaccinationRecordFactory;
module.exports.vaccinationRecordFactory = vaccinationRecordFactory;
module.exports.normalizeVaccinationRecordKey = normalizeVaccinationRecordKey;
module.exports.vaccinationRecordVariantFactory = vaccinationRecordVariantFactory;