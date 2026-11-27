import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import {
  isConnected,
  getPublicKey,
  signTransaction,
  getNetwork,
} from '@stellar/freighter-api';
import { useToast } from './useToast';
import { apiUrl } from '../config';

const AuthContext = createContext(null);
// Only persist publicKey and role — token is kept in memory only
const STORAGE_KEY = 'vaccichain_wallet';
// Cache keys for private records that must be invalidated on wallet lifecycle changes
const PRIVATE_CACHE_KEYS = ['vaccichain_vaccination_cache'];
// How often to poll Freighter for account/disconnect changes (ms)
const WALLET_POLL_INTERVAL = 3000;

function clearPrivateCaches() {
  if (typeof window === 'undefined') return;
  PRIVATE_CACHE_KEYS.forEach((key) => {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore storage errors
    }
  });
}

// Network the app is configured to talk to. Must match the wallet's network
// before any transaction is signed.
const CONFIGURED_NETWORK = (
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_STELLAR_NETWORK) ||
  'TESTNET'
).toUpperCase();

const NETWORK_MISMATCH_MESSAGE =
  `Your wallet is connected to a different Stellar network than this app (expected ${CONFIGURED_NETWORK}). ` +
  'Open Freighter, switch to the correct network, then retry. No transaction was signed.';

// Sanitized, user-facing messages per error category. Never surface raw
// provider internals or secrets to the UI.
const WALLET_ERROR_MESSAGES = {
  missing_extension:
    'Freighter wallet not found. Install the Freighter browser extension, then reload this page and try again.',
  rejected:
    'Connection request was declined. Open Freighter and approve the request, then try again.',
  locked:
    'Your Freighter wallet is locked. Unlock Freighter with your password, then try again.',
  provider_error:
    'The wallet could not complete the request. Please try again, or reload the page if the problem persists.',
};

function makeWalletError(category) {
  return {
    category,
    message: WALLET_ERROR_MESSAGES[category] || WALLET_ERROR_MESSAGES.provider_error,
  };
}

// Map a raw Freighter/provider error into a typed, sanitized category.
function classifyWalletError(e) {
  const raw = String((e && (e.message || e.error || e)) || '').toLowerCase();

  if (
    raw.includes('not found') ||
    raw.includes('not installed') ||
    raw.includes('not available') ||
    raw.includes('no freighter') ||
    raw.includes('extension')
  ) {
    return makeWalletError('missing_extension');
  }
  if (
    raw.includes('reject') ||
    raw.includes('denied') ||
    raw.includes('declin') ||
    raw.includes('cancel') ||
    raw.includes('user refused') ||
    raw.includes('not allowed')
  ) {
    return makeWalletError('rejected');
  }
  if (raw.includes('lock') || raw.includes('unlock') || raw.includes('password')) {
    return makeWalletError('locked');
  }
  return makeWalletError('provider_error');
}

