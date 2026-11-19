const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');

const VALID_ISSUER_ADDRESS = 'GA3AUY2XRF6S7R73ABSLJMKG4R2NQGRUFPEJUGCANMBAAXI4MTBS6AQU';

jest.mock('../src/stellar/soroban', () => {
  const sdk = require('@stellar/stellar-sdk');
  return {
    invokeContract: jest.fn().mockResolvedValue({ hash: 'mockhash123', ledger: 1000 }),
    simulateContract: jest.fn().mockResolvedValue(sdk.xdr.ScVal.scvVec([])),
    getRpcServer: jest.fn().mockReturnValue({ getHealth: jest.fn().mockResolvedValue({}) }),
    addIssuer: jest.fn().mockResolvedValue({ hash: 'mockhash123', ledger: 1000 }),
    revokeIssuer: jest.fn().mockResolvedValue({ hash: 'mockhash456', ledger: 1001 }),
  };
});

jest.mock('../src/stellar/issuerCache', () => ({
  isAuthorizedIssuer: jest.fn().mockResolvedValue(true),
  invalidateCache: jest.fn(),
}));

function makeToken(role) {
  return jwt.sign(
    { sub: 'GADMIN', wallet: 'GADMIN', role },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

describe('Admin Issuer Endpoints', () => {
  let adminToken;
  let issuerToken;
  let patientToken;

  beforeAll(() => {
    adminToken  = makeToken('admin');
    issuerToken = makeToken('issuer');
    patientToken = makeToken('patient');
  });

  // ── POST /admin/issuers ───────────────────────────────────────────────────

  describe('POST /v1/admin/issuers', () => {
    it('adds an issuer with admin JWT', async () => {
      const res = await request(app)
        .post('/v1/admin/issuers')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ address: VALID_ISSUER_ADDRESS });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ address: VALID_ISSUER_ADDRESS, authorized: true });
      expect(res.body).toHaveProperty('hash');
    });

    it('invalidates the issuer cache on successful add', async () => {
      const { invalidateCache } = require('../src/stellar/issuerCache');
      invalidateCache.mockClear();

      const res = await request(app)
        .post('/v1/admin/issuers')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ address: VALID_ISSUER_ADDRESS });

      expect(res.status).toBe(201);
      expect(invalidateCache).toHaveBeenCalledWith(VALID_ISSUER_ADDRESS);
    });

    it('does not invalidate the issuer cache when add is rejected', async () => {
      const { invalidateCache } = require('../src/stellar/issuerCache');
      invalidateCache.mockClear();

      const res = await request(app)
        .post('/v1/admin/issuers')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ address: 'not-a-stellar-address' });

      expect(res.status).toBe(400);
      expect(invalidateCache).not.toHaveBeenCalled();
    });

    it('rejects missing address', async () => {
      const res = await request(app)
        .post('/v1/admin/issuers')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
    });

    it('rejects invalid Stellar address', async () => {
      const res = await request(app)
        .post('/v1/admin/issuers')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ address: 'not-a-stellar-address' });

      expect(res.status).toBe(400);
    });

    it('rejects issuer role (admin only)', async () => {
      const res = await request(app)
        .post('/v1/admin/issuers')
        .set('Authorization', `Bearer ${issuerToken}`)
        .send({ address: VALID_ISSUER_ADDRESS });

      expect(res.status).toBe(403);
    });

    it('rejects patient role', async () => {
      const res = await request(app)
        .post('/v1/admin/issuers')
        .set('Authorization', `Bearer ${patientToken}`)
        .send({ address: VALID_ISSUER_ADDRESS });

      expect(res.status).toBe(403);
    });

    it('rejects unauthenticated request', async () => {
      const res = await request(app)
        .post('/v1/admin/issuers')
        .send({ address: VALID_ISSUER_ADDRESS });

      expect(res.status).toBe(401);
    });
  });

  // ── DELETE /admin/issuers/:wallet ─────────────────────────────────────────

  describe('DELETE /v1/admin/issuers/:wallet', () => {
    it('revokes an issuer with admin JWT', async () => {
      const res = await request(app)
        .delete(`/v1/admin/issuers/${VALID_ISSUER_ADDRESS}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ wallet: VALID_ISSUER_ADDRESS, authorized: false });
      expect(res.body).toHaveProperty('hash');
    });

    it('invalidates the issuer cache on successful revoke', async () => {
      const { invalidateCache } = require('../src/stellar/issuerCache');
      invalidateCache.mockClear();

      const res = await request(app)
        .delete(`/v1/admin/issuers/${VALID_ISSUER_ADDRESS}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(invalidateCache).toHaveBeenCalledWith(VALID_ISSUER_ADDRESS);
    });

    it('does not invalidate the issuer cache when revoke is rejected', async () => {
      const { invalidateCache } = require('../src/stellar/issuerCache');
      invalidateCache.mockClear();

      const res = await request(app)
        .delete('/v1/admin/issuers/bad-address')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(invalidateCache).not.toHaveBeenCalled();
    });

    it('returns 404 for non-existent issuer', async () => {
      const { isAuthorizedIssuer } = require('../src/stellar/issuerCache');
      isAuthorizedIssuer.mockResolvedValueOnce(false);

      const res = await request(app)
        .delete(`/v1/admin/issuers/${VALID_ISSUER_ADDRESS}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error');
    });

    it('rejects invalid Stellar address', async () => {
      const res = await request(app)
        .delete('/v1/admin/issuers/bad-address')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
    });

    it('rejects non-admin role', async () => {
      const res = await request(app)
        .delete(`/v1/admin/issuers/${VALID_ISSUER_ADDRESS}`)
        .set('Authorization', `Bearer ${patientToken}`);

      expect(res.status).toBe(403);
    });

    it('rejects unauthenticated request', async () => {
      const res = await request(app)
        .delete(`/v1/admin/issuers/${VALID_ISSUER_ADDRESS}`);

      expect(res.status).toBe(401);
    });
  });

  // ── Revocation consistency window ─────────────────────────────────────────

  describe('Revocation consistency window', () => {
    const CONSISTENCY_WINDOW_MS = 30 * 1000;

    afterEach(() => {
      jest.useRealTimers();
    });

    it('revoked issuer cannot mint after the consistency window', async () => {
      const { isAuthorizedIssuer } = require('../src/stellar/issuerCache');
      isAuthorizedIssuer.mockReset();

      // Before revocation the issuer is authorized and can mint.
      isAuthorizedIssuer.mockResolvedValueOnce(true);
      const before = await request(app)
        .post('/v1/issuer/mint')
        .set('Authorization', `Bearer ${issuerToken}`)
        .send({ patient: 'GPATIENT', amount: '10' });
      expect(before.status).not.toBe(403);

      // Admin revokes the issuer; cache is invalidated immediately.
      const revoke = await request(app)
        .delete(`/v1/admin/issuers/${VALID_ISSUER_ADDRESS}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(revoke.status).toBe(200);

      // Simulate the cache TTL expiring (end of the consistency window).
      jest.useFakeTimers();
      jest.advanceTimersByTime(CONSISTENCY_WINDOW_MS);

      // After the window the cache reflects the revocation.
      isAuthorizedIssuer.mockResolvedValue(false);
      const after = await request(app)
        .post('/v1/issuer/mint')
        .set('Authorization', `Bearer ${issuerToken}`)
        .send({ patient: 'GPATIENT', amount: '10' });

      expect(after.status).toBe(403);
      expect(isAuthorizedIssuer).toHaveBeenCalled();
    });
  });

  // ── GET /admin/issuers ────────────────────────────────────────────────────

  describe('GET /v1/admin/issuers', () => {
    it('returns issuer list with admin JWT', async () => {
      const res = await request(app)
        .get('/v1/admin/issuers')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('issuers');
      expect(Array.isArray(res.body.issuers)).toBe(true);
    });

    it('rejects non-admin role', async () => {
      const res = await request(app)
        .get('/v1/admin/issuers')
        .set('Authorization', `Bearer ${patientToken}`);

      expect(res.status).toBe(403);
    });

    it('rejects unauthenticated request', async () => {
      const res = await request(app).get('/v1/admin/issuers');
      expect(res.status).toBe(401);
    });
  });
});
