import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../hooks/useFreighter';
import { useVaccination } from '../hooks/useVaccination';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import ConfirmMintDialog from '../components/ConfirmMintDialog';
import CopyButton from '../components/CopyButton';
import RoleBadge from '../components/RoleBadge';
import AsyncState from '../components/AsyncState';
import { pageContainerNarrow } from '../layout.js';

const styles = {
  form: { display: 'flex', flexDirection: 'column', gap: '1rem' },
  input: { padding: '0.6rem 0.75rem', background: '#1e293b', border: '1px solid #334155', borderRadius: 8, color: '#e2e8f0', fontSize: '1rem', width: '100%', boxSizing: 'border-box' },
  inputError: { padding: '0.6rem 0.75rem', background: '#1e293b', border: '1px solid #f87171', borderRadius: 8, color: '#e2e8f0', fontSize: '1rem', width: '100%', boxSizing: 'border-box' },
  btn: { padding: '0.7rem', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 8, fontSize: '1rem', width: '100%', touchAction: 'manipulation' },
  btnDisabled: { padding: '0.7rem', background: '#334155', color: '#64748b', border: 'none', borderRadius: 8, fontSize: '1rem', cursor: 'not-allowed', width: '100%' },
  label: { color: '#94a3b8', fontSize: '0.85rem', marginBottom: '0.25rem' },
  fieldError: { color: '#f87171', fontSize: '0.78rem', marginTop: '0.25rem' },
  statusBadge: { display: 'inline-flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0.75rem', borderRadius: 6, fontSize: '0.85rem', marginBottom: '1rem' },
  authorized: { background: '#065f46', color: '#10b981', border: '1px solid #10b981' },
  unauthorized: { background: '#7f1d1d', color: '#f87171', border: '1px solid #f87171' },
  warning: { background: '#78350f', color: '#f59e0b', padding: '0.75rem', borderRadius: 8, marginBottom: '1rem', fontSize: '0.9rem' },
};

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
const today = () => new Date().toISOString().split('T')[0];
const FORM_KEY = 'issuer_form_draft';
const EMPTY_FORM = { patient_address: '', vaccine_name: '', date_administered: '', dose_number: '', dose_series: '' };
const MAX_U32 = 4294967295;
const isValidDose = (value) => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= MAX_U32;

// Only non-sensitive fields are persisted. Patient-identifying data
// (patient_address) is intentionally excluded from the draft schema.
const DRAFT_FIELDS = ['vaccine_name', 'date_administered'];

const readDraft = () => {
  try {
    const saved = sessionStorage.getItem(FORM_KEY);
    if (!saved) return EMPTY_FORM;
    const parsed = JSON.parse(saved);
    const draft = { ...EMPTY_FORM };
    for (const key of DRAFT_FIELDS) {
      if (typeof parsed?.[key] === 'string') draft[key] = parsed[key];
    }
    return draft;
  } catch {
    return EMPTY_FORM;
  }
};

const writeDraft = (form) => {
  try {
    const draft = {};
    for (const key of DRAFT_FIELDS) draft[key] = form[key] ?? '';
    sessionStorage.setItem(FORM_KEY, JSON.stringify(draft));
  } catch {
    // Persistence is best-effort; ignore storage failures.
  }
};

const clearDraft = () => {
  try {
    sessionStorage.removeItem(FORM_KEY);
  } catch {
    // ignore storage failures
  }
};

const EXPLORER_BASE = {
  testnet: 'https://stellar.expert/explorer/testnet',
  mainnet: 'https://stellar.expert/explorer/public',
};

const TX_HASH_RE = /^[0-9a-fA-F]{64}$/;

const getExplorerUrl = (network, transactionHash) => {
  if (!transactionHash || !TX_HASH_RE.test(transactionHash)) return null;
  const base = EXPLORER_BASE[network];
  if (!base) return null;
  return `${base}/tx/${transactionHash}`;
};

const SUPPORT_URL = 'https://github.com/Stellar-Vaccination/Stellar-Vaccination/issues/new';
=======