export function AuthProvider({ children }) {
  const toast = useToast();
  const announce = useAnnounce();
  const [publicKey, setPublicKey] = useState(null);
  const [role, setRole] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [walletError, setWalletError] = useState(null);
  const [freighterInstalled, setFreighterInstalled] = useState(() => typeof window !== 'undefined' && !!window.freighter);
  // True while restoring persisted identity on mount; route guards can render a loading state
  const [restoring, setRestoring] = useState(() => {
    if (typeof window === 'undefined') return false;
    return !!localStorage.getItem(STORAGE_KEY);
  });
  // Token lives only in memory — never written to localStorage
  const tokenRef = useRef(null);
  // Increments whenever the active account changes or the wallet disconnects,
  // so consumers can key data loads on the active account.
  const [walletChangeCounter, setWalletChangeCounter] = useState(0);
  // AbortController for in-flight requests; aborted on disconnect/account change
  const abortRef = useRef(null);
  // Tracks the account we believe is active, to detect changes during polling
  const activeKeyRef = useRef(null);

  const abortInFlight = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const clearWalletState = useCallback(() => {
    abortInFlight();
    setPublicKey(null);
    tokenRef.current = null;
    activeKeyRef.current = null;
    setRole(null);
    setError(null);
    localStorage.removeItem(STORAGE_KEY);
    clearPrivateCaches();
    setWalletChangeCounter((c) => c + 1);
  }, [abortInFlight]);

  const isNetworkMismatch = !!walletNetwork && walletNetwork.toUpperCase() !== CONFIGURED_NETWORK;

  // Read the wallet's current network; returns the normalized value (or null).
  const refreshNetwork = useCallback(async () => {
    try {
      const net = await getNetwork();
      const value = typeof net === 'string' ? net : net && net.network;
      const normalized = value ? String(value).toUpperCase() : null;
      setWalletNetwork(normalized);
      return normalized;
    } catch {
      setWalletNetwork(null);
      return null;
    }
  }, []);

  // Throws when the wallet network does not match the configured network.
  const assertNetworkMatch = useCallback(async () => {
    const current = await refreshNetwork();
    if (current && current !== CONFIGURED_NETWORK) {
      throw new Error(NETWORK_MISMATCH_MESSAGE);
    }
    return current;
  }, [refreshNetwork]);

  const runSep10 = useCallback(async (pk) => {
    const challengeRes = await fetch(apiUrl('/v1/auth/sep10'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_key: pk }),
    });
    const { transaction, nonce } = await challengeRes.json();
    const signedXDR = await signTransaction(transaction, { network: 'TESTNET' });
    const verifyRes = await fetch(apiUrl('/v1/auth/verify'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction: signedXDR, nonce }),
    });
    const data = await verifyRes.json();
    if (!verifyRes.ok) throw new Error(data.error);
    return data;
  }, [assertNetworkMatch]);

  const connect = useCallback(async () => {
    setLoading(true);
    setError(null);
    setWalletError(null);
    try {
      let connected = false;
      try {
        connected = await isConnected();
      } catch {
        connected = false;
      }
      if (!connected || (typeof window !== 'undefined' && !window.freighter)) {
        setFreighterInstalled(false);
        const walletErr = makeWalletError('missing_extension');
        setWalletError(walletErr);
        setError(walletErr.message);
        toast(walletErr.message, 'error');
        throw new Error(walletErr.message);
      }
      const pk = await getPublicKey();
      await refreshNetwork();
      const data = await runSep10(pk);
      setPublicKey(pk);
      activeKeyRef.current = pk;
      tokenRef.current = data.token;
      setRole(data.role);
      // Persist only publicKey and role — not the token
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ publicKey: pk, role: data.role }));
      setWalletChangeCounter((c) => c + 1);
      toast('Wallet connected.', 'success');
      announce('Wallet connected.');
      return data;
    } catch (e) {
      const msg = e.message || 'Failed to connect wallet.';
      setError(msg);
      toast(msg, 'error');
      announce(`Wallet connection failed. ${msg}`, { assertive: true });
      throw e;
    } finally {
      setLoading(false);
    }
  }, [runSep10, toast, announce, refreshNetwork]);

  const disconnect = useCallback(() => {
    clearWalletState();
  }, [clearWalletState]);

  // On mount: restore publicKey/role from localStorage, but require a fresh SEP-10 for the token
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) {
      setRestoring(false);
      return;
    }
    const { publicKey: savedKey, role: savedRole } = JSON.parse(saved);
    isConnected().then((connected) => {
      if (!connected) {
        setFreighterInstalled(false);
        localStorage.removeItem(STORAGE_KEY);
        return;
      }
      // Restore identity so UI shows as connected; token will be fetched on first apiFetch call
      setPublicKey(savedKey);
      activeKeyRef.current = savedKey;
      setRole(savedRole);
    }).catch(() => localStorage.removeItem(STORAGE_KEY))
      .finally(() => setRestoring(false));
  }, []);

  // Watch for Freighter disconnect / account changes.
  // Prefer event listeners when available, and fall back to polling.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const handleAccountChange = (newKey) => {
      const current = activeKeyRef.current;
      if (!current) return; // not connected; nothing to invalidate
      if (newKey && newKey === current) return; // no change
      // Account changed or wallet disconnected: clear everything and force a fresh load
      clearWalletState();
    };

    const checkWallet = async () => {
      if (!activeKeyRef.current) return;
      try {
        const connected = await isConnected();
        if (!connected) {
          setFreighterInstalled(false);
          clearWalletState();
          return;
        }
        const pk = await getPublicKey();
        handleAccountChange(pk);
      } catch {
        // Transient errors (e.g. extension locked) should not wipe state
      }
    };

    const onFreighterEvent = (event) => {
      const detail = event && event.detail ? event.detail : {};
      const newKey = detail.publicKey || detail.address || null;
      if (detail.disconnected || !newKey) {
        if (activeKeyRef.current) clearWalletState();
        return;
      }
      handleAccountChange(newKey);
    };

    window.addEventListener('freighter:accountChanged', onFreighterEvent);
    window.addEventListener('freighter:disconnect', onFreighterEvent);
    const interval = setInterval(checkWallet, WALLET_POLL_INTERVAL);

    return () => {
      window.removeEventListener('freighter:accountChanged', onFreighterEvent);
      window.removeEventListener('freighter:disconnect', onFreighterEvent);
      clearInterval(interval);
    };
  }, [clearWalletState]);

  const apiFetch = useCallback(async (url, options = {}) => {
    // Create a fresh controller for this request so it can be aborted on
    // disconnect/account change.
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    const doFetch = (t) => fetch(url, {
      ...options,
      signal,
      headers: { ...options.headers, Authorization: `Bearer ${t}` },
    });

    const refreshToken = async () => {
      const pk = await getPublicKey();
      const data = await runSep10(pk);
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      tokenRef.current = data.token;
      activeKeyRef.current = pk;
      setRole(data.role);
    };

    try {
      // If no token in memory yet, run SEP-10 to get one
      if (!tokenRef.current) {
        await refreshToken();
      }

    if (res.status === 401) {
      const pk = await getPublicKey();
      const data = await runSep10(pk);
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      tokenRef.current = data.token;
      activeKeyRef.current = pk;
      setRole(data.role);
      res = await doFetch(data.token);
    }

      if (res.status === 401) {
        await refreshToken();
        res = await doFetch(tokenRef.current);
      }

      return res;
    } catch (e) {
      const walletErr = classifyWalletError(e);
      setWalletError(walletErr);
      setError(walletErr.message);
      toast(walletErr.message, 'error');
      throw new Error(walletErr.message);
    }
  }, [runSep10, toast]);

  const isConnectedState = !!publicKey;
  // Role is considered loading while restoring persisted identity or while a SEP-10 flow is in flight
  const roleLoading = restoring || loading;

  return (
    <AuthContext.Provider value={{
      publicKey,
      role,
      freighterInstalled,
      connect,
      disconnect,
      apiFetch,
      isConnected: isConnectedState,
      loading,
      roleLoading,
      error,
      // Increments on account change/disconnect so consumers can key data loads
      walletChangeCounter,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
