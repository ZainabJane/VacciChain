import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../hooks/useFreighter';
import { useVaccination } from '../hooks/useVaccination';
import { useConsent } from '../hooks/useConsent';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import NFTCard from '../components/NFTCard';
import RoleBadge from '../components/RoleBadge';
import NFTCardSkeleton from '../components/NFTCardSkeleton';
import EmptyState from '../components/EmptyState';
import RecordDetailModal from '../components/RecordDetailModal';
import CopyButton from '../components/CopyButton';
import QRCodeModal from '../components/QRCodeModal';
import ConsentScreen from '../components/ConsentScreen';
import { pageContainer, section } from '../layout.js';

const styles = {
  header: { borderLeft: '4px solid #0ea5e9', paddingLeft: '0.75rem', marginBottom: '1.5rem' },
  btn: { padding: '0.6rem 1.5rem', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' },
  secondaryBtn: { padding: '0.5rem 1.1rem', background: 'transparent', color: '#0ea5e9', border: '1px solid #0ea5e9', borderRadius: 8, cursor: 'pointer' },
  privacySection: { border: '1px solid #1e293b', borderRadius: 10, padding: '1rem 1.25rem', marginBottom: '1.5rem', background: '#0f172a' },
  privacyHeader: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.5rem' },
  privacyTitle: { color: '#e2e8f0', margin: 0, fontSize: '1.05rem' },
  statusRow: { color: '#94a3b8', fontSize: '0.9rem', margin: '0.25rem 0' },
  statusValue: { color: '#e2e8f0', fontWeight: 600 },
  scopeList: { margin: '0.25rem 0 0', paddingLeft: '1.25rem', color: '#94a3b8', fontSize: '0.9rem' },
  confirmation: { color: '#4ade80', fontSize: '0.9rem', marginTop: '0.5rem' },
};

export default function PatientDashboard() {
  const { t } = useTranslation();
  const { publicKey, connect, disconnect } = useAuth();
  const { records, loading, error, refetch, page = 1, totalPages = 1, total = records.length, setPage } = useVaccination(publicKey);
  const { consented, giveConsent, loading: consentLoading } = useConsent();
  const [qrRecord, setQrRecord] = useState(null);
  const [showConsentSettings, setShowConsentSettings] = useState(false);
  const [consentConfirmation, setConsentConfirmation] = useState(null);

  // Clear wallet-specific UI state whenever the active account changes or the
  // wallet disconnects, so the prior account's data is never shown.
  useEffect(() => {
    setQrRecord(null);
  }, [publicKey]);

  const handleDeclineConsent = () => {
    setQrRecord(null);
    disconnect();
  };

  const handleRetry = () => {
    // Retry only refetches data; safe form state (e.g. open QR modal) is kept.
    refetch();
  };

  // Treat a pending request as loading even if stale records exist, so a
  // stalled request is never mistaken for empty data.
  const isInitialLoading = loading && records.length === 0;
  const isRefreshing = loading && records.length > 0;
  const hasError = !loading && Boolean(error);
  const isEmpty = !loading && !error && records.length === 0;
  const isPartial = !loading && !error && records.length > 0;

  const handleConsentUpdate = async (nextConsent) => {
    try {
      if (nextConsent === false) {
        await revokeConsent();
        setConsentConfirmation(t('consent.revokedConfirmation', 'Your consent has been revoked. Records are no longer shared.'));
      } else {
        await giveConsent(nextConsent);
        setConsentConfirmation(t('consent.updatedConfirmation', 'Your consent settings have been updated.'));
      }
    } finally {
      // Always re-render from the authoritative API state.
      if (refreshConsent) await refreshConsent();
      setShowConsentSettings(false);
    }
  };

  if (!publicKey) {
    return (
      <div style={{ ...pageContainer, marginTop: '2rem', marginBottom: '2rem' }}>
        <p style={{ color: '#94a3b8', marginBottom: '1rem' }}>Connect your wallet to view records.</p>
        <button style={styles.btn} onClick={connect} aria-label="Connect Freighter wallet to view vaccination records">Connect Wallet</button>
      </div>
    );
  }

  if (consented === false && !showConsentSettings) {
    return (
      <div style={{ ...pageContainer, marginTop: '2rem', marginBottom: '2rem' }}>
        <ConsentScreen
          onAccept={giveConsent}
          onDecline={handleDeclineConsent}
          loading={consentLoading}
        />
      </div>
    );
  }

  return (
    <div style={{ ...pageContainer, marginTop: '2rem', marginBottom: '2rem' }}>
      <div style={styles.header}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem', marginBottom: '0.25rem' }}>
          <h2 style={{ color: '#e2e8f0', margin: 0 }}>{t('patient.title')}</h2>
          <RoleBadge role="patient" />
        </div>
        {total > 0 && (
          <span style={{ color: '#64748b', fontSize: '0.85rem' }}>
            {t('patient.recordCount', { count: total })}
          </span>
        )}
      </div>
      <p style={{ color: '#64748b', fontSize: '0.85rem', marginBottom: '1.5rem', wordBreak: 'break-all' }}>
        Wallet: {publicKey}
        <CopyButton text={publicKey} label="wallet address" />
      </p>

      {isInitialLoading && (
        <div role="status" aria-live="polite" aria-busy="true">
          <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
            Loading records…
          </span>
          <NFTCardSkeleton count={3} />
        </div>
      )}

      {hasError && (
        <div role="alert" style={{ textAlign: 'center', padding: '2rem 0' }}>
          <p style={{ color: '#f87171', marginBottom: '0.75rem' }}>⚠️ {error}</p>
          <button style={styles.btn} onClick={handleRetry}>Retry</button>
        </div>
      )}

      {!loading && !error && records.map((r) => (
        <NFTCard
          key={r.token_id}
          record={r}
          patientWallet={publicKey}
          onShowQR={setQrRecord}
          disabled={isNetworkMismatch}
        />
      ))}

      {total > 0 && totalPages > 1 && (
        <nav aria-label="Vaccination records pagination" style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem' }}>
          <button style={styles.btn} onClick={() => setPage(page - 1)} disabled={loading || page <= 1}>Previous</button>
          <span aria-live="polite" style={{ color: '#94a3b8' }}>Page {page} of {totalPages}</span>
          <button style={styles.btn} onClick={() => setPage(page + 1)} disabled={loading || page >= totalPages}>Next</button>
        </nav>
      )}

      {qrRecord && (
        <QRCodeModal
          url={`${window.location.origin}/verify?wallet=${encodeURIComponent(publicKey)}&token=${encodeURIComponent(qrRecord.token_id)}`}
          onClose={() => setQrRecord(null)}
        />
      )}
    </div>
  );
}