export default function IssuerDashboard() {
  const { t } = useTranslation();
  const { publicKey, role, connect, networkMismatch, expectedNetwork, walletNetwork } = useAuth();
  const { issueVaccination, checkIssuerStatus, loading } = useVaccination();

  useDocumentTitle('Issue Vaccination — VacciChain');

  const [form, setForm] = useState(() => {
    try {
      const saved = sessionStorage.getItem(FORM_KEY);
      return saved ? { ...EMPTY_FORM, ...JSON.parse(saved) } : EMPTY_FORM;
    } catch {
      return EMPTY_FORM;
    }
  });
  const [touched, setTouched] = useState({});
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [mintResult, setMintResult] = useState(null);
  const [txState, setTxState] = useState(null); // 'pending' | 'confirmed' | 'failed' | 'expired'
  const [txError, setTxError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [pendingMint, setPendingMint] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAuthorized, setIsAuthorized] = useState(null);
  const [authStatus, setAuthStatus] = useState('idle');
  const [authError, setAuthError] = useState(null);

  const validate = (f) => {
    const errors = {};
    if (!STELLAR_ADDRESS_RE.test(f.patient_address))
      errors.patient_address = t('issuer.validation.invalidAddress');
    if (!f.vaccine_name.trim())
      errors.vaccine_name = t('issuer.validation.vaccineRequired');
    if (!f.date_administered)
      errors.date_administered = t('issuer.validation.dateRequired');
    else if (f.date_administered > today())
      errors.date_administered = t('issuer.validation.dateFuture');
    for (const key of ['dose_number', 'dose_series']) {
      if (f[key] && !isValidDose(f[key])) errors[key] = t('issuer.validation.dosePositive');
    }
    if (f.dose_number && f.dose_series && !errors.dose_number && !errors.dose_series
      && Number(f.dose_number) > Number(f.dose_series))
      errors.dose_number = t('issuer.validation.doseExceedsSeries');
    return errors;
  };

  const errors = validate(form);
  const isValid = Object.keys(errors).length === 0;

  useEffect(() => {
    writeDraft(form);
  }, [form]);

  const loadAuthorization = useCallback(async () => {
    setAuthStatus('loading');
    setAuthError(null);
    setIsAuthorized(null);
    try {
      const authorized = await checkIssuerStatus();
      setIsAuthorized(Boolean(authorized));
      setAuthStatus('success');
    } catch (err) {
      setIsAuthorized(null);
      setAuthError(err?.message || t('issuer.authCheckFailed', 'Unable to verify issuer authorization.'));
      setAuthStatus('error');
    }
  }, [checkIssuerStatus, t]);

  // Reset all wallet-scoped state whenever the active account changes or
  // disconnects, so the prior account's data is never shown.
  useEffect(() => {
    setForm(readDraft());
    setTouched({});
    setError(null);
    setSuccess(null);
    setMintResult(null);
    setConfirming(false);
    setIsAuthorized(null);
    setAuthError(null);
    setAuthStatus('idle');
  }, [publicKey]);

  useEffect(() => {
    if (publicKey && role === 'issuer') {
      loadAuthorization();
    }
  }, [publicKey, role, loadAuthorization]);

  if (!publicKey) {
    return (
      <div style={{ ...pageContainerNarrow, marginTop: '2rem', marginBottom: '2rem' }}>
        <p style={{ color: '#94a3b8', marginBottom: '1rem' }}>Connect your issuer wallet.</p>
        <button style={styles.btn} onClick={connect} aria-label="Connect issuer wallet">Connect Wallet</button>
      </div>
    );
  }

  if (role !== 'issuer') {
    return <div style={{ ...pageContainerNarrow, marginTop: '2rem', marginBottom: '2rem' }}><p style={{ color: '#f87171' }}>{t('issuer.accessDenied')}</p></div>;
  }

  if (authStatus === 'loading' || authStatus === 'idle') {
    return (
      <div style={{ ...pageContainerNarrow, marginTop: '2rem', marginBottom: '2rem' }}>
        <AsyncState status="loading" message="Checking authorization status..." />
      </div>
    );
  }

  if (authStatus === 'error') {
    return (
      <div style={{ ...pageContainerNarrow, marginTop: '2rem', marginBottom: '2rem' }}>
        <AsyncState
          status="error"
          message={authError || t('issuer.authCheckFailed', 'Unable to verify issuer authorization.')}
          onRetry={loadAuthorization}
        />
      </div>
    );
  }

  const handleSubmit = (e) => {
    e.preventDefault();
    if (isSubmitting || loading || !isAuthorized) return;
    if (errors.dose_number || errors.dose_series) return;
    if (!isValid) {
      setTouched({ patient_address: true, vaccine_name: true, date_administered: true });
      return;
    }
    setPendingMint({
      patient_address: form.patient_address.trim(),
      vaccine_name: form.vaccine_name.trim(),
      date_administered: form.date_administered,
    });
    setConfirming(true);
  };

  const handleConfirmMint = async () => {
    if (isSubmitting || !pendingMint) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await issueVaccination(pendingMint);
      if (result) {
        setMintResult(result);
        setForm(EMPTY_FORM);
        sessionStorage.removeItem(FORM_KEY);
      } else {
        setError(t('issuer.mintFailed', 'Mint failed. Please try again.'));
      }
    } catch (err) {
      setError(err?.message || t('issuer.mintFailed', 'Mint failed. Please try again.'));
    } finally {
      setIsSubmitting(false);
      setConfirming(false);
      setPendingMint(null);
    }
  };

  const handleCancelMint = () => {
    setConfirming(false);
    setPendingMint(null);
  };

  const fields = [
    { key: 'patient_address', label: t('issuer.patientAddress'), placeholder: 'G...', type: 'text' },
    { key: 'vaccine_name', label: t('issuer.vaccineName'), placeholder: t('issuer.vaccineNamePlaceholder'), type: 'text' },
    { key: 'date_administered', label: t('issuer.dateAdministered'), placeholder: '', type: 'date' },
  ];

  return (
    <RoleGuard requiredRole="issuer">
      <div style={{ ...pageContainerNarrow, marginTop: '2rem', marginBottom: '2rem' }}>
        <div style={{ borderLeft: '4px solid #22c55e', paddingLeft: '0.75rem', marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem' }}>
            <h2 style={{ color: '#e2e8f0', margin: 0 }}>Issue Vaccination NFT</h2>
            <RoleBadge role="issuer" />
          </div>
        </div>
        {isAuthorized === null ? (
          <p style={{ color: '#94a3b8' }}>Checking authorization status...</p>
        ) : (
          <>
            {!isAuthorized && (
              <div style={styles.warning} role="alert">
                {t('issuer.notAuthorized', 'This wallet is not authorized to issue vaccinations.')}
              </div>
            )}
            <form style={styles.form} onSubmit={handleSubmit} role="form">
        {[
          { key: 'patient_address', label: 'Patient Stellar Address', placeholder: 'G...' },
          { key: 'vaccine_name', label: 'Vaccine Name', placeholder: 'e.g. COVID-19' },
          { key: 'date_administered', label: 'Date Administered', placeholder: 'YYYY-MM-DD' },
          { key: 'dose_number', label: 'Dose Number (optional)', placeholder: 'e.g. 1', optional: true },
          { key: 'dose_series', label: 'Doses in Series (optional)', placeholder: 'e.g. 2', optional: true },
        ].map(({ key, label, placeholder, optional }) => (
          <div key={key}>
            <label htmlFor={key} style={styles.label}>
              {label} <span aria-hidden="true" style={{ color: '#f87171' }}>*</span>
              <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>(required)</span>
            </label>
            <input
              id={key}
              style={errors[key] ? styles.inputError : styles.input}
              placeholder={placeholder}
              value={form[key]}
              onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
              onBlur={() => setTouched((prev) => ({ ...prev, [key]: true }))}
              required={!optional}
              aria-required="true"
              inputMode={optional ? 'numeric' : undefined}
              aria-invalid={Boolean(errors[key])}
              aria-describedby={errors[key] ? `${key}-error` : undefined}
            />
            {errors[key] && (
              <p id={`${key}-error`} style={styles.fieldError} role="alert">
                {errors[key]}
              </p>
            )}
          </div>
        ))}
        <button
          style={isAuthorized && !isSubmitting ? styles.btn : styles.btnDisabled}
          type="submit"
          disabled={loading || isSubmitting || !isAuthorized}
          aria-disabled={loading || isSubmitting || !isAuthorized}
        >
          {loading || isSubmitting ? 'Minting…' : 'Issue Vaccination NFT'}
        </button>
      </form>
      <ConfirmMintDialog
        open={confirming}
        values={pendingMint}
        submitting={isSubmitting}
        onConfirm={handleConfirmMint}
        onCancel={handleCancelMint}
      />
      <div aria-live="polite" aria-atomic="true">
        {error && (
          <div role="alert" style={{ marginTop: '1rem', padding: '0.75rem 1rem', background: '#7f1d1d', borderRadius: 8, color: '#f87171' }}>
            {error}
          </div>
        )}
        {mintResult && (
          <div style={{ marginTop: '1rem', padding: '0.75rem 1rem', background: '#0f172a', borderRadius: 8, color: '#4ade80' }}>
            <p>✅ {t('issuer.lifecycle.confirmed')}</p>
            <p style={{ fontSize: '0.85rem', color: '#94a3b8', marginTop: '0.25rem', display: 'flex', alignItems: 'center' }}>
              Token ID: {mintResult.tokenId}
              <CopyButton text={String(mintResult.tokenId)} label="token ID" />
            </p>
            {(() => {
              const explorerUrl = getExplorerUrl(mintResult.network, mintResult.transactionHash);
              return explorerUrl ? (
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: '0.85rem', color: '#0ea5e9' }}
                >
                  {t('issuer.lifecycle.viewExplorer')} ↗
                </a>
              ) : null;
            })()}
          </div>
        )}
        {txState === 'failed' && (
          <div style={{ marginTop: '1rem', padding: '0.75rem 1rem', background: '#7f1d1d', borderRadius: 8, color: '#fecaca' }}>
            <p>⚠️ {t('issuer.lifecycle.failed')}</p>
            {txError && <p style={{ fontSize: '0.85rem', marginTop: '0.25rem' }}>{txError}</p>}
            <button type="button" style={{ ...styles.btn, marginTop: '0.5rem' }} onClick={handleRetry}>
              {t('issuer.lifecycle.retry')}
            </button>
          </div>
        )}
        {txState === 'expired' && (
          <div style={{ marginTop: '1rem', padding: '0.75rem 1rem', background: '#78350f', borderRadius: 8, color: '#fde68a' }}>
            <p>⏱️ {t('issuer.lifecycle.expired')}</p>
            {txError && <p style={{ fontSize: '0.85rem', marginTop: '0.25rem' }}>{txError}</p>}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.5rem' }}>
              <button type="button" style={styles.btn} onClick={handleRetry}>
                {t('issuer.lifecycle.retry')}
              </button>
              <a
                href={SUPPORT_URL}
                target="_blank"
                rel="noopener noreferrer"
                style={{ ...styles.btn, display: 'inline-block', textAlign: 'center', textDecoration: 'none', background: '#334155' }}
              >
                {t('issuer.lifecycle.contactSupport')}
              </a>
            </div>
          </div>
        )}
        <div aria-live="polite" aria-atomic="true">
          {mintResult && (
            <div style={{ marginTop: '1rem', padding: '0.75rem 1rem', background: '#0f172a', borderRadius: 8, color: '#4ade80' }}>
              <p>✅ Vaccination NFT minted!</p>
              <p style={{ fontSize: '0.85rem', color: '#94a3b8', marginTop: '0.25rem', display: 'flex', alignItems: 'center' }}>
                Token ID: {mintResult.tokenId}
                <CopyButton text={String(mintResult.tokenId)} label="token ID" />
              </p>
              <a
                href={`https://stellar.expert/explorer/testnet/tx/${mintResult.transactionHash}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: '0.85rem', color: '#0ea5e9' }}
              >
                View on Stellar Explorer ↗
              </a>
            </div>
          )}
        </div>
      </div>
    </RoleGuard>
  );
}
