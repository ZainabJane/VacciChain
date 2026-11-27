import React from 'react';
import { useAuth } from '../hooks/useAuth';

/**
 * RoleGuard
 *
 * UX-only guard for role-specific routes. Backend authorization remains
 * authoritative; this component merely prevents accidental access to issuer
 * and admin screens by wallets that do not hold the required role.
 *
 * Renders:
 *  - a loading indicator while the role is loading/restoring
 *  - a sign-in prompt (Connect Wallet) when disconnected
 *  - an accessible denial state when the authenticated role is not allowed
 *  - the children when authorized
 *
 * @param {Object} props
 * @param {string[]} props.allowedRoles - Roles permitted to view the children.
 * @param {React.ReactNode} [props.children] - Content to render when authorized.
 */
export default function RoleGuard({ allowedRoles = [], children }) {
  const auth = useAuth() || {};
  const {
    role,
    isLoading,
    isAuthenticated,
    isConnected,
    connectWallet,
    signIn,
    address,
  } = auth;

  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];

  // Loading / restoring state.
  if (isLoading) {
    return (
      <div
        className="role-guard role-guard--loading"
        role="status"
        aria-live="polite"
        data-testid="role-guard-loading"
      >
        <span className="role-guard__spinner" aria-hidden="true" />
        <span>Checking your access…</span>
      </div>
    );
  }

  // Disconnected state: prompt to connect a wallet.
  const connected = typeof isConnected === 'boolean' ? isConnected : Boolean(address);
  if (!connected) {
    return (
      <div
        className="role-guard role-guard--signin"
        role="region"
        aria-label="Sign in required"
        data-testid="role-guard-signin"
      >
        <h2>Sign in required</h2>
        <p>Connect your wallet to access this page.</p>
        <button
          type="button"
          className="role-guard__connect"
          onClick={() => {
            if (typeof connectWallet === 'function') {
              connectWallet();
            }
          }}
        >
          Connect Wallet
        </button>
      </div>
    );
  }

  // Connected but not authenticated: prompt to sign in.
  const authenticated =
    typeof isAuthenticated === 'boolean' ? isAuthenticated : Boolean(role);
  if (!authenticated) {
    return (
      <div
        className="role-guard role-guard--signin"
        role="region"
        aria-label="Sign in required"
        data-testid="role-guard-signin"
      >
        <h2>Sign in required</h2>
        <p>Please sign in to access this page.</p>
        <button
          type="button"
          className="role-guard__signin"
          onClick={() => {
            if (typeof signIn === 'function') {
              signIn();
            }
          }}
        >
          Sign In
        </button>
      </div>
    );
  }

  // Authenticated but role not permitted: accessible denial state.
  if (!role || !roles.includes(role)) {
    return (
      <div
        className="role-guard role-guard--denied"
        role="alert"
        aria-live="assertive"
        data-testid="role-guard-denied"
      >
        <h2>Access denied</h2>
        <p>
          Your connected wallet does not have the required role to view this
          page.
        </p>
        {roles.length > 0 && (
          <p className="role-guard__required">
            Required role{roles.length > 1 ? 's' : ''}: {roles.join(', ')}
          </p>
        )}
      </div>
    );
  }

  // Authorized.
  return <>{children}</>;
}