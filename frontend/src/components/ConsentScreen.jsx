import { useState, useRef, useEffect } from 'react';

const s = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1000, padding: '1rem',
  },
  modal: {
    background: '#1e293b', borderRadius: 12, padding: '2rem',
    maxWidth: 520, width: '100%', color: '#e2e8f0',
  },
  title: { fontSize: '1.25rem', fontWeight: 700, marginBottom: '1rem', color: '#38bdf8' },
  body: { fontSize: '0.9rem', lineHeight: 1.6, color: '#94a3b8', marginBottom: '1.25rem' },
  list: { paddingLeft: '1.25rem', marginBottom: '1.25rem', color: '#94a3b8', fontSize: '0.9rem', lineHeight: 1.8 },
  checkRow: { display: 'flex', alignItems: 'flex-start', gap: '0.75rem', marginBottom: '1.5rem' },
  checkLabel: { fontSize: '0.9rem', color: '#e2e8f0', cursor: 'pointer' },
  btnRow: { display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' },
  btnAccept: { padding: '0.6rem 1.5rem', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 },
  btnDecline: { padding: '0.6rem 1.5rem', background: 'transparent', color: '#94a3b8', border: '1px solid #334155', borderRadius: 8, cursor: 'pointer' },
  btnRevoke: { padding: '0.6rem 1.5rem', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 },
  statusBox: { background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '1.25rem', fontSize: '0.9rem', color: '#e2e8f0' },
  statusLabel: { color: '#94a3b8', marginRight: '0.5rem' },
  statusValue: { fontWeight: 600, color: '#38bdf8' },
  scopeRow: { display: 'flex', alignItems: 'flex-start', gap: '0.75rem', marginBottom: '0.75rem' },
  consequence: { fontSize: '0.8rem', color: '#f59e0b', marginBottom: '1rem', lineHeight: 1.5 },
  confirmBox: { background: '#450a0a', border: '1px solid #dc2626', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '1.25rem', fontSize: '0.9rem', color: '#fecaca' },
  success: { background: '#052e16', border: '1px solid #16a34a', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '1.25rem', fontSize: '0.9rem', color: '#bbf7d0' },
  error: { background: '#450a0a', border: '1px solid #dc2626', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '1.25rem', fontSize: '0.9rem', color: '#fecaca' },
};

const DEFAULT_SCOPES = [
  { key: 'records', labelKey: 'consent.scope.records' },
  { key: 'wallet', labelKey: 'consent.scope.wallet' },
  { key: 'issuer', labelKey: 'consent.scope.issuer' },
];

const DEFAULT_I18N = {
  'consent.title': '💉 Data Consent',
  'consent.intro': 'Before your vaccination records can be issued, you must understand what data is stored and who can access it.',
  'consent.status.label': 'Current status:',
  'consent.status.granted': 'Consent granted',
  'consent.status.revoked': 'Consent revoked',
  'consent.status.none': 'No consent on record',
  'consent.scope.label': 'Current scope:',
  'consent.scope.records': 'Vaccination records (vaccine name, date, issuer)',
  'consent.scope.wallet': 'Stellar wallet address',
  'consent.scope.issuer': 'Authorized issuer verification',
  'consent.scope.none': 'No scopes granted',
  'consent.consequences.title': 'What this means:',
  'consent.consequences.records': 'Vaccination records are publicly visible to anyone who queries the contract.',
  'consent.consequences.wallet': 'Your Stellar wallet address is stored on a public blockchain.',
  'consent.consequences.issuer': 'Records are permanent and cannot be deleted — only revoked by an authorized issuer.',
  'consent.consequences.offchain': 'Your consent timestamp and wallet address are stored off-chain by VacciChain.',
  'consent.consequences.revoke': 'Revoking consent stops new records from being issued and marks your consent as withdrawn. Existing on-chain records cannot be deleted.',
  'consent.checkbox.initial': 'I understand and consent to my vaccination data being stored on the Stellar blockchain.',
  'consent.checkbox.update': 'I confirm I want to update my consent scope as selected above.',
  'consent.checkbox.revoke': 'I understand revoking consent cannot delete existing on-chain records.',
  'consent.btn.decline': 'Decline',
  'consent.btn.accept': 'I Consent',
  'consent.btn.update': 'Update consent',
  'consent.btn.revoke': 'Revoke consent',
  'consent.btn.confirmRevoke': 'Yes, revoke consent',
  'consent.btn.cancel': 'Cancel',
  'consent.btn.recording': 'Recording…',
  'consent.confirm.revoke': 'Are you sure you want to revoke your consent? This cannot be undone for records already on-chain.',
  'consent.success.initial': 'Consent recorded. Your status has been refreshed.',
  'consent.success.update': 'Consent scope updated. Your status has been refreshed.',
  'consent.success.revoke': 'Consent revoked. Your status has been refreshed.',
  'consent.error': 'Something went wrong. Please try again.',
};

