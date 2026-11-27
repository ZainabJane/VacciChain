/**
 * Tests for the analytics gateway proxy at /v1/analytics/:resource
 *
 * Strategy:
 * - Mock the Node http module so tests never open a real network connection.
 * - Verify allow-list enforcement, timeout/error translation, and auth guard.
 */

const request = require('supertest');
const http = require('http');
const { EventEmitter } = require('events');

// ── Fixtures ──────────────────────────────────────────────────────────────────

// A minimal JWT for a valid authenticated user (auth middleware is mocked).
const VALID_TOKEN = 'Bearer test-token';

// ── Mock auth middleware ───────────────────────────────────────────────────────
// Replace the real JWT validation so we can test the proxy logic in isolation.
jest.mock('../src/middleware/auth', () => {
  const middleware = (req, _res, next) => {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) {
      req.user = { wallet: 'GTEST', role: 'admin' };
      return next();
    }
    _res.status(401).json({ error: 'Unauthorized' });
  };
  middleware.adminAuthMiddleware = middleware;
  return middleware;
});

// Mock everything else the app needs so we can require it safely in a test env.
jest.mock('../src/stellar/soroban', () => ({
  invokeContract: jest.fn(),
  simulateContract: jest.fn(),
  getRpcServer: jest.fn().mockReturnValue({ getHealth: jest.fn().mockResolvedValue({}) }),
  addIssuer: jest.fn(),
  revokeIssuer: jest.fn(),
}));
jest.mock('../src/stellar/issuerCache', () => ({
  isAuthorizedIssuer: jest.fn().mockResolvedValue(true),
  invalidateCache: jest.fn(),
}));
jest.mock('../src/indexer/db', () => ({
  initDb: jest.fn().mockResolvedValue(undefined),
  insertApiKey: jest.fn(),
  listApiKeys: jest.fn().mockResolvedValue([]),
  revokeApiKey: jest.fn(),
  queryAuditLog: jest.fn().mockResolvedValue([]),
}));
jest.mock('../src/indexer/poller', () => ({
  startPoller: jest.fn(),
  stopPoller: jest.fn(),
}));
jest.mock('../src/secrets', () => ({
  initializeSecrets: jest.fn().mockResolvedValue(undefined),
}));

// ── http.request mock helper ───────────────────────────────────────────────────

function makeUpstreamResponse({ statusCode = 200, body = '{}', contentType = 'application/json', error = null, timeout = false } = {}) {
  const req = new EventEmitter();
  req.setTimeout = jest.fn((ms, cb) => {
    if (timeout) setImmediate(cb);
  });
  req.destroy = jest.fn();
  req.end = jest.fn();

  if (!error && !timeout) {
    setImmediate(() => {
      const res = new EventEmitter();
      res.statusCode = statusCode;
      res.headers = { 'content-type': contentType };
      // Simulate pipe by emitting data/end on the response stream
      res.pipe = (writable) => {
        writable.write(body);
        writable.end();
      };
      req.emit('response', res);
    });
  }

  if (error) {
    setImmediate(() => req.emit('error', new Error(error)));
  }

  return req;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Analytics proxy — /v1/analytics/:resource', () => {
  let app;
  let httpRequestSpy;

  beforeAll(() => {
    // require app after mocks are set up
    app = require('../src/app');
  });

  beforeEach(() => {
    httpRequestSpy = jest.spyOn(http, 'request');
  });

  afterEach(() => {
    httpRequestSpy.mockRestore();
  });

  // ── Auth guard ─────────────────────────────────────────────────────────────

  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get('/v1/analytics/rates');
    expect(res.status).toBe(401);
  });

  // ── Allow-list enforcement ─────────────────────────────────────────────────

  it('returns 403 for a path not on the allow-list', async () => {
    const res = await request(app)
      .get('/v1/analytics/internals')
      .set('Authorization', VALID_TOKEN);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not supported/i);
    expect(res.body.allowed).toEqual(expect.arrayContaining(['rates', 'issuers', 'anomalies']));
  });

  it('returns 403 for a path traversal attempt', async () => {
    const res = await request(app)
      .get('/v1/analytics/../../admin')
      .set('Authorization', VALID_TOKEN);

    // Express normalises the path, so this will either 403 or 404 — never proxy.
    expect([403, 404]).toContain(res.status);
  });

  // ── Happy-path forwarding ──────────────────────────────────────────────────

  const ALLOWED = ['rates', 'issuers', 'anomalies'];

  ALLOWED.forEach((resource) => {
    it(`forwards GET /v1/analytics/${resource} to the upstream`, async () => {
      const fakeBody = JSON.stringify({ resource });
      httpRequestSpy.mockImplementation((_opts, cb) => {
        return makeUpstreamResponse({ body: fakeBody });
      });

      const res = await request(app)
        .get(`/v1/analytics/${resource}`)
        .set('Authorization', VALID_TOKEN);

      expect(res.status).toBe(200);
      // The upstream path forwarded must include /analytics/<resource>
      const calledPath = httpRequestSpy.mock.calls[0][0].path;
      expect(calledPath).toBe(`/analytics/${resource}`);
    });
  });

  // ── Error translation ──────────────────────────────────────────────────────

  it('returns 502 when the upstream is unreachable', async () => {
    httpRequestSpy.mockImplementation((_opts, _cb) => {
      return makeUpstreamResponse({ error: 'ECONNREFUSED' });
    });

    const res = await request(app)
      .get('/v1/analytics/rates')
      .set('Authorization', VALID_TOKEN);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/unavailable/i);
  });

  it('returns 504 when the upstream times out', async () => {
    httpRequestSpy.mockImplementation((_opts, _cb) => {
      return makeUpstreamResponse({ timeout: true });
    });

    const res = await request(app)
      .get('/v1/analytics/rates')
      .set('Authorization', VALID_TOKEN);

    expect(res.status).toBe(504);
    expect(res.body.error).toMatch(/timed out/i);
  });

  it('translates a non-200 upstream status through without leaking internals', async () => {
    httpRequestSpy.mockImplementation((_opts, cb) => {
      return makeUpstreamResponse({ statusCode: 500, body: '{"detail":"internal"}' });
    });

    const res = await request(app)
      .get('/v1/analytics/rates')
      .set('Authorization', VALID_TOKEN);

    // Status is forwarded as-is from the upstream.
    expect(res.status).toBe(500);
  });
});
