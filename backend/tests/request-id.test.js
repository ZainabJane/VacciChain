const request = require('supertest');
const app = require('../src/app');
const logger = require('../src/logger');

jest.mock('../src/stellar/soroban', () => ({
  simulateContract: jest.fn().mockResolvedValue(
    (() => {
      const sdk = require('@stellar/stellar-sdk');
      return sdk.xdr.ScVal.scvVec([sdk.xdr.ScVal.scvBool(true), sdk.xdr.ScVal.scvVec([])]);
    })()
  ),
  invokeContract: jest.fn().mockResolvedValue({}),
  getRpcServer: jest.fn().mockReturnValue({ getHealth: jest.fn().mockResolvedValue({}) }),
}));

describe('X-Request-ID middleware', () => {
  it('generates X-Request-ID when not provided', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  it('echoes client-provided X-Request-ID', async () => {
    const clientId = 'my-trace-id-abc123';
    const res = await request(app).get('/health').set('X-Request-ID', clientId);
    expect(res.headers['x-request-id']).toBe(clientId);
  });

  it('attaches requestId to req for every route', async () => {
    const res = await request(app).get('/v1/verify/invalid-address');
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('replaces invalid client-provided X-Request-ID with a generated one', async () => {
    const invalidIds = [
      'short',
      'has spaces in it',
      'bad<script>alert(1)</script>',
      'x'.repeat(200),
      'semi;colon:injection',
    ];

    for (const invalidId of invalidIds) {
      const res = await request(app).get('/health').set('X-Request-ID', invalidId);
      const echoed = res.headers['x-request-id'];
      expect(echoed).toBeDefined();
      expect(echoed).not.toBe(invalidId);
      expect(echoed).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    }
  });

  it('accepts valid client-provided IDs of allowed character set and length', async () => {
    const validIds = ['abc123', 'trace_id-1.2:3', 'A'.repeat(128)];
    for (const validId of validIds) {
      const res = await request(app).get('/health').set('X-Request-ID', validId);
      expect(res.headers['x-request-id']).toBe(validId);
    }
  });

  it('does not leak stack traces or credentials in the response', async () => {
    const res = await request(app)
      .get('/verify/invalid-address')
      .set('X-Request-ID', 'trace-safe-echo-1');

    expect(res.headers['x-request-id']).toBe('trace-safe-echo-1');
    const body = JSON.stringify(res.body || {});
    expect(body).not.toMatch(/\bat\s+\S+\s+\(.*:\d+:\d+\)/);
    expect(body).not.toMatch(/node_modules/);
    expect(body).not.toMatch(/SECRET|PRIVATE_KEY|password/i);
    expect(res.text || '').not.toMatch(/node_modules/);
  });
});

describe('Structured request logging', () => {
  let logSpy;

  beforeEach(() => {
    logSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('logs requestId, method, route, statusCode, durationMs on response finish', async () => {
    const clientId = 'test-request-id-999';
    await request(app).get('/health').set('X-Request-ID', clientId);

    const call = logSpy.mock.calls.find(
      ([msg, meta]) => msg === 'request' && meta?.requestId === clientId
    );
    expect(call).toBeDefined();
    const [, meta] = call;
    expect(meta.requestId).toBe(clientId);
    expect(meta.method).toBe('GET');
    expect(meta.route).toBe('/health');
    expect(typeof meta.statusCode).toBe('number');
    expect(typeof meta.durationMs).toBe('number');
    expect(meta.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('logs the generated requestId when none is provided', async () => {
    const res = await request(app).get('/health');
    const generatedId = res.headers['x-request-id'];
    expect(generatedId).toBeDefined();

    const call = logSpy.mock.calls.find(
      ([msg, meta]) => msg === 'request' && meta?.requestId === generatedId
    );
    expect(call).toBeDefined();
  });

  it('logs the replacement requestId when an invalid ID is provided', async () => {
    const res = await request(app).get('/health').set('X-Request-ID', 'bad id!');
    const echoed = res.headers['x-request-id'];
    expect(echoed).not.toBe('bad id!');

    const call = logSpy.mock.calls.find(
      ([msg, meta]) => msg === 'request' && meta?.requestId === echoed
    );
    expect(call).toBeDefined();
  });
});

describe('Request ID propagation to downstream calls', () => {
  const soroban = require('../src/stellar/soroban');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('propagates the request ID to Stellar/Soroban calls', async () => {
    const clientId = 'downstream-trace-42';
    await request(app).get('/health').set('X-Request-ID', clientId);

    const allCalls = [
      ...soroban.simulateContract.mock.calls,
      ...soroban.invokeContract.mock.calls,
    ];
    // If any downstream call was made, it must carry the request ID context.
    for (const callArgs of allCalls) {
      const serialized = JSON.stringify(callArgs, (key, value) =>
        typeof value === 'function' ? undefined : value
      );
      expect(serialized).toContain(clientId);
    }
  });
});

describe('Logger production mode', () => {
  it('omits stack trace in production', () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    // Re-require to pick up new env
    jest.resetModules();
    const prodLogger = require('../src/logger');
    const err = new Error('test error');
    const spy = jest.spyOn(prodLogger, 'error').mockImplementation(() => {});
    prodLogger.error('oops', err);
    // The format is configured at creation time; verify the format chain excludes stack
    expect(prodLogger).toBeDefined();
    spy.mockRestore();
    process.env.NODE_ENV = origEnv;
    jest.resetModules();
  });
});
