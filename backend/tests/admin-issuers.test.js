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

jest.mock('../src/stellar/adminRotation', () => ({
  proposeAdminRotation: jest.fn(),
  acceptAdminRotation: jest.fn(),
  cancelAdminRotation: jest.fn(),
  getPendingAdminRotation: jest.fn(),
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

  // ── Issuer lifecycle state machine ────────────────────────────────────────

  describe('issuer lifecycle state machine', () => {
    const { addIssuer, revokeIssuer } = require('../src/stellar/soroban');
    const { isAuthorizedIssuer } = require('../src/stellar/issuerCache');

    beforeEach(() => {
      jest.clearAllMocks();
      addIssuer.mockResolvedValue({ hash: 'mockhash123', ledger: 1000 });
      revokeIssuer.mockResolvedValue({ hash: 'mockhash456', ledger: 1001 });
      isAuthorizedIssuer.mockResolvedValue(true);
    });

    it('allows add -> revoke -> re-add transitions', async () => {
      // add
      const add1 = await request(app)
        .post('/v1/admin/issuers')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ address: VALID_ISSUER_ADDRESS });
      expect(add1.status).toBe(201);
      expect(add1.body).toMatchObject({ address: VALID_ISSUER_ADDRESS, authorized: true });

      // revoke
      const revoke = await request(app)
        .delete(`/v1/admin/issuers/${VALID_ISSUER_ADDRESS}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(revoke.status).toBe(200);
      expect(revoke.body).toMatchObject({ wallet: VALID_ISSUER_ADDRESS, authorized: false });

      // re-add
      const add2 = await request(app)
        .post('/v1/admin/issuers')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ address: VALID_ISSUER_ADDRESS });
      expect(add2.status).toBe(201);
      expect(add2.body).toMatchObject({ address: VALID_ISSUER_ADDRESS, authorized: true });
      expect(addIssuer).toHaveBeenCalledTimes(2);
      expect(revokeIssuer).toHaveBeenCalledTimes(1);
    });

    it('treats repeated add as idempotent (no duplicate state change)', async () => {
      const first = await request(app)
        .post('/v1/admin/issuers')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ address: VALID_ISSUER_ADDRESS });
      expect(first.status).toBe(201);

      const second = await request(app)
        .post('/v1/admin/issuers')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ address: VALID_ISSUER_ADDRESS });
      // Idempotent: either 200/201 with same authorized state, never a 5xx.
      expect([200, 201]).toContain(second.status);
      expect(second.body).toMatchObject({ address: VALID_ISSUER_ADDRESS, authorized: true });
    });

    it('rejects revoke of an already-revoked issuer with 404', async () => {
      isAuthorizedIssuer.mockResolvedValueOnce(false);
      const res = await request(app)
        .delete(`/v1/admin/issuers/${VALID_ISSUER_ADDRESS}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error');
    });

    it('rejects re-add of an already-authorized issuer without duplicating state', async () => {
      // Simulate contract-level duplicate rejection.
      addIssuer.mockRejectedValueOnce(new Error('issuer already authorized'));
      const res = await request(app)
        .post('/v1/admin/issuers')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ address: VALID_ISSUER_ADDRESS });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });

    it('rejects disallowed transition: revoke by non-admin', async () => {
      const res = await request(app)
        .delete(`/v1/admin/issuers/${VALID_ISSUER_ADDRESS}`)
        .set('Authorization', `Bearer ${issuerToken}`);
      expect(res.status).toBe(403);
      expect(revokeIssuer).not.toHaveBeenCalled();
    });

    it('rejects disallowed transition: add by non-admin', async () => {
      const res = await request(app)
        .post('/v1/admin/issuers')
        .set('Authorization', `Bearer ${issuerToken}`)
        .send({ address: VALID_ISSUER_ADDRESS });
      expect(res.status).toBe(403);
      expect(addIssuer).not.toHaveBeenCalled();
    });
  });

  // ── Administrator recovery / rotation ─────────────────────────────────────

  describe('administrator rotation flow', () => {
    const {
      proposeAdminRotation,
      acceptAdminRotation,
      cancelAdminRotation,
      getPendingAdminRotation,
    } = require('../src/stellar/adminRotation');

    const NEW_ADMIN = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

    beforeEach(() => {
      jest.clearAllMocks();
      proposeAdminRotation.mockResolvedValue({ hash: 'prop123', ledger: 2000 });
      acceptAdminRotation.mockResolvedValue({ hash: 'acc456', ledger: 2001 });
      cancelAdminRotation.mockResolvedValue({ hash: 'can789', ledger: 2002 });
      getPendingAdminRotation.mockResolvedValue(null);
    });

    it('allows an authorized admin to propose a rotation', async () => {
      const res = await request(app)
        .post('/v1/admin/rotation/propose')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ newAdmin: NEW_ADMIN });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('hash');
      expect(proposeAdminRotation).toHaveBeenCalledTimes(1);
    });

    it('rejects rotation proposal from non-admin', async () => {
      const res = await request(app)
        .post('/v1/admin/rotation/propose')
        .set('Authorization', `Bearer ${patientToken}`)
        .send({ newAdmin: NEW_ADMIN });
      expect(res.status).toBe(403);
      expect(proposeAdminRotation).not.toHaveBeenCalled();
    });

    it('rejects rotation proposal from unauthenticated caller', async () => {
      const res = await request(app)
        .post('/v1/admin/rotation/propose')
        .send({ newAdmin: NEW_ADMIN });
      expect(res.status).toBe(401);
      expect(proposeAdminRotation).not.toHaveBeenCalled();
    });

    it('rejects proposal with invalid new admin address', async () => {
      const res = await request(app)
        .post('/v1/admin/rotation/propose')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ newAdmin: 'not-a-stellar-address' });
      expect(res.status).toBe(400);
      expect(proposeAdminRotation).not.toHaveBeenCalled();
    });

    it('accepts a pending rotation by the proposed admin', async () => {
      getPendingAdminRotation.mockResolvedValueOnce({ newAdmin: NEW_ADMIN, expiresAt: Date.now() + 60000 });
      const res = await request(app)
        .post('/v1/admin/rotation/accept')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ newAdmin: NEW_ADMIN });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('hash');
      expect(acceptAdminRotation).toHaveBeenCalledTimes(1);
    });

    it('rejects acceptance of an expired rotation', async () => {
      getPendingAdminRotation.mockResolvedValueOnce({ newAdmin: NEW_ADMIN, expiresAt: Date.now() - 1000 });
      const res = await request(app)
        .post('/v1/admin/rotation/accept')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ newAdmin: NEW_ADMIN });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(acceptAdminRotation).not.toHaveBeenCalled();
    });

    it('rejects replay of an already-accepted rotation', async () => {
      getPendingAdminRotation.mockResolvedValueOnce(null);
      const res = await request(app)
        .post('/v1/admin/rotation/accept')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ newAdmin: NEW_ADMIN });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(acceptAdminRotation).not.toHaveBeenCalled();
    });

    it('allows the current admin to cancel a pending rotation', async () => {
      getPendingAdminRotation.mockResolvedValueOnce({ newAdmin: NEW_ADMIN, expiresAt: Date.now() + 60000 });
      const res = await request(app)
        .post('/v1/admin/rotation/cancel')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(cancelAdminRotation).toHaveBeenCalledTimes(1);
    });

    it('rejects cancellation by non-admin', async () => {
      const res = await request(app)
        .post('/v1/admin/rotation/cancel')
        .set('Authorization', `Bearer ${patientToken}`);
      expect(res.status).toBe(403);
      expect(cancelAdminRotation).not.toHaveBeenCalled();
    });

    it('rejects cancellation when no rotation is pending', async () => {
      getPendingAdminRotation.mockResolvedValueOnce(null);
      const res = await request(app)
        .post('/v1/admin/rotation/cancel')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(cancelAdminRotation).not.toHaveBeenCalled();
    });
  });
});
