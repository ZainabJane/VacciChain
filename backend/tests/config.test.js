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

  describe('trusted proxy configuration', () => {
    it('accepts a boolean TRUST_PROXY value', () => {
      expect(() => validateEnv({ ...valid, TRUST_PROXY: 'true' })).not.toThrow();
      expect(() => validateEnv({ ...valid, TRUST_PROXY: 'false' })).not.toThrow();
    });

    it('accepts a hop count TRUST_PROXY value', () => {
      expect(() => validateEnv({ ...valid, TRUST_PROXY: '1' })).not.toThrow();
    });

    it('accepts a comma-separated list of trusted proxy addresses', () => {
      expect(() =>
        validateEnv({ ...valid, TRUST_PROXY: '10.0.0.1, 192.168.1.0/24' })
      ).not.toThrow();
    });

    it('throws when TRUST_PROXY is set to an invalid value', () => {
      expect(() => validateEnv({ ...valid, TRUST_PROXY: 'yes-please' })).toThrow('TRUST_PROXY');
    });
  });

  describe('rate limit configuration', () => {
    it('accepts positive integer limits for onboarding and batch verification', () => {
      expect(() =>
        validateEnv({
          ...valid,
          RATE_LIMIT_ONBOARDING: '10',
          RATE_LIMIT_BATCH_VERIFY: '5',
        })
      ).not.toThrow();
    });

    it('throws when RATE_LIMIT_ONBOARDING is not a positive integer', () => {
      expect(() => validateEnv({ ...valid, RATE_LIMIT_ONBOARDING: '0' })).toThrow(
        'RATE_LIMIT_ONBOARDING'
      );
      expect(() => validateEnv({ ...valid, RATE_LIMIT_ONBOARDING: 'abc' })).toThrow(
        'RATE_LIMIT_ONBOARDING'
      );
    });

    it('throws when RATE_LIMIT_BATCH_VERIFY is not a positive integer', () => {
      expect(() => validateEnv({ ...valid, RATE_LIMIT_BATCH_VERIFY: '-1' })).toThrow(
        'RATE_LIMIT_BATCH_VERIFY'
      );
    });

    it('accepts supported RATE_LIMIT_STORE values', () => {
      expect(() => validateEnv({ ...valid, RATE_LIMIT_STORE: 'memory' })).not.toThrow();
      expect(() => validateEnv({ ...valid, RATE_LIMIT_STORE: 'redis' })).not.toThrow();
    });

    it('throws when RATE_LIMIT_STORE is set to an unsupported value', () => {
      expect(() => validateEnv({ ...valid, RATE_LIMIT_STORE: 'sqlite' })).toThrow(
        'RATE_LIMIT_STORE'
      );
    });
  });
});

describe('validateConfig', () => {
  const baseConfig = {
    ...valid,
    PORT: 3000,
    STELLAR_NETWORK: 'testnet',
    MAX_BATCH_SIZE: 100,
    MIN_BATCH_SIZE: 1,
    REQUEST_TIMEOUT_MS: 30000,
  };

  it('passes with a fully valid configuration', () => {
    expect(() => validateConfig(baseConfig)).not.toThrow();
  });

  it('throws naming each missing required variable', () => {
    for (const key of [
      'HORIZON_URL',
      'SOROBAN_RPC_URL',
      'STELLAR_NETWORK_PASSPHRASE',
      'VACCINATIONS_CONTRACT_ID',
      'ADMIN_SECRET_KEY',
      'SEP10_SERVER_KEY',
      'JWT_SECRET',
    ]) {
      const env = { ...baseConfig };
      delete env[key];
      expect(() => validateConfig(env)).toThrow(key);
    }
  });

  it('throws on malformed URLs', () => {
    expect(() => validateConfig({ ...baseConfig, HORIZON_URL: 'not-a-url' })).toThrow(
      'HORIZON_URL'
    );
    expect(() => validateConfig({ ...baseConfig, SOROBAN_RPC_URL: 'ftp://bad' })).toThrow(
      'SOROBAN_RPC_URL'
    );
  });

  it('throws on an invalid network name', () => {
    expect(() => validateConfig({ ...baseConfig, STELLAR_NETWORK: 'devnet' })).toThrow(
      'STELLAR_NETWORK'
    );
  });

  it('throws when the network and passphrase contradict each other', () => {
    expect(() =>
      validateConfig({
        ...baseConfig,
        STELLAR_NETWORK: 'mainnet',
        STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
      })
    ).toThrow(/STELLAR_NETWORK/);
  });

  it('throws on out-of-range limits', () => {
    expect(() => validateConfig({ ...baseConfig, PORT: 0 })).toThrow('PORT');
    expect(() => validateConfig({ ...baseConfig, PORT: 70000 })).toThrow('PORT');
    expect(() => validateConfig({ ...baseConfig, MAX_BATCH_SIZE: -1 })).toThrow(
      'MAX_BATCH_SIZE'
    );
    expect(() =>
      validateConfig({ ...baseConfig, MIN_BATCH_SIZE: 10, MAX_BATCH_SIZE: 5 })
    ).toThrow(/BATCH_SIZE/);
    expect(() => validateConfig({ ...baseConfig, REQUEST_TIMEOUT_MS: 0 })).toThrow(
      'REQUEST_TIMEOUT_MS'
    );
  });

  it('throws when ADMIN_SECRET_KEY equals SEP10_SERVER_KEY', () => {
    expect(() =>
      validateConfig({ ...baseConfig, SEP10_SERVER_KEY: baseConfig.ADMIN_SECRET_KEY })
    ).toThrow(/ADMIN_SECRET_KEY|SEP10_SERVER_KEY/);
  });

  it('throws when JWT_SECRET is too short', () => {
    expect(() => validateConfig({ ...baseConfig, JWT_SECRET: 'short' })).toThrow('JWT_SECRET');
  });

  it('does not call process.exit on invalid configuration', () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    expect(() => validateConfig({ ...baseConfig, PORT: -1 })).toThrow();
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
