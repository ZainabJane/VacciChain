import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import VerificationBadge from '../components/VerificationBadge';
import NFTCard from '../components/NFTCard';
import CopyButton from '../components/CopyButton';
import { useToast } from '../hooks/useToast';
import { API_BASE_URL } from '../config';
import { pageContainerNarrow } from '../layout.js';

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

export function isValidStellarAddress(address) {
  return typeof address === 'string' && STELLAR_ADDRESS_RE.test(address);
}

// Redact anything that looks like a token/secret and strip record details from
// messages before they reach the console, toasts, or error UI.
const SENSITIVE_PATTERN = /(bearer\s+)?[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|token[=:]\s*\S+|api[_-]?key[=:]\s*\S+/gi;

function sanitizeMessage(message) {
  const fallback = 'Verification failed. Please try again.';
  if (typeof message !== 'string' || !message.trim()) return fallback;
  const redacted = message.replace(SENSITIVE_PATTERN, '[redacted]');
  // Only surface short, generic messages; drop anything that may embed record data.
  return redacted.length > 200 ? fallback : redacted;
}

function deriveStatus(result) {
  if (!result) return 'not-found';
  if (result.revoked) return 'revoked';
  if (result.vaccinated) return 'verified';
  return 'not-found';
}

const styles = {
  page: { margin: '2rem 0' },
  input: { padding: '0.6rem 0.75rem', background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)', fontSize: '1rem', width: '100%' },
  inputInvalid: { borderColor: '#f87171' },
  btn: { padding: '0.6rem 1.5rem', background: 'var(--btn-primary)', color: '#fff', border: 'none', borderRadius: 8, fontSize: '1rem', marginTop: '0.75rem' },
  fieldError: { color: '#f87171', marginTop: '0.5rem', fontSize: '0.9rem' },
};

// Only surface messages we control; never leak raw provider/network internals.
const GENERIC_ERROR = 'Verification failed. Please try again.';

function safeErrorMessage(e) {
  const msg = e && typeof e.message === 'string' ? e.message : '';
  // Allow short, human-readable messages that don't look like stack traces or JSON blobs.
  if (msg && msg.length <= 200 && !/[{}\n]/.test(msg) && !/stack|internal|provider|rpc|fetch/i.test(msg)) {
    return msg;
  }
  return GENERIC_ERROR;
}

export default function VerifyPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlWallet = (searchParams.get('wallet') || '').trim();
  const [wallet, setWallet] = useState(urlWallet);
  const [result, setResult] = useState(null);
  const [resultWallet, setResultWallet] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastAddress, setLastAddress] = useState('');

  const verify = async (address) => {
    const trimmed = address.trim();
    setLastAddress(trimmed);
    setLoading(true);
    setResult(null);
    setResultWallet(null);
    setError(null);
    setLastAddress(trimmed);
    try {
      const res = await fetch(`/v1/verify/${trimmed}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (requestId !== requestIdRef.current) return;
      setResult(data);
      setResultWallet(address);
    } catch (e) {
      if (requestId !== requestIdRef.current) return;
      const message = sanitizeMessage(e.message);
      setError(message);
      toast(message, 'error');
      announce(`Verification failed: ${message}`, 'error');
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  };

  const handleRetry = () => {
    if (lastAddress) verify(lastAddress);
  };

  useEffect(() => {
    setWallet(urlWallet);
    setValidationError(null);
    if (!urlWallet) {
      requestIdRef.current += 1;
      setResult(null);
      setResultWallet(null);
      setError(null);
      setLoading(false);
      return;
    }
    if (!isValidStellarAddress(urlWallet)) {
      requestIdRef.current += 1;
      setResult(null);
      setResultWallet(null);
      setError(null);
      setLoading(false);
      return;
    }
    verify(urlWallet);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlWallet]);

  const handleChange = (e) => {
    const value = e.target.value;
    setWallet(value);
    setValidationError(null);
    // Editing the input invalidates any displayed result.
    requestIdRef.current += 1;
    setResult(null);
    setResultWallet(null);
    setError(null);
    setLoading(false);
    const trimmed = value.trim();
    if (trimmed) {
      setSearchParams({ wallet: trimmed }, { replace: true });
    } else {
      setSearchParams({}, { replace: true });
    }
  };

  const handleVerify = (e) => {
    e.preventDefault();
    const trimmed = wallet.trim();
    if (!isValidStellarAddress(trimmed)) {
      setValidationError('Enter a valid Stellar public key (56 characters, starting with G).');
      requestIdRef.current += 1;
      setResult(null);
      setResultWallet(null);
      setError(null);
      setLoading(false);
      return;
    }
    setValidationError(null);
    if (trimmed !== urlWallet) {
      setSearchParams({ wallet: trimmed });
    } else {
      verify(trimmed);
    }
  };

  const showResult = result && resultWallet && resultWallet === urlWallet;

  return (
    <div className="page-container page-section content-medium" style={{ ...pageContainerNarrow, ...styles.page }}>
      <h2 style={{ marginBottom: '1.5rem', color: 'var(--text)' }}>Verify Vaccination Status</h2>
      <form onSubmit={handleVerify} noValidate>
        <label htmlFor="wallet-input" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
          Stellar wallet address
        </label>
        <input
          id="wallet-input"
          style={validationError ? { ...styles.input, ...styles.inputInvalid } : styles.input}
          placeholder={t('verify.placeholder')}
          value={wallet}
          onChange={handleChange}
          aria-label="Stellar wallet address to verify"
          aria-invalid={validationError ? 'true' : 'false'}
          aria-describedby={validationError ? 'wallet-input-error' : undefined}
          required
        />
        <button style={styles.btn} type="submit" disabled={loading} aria-disabled={loading}>
          {loading ? 'Checking…' : 'Verify'}
        </button>
        {validationError && (
          <p id="wallet-input-error" role="alert" style={styles.fieldError}>
            {validationError}
          </p>
        )}
      </form>

      <div aria-live="polite" aria-atomic="true">
        {loading && (
          <p style={{ color: 'var(--text)', marginTop: '1rem' }} role="status">
            Checking vaccination status…
          </p>
        )}
        {error && (
          <div style={{ marginTop: '1rem' }} role="alert">
            <p style={{ color: '#f87171' }}>Error: {error}</p>
            <button
              type="button"
              style={styles.btn}
              onClick={handleRetry}
              disabled={loading || !lastAddress}
            >
              Retry
            </button>
          </div>
        )}
      </div>

      {!loading && !error && result && (
        <div style={{ marginTop: '1.5rem' }} aria-live="polite">
          <VerificationBadge
            status={deriveStatus(result)}
            vaccinated={result.vaccinated}
            recordCount={result.record_count}
          />
          <p style={{ color: '#64748b', fontSize: '0.85rem', marginTop: '1rem', wordBreak: 'break-all', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.25rem' }}>
            Wallet: {resultWallet}
            <CopyButton text={resultWallet} label="wallet address" />
          </p>
          <div style={{ marginTop: '1rem' }}>
            {result.records?.map((r) => <NFTCard key={r.token_id} record={r} patientWallet={result.wallet} />)}
          </div>
        </div>
      )}
    </div>
  );
}
