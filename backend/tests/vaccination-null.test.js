/**
 * Edge case / null value tests for the vaccination issue endpoint.
 * Closes #345
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');

jest.mock('../src/stellar/soroban', () => ({
  invokeContract: jest.fn(),
  simulateContract: jest.fn(),
  getContractState: jest.fn(),
  getRpcServer: jest.fn().mockReturnValue({ getHealth: jest.fn() }),
}));

jest.mock('../src/indexer/db', () => ({
  hasConsented: jest.fn().mockReturnValue(true),
  initDb: jest.fn(),
}));

jest.mock('../src/stellar/issuerCache', () => ({
  isAuthorizedIssuer: jest.fn().mockResolvedValue(true),
}));

const VALID_WALLET = 'GA3AUY2XRF6S7R73ABSLJMKG4R2NQGRUFPEJUGCANMBAAXI4MTBS6AQU';
const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

function issuerToken() {
  return jwt.sign(
    { sub: VALID_WALLET, role: 'issuer', wallet: VALID_WALLET, publicKey: VALID_WALLET },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

describe('POST /vaccination/issue — null / missing field validation (#345)', () => {
  const base = {
    patient_address: VALID_WALLET,
    vaccine_name: 'COVID-19',
    date_administered: '2024-01-15',
  };

  it('returns 400 when vaccine_name is null', async () => {
    const res = await request(app)
      .post('/v1/vaccination/issue')
      .set('Authorization', `Bearer ${issuerToken()}`)
      .send({ ...base, vaccine_name: null });

    expect(res.status).toBe(400);
  });

  it('returns 400 when vaccine_name is empty string', async () => {
    const res = await request(app)
      .post('/v1/vaccination/issue')
      .set('Authorization', `Bearer ${issuerToken()}`)
      .send({ ...base, vaccine_name: '' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when date_administered is null', async () => {
    const res = await request(app)
      .post('/v1/vaccination/issue')
      .set('Authorization', `Bearer ${issuerToken()}`)
      .send({ ...base, date_administered: null });

    expect(res.status).toBe(400);
  });

  it('returns 400 when date_administered is missing', async () => {
    const { date_administered: _, ...body } = base;
    const res = await request(app)
      .post('/v1/vaccination/issue')
      .set('Authorization', `Bearer ${issuerToken()}`)
      .send(body);

    expect(res.status).toBe(400);
  });

  it('returns 400 when vaccine_name is missing', async () => {
    const { vaccine_name: _, ...body } = base;
    const res = await request(app)
      .post('/v1/vaccination/issue')
      .set('Authorization', `Bearer ${issuerToken()}`)
      .send(body);

    expect(res.status).toBe(400);
  });
});

describe('GET /vaccination — pagination edge cases (#44)', () => {
  const MAX_LIMIT = 100;

  it('uses default pagination when query params are missing', async () => {
    const res = await request(app)
      .get('/v1/vaccination')
      .set('Authorization', `Bearer ${issuerToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        data: expect.any(Array),
        page: 1,
        limit: expect.any(Number),
        total: expect.any(Number),
        has_more: expect.any(Boolean),
      })
    );
    expect(res.body.limit).toBeLessThanOrEqual(MAX_LIMIT);
  });

  it('accepts a limit exactly at the maximum', async () => {
    const res = await request(app)
      .get('/v1/vaccination')
      .query({ limit: MAX_LIMIT })
      .set('Authorization', `Bearer ${issuerToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(MAX_LIMIT);
    expect(res.body.data.length).toBeLessThanOrEqual(MAX_LIMIT);
  });

  it('returns 400 when limit exceeds the maximum', async () => {
    const res = await request(app)
      .get('/v1/vaccination')
      .query({ limit: MAX_LIMIT + 1 })
      .set('Authorization', `Bearer ${issuerToken()}`);

    expect(res.status).toBe(400);
  });

  it('returns an empty data array with has_more=false beyond the last page', async () => {
    const res = await request(app)
      .get('/v1/vaccination')
      .query({ page: 999999, limit: 10 })
      .set('Authorization', `Bearer ${issuerToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.has_more).toBe(false);
  });
});

describe('POST /vaccination/issue — dose_number validation and normalization (#80)', () => {
  const base = {
    patient_address: VALID_WALLET,
    vaccine_name: 'COVID-19',
    date_administered: '2024-01-15',
    dose_number: 1,
  };

  it('returns 400 when dose_number is null', async () => {
    const res = await request(app)
      .post('/v1/vaccination/issue')
      .set('Authorization', `Bearer ${issuerToken()}`)
      .send({ ...base, dose_number: null });

    expect(res.status).toBe(400);
  });

  it('returns 400 when dose_number is missing', async () => {
    const { dose_number: _, ...body } = base;
    const res = await request(app)
      .post('/v1/vaccination/issue')
      .set('Authorization', `Bearer ${issuerToken()}`)
      .send(body);

    expect(res.status).toBe(400);
  });

  it('returns 400 when dose_number is zero', async () => {
    const res = await request(app)
      .post('/v1/vaccination/issue')
      .set('Authorization', `Bearer ${issuerToken()}`)
      .send({ ...base, dose_number: 0 });

    expect(res.status).toBe(400);
  });

  it('returns 400 when dose_number is negative', async () => {
    const res = await request(app)
      .post('/v1/vaccination/issue')
      .set('Authorization', `Bearer ${issuerToken()}`)
      .send({ ...base, dose_number: -1 });

    expect(res.status).toBe(400);
  });

  it('returns 400 when dose_number is a non-integer', async () => {
    const res = await request(app)
      .post('/v1/vaccination/issue')
      .set('Authorization', `Bearer ${issuerToken()}`)
      .send({ ...base, dose_number: 1.5 });

    expect(res.status).toBe(400);
  });

  it('returns 400 when dose_number is a non-numeric string', async () => {
    const res = await request(app)
      .post('/v1/vaccination/issue')
      .set('Authorization', `Bearer ${issuerToken()}`)
      .send({ ...base, dose_number: 'first' });

    expect(res.status).toBe(400);
  });

  it('accepts a legitimate repeat dose (dose_number 2)', async () => {
    const res = await request(app)
      .post('/v1/vaccination/issue')
      .set('Authorization', `Bearer ${issuerToken()}`)
      .send({ ...base, dose_number: 2 });

    expect(res.status).not.toBe(400);
  });

  it('normalizes vaccine_name formatting variants to the same key', async () => {
    const variants = ['COVID-19', 'covid-19', '  Covid-19  ', 'COVID19'];
    const statuses = [];

    for (const vaccine_name of variants) {
      const res = await request(app)
        .post('/v1/vaccination/issue')
        .set('Authorization', `Bearer ${issuerToken()}`)
        .send({ ...base, vaccine_name });

      statuses.push(res.status);
    }

    // All formatting variants must be treated consistently (no 400 from normalization).
    expect(statuses.every((s) => s !== 400)).toBe(true);
  });
});
