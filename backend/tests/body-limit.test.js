const request = require('supertest');
const app = require('../src/app');

describe('Body size limit', () => {
  it('returns 413 when JSON body exceeds limit', async () => {
    const large = { data: 'x'.repeat(11 * 1024) }; // > 10 kb
    const res = await request(app).post('/v1/auth/sep10').send(large);
    expect(res.status).toBe(413);
  });

  it('returns a stable 413 error shape with error and requestId', async () => {
    const large = { data: 'x'.repeat(11 * 1024) }; // > 10 kb
    const res = await request(app).post('/auth/sep10').send(large);
    expect(res.status).toBe(413);
    expect(res.body).toBeDefined();
    expect(res.body.error).toBeDefined();
    expect(typeof res.body.error).toBe('string');
    expect(res.body.requestId).toBeDefined();
    expect(typeof res.body.requestId).toBe('string');
  });

  it('accepts requests within the limit', async () => {
    const small = { public_key: 'GABC' };
    const res = await request(app).post('/v1/auth/sep10').send(small);
    expect(res.status).not.toBe(413);
  });

  it('rejects oversized query parameters with a 400', async () => {
    const oversized = 'x'.repeat(2048);
    const res = await request(app)
      .get('/auth/sep10')
      .query({ q: oversized });
    expect(res.status).toBe(400);
    expect(res.body).toBeDefined();
    expect(res.body.error).toBeDefined();
    expect(typeof res.body.error).toBe('string');
  });

  it('rejects oversized query parameter arrays with a 400', async () => {
    const many = Array.from({ length: 200 }, (_, i) => `v${i}`);
    const res = await request(app)
      .get('/auth/sep10')
      .query({ tag: many });
    expect(res.status).toBe(400);
    expect(res.body).toBeDefined();
    expect(res.body.error).toBeDefined();
  });

  it('rejects oversized nested-object payloads with a 400', async () => {
    const nested = { public_key: 'GABC', meta: {} };
    let cursor = nested.meta;
    for (let i = 0; i < 50; i += 1) {
      cursor.next = {};
      cursor = cursor.next;
    }
    const res = await request(app).post('/auth/sep10').send(nested);
    expect(res.status).toBe(400);
    expect(res.body).toBeDefined();
    expect(res.body.error).toBeDefined();
    expect(typeof res.body.error).toBe('string');
  });

  it('rejects oversized arrays in payloads with a 400', async () => {
    const payload = {
      public_key: 'GABC',
      items: Array.from({ length: 5000 }, (_, i) => i),
    };
    const res = await request(app).post('/auth/sep10').send(payload);
    expect(res.status).toBe(400);
    expect(res.body).toBeDefined();
    expect(res.body.error).toBeDefined();
  });

  it('rejects oversized strings in payloads with a 400', async () => {
    const payload = {
      public_key: 'GABC',
      note: 'y'.repeat(5000),
    };
    const res = await request(app).post('/auth/sep10').send(payload);
    expect(res.status).toBe(400);
    expect(res.body).toBeDefined();
    expect(res.body.error).toBeDefined();
  });
});