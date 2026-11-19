'use strict';

const request = require('supertest');
const StellarSdk = require('@stellar/stellar-sdk');

// Must be mocked before app is loaded
jest.mock('../src/jwtKeys', () => ({
  getVerificationKeys: () => [{ kid: '1', secret: 'test-jwt-secret' }],
  getSigningKey: () => ({ kid: '1', secret: 'test-jwt-secret' }),
  rotateKey: jest.fn(),
  reloadFromEnv: jest.fn(),
}));

const app = require('../src/app');
const jwtFactory = require('./factories/jwt');
const vaccinationFactory = require('./factories/vaccination');
const { PATIENT_WALLET, ISSUER_WALLET } = require('./fixtures/wallets');

// Mock Soroban RPC — controlled per-test via mockResolvedValue / mockRejectedValue
jest.mock('../src/stellar/soroban', () => {
  const sdk = require('@stellar/stellar-sdk');
  const emptyRecords = sdk.xdr.ScVal.scvVec([
    sdk.xdr.ScVal.scvBool(true),
    sdk.xdr.ScVal.scvVec([]),
  ]);
  return {
    mintVaccination: jest.fn().mockResolvedValue({ tokenId: 'tok_1', hash: 'abc123', ledger: 1000 }),
    simulateContract: jest.fn().mockResolvedValue(emptyRecords),
    sendRpcTimeout: jest.fn(),
    SorobanTimeoutError: class SorobanTimeoutError extends Error {},
  };
});

// Mock issuer on-chain check
jest.mock('../src/stellar/issuerCache', () => ({
  isAuthorizedIssuer: jest.fn().mockResolvedValue(true),
}));

// Mock patient consent
jest.mock('../src/indexer/db', () => ({
  hasConsented: jest.fn().mockReturnValue(true),
  initDb: jest.fn().mockResolvedValue(undefined),
  getDb: jest.fn(),
}));

const { mintVaccination, simulateContract } = require('../src/stellar/soroban');

const VALID_BODY = {
  patient_address: PATIENT_WALLET,
  vaccine_name: 'COVID-19',
  date_administered: '2024-01-15',
};

let issuerToken;
let patientToken;

beforeAll(() => {
  issuerToken = jwtFactory({ publicKey: ISSUER_WALLET, role: 'issuer' });
  patientToken = jwtFactory({ publicKey: PATIENT_WALLET, role: 'patient' });
});

beforeEach(() => {
  jest.clearAllMocks();
  mintVaccination.mockResolvedValue({ tokenId: 'tok_1', hash: 'abc123', ledger: 1000 });
  const sdk = require('@stellar/stellar-sdk');
  simulateContract.mockResolvedValue(
    sdk.xdr.ScVal.scvVec([sdk.xdr.ScVal.scvBool(true), sdk.xdr.ScVal.scvVec([])])
  );
});

describe('POST /v1/vaccination/issue', () => {
  it('returns 200 with issuer JWT and valid body', async () => {
    const res = await request(app)
      .post('/v1/vaccination/issue')
      .set('Authorization', `Bearer ${issuerToken}`)
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, tokenId: 'tok_1', transactionHash: 'abc123' });
  });

  it('returns 403 with patient JWT', async () => {
    const res = await request(app)
      .post('/v1/vaccination/issue')
      .set('Authorization', `Bearer ${patientToken}`)
      .send(VALID_BODY);

    expect(res.status).toBe(403);
  });

  it('returns 409 when contract returns DuplicateRecord error', async () => {
    mintVaccination.mockRejectedValue(new Error('Error(Contract, #6)'));

    const res = await request(app)
      .post('/v1/vaccination/issue')
      .set('Authorization', `Bearer ${issuerToken}`)
      .send(VALID_BODY);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/identical|duplicate/i);
  });
});

