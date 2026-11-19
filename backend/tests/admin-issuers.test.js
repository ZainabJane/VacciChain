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

jest.mock('../src/indexer/poller', () => ({
  getStatus: jest.fn(),
  pause: jest.fn(),
  resume: jest.fn(),
}));

jest.mock('../src/audit/auditLog', () => ({
  record: jest.fn().mockResolvedValue(undefined),
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

  // ── Indexer operational controls ──────────────────────────────────────────

  describe('GET /v1/admin/indexer/status', () => {
    const { getStatus } = require('../src/indexer/poller');

    beforeEach(() => {
      getStatus.mockReset();
      getStatus.mockResolvedValue({
        state: 'running',
        lastLedger: 1234,
        latestLedger: 1250,
        lag: 16,
        progress: 0.87,
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
    });

    it('returns poller status with admin JWT', async () => {
      const res = await request(app)
        .get('/v1/admin/indexer/status')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        state: 'running',
        lastLedger: 1234,
        latestLedger: 1250,
        lag: 16,
        progress: 0.87,
      });
      expect(res.body).toHaveProperty('updatedAt');
    });

    it('rejects issuer role', async () => {
      const res = await request(app)
        .get('/v1/admin/indexer/status')
        .set('Authorization', `Bearer ${issuerToken}`);

      expect(res.status).toBe(403);
    });

    it('rejects patient role', async () => {
      const res = await request(app)
        .get('/v1/admin/indexer/status')
        .set('Authorization', `Bearer ${patientToken}`);

      expect(res.status).toBe(403);
    });

    it('rejects unauthenticated request', async () => {
      const res = await request(app).get('/v1/admin/indexer/status');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /v1/admin/indexer/pause', () => {
    const { pause } = require('../src/indexer/poller');
    const auditLog = require('../src/audit/auditLog');

    beforeEach(() => {
      pause.mockReset();
      pause.mockResolvedValue({ state: 'paused' });
      auditLog.record.mockClear();
    });

    it('pauses the poller with admin JWT and emits an audit event', async () => {
      const res = await request(app)
        .post('/v1/admin/indexer/pause')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'provider incident' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ state: 'paused' });
      expect(pause).toHaveBeenCalledTimes(1);
      expect(auditLog.record).toHaveBeenCalledTimes(1);
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'indexer.pause',
          actor: 'GADMIN',
        })
      );
    });

    it('rejects non-admin role and does not pause', async () => {
      const res = await request(app)
        .post('/v1/admin/indexer/pause')
        .set('Authorization', `Bearer ${patientToken}`)
        .send({});

      expect(res.status).toBe(403);
      expect(pause).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('rejects unauthenticated request', async () => {
      const res = await request(app).post('/v1/admin/indexer/pause').send({});
      expect(res.status).toBe(401);
      expect(pause).not.toHaveBeenCalled();
    });
  });

  describe('POST /v1/admin/indexer/resume', () => {
    const { resume } = require('../src/indexer/poller');
    const auditLog = require('../src/audit/auditLog');

    beforeEach(() => {
      resume.mockReset();
      resume.mockResolvedValue({ state: 'running' });
      auditLog.record.mockClear();
    });

    it('resumes the poller with admin JWT and emits an audit event', async () => {
      const res = await request(app)
        .post('/v1/admin/indexer/resume')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ state: 'running' });
      expect(resume).toHaveBeenCalledTimes(1);
      expect(auditLog.record).toHaveBeenCalledTimes(1);
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'indexer.resume',
          actor: 'GADMIN',
        })
      );
    });

    it('rejects non-admin role and does not resume', async () => {
      const res = await request(app)
        .post('/v1/admin/indexer/resume')
        .set('Authorization', `Bearer ${issuerToken}`)
        .send({});

      expect(res.status).toBe(403);
      expect(resume).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('rejects unauthenticated request', async () => {
      const res = await request(app).post('/v1/admin/indexer/resume').send({});
      expect(res.status).toBe(401);
      expect(resume).not.toHaveBeenCalled();
    });
  });
});
