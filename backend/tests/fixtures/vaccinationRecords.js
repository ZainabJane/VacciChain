// Centralized vaccination record fixtures for backend tests.

const { PATIENT_WALLET, ISSUER_WALLET } = require('./wallets');

module.exports = {
  // Happy path: a fully populated vaccination record
  RECORD_COVID: {
    token_id: 'token-001',
    patient_address: PATIENT_WALLET,
    vaccine_name: 'COVID-19',
    date_administered: '2024-01-15',
    issuer_address: ISSUER_WALLET,
    lot_number: 'LOT-ABC123',
    dose_number: 1,
    dose_series: 'primary',
    tx_hash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  },

  // Happy path: a second record for the same patient (different vaccine)
  RECORD_FLU: {
    token_id: 'token-002',
    patient_address: PATIENT_WALLET,
    vaccine_name: 'Influenza',
    date_administered: '2023-10-01',
    issuer_address: ISSUER_WALLET,
    lot_number: 'LOT-FLU999',
    dose_number: 1,
    dose_series: 'annual',
    tx_hash: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
  },

  // Happy path: valid issue request payload (POST /vaccination/issue body)
  ISSUE_PAYLOAD: {
    patient_address: PATIENT_WALLET,
    vaccine_name: 'COVID-19',
    date_administered: '2024-01-15',
    dose_number: 1,
    dose_series: 'primary',
  },

  // Edge case: issue payload with a future date
  ISSUE_PAYLOAD_FUTURE_DATE: {
    patient_address: PATIENT_WALLET,
    vaccine_name: 'COVID-19',
    date_administered: '2099-12-31',
    dose_number: 1,
    dose_series: 'primary',
  },

  // Duplicate detection: exact duplicate of ISSUE_PAYLOAD (must be rejected)
  ISSUE_PAYLOAD_EXACT_DUPLICATE: {
    patient_address: PATIENT_WALLET,
    vaccine_name: 'COVID-19',
    date_administered: '2024-01-15',
    dose_number: 1,
    dose_series: 'primary',
  },

  // Duplicate detection: semantically equivalent vaccine name (case variant)
  ISSUE_PAYLOAD_DUPLICATE_CASE_VARIANT: {
    patient_address: PATIENT_WALLET,
    vaccine_name: 'covid-19',
    date_administered: '2024-01-15',
    dose_number: 1,
    dose_series: 'primary',
  },

  // Duplicate detection: semantically equivalent vaccine name (whitespace variant)
  ISSUE_PAYLOAD_DUPLICATE_WHITESPACE_VARIANT: {
    patient_address: PATIENT_WALLET,
    vaccine_name: '  COVID-19  ',
    date_administered: '2024-01-15',
    dose_number: 1,
    dose_series: 'primary',
  },

  // Duplicate detection: semantically equivalent date (ISO datetime for same day)
  ISSUE_PAYLOAD_DUPLICATE_DATE_VARIANT: {
    patient_address: PATIENT_WALLET,
    vaccine_name: 'COVID-19',
    date_administered: '2024-01-15T00:00:00.000Z',
    dose_number: 1,
    dose_series: 'primary',
  },

  // Legitimate repeat dose: same vaccine/series, next dose number, later date
  ISSUE_PAYLOAD_REPEAT_DOSE: {
    patient_address: PATIENT_WALLET,
    vaccine_name: 'COVID-19',
    date_administered: '2024-02-15',
    dose_number: 2,
    dose_series: 'primary',
  },

  // Legitimate repeat dose: annual booster in a later series
  ISSUE_PAYLOAD_BOOSTER_DOSE: {
    patient_address: PATIENT_WALLET,
    vaccine_name: 'COVID-19',
    date_administered: '2025-01-15',
    dose_number: 1,
    dose_series: 'booster-2025',
  },

  // Edge case: issue payload missing required fields
  ISSUE_PAYLOAD_MISSING_VACCINE: {
    patient_address: PATIENT_WALLET,
    date_administered: '2024-01-15',
    dose_number: 1,
    dose_series: 'primary',
  },

  // Empty case: no records found for a wallet
  EMPTY_RECORDS_RESPONSE: {
    data: [],
    total: 0,
    page: 1,
    limit: 20,
  },

  // Happy path: paginated records response
  PAGINATED_RECORDS_RESPONSE: {
    data: [
      {
        token_id: 'token-001',
        vaccine_name: 'COVID-19',
        date_administered: '2024-01-15',
        issuer_address: ISSUER_WALLET,
        dose_number: 1,
        dose_series: 'primary',
      },
    ],
    total: 1,
    page: 1,
    limit: 20,
  },
};
