const StellarSdk = require('@stellar/stellar-sdk');
const { issueRequestV1, toRecord, toApiRecords, toIndexedMint } = require('../src/schemas/vaccinationRecord');

const req = { patient_address: 'GP', vaccine_name: 'Flu', date_administered: '2024-01-15' };
const onChain = {
  token_id: 18446744073709551615n, patient: 'GP', vaccine_name: 'Flu', date_administered: '2024-01-15',
  issuer: 'GI', timestamp: 1700000000n, schema_version: 1, revoked: false, dose_number: 1, dose_series: 2,
};

describe('issue request', () => {
  it('accepts required-only and full requests', () => {
    expect(issueRequestV1.safeParse(req).success).toBe(true);
    expect(issueRequestV1.safeParse({ ...req, schema_version: 1, dose_number: 1, dose_series: 2 }).success).toBe(true);
  });
  it.each([
    ['unknown field', { token_id: 1 }],
    ['unsupported version', { schema_version: 2 }],
    ['vaccine name over the contract limit', { vaccine_name: 'a'.repeat(101) }],
    ['multi-byte name over the limit', { vaccine_name: 'é'.repeat(51) }],
    ['invalid date', { date_administered: 'nope' }],
    ['fractional dose', { dose_number: 1.5 }],
    ['dose past series', { dose_number: 3, dose_series: 2 }],
    ['null vaccine', { vaccine_name: null }],
  ])('rejects %s', (_n, patch) => {
    expect(issueRequestV1.safeParse({ ...req, ...patch }).success).toBe(false);
  });
});

describe('record mapping', () => {
  it('maps contract records without losing u64 precision', () => {
    expect(toRecord(onChain)).toEqual({ ...onChain, token_id: '18446744073709551615', timestamp: 1700000000 });
  });
  it('upgrades a legacy record', () => {
    expect(toRecord({
      token_id: 'token-001', patient_address: 'GP', issuer_address: 'GI',
      vaccine_name: 'Flu', date_administered: '2020-01-01', lot_number: 'L', tx_hash: 'h',
    })).toEqual({
      token_id: 'token-001', patient: 'GP', issuer: 'GI', vaccine_name: 'Flu', date_administered: '2020-01-01',
      lot_number: 'L', tx_hash: 'h', schema_version: 1, timestamp: null, revoked: false, dose_number: null, dose_series: null,
    });
  });
  it.each([['missing issuer', { issuer: undefined }], ['unknown field', { x: 1 }], ['future version', { schema_version: 9 }]])(
    'rejects %s', (_n, patch) => expect(() => toRecord({ ...onChain, ...patch })).toThrow());
  it('still returns non-conforming on-chain records, JSON safe', () => {
    expect(toApiRecords([{ token_id: 5n, x: 1 }])).toEqual([{ token_id: '5', x: 1 }]);
  });
});

describe('indexed mint mapping', () => {
  const expected = { schema_version: 1, patient: 'GP', vaccine_name: 'Flu', issuer: 'GI', timestamp: 7 };
  it.each([
    ['tuple', ['GP', 'Flu', 'GI', 7n]],
    ['positional object', { 0: 'GP', 1: 'Flu', 2: 'GI', 3: 7 }],
    ['aliased object', { patient_address: 'GP', vaccine_name: 'Flu', issuer_address: 'GI', timestamp: 7 }],
    ['current form', expected],
  ])('maps %s', (_n, v) => expect(toIndexedMint(v)).toEqual(expected));
  it('decodes an ScVal', () => {
    const v = StellarSdk.xdr.ScVal.scvVec(['GP', 'Flu', 'GI', 7n].map((x) => StellarSdk.nativeToScVal(x)));
    expect(toIndexedMint(v)).toEqual(expected);
  });
});
