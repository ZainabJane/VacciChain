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

  // Edge case: leap day (2024 is a leap year) - valid date-only value
  ISSUE_PAYLOAD_LEAP_DATE: {
    patient_address: PATIENT_WALLET,
    vaccine_name: 'COVID-19',
    date_administered: '2024-02-29',
  },

  // Edge case: invalid leap day (2023 is not a leap year) - must be rejected
  ISSUE_PAYLOAD_INVALID_LEAP_DATE: {
    patient_address: PATIENT_WALLET,
    vaccine_name: 'COVID-19',
    date_administered: '2023-02-29',
  },

  // Edge case: UTC boundary - date-only value at the start of the UTC day
  ISSUE_PAYLOAD_UTC_BOUNDARY_START: {
    patient_address: PATIENT_WALLET,
    vaccine_name: 'COVID-19',
    date_administered: '2024-01-01',
  },

  // Edge case: UTC boundary - date-only value at the end of the UTC day
  ISSUE_PAYLOAD_UTC_BOUNDARY_END: {
    patient_address: PATIENT_WALLET,
    vaccine_name: 'COVID-19',
    date_administered: '2024-12-31',
  },

  // Edge case: ambiguous timestamp with a non-UTC offset - must be rejected
  ISSUE_PAYLOAD_OFFSET_TIMESTAMP: {
    patient_address: PATIENT_WALLET,
    vaccine_name: 'COVID-19',
    date_administered: '2024-01-15T23:30:00-05:00',
  },

  // Edge case: ambiguous timestamp with a UTC designator - must be rejected
  ISSUE_PAYLOAD_UTC_TIMESTAMP: {
    patient_address: PATIENT_WALLET,
    vaccine_name: 'COVID-19',
    date_administered: '2024-01-15T00:00:00Z',
  },

  // Edge case: ambiguous non-ISO date format - must be rejected
  ISSUE_PAYLOAD_AMBIGUOUS_DATE_FORMAT: {
    patient_address: PATIENT_WALLET,
    vaccine_name: 'COVID-19',
    date_administered: '01/15/2024',
  },

  // Edge case: historical record with a date-only value
  RECORD_HISTORICAL: {
    token_id: 'token-historical-001',
    patient_address: PATIENT_WALLET,
    vaccine_name: 'Smallpox',
    date_administered: '1975-06-30',
    issuer_address: ISSUER_WALLET,
    lot_number: 'LOT-HIST001',
    tx_hash: 'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
  },

  // Edge case: record on a leap day
  RECORD_LEAP_DATE: {
    token_id: 'token-leap-001',
    patient_address: PATIENT_WALLET,
    vaccine_name: 'COVID-19',
    date_administered: '2024-02-29',
    issuer_address: ISSUER_WALLET,
    lot_number: 'LOT-LEAP001',
    tx_hash: 'd4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5',
  },

  // Empty case: no records found for a wallet
  EMPTY_RECORDS_RESPONSE: {
    data: [],
    total: 0,
    page: 1,
    limit: 20,
    has_more: false,
    next_page: null,
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
    has_more: false,
    next_page: null,
  },

  // Boundary case: first page of a multi-page result set
  PAGINATED_RECORDS_FIRST_PAGE: {
    data: [
      {
        token_id: 'token-001',
        vaccine_name: 'COVID-19',
        date_administered: '2024-01-15',
        issuer_address: ISSUER_WALLET,
      },
      {
        token_id: 'token-002',
        vaccine_name: 'Influenza',
        date_administered: '2023-10-01',
        issuer_address: ISSUER_WALLET,
      },
    ],
    total: 3,
    page: 1,
    limit: 2,
    has_more: true,
    next_page: 2,
  },

  // Boundary case: last page of a multi-page result set
  PAGINATED_RECORDS_LAST_PAGE: {
    data: [
      {
        token_id: 'token-003',
        vaccine_name: 'Tetanus',
        date_administered: '2023-05-20',
        issuer_address: ISSUER_WALLET,
      },
    ],
    total: 3,
    page: 2,
    limit: 2,
    has_more: false,
    next_page: null,
  },
};
