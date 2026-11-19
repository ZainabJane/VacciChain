const { faker } = require('@faker-js/faker');
const StellarSdk = require('@stellar/stellar-sdk');

/**
 * Generates a mock vaccination record.
 * @param {Object} overrides - Values to override in the generated record.
 * @returns {Object} A vaccination record object.
 */
const vaccinationRecordFactory = (overrides = {}) => {
  return {
    patient_address: overrides.patient_address || StellarSdk.Keypair.random().publicKey(),
    vaccine_name: overrides.vaccine_name || faker.helpers.arrayElement(['MMR', 'COVID-19', 'Hepatitis B', 'Influenza']),
    date_administered: overrides.date_administered || faker.date.recent().toISOString().split('T')[0],
    issuer_address: overrides.issuer_address || StellarSdk.Keypair.random().publicKey(),
    lot_number: overrides.lot_number || faker.string.alphanumeric(8).toUpperCase(),
    created_at: overrides.created_at || new Date().toISOString(),
    token_id: overrides.token_id !== undefined ? overrides.token_id : faker.number.int({ min: 1, max: 1000000 }),
    ...overrides
  };
};

/**
 * Generates N vaccination records with controlled, monotonically increasing
 * timestamps and token_ids so pagination tests can assert stable ordering
 * and boundary behavior.
 *
 * @param {number} count - Number of records to generate.
 * @param {Object} [options] - Generation options.
 * @param {Date|string|number} [options.startTime] - Base timestamp for the first record.
 * @param {number} [options.stepMs] - Milliseconds between consecutive records (default 1000).
 * @param {number} [options.startTokenId] - token_id for the first record (default 1).
 * @param {number} [options.tokenStep] - Increment between consecutive token_ids (default 1).
 * @param {Object} [options.overrides] - Values applied to every generated record.
 * @returns {Array<Object>} Array of vaccination records ordered by created_at asc.
 */
const vaccinationRecordsFactory = (count, options = {}) => {
  const {
    startTime = new Date('2024-01-01T00:00:00.000Z'),
    stepMs = 1000,
    startTokenId = 1,
    tokenStep = 1,
    overrides = {}
  } = options;

  const baseTime = startTime instanceof Date ? startTime.getTime() : new Date(startTime).getTime();

  return Array.from({ length: count }, (_, index) => {
    const createdAt = new Date(baseTime + index * stepMs).toISOString();
    const tokenId = startTokenId + index * tokenStep;
    return vaccinationRecordFactory({
      ...overrides,
      created_at: createdAt,
      token_id: tokenId
    });
  });
};

module.exports = vaccinationRecordFactory;
module.exports.vaccinationRecordFactory = vaccinationRecordFactory;
module.exports.vaccinationRecordsFactory = vaccinationRecordsFactory;