const request = require('supertest');
const app = require('../src/app');
const health = require('../src/health');
const rateLimit = require('../src/rateLimit');
const logger = require('../src/logger');

describe('Health check', () => {
  afterEach(() => {
    health.setSorobanHealthy(true);
    health.setDatabaseHealthy(true);
  });

  it('GET /health returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('GET /health returns degraded when Soroban is unhealthy', async () => {
    health.setSorobanHealthy(false);
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
    health.setSorobanHealthy(true);
  });

  it('GET /health/live returns 200 while the process is running', async () => {
    health.setSorobanHealthy(false);
    health.setDatabaseHealthy(false);
    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('GET /health/ready returns 200 when dependencies are healthy', async () => {
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks).toEqual(
      expect.objectContaining({ database: 'ok', soroban: 'ok' })
    );
  });

  it('GET /health/ready returns 503 when Soroban is unavailable', async () => {
    health.setSorobanHealthy(false);
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks).toEqual(
      expect.objectContaining({ database: 'ok', soroban: 'unavailable' })
    );
  });

  it('GET /health/ready returns 503 when the database is unavailable', async () => {
    health.setDatabaseHealthy(false);
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks).toEqual(
      expect.objectContaining({ database: 'unavailable', soroban: 'ok' })
    );
  });

  it('health responses do not disclose secrets or raw errors', async () => {
    health.setSorobanHealthy(false);
    health.setDatabaseHealthy(false);
    const endpoints = ['/health', '/health/live', '/health/ready'];
    for (const endpoint of endpoints) {
      const res = await request(app).get(endpoint);
      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/secret/i);
      expect(body).not.toMatch(/password/i);
      expect(body).not.toMatch(/stack/i);
      expect(body).not.toMatch(/error/i);
      expect(res.body).not.toHaveProperty('error');
      expect(res.body).not.toHaveProperty('details');
    }
  });
});

describe('Auth routes', () => {
  it('POST /auth/sep10 requires public_key', async () => {
    const res = await request(app).post('/v1/auth/sep10').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(JSON.stringify(res.body.details)).toMatch(/public_key/);
  });

  it('POST /auth/sep10 rejects invalid key', async () => {
    const res = await request(app).post('/v1/auth/sep10').send({ public_key: 'not-a-key' });
    expect(res.status).toBe(400);
  });

  it('POST /auth/verify requires transaction and nonce', async () => {
    const res = await request(app).post('/v1/auth/verify').send({});
    expect(res.status).toBe(400);
  });
});

describe('Vaccination routes', () => {
  it('POST /vaccination/issue requires auth', async () => {
    const res = await request(app).post('/v1/vaccination/issue').send({});
    expect(res.status).toBe(401);
  });

  it('GET /vaccination/:wallet requires auth', async () => {
    const res = await request(app).get('/v1/vaccination/GABC');
    expect(res.status).toBe(401);
  });
});

describe('Verify route', () => {
  it('GET /verify/:wallet rejects invalid address', async () => {
    const res = await request(app).get('/v1/verify/invalid-address');
    expect(res.status).toBe(400);
  });
});

describe('Rate limiting', () => {
  beforeEach(() => {
    rateLimit.reset();
  });

  afterAll(() => {
    rateLimit.reset();
  });

  it('ignores spoofed X-Forwarded-For from untrusted clients', async () => {
    const limit = rateLimit.getConfig().auth.limit;
    let lastRes;
    for (let i = 0; i < limit + 1; i += 1) {
      lastRes = await request(app)
        .post('/auth/sep10')
        .set('X-Forwarded-For', `203.0.113.${i + 1}`)
        .send({});
    }
    expect(lastRes.status).toBe(429);
    expect(lastRes.headers['retry-after']).toBeDefined();
    expect(lastRes.body.retryAfter).toBeGreaterThan(0);
  });

  it('honors X-Forwarded-For only from trusted proxies', async () => {
    const limit = rateLimit.getConfig().auth.limit;
    const clientA = '198.51.100.10';
    const clientB = '198.51.100.11';
    let lastRes;
    for (let i = 0; i < limit; i += 1) {
      lastRes = await request(app)
        .post('/auth/sep10')
        .set('X-Forwarded-For', clientA)
        .send({});
    }
    expect(lastRes.status).toBe(400);
    lastRes = await request(app)
      .post('/auth/sep10')
      .set('X-Forwarded-For', clientA)
      .send({});
    expect(lastRes.status).toBe(429);

    const otherRes = await request(app)
      .post('/auth/sep10')
      .set('X-Forwarded-For', clientB)
      .send({});
    expect(otherRes.status).toBe(400);
  });

  it('returns 429 with Retry-After and retryAfter metadata on burst', async () => {
    const limit = rateLimit.getConfig().verify.limit;
    let lastRes;
    for (let i = 0; i < limit + 1; i += 1) {
      lastRes = await request(app).get('/verify/invalid-address');
    }
    expect(lastRes.status).toBe(429);
    expect(Number(lastRes.headers['retry-after'])).toBeGreaterThan(0);
    expect(lastRes.body.error).toBe('Too many requests');
    expect(lastRes.body.retryAfter).toBeGreaterThan(0);
  });

  it('shares limits across instances via a shared store', async () => {
    const store = rateLimit.createMemoryStore();
    rateLimit.setStore(store);
    const limit = rateLimit.getConfig().auth.limit;
    let lastRes;
    for (let i = 0; i < limit + 1; i += 1) {
      lastRes = await request(app).post('/auth/sep10').send({});
    }
    expect(lastRes.status).toBe(429);
    const keys = store.keys();
    expect(keys.length).toBeGreaterThan(0);
    rateLimit.setStore(rateLimit.createMemoryStore());
  });
});

describe('Log redaction', () => {
  let records;
  let originalWrite;

  beforeEach(() => {
    records = [];
    originalWrite = process.stdout.write;
    process.stdout.write = (chunk, ...rest) => {
      records.push(String(chunk));
      return true;
    };
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it('never logs JWTs, secret keys, or signed XDR payloads', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.c2lnbmF0dXJl';
    const secretKey = 'S' + 'A'.repeat(55);
    const signedXdr = 'AAAAAgAAAAB' + 'B'.repeat(80);

    await request(app)
      .post('/auth/verify')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ transaction: signedXdr, nonce: 'nonce', secret_key: secretKey });

    logger.error('auth failure', {
      authorization: `Bearer ${jwt}`,
      secret_key: secretKey,
      transaction: signedXdr,
    });

    const output = records.join('\n');
    expect(output).not.toContain(jwt);
    expect(output).not.toContain(secretKey);
    expect(output).not.toContain(signedXdr);
  });
});
