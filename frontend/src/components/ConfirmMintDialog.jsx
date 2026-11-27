import AccessibleDialog from './AccessibleDialog';

const row = { display: 'flex', justifyContent: 'space-between', margin: '0.4rem 0', fontSize: '0.9rem' };
const btnRow = { display: 'flex', gap: '0.75rem', marginTop: '1.5rem' };
const btnConfirm = { flex: 1, padding: '0.7rem', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 8, fontSize: '1rem', cursor: 'pointer' };
const btnConfirmDisabled = { ...btnConfirm, background: '#334155', color: '#94a3b8', cursor: 'not-allowed' };
const btnCancel = { flex: 1, padding: '0.7rem', background: 'transparent', color: '#94a3b8', border: '1px solid #334155', borderRadius: 8, fontSize: '1rem', cursor: 'pointer' };
const mismatchBox = { marginTop: '1rem', padding: '0.75rem 1rem', background: '#451a03', border: '1px solid #b45309', borderRadius: 8, color: '#fcd34d', fontSize: '0.85rem' };

function getFocusableElements(root) {
  if (!root) return [];
  const selectors = 'a[href],button:not([disabled]),textarea, input, select, [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll(selectors)).filter((el) => el.offsetParent !== null);
}

export default function ConfirmMintDialog({ record, onConfirm, onCancel, isSubmitting = false }) {
  const overlayRef = useRef(null);
  const boxRef = useRef(null);
  const previousActive = useRef(null);
  const submittingRef = useRef(isSubmitting);

  useEffect(() => {
    submittingRef.current = isSubmitting;
  }, [isSubmitting]);

  const handleConfirm = () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    onConfirm();
  };

  useEffect(() => {
    previousActive.current = document.activeElement;
    const focusable = getFocusableElements(boxRef.current);
    (focusable[0] || boxRef.current)?.focus?.();

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key === 'Tab') {
        const nodes = getFocusableElements(boxRef.current);
        if (nodes.length === 0) {
          e.preventDefault();
          return;
        }
        const idx = nodes.indexOf(document.activeElement);
        if (e.shiftKey) {
          if (idx === 0 || document.activeElement === boxRef.current) {
            nodes[nodes.length - 1].focus();
            e.preventDefault();
          }
        } else {
          if (idx === nodes.length - 1) {
            nodes[0].focus();
            e.preventDefault();
          }
        }
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previousActive.current?.focus?.();
    };
  }, [onCancel]);

  const handleConfirm = async () => {
    if (networkMismatch) {
      announce('Mint blocked: wallet network does not match the configured network.', 'assertive');
      return;
    }
    try {
      await onConfirm();
      announce('Vaccination record minted successfully.', 'polite');
    } catch (err) {
      announce(`Mint failed: ${err?.message || 'unknown error'}.`, 'assertive');
    }
  };

  return (
    <div ref={overlayRef} style={overlay} role="dialog" aria-modal="true" aria-labelledby="dialog-title" onClick={(e) => e.target === overlayRef.current && onCancel()}>
      <div style={box} ref={boxRef} tabIndex={-1}>
        <h3 id="dialog-title" style={{ marginBottom: '1rem', color: '#f1f5f9' }}>Confirm Vaccination Mint</h3>
        <p style={{ color: '#94a3b8', fontSize: '0.85rem', marginBottom: '1rem' }}>
          This action is irreversible. Please review the record before confirming.
        </p>
        <div style={{ background: '#0f172a', borderRadius: 8, padding: '0.75rem 1rem' }}>
          <div style={row}><span style={{ color: '#64748b' }}>Patient</span><span style={{ wordBreak: 'break-all', maxWidth: '60%', textAlign: 'right' }}>{record.patient_address}</span></div>
          <div style={row}><span style={{ color: '#64748b' }}>Vaccine</span><span>{record.vaccine_name}</span></div>
          <div style={row}><span style={{ color: '#64748b' }}>Date</span><span>{record.date_administered}</span></div>
        </div>
        {networkMismatch && (
          <div style={mismatchBox} role="alert">
            <strong>Network mismatch.</strong> Your wallet is on {walletNetwork || 'an unknown network'}, but this app is configured for {configuredNetwork || 'a different network'}. Switch your wallet to {configuredNetwork || 'the configured network'} and try again.
          </div>
        )}
        <div style={btnRow}>
          <button style={btnCancel} onClick={onCancel} disabled={isSubmitting}>Cancel</button>
          <button
            style={{ ...btnConfirm, opacity: isSubmitting ? 0.6 : 1, cursor: isSubmitting ? 'not-allowed' : 'pointer' }}
            onClick={handleConfirm}
            disabled={isSubmitting}
            aria-busy={isSubmitting}
          >
            {isSubmitting ? 'Minting…' : 'Confirm & Mint'}
          </button>
        </div>
      </div>
    </AccessibleDialog>
  );
}
