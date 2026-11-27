import { renderHook, act } from '@testing-library/react';
import { AuthProvider, useAuth } from './useFreighter';

// Mock Freighter API
jest.mock('@stellar/freighter-api', () => ({
  isConnected: jest.fn(),
  getPublicKey: jest.fn(),
  getNetwork: jest.fn(),
  signTransaction: jest.fn(),
  onAccountChange: jest.fn(),
  onDisconnect: jest.fn(),
}));

// Mock useToast
jest.mock('./useToast', () => ({
  useToast: () => jest.fn(),
}));

import {
  isConnected,
  getPublicKey,
  signTransaction,
  onAccountChange,
  onDisconnect,
} from '@stellar/freighter-api';

const WALLET = 'GA3AUY2XRF6S7R73ABSLJMKG4R2NQGRUFPEJUGCANMBAAXI4MTBS6AQU';
const WALLET_2 = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const TOKEN = 'jwt-token-abc';
const TOKEN_2 = 'jwt-token-xyz';

// Captured Freighter event listeners so tests can fire them manually.
let accountChangeListener;
let disconnectListener;

const wrapper = ({ children }) => <AuthProvider>{children}</AuthProvider>;

// Stub fetch globally
beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();

  isConnected.mockResolvedValue(true);
  getPublicKey.mockResolvedValue(WALLET);
  getNetwork.mockResolvedValue(CONFIGURED_NETWORK);
  signTransaction.mockResolvedValue('signed-xdr');

  accountChangeListener = undefined;
  disconnectListener = undefined;
  onAccountChange.mockImplementation((cb) => {
    accountChangeListener = cb;
    return () => {};
  });
  onDisconnect.mockImplementation((cb) => {
    disconnectListener = cb;
    return () => {};
  });

  global.fetch = jest.fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ transaction: 'challenge-xdr', nonce: 'nonce-1' }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: TOKEN, role: 'patient' }),
    });
});

describe('useFreighter / useAuth', () => {
  it('connect() calls POST /auth/sep10 then POST /auth/verify', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => { await result.current.connect(); });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(1, '/v1/auth/sep10', expect.objectContaining({ method: 'POST' }));
    expect(fetch).toHaveBeenNthCalledWith(2, '/v1/auth/verify', expect.objectContaining({ method: 'POST' }));
  });

  it('successful connect sets isConnected: true and publicKey', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => { await result.current.connect(); });

    expect(result.current.isConnected).toBe(true);
    expect(result.current.publicKey).toBe(WALLET);
  });

  it('Freighter signing failure sets error state', async () => {
    signTransaction.mockRejectedValue(new Error('User rejected'));

    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {
      await result.current.connect().catch(() => {});
    });

    expect(result.current.error).toBe('User rejected');
    expect(result.current.isConnected).toBe(false);
  });

  it('backend 401 on verify sets error state', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ transaction: 'challenge-xdr', nonce: 'nonce-1' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: 'Invalid signature' }),
      });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {
      await result.current.connect().catch(() => {});
    });

    expect(result.current.error).toBe('Invalid signature');
    expect(result.current.isConnected).toBe(false);
  });

  it('disconnect() clears JWT and resets state', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => { await result.current.connect(); });
    expect(result.current.isConnected).toBe(true);

    act(() => { result.current.disconnect(); });

    expect(result.current.isConnected).toBe(false);
    expect(result.current.publicKey).toBeNull();
    expect(localStorage.getItem('vaccichain_wallet')).toBeNull();
  });

  it('disconnect() clears wallet-specific UI state, pending requests and cached records', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => { await result.current.connect(); });
    expect(result.current.isConnected).toBe(true);

    // Seed wallet-specific state that must not survive a disconnect.
    act(() => {
      result.current.setPendingRequests?.([{ id: 'req-1' }]);
      result.current.setCachedRecords?.([{ id: 'rec-1' }]);
    });

    act(() => { result.current.disconnect(); });

    expect(result.current.isConnected).toBe(false);
    expect(result.current.publicKey).toBeNull();
    expect(result.current.role).toBeNull();
    expect(result.current.token).toBeNull();
    expect(result.current.pendingRequests ?? []).toEqual([]);
    expect(result.current.cachedRecords ?? []).toEqual([]);
    expect(localStorage.getItem('vaccichain_wallet')).toBeNull();
    expect(localStorage.getItem('vaccichain_token')).toBeNull();
  });

  it('disconnect() aborts in-flight requests', async () => {
    const abortSpy = jest.fn();
    const originalAbortController = global.AbortController;
    global.AbortController = jest.fn(() => ({
      signal: { aborted: false },
      abort: abortSpy,
    }));

    try {
      const { result } = renderHook(() => useAuth(), { wrapper });

      await act(async () => { await result.current.connect(); });
      act(() => { result.current.disconnect(); });

      expect(abortSpy).toHaveBeenCalled();
    } finally {
      global.AbortController = originalAbortController;
    }
  });

  it('Freighter disconnect event resets wallet state', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => { await result.current.connect(); });
    expect(result.current.isConnected).toBe(true);
    expect(disconnectListener).toBeDefined();

    await act(async () => { disconnectListener(); });

    expect(result.current.isConnected).toBe(false);
    expect(result.current.publicKey).toBeNull();
    expect(result.current.role).toBeNull();
    expect(localStorage.getItem('vaccichain_wallet')).toBeNull();
  });

  it('account change triggers a fresh role and data load for the new account', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => { await result.current.connect(); });
    expect(result.current.publicKey).toBe(WALLET);
    expect(result.current.role).toBe('patient');

    getPublicKey.mockResolvedValue(WALLET_2);
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ transaction: 'challenge-xdr-2', nonce: 'nonce-2' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: TOKEN_2, role: 'admin' }),
      });

    expect(accountChangeListener).toBeDefined();
    await act(async () => { await accountChangeListener({ address: WALLET_2 }); });

    expect(result.current.publicKey).toBe(WALLET_2);
    expect(result.current.role).toBe('admin');
    expect(result.current.token).toBe(TOKEN_2);
    expect(fetch).toHaveBeenCalledWith('/v1/auth/sep10', expect.objectContaining({ method: 'POST' }));
    expect(fetch).toHaveBeenCalledWith('/v1/auth/verify', expect.objectContaining({ method: 'POST' }));
  });

  it('account change clears prior account data before the new load resolves', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => { await result.current.connect(); });
    expect(result.current.publicKey).toBe(WALLET);
    expect(result.current.role).toBe('patient');

    // Make the refresh hang so we can observe the intermediate state.
    let resolveVerify;
    getPublicKey.mockResolvedValue(WALLET_2);
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ transaction: 'challenge-xdr-2', nonce: 'nonce-2' }),
      })
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveVerify = () => resolve({
          ok: true,
          json: async () => ({ token: TOKEN_2, role: 'admin' }),
        });
      }));

    await act(async () => { accountChangeListener({ address: WALLET_2 }); });

    // Prior account's information must not be visible during the reload.
    expect(result.current.publicKey).not.toBe(WALLET);
    expect(result.current.role).toBeNull();
    expect(result.current.token).toBeNull();

    await act(async () => { resolveVerify(); });
    expect(result.current.publicKey).toBe(WALLET_2);
    expect(result.current.role).toBe('admin');
  });
});
