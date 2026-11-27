const os      = require('os');
const path    = require('path');
const fs      = require('fs');
const request = require('supertest');
const crypto  = require('crypto');
const { initDb, insertApiKey, revokeApiKey } = require('../src/indexer/db');
const app     = require('../src/app');
const { jwtFactory } = require('./factories');


const tmpDb = path.join(os.tmpdir(), `vaccichain-apikey-test-${Date.now()}.db`);

beforeAll(async () => {
  await initDb(tmpDb);
});

afterAll(() => {
  if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb);
});

// ── helpers ───────────────────────────────────────────────────────────────────

const VALID_WALLET = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';

function issuerToken() {
  return jwtFactory({ sub: 'admin', role: 'issuer', wallet: VALID_WALLET });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}


// ── admin API key routes ──────────────────────────────────────────────────────

describe('POST /v1/admin/api-keys', () => {
  it('requires auth', async () => {
    const res = await request(app).post('/v1/admin/api-keys').send({ label: 'Test' });
    expect(res.status).toBe(401);
  });

  it('requires issuer role', async () => {
    const token = jwtFactory({ sub: 'p', role: 'patient', wallet: VALID_WALLET });

    const res = await request(app)
      .post('/v1/admin/api-keys')
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'Test' });
    expect(res.status).toBe(403);
  });

  it('rejects missing label', async () => {
    const res = await request(app)
      .post('/v1/admin/api-keys')
      .set('Authorization', `Bearer ${issuerToken()}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/label/);
  });

  it('creates a key and returns it once', async () => {
    const res = await request(app)
      .post('/v1/admin/api-keys')
      .set('Authorization', `Bearer ${issuerToken()}`)
      .send({ label: 'School A' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ label: 'School A' });
    expect(typeof res.body.key).toBe('string');
    expect(res.body.key).toHaveLength(64); // 32 bytes hex
    expect(typeof res.body.id).toBe('string');
  });
});

describe('GET /v1/admin/api-keys', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/v1/admin/api-keys');
    expect(res.status).toBe(401);
  });

  it('returns list of keys without raw key value', async () => {
    const res = await request(app)
      .get('/v1/admin/api-keys')
      .set('Authorization', `Bearer ${issuerToken()}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // raw key must never appear in list
    res.body.forEach(k => expect(k.key).toBeUndefined());
    res.body.forEach(k => expect(k.key_hash).toBeUndefined());
  });
});

describe('DELETE /v1/admin/api-keys/:id', () => {
  it('revokes a key', async () => {
    const createRes = await request(app)
      .post('/v1/admin/api-keys')
      .set('Authorization', `Bearer ${issuerToken()}`)
      .send({ label: 'To Revoke' });
    expect(createRes.status).toBe(201);
    const { id } = createRes.body;

    const revokeRes = await request(app)
      .delete(`/v1/admin/api-keys/${id}`)
      .set('Authorization', `Bearer ${issuerToken()}`);
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.revoked).toBe(true);

    // Key should now appear as revoked in list
    const listRes = await request(app)
      .get('/v1/admin/api-keys')
      .set('Authorization', `Bearer ${issuerToken()}`);
    const found = listRes.body.find(k => k.id === id);
    expect(found.revoked).toBeTruthy();
  });
});

// ── verifierApiKey middleware ─────────────────────────────────────────────────

