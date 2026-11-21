const StellarSdk = require('@stellar/stellar-sdk');
const config = require('../config');
const logger = require('../logger');

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
async function withTimeout(fn, context) {
  const start = Date.now();
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const elapsed = Date.now() - start;
      logger.warn('Soroban RPC timeout', { context, rpcUrl: SOROBAN_RPC_URL, elapsedMs: elapsed });
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

function getRpcServer() {
  return new StellarSdk.SorobanRpc.Server(SOROBAN_RPC_URL);
}

/**
 * Helper to retry RPC calls with exponential backoff.
 * @param {Function} fn - The RPC call to execute
 * @param {string} context - Context for logging
 */
async function withRetry(fn, context = '') {
  let lastError;
  for (let attempt = 0; attempt <= SOROBAN_RPC_MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        const backoff = Math.pow(2, attempt - 1) * 100; // 100ms, 200ms, 400ms
        logger.info(`Retrying Soroban RPC call`, {
          context,
          attempt,
          maxRetries: SOROBAN_RPC_MAX_RETRIES,
          backoffMs: backoff,
        });
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
      return await withTimeout(fn, context);
    } catch (error) {
      lastError = error;

      // Don't retry 4xx errors as they are likely client-side/contract logic errors
      const status = error.response?.status;
      if (status && status >= 400 && status < 500) {
        logger.warn(`Non-retryable Soroban RPC error`, {
          context,
          status,
          message: error.message,
        });
        throw error;
      }

      if (attempt === SOROBAN_RPC_MAX_RETRIES) {
        logger.error(`Soroban RPC call failed after maximum retries`, {
          context,
          attempt,
          message: error.message,
        });
      } else {
        logger.debug(`Soroban RPC call transient failure`, {
          context,
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
 */
async function invokeContract(secretKey, method, args) {
  const rpc = getRpcServer();
  const keypair = StellarSdk.Keypair.fromSecret(secretKey);
  const account = await withRetry(() => rpc.getAccount(keypair.publicKey()), 'getAccount');

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

  const prepared = await withRetry(() => rpc.prepareTransaction(tx), 'prepareTransaction');
  prepared.sign(keypair);

  const response = await withRetry(() => rpc.sendTransaction(prepared), 'sendTransaction');
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
    result = await withRetry(() => rpc.getTransaction(response.hash), 'getTransaction');
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
 */
async function mintVaccination(patient, vaccineName, dateAdministered, issuerSecret, options = {}) {
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

    const result = await invokeContract(issuerSecret, 'mint_vaccination', args);
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
 * Verify vaccination status via a read-only contract call.
 * @param {string} wallet - Stellar wallet address to verify
 */
async function verifyVaccination(wallet) {
  try {
    const args = [StellarSdk.Address.fromString(wallet).toScVal()];
    const rawResult = await simulateContract('verify_vaccination', args);
    const [vaccinated, records] = StellarSdk.scValToNative(rawResult);
    return {
      wallet,
      vaccinated,
      records: Array.isArray(records) ? records : [],
    };
  } catch (error) {
    if (error instanceof SorobanError) throw error;
    throw new SorobanSimulationError('Failed to verify vaccination status', error);
  }
}

/**
 * Read-only contract call (no signing needed).
 */
async function simulateContract(method, args) {
  const rpc = getRpcServer();
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

  const sim = await withRetry(() => rpc.simulateTransaction(tx), 'simulateTransaction');
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

/**
 * Map known contract error codes/messages to descriptive Soroban errors.
 * Contract errors surface either as simulation errors (read paths) or as
 * errorResult XDR strings (write paths). We normalize both into a stable
 * shape so callers can branch on `error.contractError`.
 */
const CONTRACT_ERROR_MAP = {
  // Admin rotation / recovery
  AdminAlreadyProposed: 'An admin rotation proposal is already pending',
  NoPendingAdmin: 'No pending admin rotation proposal exists',
  ProposalExpired: 'Admin rotation proposal has expired',
  ProposalNotYetValid: 'Admin rotation proposal delay has not elapsed',
  Unauthorized: 'Caller is not authorized for this admin operation',
  InvalidAdmin: 'Proposed admin address is invalid',
  SelfRotation: 'Cannot propose the current admin as the new admin',
  // Duplicate detection
  DuplicateRecord: 'A matching vaccination record already exists',
  DuplicateDose: 'This dose number has already been recorded for the series',
};

function mapContractError(rawMessage) {
  if (!rawMessage) return null;
  const text = String(rawMessage);
  for (const [code, description] of Object.entries(CONTRACT_ERROR_MAP)) {
    if (text.includes(code)) {
      return { code, description };
    }
  }
  return null;
}

function buildContractError(rawMessage, fallbackMessage) {
  const mapped = mapContractError(rawMessage);
  const message = mapped
    ? `${fallbackMessage}: ${mapped.description} (${mapped.code})`
    : `${fallbackMessage}: ${rawMessage}`;
  const error = new SorobanTransactionError(message);
  error.contractError = mapped ? mapped.code : null;
  error.rawContractError = rawMessage;
  return error;
}

/**
 * Propose a new admin for the contract (current admin-signed).
 * Starts the rotation delay window; the proposal must be accepted by the
 * proposed admin after the delay and before expiry.
 * @param {string} newAdminWallet - Stellar public key of the proposed admin
 * @param {Object} [options]
 * @param {string} [options.adminSecret] - Override for ADMIN_SECRET_KEY
 */
async function proposeAdmin(newAdminWallet, options = {}) {
  const adminSecret = options.adminSecret || process.env.ADMIN_SECRET_KEY;
  if (!adminSecret) throw new Error('ADMIN_SECRET_KEY not configured');
  try {
    const args = [
      StellarSdk.xdr.ScVal.scvAddress(
        StellarSdk.Address.fromString(newAdminWallet).toScAddress()
      ),
    ];
    return await invokeContract(adminSecret, 'propose_admin', args);
  } catch (error) {
    if (error instanceof SorobanError) throw error;
    throw buildContractError(error.message, 'Failed to propose admin rotation');
  }
}

/**
 * Accept a pending admin rotation (signed by the proposed admin).
 * @param {string} newAdminSecret - Secret key of the proposed admin
 */
async function acceptAdmin(newAdminSecret) {
  if (!newAdminSecret) throw new Error('Proposed admin secret key required');
  try {
    return await invokeContract(newAdminSecret, 'accept_admin', []);
  } catch (error) {
    if (error instanceof SorobanError) throw error;
    throw buildContractError(error.message, 'Failed to accept admin rotation');
  }
}

/**
 * Cancel a pending admin rotation (current admin-signed).
 * @param {Object} [options]
 * @param {string} [options.adminSecret] - Override for ADMIN_SECRET_KEY
 */
async function cancelAdmin(options = {}) {
  const adminSecret = options.adminSecret || process.env.ADMIN_SECRET_KEY;
  if (!adminSecret) throw new Error('ADMIN_SECRET_KEY not configured');
  try {
    return await invokeContract(adminSecret, 'cancel_admin', []);
  } catch (error) {
    if (error instanceof SorobanError) throw error;
    throw buildContractError(error.message, 'Failed to cancel admin rotation');
  }
}

/**
 * Read the pending admin rotation proposal, if any (read-only).
 * Returns { pendingAdmin, proposedAt, expiresAt } or null.
 */
async function getPendingAdmin() {
  try {
    const rawResult = await simulateContract('get_pending_admin', []);
    if (rawResult == null) return null;
    const native = StellarSdk.scValToNative(rawResult);
    if (!native) return null;
    return {
      pendingAdmin: native.pending_admin ?? native.pendingAdmin ?? null,
      proposedAt: native.proposed_at ?? native.proposedAt ?? null,
      expiresAt: native.expires_at ?? native.expiresAt ?? null,
    };
  } catch (error) {
    if (error instanceof SorobanError) throw error;
    throw new SorobanSimulationError('Failed to read pending admin', error);
  }
}

module.exports = {
  getRpcServer,
  invokeContract,
  simulateContract,
  mintVaccination,
  verifyVaccination,
  addIssuer,
  revokeIssuer,
  proposeAdmin,
  acceptAdmin,
  cancelAdmin,
  getPendingAdmin,
  mapContractError,
  sendRpcTimeout,
  SorobanError,
  SorobanRpcError,
  SorobanTransactionError,
  SorobanSimulationError,
  SorobanTimeoutError,
};

/**
 * Add a new issuer to the contract allowlist (admin-signed).
 * @param {string} issuerWallet - Stellar public key to authorize as issuer
 */
async function addIssuer(issuerWallet) {
  const adminSecret = process.env.ADMIN_SECRET_KEY;
  if (!adminSecret) throw new Error('ADMIN_SECRET_KEY not configured');
  const args = [StellarSdk.xdr.ScVal.scvAddress(
    StellarSdk.Address.fromString(issuerWallet).toScAddress()
  )];
  return invokeContract(adminSecret, 'add_issuer', args);
}

/**
 * Revoke an issuer from the contract allowlist (admin-signed).
 * @param {string} issuerWallet - Stellar public key to deauthorize
 */
async function revokeIssuer(issuerWallet) {
  const adminSecret = process.env.ADMIN_SECRET_KEY;
  if (!adminSecret) throw new Error('ADMIN_SECRET_KEY not configured');
  const args = [StellarSdk.xdr.ScVal.scvAddress(
    StellarSdk.Address.fromString(issuerWallet).toScAddress()
  )];
  return invokeContract(adminSecret, 'revoke_issuer', args);
}
