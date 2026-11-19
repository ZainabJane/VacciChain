const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');

const VALID_WALLET = 'GA3AUY2XRF6S7R73ABSLJMKG4R2NQGRUFPEJUGCANMBAAXI4MTBS6AQU';

// Mock Soroban RPC responses
jest.mock('../src/stellar/soroban', () => {
  const sdk = require('@stellar/stellar-sdk');
  const mockResult = sdk.xdr.ScVal.scvVec([
    sdk.xdr.ScVal.scvBool(true),
    sdk.xdr.ScVal.scvVec([]),
  ]);
  return {
    invokeContract: jest.fn().mockResolvedValue({
      returnValue: sdk.xdr.ScVal.scvBool(true),
      hash: 'abc123',
      ledger: 1000,
    }),
    simulateContract: jest.fn().mockResolvedValue(mockResult),
    getContractState: jest.fn().mockResolvedValue({}),
    getRpcServer: jest.fn().mockReturnValue({ getHealth: jest.fn().mockResolvedValue({}) }),
  };
});

// Mock SEP-10 functions
jest.mock('../src/stellar/sep10', () => ({
  buildChallenge: jest.fn().mockResolvedValue({
    transaction: 'AAAAAgAAAABIQvkylb3/M+0wTwfqSo7VVV+xopwUcY+KJH31xvEGzgAAAGQAJZf9AAAAAwAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAABAAAAAAAAAAA=',
    nonce: 'test-nonce-123',
  }),
  verifyChallenge: jest.fn((tx, nonce) => {
    if (nonce === 'test-nonce-123') {
      return VALID_WALLET;
    }
    throw new Error('Invalid nonce');
  }),
}));

