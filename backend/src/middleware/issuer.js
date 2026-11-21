const { isAuthorizedIssuer, getIssuerState } = require('../stellar/issuerCache');
const logger = require('../logger');

/**
 * Issuer lifecycle states.
 *
 * - ACTIVE: issuer is authorized on-chain and may issue credentials.
 * - REVOKED: issuer was authorized but has since been revoked on-chain.
 * - PENDING_READD: issuer was revoked and a re-add is in flight; not yet usable.
 * - UNKNOWN: no record of the issuer on-chain.
 */
const ISSUER_STATE = Object.freeze({
  ACTIVE: 'active',
  REVOKED: 'revoked',
  PENDING_READD: 'pending_re_add',
  UNKNOWN: 'unknown',
});

/**
 * Resolve the lifecycle state for a wallet.
 *
 * Prefers the richer `getIssuerState` lookup when available (it exposes the
 * revoked / pending re-add distinction) and falls back to the boolean
 * `isAuthorizedIssuer` check for backwards compatibility.
 *
 * @param {string} wallet - Stellar public key of the issuer
 * @returns {Promise<string>} One of ISSUER_STATE values
 */
async function resolveIssuerState(wallet) {
  if (typeof getIssuerState === 'function') {
    const state = await getIssuerState(wallet);
    if (state && Object.values(ISSUER_STATE).includes(state)) {
      return state;
    }
  }

  const isAuthorized = await isAuthorizedIssuer(wallet);
  return isAuthorized ? ISSUER_STATE.ACTIVE : ISSUER_STATE.UNKNOWN;
}

/**
 * Require the authenticated user to have the 'issuer' role AND 
 * verify their wallet is currently authorized on-chain.
 * Must be used after authMiddleware.
 * Issuer role authorization middleware.
 *
 * Verifies that the authenticated user has the 'issuer' role.
 * Must be used after authMiddleware to ensure req.user is populated.
 *
 * @param {Object} req - Express request object
 * @param {Object} req.user - Decoded JWT payload (set by authMiddleware)
 * @param {string} req.user.role - User role ('patient' or 'issuer')
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 *
 * @returns {void} Calls next() if user has 'issuer' role, sends 403 response otherwise
 *
 * @throws {Error} 403 - User does not have 'issuer' role
 *
 * @side-effects None
 */
async function issuerMiddleware(req, res, next) {
  if (req.user?.role !== 'issuer') {
    return res.status(403).json({ error: 'Issuer role required' });
  }

  const wallet = req.user.wallet || req.user.publicKey;
  if (!wallet) {
    return res.status(401).json({ error: 'Wallet address missing in token' });
  }

  try {
    const state = await resolveIssuerState(wallet);

    switch (state) {
      case ISSUER_STATE.ACTIVE:
        return next();

      case ISSUER_STATE.REVOKED:
        logger.warn('Revoked issuer attempt', { wallet, state });
        return res.status(403).json({
          error: 'Issuer authorization has been revoked',
          code: 'ISSUER_REVOKED',
        });

      case ISSUER_STATE.PENDING_READD:
        logger.warn('Pending re-add issuer attempt', { wallet, state });
        return res.status(403).json({
          error: 'Issuer authorization is pending re-approval',
          code: 'ISSUER_PENDING_READD',
        });

      case ISSUER_STATE.UNKNOWN:
      default:
        logger.warn('Unauthorized issuer attempt', { wallet, state });
        return res.status(403).json({
          error: 'Issuer authorization revoked or not found on-chain',
          code: 'ISSUER_NOT_AUTHORIZED',
        });
    }
  } catch (error) {
    logger.error('Error verifying issuer allowlist', { wallet, error: error.message });
    res.status(500).json({ error: 'Failed to verify issuer authorization' });
  }
}

module.exports = issuerMiddleware;
module.exports.ISSUER_STATE = ISSUER_STATE;
module.exports.resolveIssuerState = resolveIssuerState;
