const { validateEnv } = require('../src/config');

const valid = {
  HORIZON_URL: 'https://horizon-testnet.stellar.org',
  SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
  STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  VACCINATIONS_CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
  ADMIN_SECRET_KEY: 'STEST000000000000000000000000000000000000000000000000000',
  SEP10_SERVER_KEY: 'STEST000000000000000000000000000000000000000000000000001',
  JWT_SECRET: 'test-jwt-secret',
};

describe('validateEnv', () => {
  it('passes with all required variables present', () => {
    expect(() => validateEnv(valid)).not.toThrow();
  });

  it('throws with the variable name when a required variable is missing', () => {
    const { HORIZON_URL: _, ...env } = valid;
    expect(() => validateEnv(env)).toThrow('HORIZON_URL');
  });

  it('throws a format error when ADMIN_SECRET_KEY does not start with S', () => {
    expect(() => validateEnv({ ...valid, ADMIN_SECRET_KEY: 'XBADKEY' })).toThrow(
      'ADMIN_SECRET_KEY'
    );
  });

  it('throws when STELLAR_NETWORK is set to an invalid value', () => {
    expect(() => validateEnv({ ...valid, STELLAR_NETWORK: 'devnet' })).toThrow('STELLAR_NETWORK');
  });

  it('is callable without side effects (no process.exit)', () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    expect(() => validateEnv({ ...valid, HORIZON_URL: 'not-a-url' })).toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});

describe('startup initialization', () => {
  let initializeStartup;
  let isReady;

  beforeEach(() => {
    jest.resetModules();
    ({ initializeStartup, isReady } = require('../src/startup'));
  });

  const okStep = () => Promise.resolve();

  it('reports a structured diagnostic and non-zero exit when config is missing', async () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await initializeStartup({
      steps: {
        config: () => {
          throw new Error('HORIZON_URL is required');
        },
        secrets: okStep,
        database: okStep,
        poller: okStep,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostic).toMatchObject({
      event: 'startup_failure',
      step: 'config',
    });
    expect(typeof result.diagnostic.message).toBe('string');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(isReady()).toBe(false);

    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('reports a structured diagnostic when secrets initialization fails', async () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await initializeStartup({
      steps: {
        config: okStep,
        secrets: () => Promise.reject(new Error('vault unreachable')),
        database: okStep,
        poller: okStep,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostic).toMatchObject({
      event: 'startup_failure',
      step: 'secrets',
    });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(isReady()).toBe(false);

    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('reports a structured diagnostic when database initialization fails', async () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await initializeStartup({
      steps: {
        config: okStep,
        secrets: okStep,
        database: () => Promise.reject(new Error('connection refused')),
        poller: okStep,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostic).toMatchObject({
      event: 'startup_failure',
      step: 'database',
    });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(isReady()).toBe(false);

    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('reports a structured diagnostic when poller initialization fails', async () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await initializeStartup({
      steps: {
        config: okStep,
        secrets: okStep,
        database: okStep,
        poller: () => Promise.reject(new Error('poller start failed')),
      },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostic).toMatchObject({
      event: 'startup_failure',
      step: 'poller',
    });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(isReady()).toBe(false);

    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('does not leak secrets in the structured diagnostic', async () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const secret = valid.ADMIN_SECRET_KEY;
    const result = await initializeStartup({
      steps: {
        config: okStep,
        secrets: () => Promise.reject(new Error(`failed to load ${secret}`)),
        database: okStep,
        poller: okStep,
      },
    });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.diagnostic)).not.toContain(secret);
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('keeps readiness false until all initialization steps succeed', async () => {
    let releaseDatabase;
    const databaseGate = new Promise((resolve) => {
      releaseDatabase = resolve;
    });

    const initPromise = initializeStartup({
      steps: {
        config: okStep,
        secrets: okStep,
        database: () => databaseGate,
        poller: okStep,
      },
    });

    // Give the earlier steps a chance to run; readiness must still be false.
    await Promise.resolve();
    expect(isReady()).toBe(false);

    releaseDatabase();
    const result = await initPromise;

    expect(result.ok).toBe(true);
    expect(isReady()).toBe(true);
  });
});
