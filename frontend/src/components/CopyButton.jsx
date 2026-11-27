import { useState, useCallback } from 'react';
import { useAnnounce } from '../hooks/useAnnounce';

/**
 * A small copy-to-clipboard button with a brief 'Copied!' tooltip.
 * Accessible via keyboard (focusable, responds to Enter/Space).
 * Success and failure are also announced via a polite live region.
 */
export default function CopyButton({ text, label }) {
  const [copied, setCopied] = useState(false);
  const announce = useAnnounce();

  const handleCopy = useCallback(async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      announce(label ? `${label} copied to clipboard` : 'Copied to clipboard');
      setTimeout(() => setCopied(false), 1500);
    } catch {
      try {
        // fallback for older browsers
        const el = document.createElement('textarea');
        el.value = text;
        el.style.position = 'fixed';
        el.style.opacity = '0';
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
        setCopied(true);
        announce(label ? `${label} copied to clipboard` : 'Copied to clipboard');
        setTimeout(() => setCopied(false), 1500);
      } catch {
        announce('Copy failed. Please copy manually.', { assertive: true });
      }
    }
  }, [text, label, announce]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleCopy(e);
    }
  }, [handleCopy]);

  const copied = status === 'copied';
  const errored = status === 'error';
  const statusMessage = copied
    ? 'Copied!'
    : errored
      ? 'Copy failed — select and copy manually'
      : '';

  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', marginLeft: '0.4rem' }}>
      <button
        type="button"
        onClick={handleCopy}
        onKeyDown={handleKeyDown}
        aria-label={copied ? 'Copied!' : errored ? 'Copy failed' : (label ? `Copy ${label}` : 'Copy to clipboard')}
        title={copied ? 'Copied!' : errored ? 'Copy failed — select and copy manually' : 'Copy to clipboard'}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '0.15rem 0.25rem',
          borderRadius: 4,
          color: copied ? '#4ade80' : errored ? '#f87171' : '#64748b',
          fontSize: '0.85rem',
          lineHeight: 1,
          transition: 'color 0.15s',
          verticalAlign: 'middle',
        }}
        onMouseEnter={(e) => { if (!copied && !errored) e.currentTarget.style.color = '#38bdf8'; }}
        onMouseLeave={(e) => { if (!copied && !errored) e.currentTarget.style.color = '#64748b'; }}
      >
        {copied ? '✓' : errored ? '⚠' : '⎘'}
      </button>
      <span
        role="status"
        aria-live="polite"
        style={{
          position: 'absolute',
          bottom: '120%',
          left: '50%',
          transform: 'translateX(-50%)',
          background: '#1e293b',
          border: `1px solid ${errored ? '#7f1d1d' : '#334155'}`,
          color: errored ? '#f87171' : '#4ade80',
          fontSize: '0.72rem',
          padding: '0.2rem 0.5rem',
          borderRadius: 4,
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
          zIndex: 10,
          visibility: statusMessage ? 'visible' : 'hidden',
        }}
      >
        {statusMessage}
      </span>
    </span>
  );
}
