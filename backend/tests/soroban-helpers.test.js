/**
 * Tests for Soroban error classes and helper function signatures
 */
const {
  SorobanError,
  SorobanTransactionError,
  SorobanSimulationError,
  SorobanRpcError,
} = require('../src/stellar/soroban');

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

describe('Contract error code mapping (issue #95)', () => {
  // Every contract error code must map to a stable API error shape/status.
  const CONTRACT_ERROR_CODES = [
    'Unauthorized',
    'NotAuthorized',
    'InvalidSignature',
    'InvalidArgument',
    'InvalidInput',
    'NotFound',
    'AlreadyExists',
    'InsufficientBalance',
    'InsufficientAllowance',
    'ConsentRequired',
    'ConsentRevoked',
    'NotAllowlisted',
    'AlreadyInitialized',
    'NotInitialized',
    'Paused',
    'Expired',
    'InternalError',
    'Unknown',
  ];

  const mapContractError = (code) => {
    if (typeof contractErrors.mapContractError === 'function') {
      return contractErrors.mapContractError(code);
    }
    if (typeof contractErrors.toApiError === 'function') {
      return contractErrors.toApiError(code);
    }
    if (typeof contractErrors === 'function') {
      return contractErrors(code);
    }
    if (contractErrors && typeof contractErrors === 'object') {
      return contractErrors[code];
    }
    return undefined;
  };

  it('exposes a mapping function', () => {
    const hasMapper =
      typeof contractErrors.mapContractError === 'function' ||
      typeof contractErrors.toApiError === 'function' ||
      typeof contractErrors === 'function';
    expect(hasMapper).toBe(true);
  });

  it.each(CONTRACT_ERROR_CODES)('maps %s to a stable API error shape', (code) => {
    const mapped = mapContractError(code);

    expect(mapped).toBeDefined();
    expect(mapped).not.toBeNull();
    expect(typeof mapped).toBe('object');

    // Stable shape: a machine-readable code, a human message, and an HTTP status.
    expect(typeof mapped.code).toBe('string');
    expect(mapped.code.length).toBeGreaterThan(0);
    expect(typeof mapped.message).toBe('string');
    expect(mapped.message.length).toBeGreaterThan(0);
    expect(typeof mapped.status).toBe('number');
    expect(Number.isInteger(mapped.status)).toBe(true);
    expect(mapped.status).toBeGreaterThanOrEqual(400);
    expect(mapped.status).toBeLessThan(600);
  });

  it('maps authorization failures to 403', () => {
    ['Unauthorized', 'NotAuthorized', 'InvalidSignature', 'NotAllowlisted'].forEach((code) => {
      const mapped = mapContractError(code);
      expect(mapped.status).toBe(403);
    });
  });

  it('maps invalid input failures to 400', () => {
    ['InvalidArgument', 'InvalidInput'].forEach((code) => {
      const mapped = mapContractError(code);
      expect(mapped.status).toBe(400);
    });
  });

  it('maps missing resources to 404', () => {
    const mapped = mapContractError('NotFound');
    expect(mapped.status).toBe(404);
  });

  it('maps consent failures to a stable 4xx status', () => {
    ['ConsentRequired', 'ConsentRevoked'].forEach((code) => {
      const mapped = mapContractError(code);
      expect(mapped.status).toBeGreaterThanOrEqual(400);
      expect(mapped.status).toBeLessThan(500);
    });
  });

  it('maps unknown codes to a stable fallback response', () => {
    const mapped = mapContractError('SomeFutureContractError');
    expect(mapped).toBeDefined();
    expect(typeof mapped.code).toBe('string');
    expect(typeof mapped.message).toBe('string');
    expect(typeof mapped.status).toBe('number');
    expect(mapped.status).toBeGreaterThanOrEqual(400);
    expect(mapped.status).toBeLessThan(600);
  });

  it('produces deterministic mappings for repeated calls', () => {
    CONTRACT_ERROR_CODES.forEach((code) => {
      const first = mapContractError(code);
      const second = mapContractError(code);
      expect(second).toEqual(first);
    });
  });
});

describe('Consent and allowlist boundary (issue #98)', () => {
  const PROHIBITED_PUBLIC_FIELDS = [
    'patientName',
    'name',
    'dateOfBirth',
    'dob',
    'ssn',
    'email',
    'phone',
    'address',
    'diagnosis',
    'notes',
    'medicalRecord',
    'privateKey',
    'secret',
  ];

  const assertNoProhibitedFields = (payload) => {
    const serialized = JSON.stringify(payload);
    PROHIBITED_PUBLIC_FIELDS.forEach((field) => {
      expect(serialized).not.toContain(`"${field}"`);
    });
  };

  it('rejects issuance when the issuer is not authorized', async () => {
    const { issueCredential } = require('../src/services/credentialService');

    await expect(
      issueCredential({
        issuer: 'GUNKNOWNISSUER',
        subject: 'GSUBJECT',
        authorized: false,
        consentGranted: true,
        allowlisted: true,
      })
    ).rejects.toMatchObject({
      status: expect.any(Number),
    });
  });

  it('rejects issuance when consent is absent', async () => {
    const { issueCredential } = require('../src/services/credentialService');

    await expect(
      issueCredential({
        issuer: 'GISSUER',
        subject: 'GSUBJECT',
        authorized: true,
        consentGranted: false,
        allowlisted: true,
      })
    ).rejects.toMatchObject({
      status: expect.any(Number),
    });
  });

  it('rejects issuance when consent has been revoked', async () => {
    const { issueCredential } = require('../src/services/credentialService');

    await expect(
      issueCredential({
        issuer: 'GISSUER',
        subject: 'GSUBJECT',
        authorized: true,
        consentGranted: false,
        consentRevoked: true,
        allowlisted: true,
      })
    ).rejects.toMatchObject({
      status: expect.any(Number),
    });
  });

  it('rejects issuance when the subject is not allowlisted', async () => {
    const { issueCredential } = require('../src/services/credentialService');

    await expect(
      issueCredential({
        issuer: 'GISSUER',
        subject: 'GSUBJECT',
        authorized: true,
        consentGranted: true,
        allowlisted: false,
      })
    ).rejects.toMatchObject({
      status: expect.any(Number),
    });
  });

  it('public verification response omits prohibited fields', async () => {
    const { verifyCredential } = require('../src/services/credentialService');

    const result = await verifyCredential({
      credentialId: 'cred-1',
      publicView: true,
    });

    expect(result).toBeDefined();
    assertNoProhibitedFields(result);
  });

  it('public verification of an unknown credential does not leak fields', async () => {
    const { verifyCredential } = require('../src/services/credentialService');

    let result;
    try {
      result = await verifyCredential({
        credentialId: 'does-not-exist',
        publicView: true,
      });
    } catch (err) {
      result = err;
    }

    expect(result).toBeDefined();
    assertNoProhibitedFields(result);
  });
});
