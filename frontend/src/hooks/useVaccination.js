import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from './useFreighter';
import { useToast } from './useToast';

// Module-level cache: walletAddress -> { records, timestamp }
export const cache = new Map();
const CACHE_TTL = 30_000; // 30 seconds

// Redaction utility for client-side diagnostics. Strips tokens, patient
// identifiers and record details before anything is logged or surfaced.
const SENSITIVE_KEY_PATTERN = /(token|secret|password|authorization|auth|jwt|key|wallet|address|patient|name|dob|birth|record|vaccin|issuer|hash)/i;
const TOKEN_LIKE_PATTERN = /\b(?:bearer\s+)?[A-Za-z0-9_-]{20,}\b/gi;

export function redactForDiagnostics(input) {
  if (input == null) return input;
  if (typeof input === 'string') {
    return input.replace(TOKEN_LIKE_PATTERN, '[REDACTED]');
  }
  if (typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map(redactForDiagnostics);
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : redactForDiagnostics(value);
  }
  return out;
}

// Produce a safe, user-facing error message that never includes raw payloads.
function safeErrorMessage(e, fallback) {
  const raw = (e && typeof e.message === 'string' && e.message) || fallback;
  return redactForDiagnostics(raw);
}

export function useVaccination(walletAddress) {
  const { apiFetch } = useAuth();
  const toast = useToast();
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);
  // Keep latest apiFetch/toast in refs so effects don't re-run when they change
  const apiFetchRef = useRef(apiFetch);
  const toastRef = useRef(toast);
  useEffect(() => { apiFetchRef.current = apiFetch; }, [apiFetch]);
  useEffect(() => { toastRef.current = toast; }, [toast]);

  const fetchFromApi = useCallback(async (wallet, signal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetchRef.current(`/v1/vaccination/${wallet}`, { signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const list = Array.isArray(data.data) ? data.data : [];
      cache.set(wallet, { records: list, timestamp: Date.now() });
      setRecords(list);
      return list;
    } catch (e) {
      if (e.name === 'AbortError') return;
      const msg = safeErrorMessage(e, 'Failed to fetch records.');
      setError(msg);
      toastRef.current(msg, 'error');
      return null;
    } finally {
      setLoading(false);
    }
  }, []); // stable — uses refs internally

  useEffect(() => {
    if (!walletAddress) return;

    const cached = cache.get(walletAddress);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      setRecords(cached.records);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    fetchFromApi(walletAddress, controller.signal);

    return () => { controller.abort(); };
  }, [walletAddress, fetchFromApi]);

  const refetch = useCallback(() => {
    if (!walletAddress) return;
    cache.delete(walletAddress);
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    return fetchFromApi(walletAddress, controller.signal);
  }, [walletAddress, fetchFromApi]);

  const issueVaccination = useCallback(async (payload) => {
    setLoading(true);
    try {
      const res = await apiFetchRef.current('/v1/vaccination/issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const explorerUrl = `https://stellar.expert/explorer/testnet/tx/${data.transactionHash}`;
      toastRef.current(`Vaccination NFT minted! View on Explorer: ${explorerUrl}`, 'success');
      return data;
    } catch (e) {
      toastRef.current(safeErrorMessage(e, 'Failed to issue vaccination.'), 'error');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const checkIssuerStatus = useCallback(async () => {
    try {
      const res = await apiFetchRef.current('/v1/issuer/status');
      const data = await res.json();
      return res.ok ? data.authorized : false;
    } catch {
      return false;
    }
  }, []);

  return { records, loading, error, refetch, issueVaccination, checkIssuerStatus };
}