describe('Integration Tests - SEP-10 Auth Flow', () => {
  describe('POST /auth/sep10', () => {
    it('should generate a challenge for a valid public key', async () => {
      const res = await request(app)
        .post('/auth/sep10')
        .send({ public_key: VALID_WALLET });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('transaction');
      expect(res.body).toHaveProperty('nonce');
      expect(res.body.nonce).toBe('test-nonce-123');
    });

    it('should reject invalid public key format', async () => {
      const res = await request(app)
        .post('/auth/sep10')
        .send({ public_key: 'invalid-key' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('should reject missing public_key', async () => {
      const res = await request(app)
        .post('/auth/sep10')
        .send({});

      expect(res.status).toBe(400);
    });
  });

  describe('POST /auth/verify', () => {
    it('should issue JWT for valid signed challenge', async () => {
      const res = await request(app)
        .post('/auth/verify')
        .send({
          transaction: 'AAAAAgAAAABIQvkylb3/M+0wTwfqSo7VVV+xopwUcY+KJH31xvEGzgAAAGQAJZf9AAAAAwAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAABAAAAAAAAAAA=',
          nonce: 'test-nonce-123',
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('token');
      expect(res.body).toHaveProperty('wallet');
      expect(res.body).toHaveProperty('role');
      expect(res.body.wallet).toBe(VALID_WALLET);
    });

    it('should reject invalid nonce', async () => {
      const res = await request(app)
        .post('/auth/verify')
        .send({
          transaction: 'AAAAAgAAAABIQvkylb3/M+0wTwfqSo7VVV+xopwUcY+KJH31xvEGzgAAAGQAJZf9AAAAAwAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAABAAAAAAAAAAA=',
          nonce: 'invalid-nonce',
        });

      expect(res.status).toBe(401);
    });

    it('should reject missing transaction', async () => {
      const res = await request(app)
        .post('/auth/verify')
        .send({ nonce: 'test-nonce-123' });

      expect(res.status).toBe(400);
    });

    it('should reject missing nonce', async () => {
      const res = await request(app)
        .post('/auth/verify')
        .send({ transaction: 'some-tx' });

      expect(res.status).toBe(400);
    });
  });
});

describe('Integration Tests - Protected Routes', () => {
  let validToken;
  let issuerToken;

  beforeAll(() => {
    validToken = jwt.sign(
      {
        publicKey: VALID_WALLET,
        role: 'patient',
        sub: VALID_WALLET,
        wallet: VALID_WALLET,
      },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    issuerToken = jwt.sign(
      {
        publicKey: process.env.ADMIN_PUBLIC_KEY || 'GADMIN',
        role: 'issuer',
        sub: process.env.ADMIN_PUBLIC_KEY || 'GADMIN',
        wallet: process.env.ADMIN_PUBLIC_KEY || 'GADMIN',
      },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
  });

  describe('GET /vaccination/:wallet', () => {
    it('should reject request without auth header', async () => {
      const res = await request(app).get(`/vaccination/${VALID_WALLET}`);
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/authorization/i);
    });

    it('should reject request with invalid token', async () => {
      const res = await request(app)
        .get(`/vaccination/${VALID_WALLET}`)
        .set('Authorization', 'Bearer invalid-token');
      expect(res.status).toBe(401);
    });

    it('should return paginated shape with defaults', async () => {
      const res = await request(app)
        .get(`/vaccination/${VALID_WALLET}`)
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('total');
      expect(res.body).toHaveProperty('page', 1);
      expect(res.body).toHaveProperty('limit', 20);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('should accept valid page and limit params', async () => {
      const res = await request(app)
        .get(`/vaccination/${VALID_WALLET}?page=2&limit=10`)
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(200);
      expect(res.body.page).toBe(2);
      expect(res.body.limit).toBe(10);
    });

    it('should return 400 for invalid page param', async () => {
      const res = await request(app)
        .get(`/vaccination/${VALID_WALLET}?page=0`)
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/page/i);
    });

    it('should return 400 for non-numeric page param', async () => {
      const res = await request(app)
        .get(`/vaccination/${VALID_WALLET}?page=abc`)
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(400);
    });

    it('should return 400 for limit exceeding 100', async () => {
      const res = await request(app)
        .get(`/vaccination/${VALID_WALLET}?limit=101`)
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/limit/i);
    });

    it('should return 400 for limit of 0', async () => {
      const res = await request(app)
        .get(`/vaccination/${VALID_WALLET}?limit=0`)
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(400);
    });
  });

  describe('POST /vaccination/issue', () => {
    it('should reject request without auth header', async () => {
      const res = await request(app)
        .post('/vaccination/issue')
        .send({ patient_address: VALID_WALLET, vaccine_name: 'COVID-19', date_administered: '2024-01-15' });
      expect(res.status).toBe(401);
    });

    it('should reject patient role (issuer role required)', async () => {
      const res = await request(app)
        .post('/vaccination/issue')
        .set('Authorization', `Bearer ${validToken}`)
        .send({ patient_address: VALID_WALLET, vaccine_name: 'COVID-19', date_administered: '2024-01-15' });
      expect(res.status).toBe(403);
    });

    it('should accept issuer role with valid data', async () => {
      const res = await request(app)
        .post('/vaccination/issue')
        .set('Authorization', `Bearer ${issuerToken}`)
        .send({ patient_address: VALID_WALLET, vaccine_name: 'COVID-19', date_administered: '2024-01-15' });
      expect(res.status).toBe(200);
    });

    it('should reject missing required fields', async () => {
      const res = await request(app)
        .post('/vaccination/issue')
        .set('Authorization', `Bearer ${issuerToken}`)
        .send({ patient_address: VALID_WALLET });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /vaccination/issue idempotency', () => {
    const soroban = require('../src/stellar/soroban');
    const issuePayload = {
      patient_address: VALID_WALLET,
      vaccine_name: 'COVID-19',
      date_administered: '2024-01-15',
    };

    const otherIssuerToken = jwt.sign(
      {
        publicKey: 'GOTHERISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        role: 'issuer',
        sub: 'GOTHERISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        wallet: 'GOTHERISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    beforeEach(() => {
      soroban.invokeContract.mockClear();
    });

    it('returns the original outcome for a repeated key and payload without a second mint', async () => {
      const key = 'idem-repeat-key-1';

      const first = await request(app)
        .post('/vaccination/issue')
        .set('Authorization', `Bearer ${issuerToken}`)
        .set('Idempotency-Key', key)
        .send(issuePayload);
      expect(first.status).toBe(200);
      const mintCallsAfterFirst = soroban.invokeContract.mock.calls.length;

      const second = await request(app)
        .post('/vaccination/issue')
        .set('Authorization', `Bearer ${issuerToken}`)
        .set('Idempotency-Key', key)
        .send(issuePayload);
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(soroban.invokeContract.mock.calls.length).toBe(mintCallsAfterFirst);
    });

    it('rejects key reuse with a different payload with 409', async () => {
      const key = 'idem-conflict-key-1';

      const first = await request(app)
        .post('/vaccination/issue')
        .set('Authorization', `Bearer ${issuerToken}`)
        .set('Idempotency-Key', key)
        .send(issuePayload);
      expect(first.status).toBe(200);

      const conflict = await request(app)
        .post('/vaccination/issue')
        .set('Authorization', `Bearer ${issuerToken}`)
        .set('Idempotency-Key', key)
        .send({ ...issuePayload, vaccine_name: 'Influenza' });
      expect(conflict.status).toBe(409);
    });

    it('persists idempotency entries across a simulated restart', async () => {
      const key = 'idem-restart-key-1';

      const first = await request(app)
        .post('/vaccination/issue')
        .set('Authorization', `Bearer ${issuerToken}`)
        .set('Idempotency-Key', key)
        .send(issuePayload);
      expect(first.status).toBe(200);

      // Simulate a service restart: drop cached modules and re-require the app
      // so the idempotency store is rebuilt from its persistent backing store.
      jest.resetModules();
      const restartedApp = require('../src/app');
      const restartedSoroban = require('../src/stellar/soroban');
      restartedSoroban.invokeContract.mockClear();

      const replay = await request(restartedApp)
        .post('/vaccination/issue')
        .set('Authorization', `Bearer ${issuerToken}`)
        .set('Idempotency-Key', key)
        .send(issuePayload);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(first.body);
      expect(restartedSoroban.invokeContract).not.toHaveBeenCalled();
    });

    it('scopes keys per issuer so two issuers can use the same key independently', async () => {
      const key = 'idem-shared-key-1';

      const first = await request(app)
        .post('/vaccination/issue')
        .set('Authorization', `Bearer ${issuerToken}`)
        .set('Idempotency-Key', key)
        .send(issuePayload);
      expect(first.status).toBe(200);

      const second = await request(app)
        .post('/vaccination/issue')
        .set('Authorization', `Bearer ${otherIssuerToken}`)
        .set('Idempotency-Key', key)
        .send(issuePayload);
      expect(second.status).toBe(200);
      expect(second.body).not.toEqual(first.body);
    });
  });
});

describe('Integration Tests - Public Verify Endpoint', () => {
  describe('GET /verify/:wallet', () => {
    it('should accept valid Stellar address', async () => {
      const res = await request(app).get(`/verify/${VALID_WALLET}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('vaccinated');
      expect(res.body).toHaveProperty('record_count');
    });

    it('should reject invalid Stellar address', async () => {
      const res = await request(app).get('/verify/invalid-address');
      expect(res.status).toBe(400);
    });

    it('should not require authentication', async () => {
      const res = await request(app).get(`/verify/${VALID_WALLET}`);
      expect(res.status).toBe(200);
    });
  });
});

describe('Integration Tests - Error Handling', () => {
  it('should return 404 for unknown routes', async () => {
    const res = await request(app).get('/unknown-route');
    expect(res.status).toBe(404);
  });

  it('should handle malformed JSON', async () => {
    const res = await request(app)
      .post('/auth/sep10')
      .set('Content-Type', 'application/json')
      .send('{ invalid json }');
    expect(res.status).toBe(400);
  });
});
