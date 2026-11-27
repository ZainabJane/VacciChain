const request = require('supertest');
const express = require('express');
const errorHandler = require('../src/middleware/errorHandler');
const { AppError } = require('../src/middleware/errors');
const requestId = require('../src/middleware/requestId');
const logger = require('../src/utils/logger');

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
    expect(res.body.code).toBe('internal_server_error');
    expect(res.body.message).toBe('Internal Server Error');
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
    expect(res.body.message).toBe('resource not found');
    expect(res.body.requestId).toBeDefined();
  });

  it('returns standardized shape for AppError', async () => {
    const app = makeApp((_req, _res, next) => {
      next(new AppError('validation_failed', 'bad input', 400));
    });
    const res = await request(app).get('/test');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.message).toBe('bad input');
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
    expect(res.body.message).toBe('Internal Server Error');
  });

  describe('log redaction', () => {
    const JWT =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const SECRET_KEY = 'sk_live_super_secret_key_value_1234567890';
    const SIGNED_XDR =
      'AAAAAgAAAABsignedTransactionPayloadEnvelopeBase64EncodedValueXYZ1234567890==';

    let logSpy;

    beforeEach(() => {
      logSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      logSpy.mockRestore();
    });

    function emittedLogText() {
      return logSpy.mock.calls
        .map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
        .join('\n');
    }

    it('redacts JWTs, secret keys and signed payloads from error logs', async () => {
      const app = makeApp((req, _res, next) => {
        const err = new Error('payment failed');
        err.statusCode = 400;
        err.details = {
          authorization: `Bearer ${JWT}`,
          secretKey: SECRET_KEY,
          signedXdr: SIGNED_XDR,
        };
        req.headers.authorization = `Bearer ${JWT}`;
        req.body = { secretKey: SECRET_KEY, signedXdr: SIGNED_XDR };
        next(err);
      });

      await request(app)
        .get('/test')
        .set('Authorization', `Bearer ${JWT}`)
        .set('X-Api-Key', SECRET_KEY);

      const text = emittedLogText();
      expect(text).not.toContain(JWT);
      expect(text).not.toContain(SECRET_KEY);
      expect(text).not.toContain(SIGNED_XDR);
    });

    it('does not leak secrets embedded in error messages', async () => {
      const app = makeApp((_req, _res, next) => {
        const err = new Error(`invalid token ${JWT} with key ${SECRET_KEY}`);
        next(err);
      });

      await request(app).get('/test');

      const text = emittedLogText();
      expect(text).not.toContain(JWT);
      expect(text).not.toContain(SECRET_KEY);
    });

    it('omits unnecessary internal details from health log records', async () => {
      const app = makeApp((_req, _res, next) => {
        const err = new Error('health check failed');
        err.statusCode = 503;
        err.health = {
          database: { host: '10.0.0.5', user: 'admin', password: SECRET_KEY },
          uptime: 12345,
        };
        next(err);
      });

      await request(app).get('/test');

      const text = emittedLogText();
      expect(text).not.toContain(SECRET_KEY);
      expect(text).not.toContain('10.0.0.5');
    });
  });
});