describe('GET /v1/vaccination/:wallet', () => {
  it('returns records array with valid JWT', async () => {
    const res = await request(app)
      .get(`/v1/vaccination/${PATIENT_WALLET}`)
      .set('Authorization', `Bearer ${patientToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('returns 400 for invalid wallet format', async () => {
    const res = await request(app)
      .get('/v1/vaccination/not-a-valid-wallet')
      .set('Authorization', `Bearer ${patientToken}`);

    expect(res.status).toBe(400);
  });
});

describe('GET /v1/vaccination/:wallet pagination', () => {
  const MAX_PAGE_SIZE = 100;

  // Build a deterministic, ordered set of records (ascending by date_administered)
  function buildRecords(count) {
    return Array.from({ length: count }, (_, i) =>
      vaccinationFactory({
        tokenId: `tok_${String(i).padStart(4, '0')}`,
        dateAdministered: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`,
        ledger: 1000 + i,
      })
    );
  }

  function mockRecords(records) {
    const sdk = require('@stellar/stellar-sdk');
    const scvRecords = sdk.xdr.ScVal.scvVec(
      records.map((r) =>
        sdk.xdr.ScVal.scvMap([
          new sdk.xdr.ScMapEntry({
            key: sdk.xdr.ScVal.scvSymbol('token_id'),
            val: sdk.xdr.ScVal.scvString(r.tokenId),
          }),
          new sdk.xdr.ScMapEntry({
            key: sdk.xdr.ScVal.scvSymbol('date_administered'),
            val: sdk.xdr.ScVal.scvString(r.dateAdministered),
          }),
          new sdk.xdr.ScMapEntry({
            key: sdk.xdr.ScVal.scvSymbol('ledger'),
            val: sdk.xdr.ScVal.scvU32(r.ledger),
          }),
        ])
      )
    );
    simulateContract.mockResolvedValue(
      sdk.xdr.ScVal.scvVec([sdk.xdr.ScVal.scvBool(true), scvRecords])
    );
  }

  function fetchPage(query) {
    return request(app)
      .get(`/v1/vaccination/${PATIENT_WALLET}`)
      .query(query)
      .set('Authorization', `Bearer ${patientToken}`);
  }

  it('returns empty data with correct metadata for an empty dataset', async () => {
    mockRecords([]);

    const res = await fetchPage({ limit: 10 });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination).toMatchObject({ has_more: false, next_page: null });
  });

  it('returns the first page with stable ordering and metadata', async () => {
    mockRecords(buildRecords(25));

    const res = await fetchPage({ limit: 10 });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(10);
    expect(res.body.pagination).toMatchObject({ has_more: true });
    expect(res.body.pagination.next_page).not.toBeNull();

    const tokenIds = res.body.data.map((r) => r.tokenId);
    expect(tokenIds).toEqual([...tokenIds].sort());
  });

  it('returns the last boundary page with has_more false', async () => {
    mockRecords(buildRecords(25));

    const res = await fetchPage({ limit: 10, page: 3 });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5);
    expect(res.body.pagination).toMatchObject({ has_more: false, next_page: null });
  });

  it('returns an empty page past the last boundary', async () => {
    mockRecords(buildRecords(25));

    const res = await fetchPage({ limit: 10, page: 10 });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination).toMatchObject({ has_more: false, next_page: null });
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['non-numeric', 'abc'],
  ])('rejects invalid limit (%s) with 400', async (_label, limit) => {
    mockRecords(buildRecords(5));

    const res = await fetchPage({ limit });

    expect(res.status).toBe(400);
  });

  it('caps limit at the maximum page size', async () => {
    mockRecords(buildRecords(MAX_PAGE_SIZE + 20));

    const res = await fetchPage({ limit: MAX_PAGE_SIZE + 50 });

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(MAX_PAGE_SIZE);
    expect(res.body.pagination).toHaveProperty('limit', MAX_PAGE_SIZE);
  });

  it('does not duplicate or skip records when new records are added between page fetches', async () => {
    const initial = buildRecords(20);
    mockRecords(initial);

    const first = await fetchPage({ limit: 10 });
    expect(first.status).toBe(200);
    const firstIds = first.body.data.map((r) => r.tokenId);

    // A new record is inserted (appended at the end of the ordered set)
    const withNew = [...initial, ...buildRecords(1).map((r) => ({ ...r, tokenId: 'tok_new' }))];
    mockRecords(withNew);

    const second = await fetchPage({ limit: 10, page: 2 });
    expect(second.status).toBe(200);
    const secondIds = second.body.data.map((r) => r.tokenId);

    // No overlap between pages
    const overlap = firstIds.filter((id) => secondIds.includes(id));
    expect(overlap).toEqual([]);

    // No records from the original set are skipped
    const seen = new Set([...firstIds, ...secondIds]);
    for (const rec of initial) {
      expect(seen.has(rec.tokenId)).toBe(true);
    }
  });
});
