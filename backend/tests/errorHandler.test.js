const request = require('supertest');
const express = require('express');
const errorHandler = require('../src/middleware/errorHandler');
const requestId = require('../src/middleware/requestId');

function makeApp(routeHandler) {
  const app = express();
  app.use(requestId);
  app.get('/test', routeHandler);
  app.use(errorHandler);
  return app;
}

describe('errorHandler middleware', () => {
  it('returns 500 with generic message for unexpected errors', async () => {
    const app = makeApp((_req, _res, next) => {
      next(new Error('db exploded'));
    });
    const res = await request(app).get('/test');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal Server Error');
    expect(res.body.requestId).toBeDefined();
    // internal detail must not leak
    expect(JSON.stringify(res.body)).not.toMatch(/db exploded/);
  });

  it('returns 4xx with the original message for operational errors', async () => {
    const app = makeApp((_req, _res, next) => {
      const err = new Error('resource not found');
      err.statusCode = 404;
      next(err);
    });
    const res = await request(app).get('/test');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('resource not found');
    expect(res.body.requestId).toBeDefined();
  });

  it('includes requestId in the response body', async () => {
    const app = makeApp((_req, _res, next) => next(new Error('boom')));
    const res = await request(app).get('/test');
    expect(typeof res.body.requestId).toBe('string');
    expect(res.body.requestId.length).toBeGreaterThan(0);
  });

  it('uses the requestId from X-Request-ID header when provided', async () => {
    const app = makeApp((_req, _res, next) => next(new Error('boom')));
    const res = await request(app).get('/test').set('X-Request-ID', 'my-trace-id');
    expect(res.body.requestId).toBe('my-trace-id');
  });

  it('defaults to 500 when statusCode is not set', async () => {
    const app = makeApp((_req, _res, next) => {
      const err = new Error('unexpected');
      next(err);
    });
    const res = await request(app).get('/test');
    expect(res.status).toBe(500);
  });

  it('defaults to 500 for invalid statusCode values', async () => {
    const app = makeApp((_req, _res, next) => {
      const err = new Error('bad code');
      err.statusCode = 'oops';
      next(err);
    });
    const res = await request(app).get('/test');
    expect(res.status).toBe(500);
  });

  it('handles 5xx statusCode as unexpected (generic message)', async () => {
    const app = makeApp((_req, _res, next) => {
      const err = new Error('downstream failure');
      err.statusCode = 503;
      next(err);
    });
    const res = await request(app).get('/test');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Internal Server Error');
  });

  it('exposes requestId in the X-Request-ID response header', async () => {
    const app = makeApp((_req, _res, next) => next(new Error('boom')));
    const res = await request(app).get('/test').set('X-Request-ID', 'header-trace-id');
    expect(res.headers['x-request-id']).toBe('header-trace-id');
    expect(res.body.requestId).toBe('header-trace-id');
  });

  it('generates a requestId when the header is missing', async () => {
    const app = makeApp((_req, _res, next) => next(new Error('boom')));
    const res = await request(app).get('/test');
    expect(typeof res.headers['x-request-id']).toBe('string');
    expect(res.headers['x-request-id'].length).toBeGreaterThan(0);
    expect(res.headers['x-request-id']).toBe(res.body.requestId);
  });

  it('replaces an invalid requestId with a generated one', async () => {
    const app = makeApp((_req, _res, next) => next(new Error('boom')));
    const res = await request(app)
      .get('/test')
      .set('X-Request-ID', 'bad id with spaces & <script>');
    expect(res.body.requestId).toBeDefined();
    expect(res.body.requestId).not.toBe('bad id with spaces & <script>');
    expect(res.body.requestId).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(res.headers['x-request-id']).toBe(res.body.requestId);
  });

  it('does not leak stack traces for unexpected errors', async () => {
    const app = makeApp((_req, _res, next) => {
      const err = new Error('secret internal failure');
      err.stack = 'Error: secret internal failure\n    at /app/src/secret.js:1:1';
      next(err);
    });
    const res = await request(app).get('/test');
    expect(res.status).toBe(500);
    expect(res.body.stack).toBeUndefined();
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/secret internal failure/);
    expect(serialized).not.toMatch(/\/app\/src\/secret\.js/);
    expect(serialized).not.toMatch(/at\s/);
  });

  it('does not leak stack traces for operational errors', async () => {
    const app = makeApp((_req, _res, next) => {
      const err = new Error('resource not found');
      err.statusCode = 404;
      err.stack = 'Error: resource not found\n    at /app/src/secret.js:1:1';
      next(err);
    });
    const res = await request(app).get('/test');
    expect(res.status).toBe(404);
    expect(res.body.stack).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/\/app\/src\/secret\.js/);
  });

  it('does not leak credentials in the error response', async () => {
    const app = makeApp((_req, _res, next) => {
      const err = new Error('auth failed for token=supersecret');
      err.statusCode = 401;
      next(err);
    });
    const res = await request(app).get('/test');
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toMatch(/supersecret/);
  });
});