describe('verifierApiKey middleware', () => {
  const verifierApiKey = require('../src/middleware/verifierApiKey');

  function makeReqRes(headerValue) {
    const req = { headers: headerValue !== undefined ? { 'x-api-key': headerValue } : {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    return { req, res, next };
  }

  it('rejects missing header', () => {
    const { req, res, next } = makeReqRes(undefined);
    verifierApiKey(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects unknown key', () => {
    const { req, res, next } = makeReqRes('unknownkey');
    verifierApiKey(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts a valid active key', () => {
    const rawKey  = crypto.randomBytes(32).toString('hex');
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const id      = crypto.randomUUID();
    insertApiKey({ id, key_hash: keyHash, label: 'Test', created_at: new Date().toISOString() });

    const { req, res, next } = makeReqRes(rawKey);
    verifierApiKey(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.verifier).toMatchObject({ id, label: 'Test' });
  });

  it('rejects a revoked key', () => {
    const rawKey  = crypto.randomBytes(32).toString('hex');
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const id      = crypto.randomUUID();
    insertApiKey({ id, key_hash: keyHash, label: 'Revoked', created_at: new Date().toISOString() });
    revokeApiKey(id);

    const { req, res, next } = makeReqRes(rawKey);
    verifierApiKey(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

// ── lifecycle integration tests ──────────────────────────────────────────────

describe('verifier API key lifecycle', () => {
  const verifierApiKey = require('../src/middleware/verifierApiKey');

  function makeReqRes(headerValue) {
    const req = { headers: headerValue !== undefined ? { 'x-api-key': headerValue } : {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    return { req, res, next };
  }

  async function createKey(payload) {
    const res = await request(app)
      .post('/admin/api-keys')
      .set('Authorization', `Bearer ${issuerToken()}`)
      .send(payload);
    expect(res.status).toBe(201);
    return res.body;
  }

  async function listKeys() {
    const res = await request(app)
      .get('/admin/api-keys')
      .set('Authorization', `Bearer ${issuerToken()}`);
    expect(res.status).toBe(200);
    return res.body;
  }

  async function listAudit() {
    const res = await request(app)
      .get('/admin/api-keys/audit')
      .set('Authorization', `Bearer ${issuerToken()}`);
    expect(res.status).toBe(200);
    return res.body;
  }

  describe('provisioning', () => {
    it('returns the raw key exactly once and stores only its hash', async () => {
      const created = await createKey({ label: 'Provisioning Test' });
      expect(typeof created.key).toBe('string');
      expect(created.key).toHaveLength(64);

      // Raw key must not be retrievable from the list endpoint.
      const keys = await listKeys();
      const found = keys.find(k => k.id === created.id);
      expect(found).toBeDefined();
      expect(found.key).toBeUndefined();
      expect(found.key_hash).toBeUndefined();

      // The stored hash must match the returned raw key.
      const { getApiKeyById } = require('../src/indexer/db');
      const stored = getApiKeyById(created.id);
      expect(stored.key_hash).toBe(sha256(created.key));
      expect(stored.key_hash).not.toBe(created.key);
    });

    it('accepts the provisioned key via middleware', async () => {
      const created = await createKey({ label: 'Provisioning Accept' });
      const { req, res, next } = makeReqRes(created.key);
      verifierApiKey(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.verifier).toMatchObject({ id: created.id, label: 'Provisioning Accept' });
    });
  });

  describe('scope enforcement', () => {
    it('allows a request whose scope is granted', async () => {
      const created = await createKey({ label: 'Scoped Allow', scopes: ['verify:read'] });
      const { req, res, next } = makeReqRes(created.key);
      req.requiredScope = 'verify:read';
      verifierApiKey(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.verifier.scopes).toContain('verify:read');
    });

    it('forbids a request whose scope is not granted', async () => {
      const created = await createKey({ label: 'Scoped Forbid', scopes: ['verify:read'] });
      const { req, res, next } = makeReqRes(created.key);
      req.requiredScope = 'verify:write';
      verifierApiKey(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects a key with no scopes when a scope is required', async () => {
      const created = await createKey({ label: 'No Scopes' });
      const { req, res, next } = makeReqRes(created.key);
      req.requiredScope = 'verify:read';
      verifierApiKey(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('rotation', () => {
    it('rejects the old key and accepts the new key after rotation', async () => {
      const original = await createKey({ label: 'Rotate Me', scopes: ['verify:read'] });

      const rotateRes = await request(app)
        .post(`/admin/api-keys/${original.id}/rotate`)
        .set('Authorization', `Bearer ${issuerToken()}`)
        .send({});
      expect(rotateRes.status).toBe(201);
      expect(typeof rotateRes.body.key).toBe('string');
      expect(rotateRes.body.key).toHaveLength(64);
      expect(rotateRes.body.key).not.toBe(original.key);
      expect(rotateRes.body.rotated_from).toBe(original.id);

      // Old key must be rejected.
      const oldReq = makeReqRes(original.key);
      verifierApiKey(oldReq.req, oldReq.res, oldReq.next);
      expect(oldReq.res.status).toHaveBeenCalledWith(401);
      expect(oldReq.next).not.toHaveBeenCalled();

      // New key must be accepted.
      const newReq = makeReqRes(rotateRes.body.key);
      verifierApiKey(newReq.req, newReq.res, newReq.next);
      expect(newReq.next).toHaveBeenCalled();
      expect(newReq.req.verifier).toMatchObject({ id: rotateRes.body.id });

      // rotated_from must be recorded on the new key.
      const keys = await listKeys();
      const rotated = keys.find(k => k.id === rotateRes.body.id);
      expect(rotated).toBeDefined();
      expect(rotated.rotated_from).toBe(original.id);
    });
  });

  describe('revocation', () => {
    it('rejects a revoked key via middleware', async () => {
      const created = await createKey({ label: 'Revoke Lifecycle' });

      const revokeRes = await request(app)
        .delete(`/admin/api-keys/${created.id}`)
        .set('Authorization', `Bearer ${issuerToken()}`);
      expect(revokeRes.status).toBe(200);
      expect(revokeRes.body.revoked).toBe(true);

      const { req, res, next } = makeReqRes(created.key);
      verifierApiKey(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('audit', () => {
    it('emits audit entries for provisioning, rotation, and revocation', async () => {
      const created = await createKey({ label: 'Audit Lifecycle' });

      const rotateRes = await request(app)
        .post(`/admin/api-keys/${created.id}/rotate`)
        .set('Authorization', `Bearer ${issuerToken()}`)
        .send({});
      expect(rotateRes.status).toBe(201);

      const revokeRes = await request(app)
        .delete(`/admin/api-keys/${rotateRes.body.id}`)
        .set('Authorization', `Bearer ${issuerToken()}`);
      expect(revokeRes.status).toBe(200);

      const audit = await listAudit();
      expect(Array.isArray(audit)).toBe(true);

      const actions = audit.map(a => a.action);
      expect(actions).toEqual(expect.arrayContaining(['create', 'rotate', 'revoke']));

      const createEntry = audit.find(a => a.action === 'create' && a.api_key_id === created.id);
      expect(createEntry).toBeDefined();
      expect(createEntry.actor).toBe('admin');

      const rotateEntry = audit.find(a => a.action === 'rotate' && a.api_key_id === rotateRes.body.id);
      expect(rotateEntry).toBeDefined();
      expect(rotateEntry.actor).toBe('admin');

      const revokeEntry = audit.find(a => a.action === 'revoke' && a.api_key_id === rotateRes.body.id);
      expect(revokeEntry).toBeDefined();
      expect(revokeEntry.actor).toBe('admin');

      // Audit entries must never leak raw keys or hashes.
      audit.forEach(a => {
        expect(a.key).toBeUndefined();
        expect(a.key_hash).toBeUndefined();
      });
    });
  });
});