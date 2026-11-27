const StellarSdk = require('@stellar/stellar-sdk');
const config = require('../config');
const logger = require('../logger');
const { getRequestId } = require('../requestContext');

const {
  SOROBAN_RPC_URL,
  STELLAR_NETWORK_PASSPHRASE: NETWORK_PASSPHRASE,
  VACCINATIONS_CONTRACT_ID: CONTRACT_ID,
  SOROBAN_RPC_MAX_RETRIES,
  SOROBAN_RPC_TIMEOUT_MS,
} = config;

class SorobanError extends Error {
  constructor(message, originalError) {
    super(message);
    this.name = 'SorobanError';
    this.original = originalError;
  }
}

class SorobanRpcError extends SorobanError {
  constructor(message, originalError) {
    super(message, originalError);
    this.name = 'SorobanRpcError';
  }
}

class SorobanTransactionError extends SorobanError {
  constructor(message, originalError) {
    super(message, originalError);
    this.name = 'SorobanTransactionError';
  }
}

class SorobanSimulationError extends SorobanError {
  constructor(message, originalError) {
    super(message, originalError);
    this.name = 'SorobanSimulationError';
  }
}

class SorobanTimeoutError extends SorobanError {
  constructor(context, elapsedMs) {
    super(`RPC timeout after ${elapsedMs}ms (context: ${context})`);
    this.name = 'SorobanTimeoutError';
    this.context = context;
    this.elapsedMs = elapsedMs;
  }
}

/**
 * Race an async fn against a timeout. Cleans up the timer on resolution.
 * Throws SorobanTimeoutError if the timeout fires first.
 */
async function withTimeout(fn, context, requestId) {
  const start = Date.now();
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const elapsed = Date.now() - start;
      logger.warn('Soroban RPC timeout', {
        context,
        requestId,
        rpcUrl: SOROBAN_RPC_URL,
        elapsedMs: elapsed,
      });
      reject(new SorobanTimeoutError(context, elapsed));
    }, SOROBAN_RPC_TIMEOUT_MS);
  });
  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

// Fee in stroops (1 XLM = 10_000_000 stroops). Minimum is 100.
const TX_FEE = String(process.env.SOROBAN_FEE || 100);
// Inclusion tip in stroops for priority during congestion (0 = no tip).
const TX_TIP = process.env.SOROBAN_TIP ? String(process.env.SOROBAN_TIP) : undefined;

/**
 * Build a Soroban RPC server whose underlying HTTP client forwards the
 * correlation ID as an X-Request-ID header on every downstream call.
 * @param {string} [requestId] - Correlation ID for this workflow
 */
function getRpcServer(requestId) {
  const server = new StellarSdk.SorobanRpc.Server(SOROBAN_RPC_URL);
  const correlationId = requestId || getRequestId();
  if (correlationId && server && server.httpClient && server.httpClient.defaults) {
    server.httpClient.defaults.headers = server.httpClient.defaults.headers || {};
    server.httpClient.defaults.headers['X-Request-ID'] = correlationId;
  }
  return server;
}

/**
 * Helper to retry RPC calls with exponential backoff.
 * @param {Function} fn - The RPC call to execute
 * @param {string} context - Context for logging
 * @param {string} [requestId] - Correlation ID for this workflow
 */
async function withRetry(fn, context = '', requestId) {
  const correlationId = requestId || getRequestId();
  let lastError;
  for (let attempt = 0; attempt <= SOROBAN_RPC_MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        const backoff = Math.pow(2, attempt - 1) * 100; // 100ms, 200ms, 400ms
        logger.info(`Retrying Soroban RPC call`, {
          context,
          requestId: correlationId,
          attempt,
          maxRetries: SOROBAN_RPC_MAX_RETRIES,
          backoffMs: backoff,
        });
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
      return await withTimeout(fn, context, correlationId);
    } catch (error) {
      lastError = error;

      // Don't retry 4xx errors as they are likely client-side/contract logic errors
      const status = error.response?.status;
      if (status && status >= 400 && status < 500) {
        logger.warn(`Non-retryable Soroban RPC error`, {
          context,
          requestId: correlationId,
          status,
          message: error.message,
        });
        throw error;
      }

      if (attempt === SOROBAN_RPC_MAX_RETRIES) {
        logger.error(`Soroban RPC call failed after maximum retries`, {
          context,
          requestId: correlationId,
          attempt,
          message: error.message,
        });
      } else {
        logger.debug(`Soroban RPC call transient failure`, {
          context,
          requestId: correlationId,
          attempt,
          message: error.message,
        });
      }
    }
  }
  throw lastError;
}

