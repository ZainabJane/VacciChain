/**
 * Tests for Soroban error classes and helper function signatures
 */
const {
  SorobanError,
  SorobanTransactionError,
  SorobanSimulationError,
  SorobanRpcError,
} = require('../src/stellar/soroban');
const {
  StellarClient,
  StellarTimeoutError,
  StellarRetryExhaustedError,
} = require('../src/stellar/client');

const contractErrors = require('../src/stellar/contractErrors');

describe('Soroban Error Classes', () => {
  describe('SorobanError', () => {
    it('is an Error subclass with proper name', () => {
      const original = new Error('original error');
      const error = new SorobanError('test message', original);
      
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('SorobanError');
      expect(error.message).toBe('test message');
      expect(error.original).toBe(original);
    });

    it('can be thrown and caught', () => {
      const error = new SorobanError('test', null);
      
      expect(() => {
        throw error;
      }).toThrow(SorobanError);
    });
  });

  describe('SorobanRpcError', () => {
    it('is subclass of SorobanError', () => {
      const error = new SorobanRpcError('RPC failed', new Error('network'));
      
      expect(error).toBeInstanceOf(SorobanError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('SorobanRpcError');
      expect(error.message).toBe('RPC failed');
    });
  });

  describe('SorobanTransactionError', () => {
    it('is subclass of SorobanError', () => {
      const error = new SorobanTransactionError('TX failed', new Error('gas'));
      
      expect(error).toBeInstanceOf(SorobanError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('SorobanTransactionError');
      expect(error.message).toBe('TX failed');
    });

    it('preserves original error', () => {
      const originalError = new Error('insufficient fee');
      const error = new SorobanTransactionError('Mint failed', originalError);
      
      expect(error.original).toBe(originalError);
      expect(error.original.message).toBe('insufficient fee');
    });
  });

  describe('SorobanSimulationError', () => {
    it('is subclass of SorobanError', () => {
      const error = new SorobanSimulationError('Simulation failed', new Error('contract'));
      
      expect(error).toBeInstanceOf(SorobanError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('SorobanSimulationError');
      expect(error.message).toBe('Simulation failed');
    });

    it('can be caught as SorobanError', () => {
      const error = new SorobanSimulationError('Verify failed', null);
      
      expect(() => {
        throw error;
      }).toThrow(SorobanError);
    });
  });

  describe('Error Hierarchy', () => {
    it('all custom errors inherit from Error', () => {
      const errors = [
        new SorobanError('e1', null),
        new SorobanRpcError('e2', null),
        new SorobanTransactionError('e3', null),
        new SorobanSimulationError('e4', null),
      ];

      errors.forEach((err) => {
        expect(err).toBeInstanceOf(Error);
      });
    });

    it('typed errors can be distinguished', () => {
      const rpc = new SorobanRpcError('rpc', null);
      const tx = new SorobanTransactionError('tx', null);
      const sim = new SorobanSimulationError('sim', null);

      expect(rpc.name).toBe('SorobanRpcError');
      expect(tx.name).toBe('SorobanTransactionError');
      expect(sim.name).toBe('SorobanSimulationError');
    });
  });

  describe('Typed error catching', () => {
    it('instanceof checks work for error filtering', () => {
      const errors = [
        new SorobanTransactionError('tx error', null),
        new SorobanSimulationError('sim error', null),
        new Error('generic error'),
      ];

      const txErrors = errors.filter((e) => e instanceof SorobanTransactionError);
      const simErrors = errors.filter((e) => e instanceof SorobanSimulationError);
      const sorobanErrors = errors.filter((e) => e instanceof SorobanError);

      expect(txErrors).toHaveLength(1);
      expect(simErrors).toHaveLength(1);
      expect(sorobanErrors).toHaveLength(2);
    });
  });
});

describe('StellarClient timeouts and retries', () => {
  const makeClient = (overrides = {}) =>
    new StellarClient({
      timeoutMs: 50,
      maxRetries: 2,
      retryDelayMs: 1,
      ...overrides,
    });

  const hanging = () => new Promise(() => {});

  describe('timeout enforcement', () => {
    it('rejects with a StellarTimeoutError when a call exceeds the timeout', async () => {
      const client = makeClient();
      const call = jest.fn(hanging);

      await expect(client.read('getLedger', call)).rejects.toBeInstanceOf(
        StellarTimeoutError
      );
      expect(call).toHaveBeenCalledTimes(1);
    });

    it('classifies the timeout error and attaches a correlation id', async () => {
      const client = makeClient();
      const call = jest.fn(hanging);

      const error = await client.read('getLedger', call).catch((e) => e);

      expect(error).toBeInstanceOf(SorobanError);
      expect(error.code).toBe('STELLAR_TIMEOUT');
      expect(typeof error.correlationId).toBe('string');
      expect(error.correlationId.length).toBeGreaterThan(0);
    });

    it('resolves normally when the call completes within the timeout', async () => {
      const client = makeClient();

      await expect(
        client.read('getLedger', async () => 'ok')
      ).resolves.toBe('ok');
    });
  });

  describe('retry policy for idempotent reads', () => {
    it('retries transient failures on reads and eventually succeeds', async () => {
      const client = makeClient();
      const call = jest
        .fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce('ok');

      await expect(client.read('getLedger', call)).resolves.toBe('ok');
      expect(call).toHaveBeenCalledTimes(2);
    });

    it('retries timeouts on reads', async () => {
      const client = makeClient({ timeoutMs: 10 });
      const call = jest
        .fn()
        .mockImplementationOnce(hanging)
        .mockResolvedValueOnce('ok');

      await expect(client.read('getLedger', call)).resolves.toBe('ok');
      expect(call).toHaveBeenCalledTimes(2);
    });

    it('does not retry non-retryable errors on reads', async () => {
      const client = makeClient();
      const call = jest.fn().mockRejectedValue(new Error('invalid argument'));

      await expect(client.read('getLedger', call)).rejects.toBeInstanceOf(
        SorobanError
      );
      expect(call).toHaveBeenCalledTimes(1);
    });

    it('throws a classified StellarRetryExhaustedError with correlation id when retries run out', async () => {
      const client = makeClient({ maxRetries: 2 });
      const call = jest.fn().mockRejectedValue(new Error('ECONNRESET'));

      const error = await client.read('getLedger', call).catch((e) => e);

      expect(error).toBeInstanceOf(StellarRetryExhaustedError);
      expect(error).toBeInstanceOf(SorobanError);
      expect(error.code).toBe('STELLAR_RETRY_EXHAUSTED');
      expect(typeof error.correlationId).toBe('string');
      expect(error.correlationId.length).toBeGreaterThan(0);
      expect(call).toHaveBeenCalledTimes(3);
    });
  });

  describe('transaction submissions', () => {
    it('does not retry transaction submissions', async () => {
      const client = makeClient({ maxRetries: 3 });
      const call = jest.fn().mockRejectedValue(new Error('ECONNRESET'));

      await expect(
        client.submit('sendTransaction', call)
      ).rejects.toBeInstanceOf(SorobanError);
      expect(call).toHaveBeenCalledTimes(1);
    });

    it('does not retry submissions on timeout', async () => {
      const client = makeClient({ timeoutMs: 10, maxRetries: 3 });
      const call = jest.fn(hanging);

      await expect(
        client.submit('sendTransaction', call)
      ).rejects.toBeInstanceOf(StellarTimeoutError);
      expect(call).toHaveBeenCalledTimes(1);
    });

    it('attaches a correlation id to submission errors', async () => {
      const client = makeClient();
      const call = jest.fn().mockRejectedValue(new Error('tx failed'));

      const error = await client
        .submit('sendTransaction', call)
        .catch((e) => e);

      expect(typeof error.correlationId).toBe('string');
      expect(error.correlationId.length).toBeGreaterThan(0);
    });
  });
});