/**
 * ConsentScreen — shown to first-time patients before their wallet is associated
 * with on-chain vaccination records.
 *
 * Props:
 *   onAccept()        — called when patient accepts initial consent; caller should POST /v1/patient/consent
 *   onDecline()       — called when patient declines
 *   loading           — disables action buttons while a request is in flight
 *   mode              — 'initial' (default) or 'manage' (update/revoke flow)
 *   consent           — current authoritative consent state: { status, scopes, updatedAt }
 *   onUpdate(scopes)  — called when patient submits an updated scope; caller should PUT /v1/patient/consent
 *   onRevoke()        — called when patient confirms revocation; caller should DELETE /v1/patient/consent
 *   i18n              — optional overrides for translation keys
 */
export default function ConsentScreen({
  onAccept,
  onDecline,
  loading = false,
  mode = 'initial',
  consent = null,
  onUpdate,
  onRevoke,
  i18n = {},
}) {
  const t = (key) => i18n[key] ?? DEFAULT_I18N[key] ?? key;
  const isManage = mode === 'manage';
  const currentStatus = consent?.status || (isManage ? 'none' : 'none');
  const currentScopes = Array.isArray(consent?.scopes) ? consent.scopes : [];
  const [checked, setChecked] = useState(false);
  const [selectedScopes, setSelectedScopes] = useState(currentScopes);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [feedback, setFeedback] = useState(null); // { type: 'success' | 'error', key }
  const overlayRef = useRef(null);
  const modalRef = useRef(null);
  const previousActive = useRef(null);

  // Keep the local scope selection in sync with authoritative state from the parent.
  useEffect(() => {
    setSelectedScopes(currentScopes);
  }, [consent]);

  const toggleScope = (key) => {
    setSelectedScopes((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
    setChecked(false);
    setFeedback(null);
  };

  const handleSubmit = async () => {
    setFeedback(null);
    try {
      if (isManage) {
        if (confirmingRevoke) {
          await onRevoke?.();
          setFeedback({ type: 'success', key: 'consent.success.revoke' });
        } else {
          await onUpdate?.(selectedScopes);
          setFeedback({ type: 'success', key: 'consent.success.update' });
        }
      } else {
        await onAccept?.();
        setFeedback({ type: 'success', key: 'consent.success.initial' });
      }
      setChecked(false);
      setConfirmingRevoke(false);
    } catch (err) {
      setFeedback({ type: 'error', key: 'consent.error' });
    }
  };

  useEffect(() => {
    previousActive.current = document.activeElement;
    const focusable = modalRef.current?.querySelectorAll('a[href],button:not([disabled]),textarea, input, select, [tabindex]:not([tabindex="-1"])');
    (focusable && focusable[0]) ? focusable[0].focus() : modalRef.current?.focus?.();

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onDecline();
      }
      if (e.key === 'Tab') {
        const nodes = Array.from(modalRef.current.querySelectorAll('a[href],button:not([disabled]),textarea, input, select, [tabindex]:not([tabindex="-1"])')).filter((el) => el.offsetParent !== null);
        if (nodes.length === 0) { e.preventDefault(); return; }
        const idx = nodes.indexOf(document.activeElement);
        if (e.shiftKey) {
          if (idx === 0 || document.activeElement === modalRef.current) { nodes[nodes.length - 1].focus(); e.preventDefault(); }
        } else {
          if (idx === nodes.length - 1) { nodes[0].focus(); e.preventDefault(); }
        }
      }
    };

    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previousActive.current?.focus?.(); };
  }, [onDecline]);

  const statusText = currentStatus === 'granted'
    ? t('consent.status.granted')
    : currentStatus === 'revoked'
      ? t('consent.status.revoked')
      : t('consent.status.none');

  const scopeText = currentScopes.length
    ? currentScopes.map((k) => t(`consent.scope.${k}`)).join(', ')
    : t('consent.scope.none');

  const canSubmit = isManage
    ? (confirmingRevoke ? checked : checked && selectedScopes.length > 0)
    : checked;

  return (
    <div ref={overlayRef} style={s.overlay} role="dialog" aria-modal="true" aria-labelledby="consent-title" onClick={(e) => e.target === overlayRef.current && onDecline?.()}>
      <div style={s.modal} ref={modalRef} tabIndex={-1}>
        <h2 id="consent-title" style={s.title}>{t('consent.title')}</h2>
        <p style={s.body}>{t('consent.intro')}</p>

        {isManage && (
          <div style={s.statusBox} role="status" aria-live="polite">
            <div>
              <span style={s.statusLabel}>{t('consent.status.label')}</span>
              <span style={s.statusValue}>{statusText}</span>
            </div>
            <div style={{ marginTop: '0.35rem' }}>
              <span style={s.statusLabel}>{t('consent.scope.label')}</span>
              <span style={s.statusValue}>{scopeText}</span>
            </div>
          </div>
        )}

        {feedback && (
          <div style={feedback.type === 'success' ? s.success : s.error} role="alert">
            {t(feedback.key)}
          </div>
        )}

        {isManage && confirmingRevoke ? (
          <div style={s.confirmBox} role="alertdialog" aria-labelledby="consent-revoke-title">
            <strong id="consent-revoke-title">{t('consent.confirm.revoke')}</strong>
          </div>
        ) : (
          <>
            <p style={{ ...s.body, marginBottom: '0.5rem' }}>{t('consent.consequences.title')}</p>
            <ul style={s.list}>
              <li>{t('consent.consequences.wallet')}</li>
              <li>{t('consent.consequences.records')}</li>
              <li>{t('consent.consequences.issuer')}</li>
              <li>{t('consent.consequences.offchain')}</li>
              {isManage && <li>{t('consent.consequences.revoke')}</li>}
            </ul>
          </>
        )}

        {isManage && !confirmingRevoke && (
          <fieldset style={{ border: 'none', padding: 0, margin: '0 0 1rem' }}>
            <legend style={{ ...s.statusLabel, marginBottom: '0.5rem' }}>{t('consent.scope.label')}</legend>
            {DEFAULT_SCOPES.map(({ key, labelKey }) => (
              <div key={key} style={s.scopeRow}>
                <input
                  id={`consent-scope-${key}`}
                  type="checkbox"
                  checked={selectedScopes.includes(key)}
                  onChange={() => toggleScope(key)}
                  disabled={loading}
                />
                <label htmlFor={`consent-scope-${key}`} style={s.checkLabel}>
                  {t(labelKey)}
                </label>
              </div>
            ))}
          </fieldset>
        )}

        <div style={s.checkRow}>
          <input
            id="consent-check"
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            aria-required="true"
            disabled={loading}
          />
          <label htmlFor="consent-check" style={s.checkLabel}>
            {isManage
              ? (confirmingRevoke ? t('consent.checkbox.revoke') : t('consent.checkbox.update'))
              : t('consent.checkbox.initial')}
          </label>
        </div>

        <div style={s.btnRow}>
          {isManage && confirmingRevoke ? (
            <>
              <button style={s.btnDecline} onClick={() => { setConfirmingRevoke(false); setChecked(false); }} type="button" disabled={loading}>
                {t('consent.btn.cancel')}
              </button>
              <button
                style={{ ...s.btnRevoke, opacity: (!canSubmit || loading) ? 0.5 : 1 }}
                onClick={handleSubmit}
                disabled={!canSubmit || loading}
                aria-disabled={!canSubmit || loading}
                type="button"
              >
                {loading ? t('consent.btn.recording') : t('consent.btn.confirmRevoke')}
              </button>
            </>
          ) : (
            <>
              {isManage ? (
                <button
                  style={s.btnDecline}
                  onClick={() => { setConfirmingRevoke(true); setChecked(false); setFeedback(null); }}
                  type="button"
                  disabled={loading}
                >
                  {t('consent.btn.revoke')}
                </button>
              ) : (
                <button style={s.btnDecline} onClick={onDecline} type="button" disabled={loading}>
                  {t('consent.btn.decline')}
                </button>
              )}
              <button
                style={{ ...s.btnAccept, opacity: (!canSubmit || loading) ? 0.5 : 1 }}
                onClick={handleSubmit}
                disabled={!canSubmit || loading}
                aria-disabled={!canSubmit || loading}
                type="button"
              >
                {loading
                  ? t('consent.btn.recording')
                  : (isManage ? t('consent.btn.update') : t('consent.btn.accept'))}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