/**
 * Invoke a Soroban contract function.
 * @param {string} secretKey - Caller's secret key
 * @param {string} method - Contract method name
 * @param {StellarSdk.xdr.ScVal[]} args - Method arguments
 * @param {Object} [options]
 * @param {string} [options.requestId] - Correlation ID for this workflow
 */
async function invokeContract(secretKey, method, args, options = {}) {
  const requestId = options.requestId || getRequestId();
  const rpc = getRpcServer(requestId);
  const keypair = StellarSdk.Keypair.fromSecret(secretKey);
  const account = await withRetry(
    () => rpc.getAccount(keypair.publicKey()),
    'getAccount',
    requestId
  );

  const contract = new StellarSdk.Contract(CONTRACT_ID);

  const txBuilderOpts = {
    fee: TX_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  };
  if (TX_TIP) txBuilderOpts.sorobanData = undefined; // tip applied via fee bump if needed

  const tx = new StellarSdk.TransactionBuilder(account, txBuilderOpts)
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const prepared = await withRetry(
    () => rpc.prepareTransaction(tx),
    'prepareTransaction',
    requestId
  );
  prepared.sign(keypair);

  const response = await withRetry(
    () => rpc.sendTransaction(prepared),
    'sendTransaction',
    requestId
  );
  if (response.status === 'ERROR') {
    const errDetail = JSON.stringify(response.errorResult);
    if (errDetail.includes('txINSUFFICIENT_FEE') || errDetail.includes('fee')) {
      throw new Error(
        `Transaction rejected: fee too low (current: ${TX_FEE} stroops). ` +
        `Increase SOROBAN_FEE in your environment. Details: ${errDetail}`
      );
    }
    const error = new Error(`Contract invocation failed: ${errDetail}`);
    error.sorobanErrorResult = response.errorResult;
    throw error;
  }

  // Poll for result
  let result;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    result = await withRetry(
      () => rpc.getTransaction(response.hash),
      'getTransaction',
      requestId
    );
    if (result.status !== 'NOT_FOUND') break;
  }

  if (result.status !== 'SUCCESS') {
    const error = new Error(`Transaction failed: ${result.status}`);
    error.sorobanResultXdr = result.resultXdr;
    error.sorobanStatus = result.status;
    throw error;
  }

  return { returnValue: result.returnValue, hash: response.hash, ledger: result.ledger };
}

function toOptionalU32(value) {
  return value != null
    ? StellarSdk.xdr.ScVal.scvVec([StellarSdk.xdr.ScVal.scvU32(value)])
    : StellarSdk.xdr.ScVal.scvVoid();
}

/**
 * Mint a vaccination record and submit a signed transaction.
 * @param {string} patient - Stellar address of the patient
 * @param {string} vaccineName - Vaccine name
 * @param {string} dateAdministered - ISO-8601 timestamp
 * @param {string} issuerSecret - Issuer secret key for signing
 * @param {Object} [options]
 * @param {number|null} [options.doseNumber]
 * @param {number|null} [options.doseSeries]
 * @param {string} [options.requestId] - Correlation ID for this workflow
 */
async function mintVaccination(patient, vaccineName, dateAdministered, issuerSecret, options = {}) {
  const requestId = options.requestId || getRequestId();
  try {
    const issuerKeypair = StellarSdk.Keypair.fromSecret(issuerSecret);
    const args = [
      StellarSdk.Address.fromString(patient).toScVal(),
      StellarSdk.xdr.ScVal.scvString(vaccineName),
      StellarSdk.xdr.ScVal.scvString(dateAdministered),
      StellarSdk.Address.fromString(issuerKeypair.publicKey()).toScVal(),
      toOptionalU32(options.doseNumber),
      toOptionalU32(options.doseSeries),
    ];

    const result = await invokeContract(issuerSecret, 'mint_vaccination', args, { requestId });
    const tokenId = StellarSdk.scValToNative(result.returnValue);
    return {
      tokenId,
      hash: result.hash,
      ledger: result.ledger,
    };
  } catch (error) {
    if (error instanceof SorobanError) throw error;
    throw new SorobanTransactionError('Failed to mint vaccination record', error);
  }
}

/**
 * Explicit verification statuses. These MUST NOT be collapsed into a boolean:
 * a missing, revoked, or unavailable record is never a positive verification.
 */
const VerificationStatus = Object.freeze({
  VALID: 'valid',
  REVOKED: 'revoked',
  ABSENT: 'absent',
  UNAVAILABLE: 'unavailable',
});

/**
 * Verify vaccination status via a read-only contract call.
 *
 * Returns an explicit status rather than a boolean so callers cannot
 * misinterpret missing/revoked/unavailable data as a positive result.
 * RPC and simulation failures are mapped to UNAVAILABLE (never VALID).
 *
 * @param {string} wallet - Stellar wallet address to verify
 * @param {Object} [options]
 * @param {string} [options.requestId] - Correlation ID for this workflow
 * @returns {Promise<{wallet: string, status: string, vaccinated: boolean, records: Array, error?: string}>}
 */
async function verifyVaccination(wallet, options = {}) {
  const requestId = options.requestId || getRequestId();
  try {
    const args = [StellarSdk.Address.fromString(wallet).toScVal()];
    const rawResult = await simulateContract('verify_vaccination', args, { requestId });

    if (rawResult == null) {
      // No return value from the contract: treat as absent, never positive.
      return {
        wallet,
        status: VerificationStatus.ABSENT,
        vaccinated: false,
        records: [],
      };
    }

    const [vaccinated, records] = StellarSdk.scValToNative(rawResult);
    const recordList = Array.isArray(records) ? records : [];

    let status;
    if (vaccinated === true && recordList.length > 0) {
      status = VerificationStatus.VALID;
    } else if (recordList.length > 0) {
      // Records exist but are not currently valid (e.g. revoked).
      status = VerificationStatus.REVOKED;
    } else {
      status = VerificationStatus.ABSENT;
    }

    return {
      wallet,
      status,
      vaccinated: status === VerificationStatus.VALID,
      records: recordList,
    };
  } catch (error) {
    // Any RPC/simulation failure means data is unavailable — never positive.
    logger.warn('Vaccination verification unavailable', {
      wallet,
      message: error.message,
    });
    return {
      wallet,
      status: VerificationStatus.UNAVAILABLE,
      vaccinated: false,
      records: [],
      error: error.message,
    };
  }
}

/**
 * Read-only contract call (no signing needed).
 * @param {string} method - Contract method name
 * @param {StellarSdk.xdr.ScVal[]} args - Method arguments
 * @param {Object} [options]
 * @param {string} [options.requestId] - Correlation ID for this workflow
 */
async function simulateContract(method, args, options = {}) {
  const requestId = options.requestId || getRequestId();
  const rpc = getRpcServer(requestId);
  const contract = new StellarSdk.Contract(CONTRACT_ID);

  // Use a dummy account for simulation
  const dummyKeypair = StellarSdk.Keypair.random();
  const account = new StellarSdk.Account(dummyKeypair.publicKey(), '0');

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: TX_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await withRetry(
    () => rpc.simulateTransaction(tx),
    'simulateTransaction',
    requestId
  );
  if (StellarSdk.SorobanRpc.Api.isSimulationError(sim)) {
    const error = new Error(`Simulation failed: ${sim.error}`);
    error.simulationError = sim.error;
    throw error;
  }

  return sim.result?.retval;
}

/**
 * Send a 503 RPC timeout response. Use in route catch blocks when err is SorobanTimeoutError.
 */
function sendRpcTimeout(res) {
  return res.status(503).json({ error: 'RPC timeout', retryAfter: 5 });
}

module.exports = {
  getRpcServer,
  invokeContract,
  simulateContract,
  mintVaccination,
  verifyVaccination,
  addIssuer,
  revokeIssuer,
  sendRpcTimeout,
  VerificationStatus,
  SorobanError,
  SorobanRpcError,
  SorobanTransactionError,
  SorobanSimulationError,
  SorobanTimeoutError,
};

/**
 * Add a new issuer to the contract allowlist (admin-signed).
 * @param {string} issuerWallet - Stellar public key to authorize as issuer
 * @param {Object} [options]
 * @param {string} [options.requestId] - Correlation ID for this workflow
 */
async function addIssuer(issuerWallet, options = {}) {
  const requestId = options.requestId || getRequestId();
  const adminSecret = process.env.ADMIN_SECRET_KEY;
  if (!adminSecret) throw new Error('ADMIN_SECRET_KEY not configured');
  const args = [StellarSdk.xdr.ScVal.scvAddress(
    StellarSdk.Address.fromString(issuerWallet).toScAddress()
  )];
  return invokeContract(adminSecret, 'add_issuer', args, { requestId });
}

/**
 * Revoke an issuer from the contract allowlist (admin-signed).
 * @param {string} issuerWallet - Stellar public key to deauthorize
 * @param {Object} [options]
 * @param {string} [options.requestId] - Correlation ID for this workflow
 */
async function revokeIssuer(issuerWallet, options = {}) {
  const requestId = options.requestId || getRequestId();
  const adminSecret = process.env.ADMIN_SECRET_KEY;
  if (!adminSecret) throw new Error('ADMIN_SECRET_KEY not configured');
  const args = [StellarSdk.xdr.ScVal.scvAddress(
    StellarSdk.Address.fromString(issuerWallet).toScAddress()
  )];
  return invokeContract(adminSecret, 'revoke_issuer', args, { requestId });
}
