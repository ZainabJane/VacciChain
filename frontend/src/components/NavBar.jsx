import { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import DarkModeToggle from './DarkModeToggle';
import { useAuth } from '../hooks/useFreighter';

const NAV_LINKS = [
  { to: '/', label: 'Home' },
  { to: '/patient', label: 'My Records' },
  { to: '/issuer', label: 'Issue' },
  { to: '/verify', label: 'Verify' },
  { to: '/admin', label: 'Admin' },
  { to: '/apply', label: 'Apply as Issuer' },
  { to: '/analytics', label: 'Analytics' },
];

function truncate(addr) {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function WalletIndicator() {
  const { publicKey, connect, disconnect } = useAuth();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close wallet dropdown on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  if (!publicKey) {
    return (
      <button
        onClick={connect}
        style={{
          padding: '0.4rem 1rem',
          background: 'var(--btn-primary)',
          color: '#fff',
          border: 'none',
          borderRadius: 6,
          fontSize: '0.85rem',
          cursor: 'pointer',
        }}
      >
        Connect Wallet
      </button>
    );
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(publicKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.4rem',
          padding: '0.4rem 0.75rem',
          background: '#1e293b',
          border: '1px solid #334155',
          borderRadius: 6,
          color: '#e2e8f0',
          fontSize: '0.85rem',
          cursor: 'pointer',
        }}
      >
        <span
          aria-hidden="true"
          style={{ width: 8, height: 8, borderRadius: '50%', background: '#4ade80', display: 'inline-block' }}
        />
        {truncate(publicKey)}
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 6px)',
            background: '#1e293b',
            border: '1px solid #334155',
            borderRadius: 8,
            padding: '0.75rem',
            minWidth: 220,
            zIndex: 100,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ color: '#94a3b8', fontSize: '0.8rem', wordBreak: 'break-all', flex: 1 }}>
              {truncate(publicKey)}
            </span>
            <button
              onClick={handleCopy}
              style={{
                padding: '0.25rem 0.6rem',
                fontSize: '0.75rem',
                background: 'transparent',
                border: '1px solid #334155',
                borderRadius: 4,
                color: '#e2e8f0',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <button
            onClick={() => { disconnect(); setOpen(false); }}
            style={{
              padding: '0.35rem 0.75rem',
              background: 'transparent',
              border: '1px solid #f87171',
              borderRadius: 4,
              color: '#f87171',
              fontSize: '0.8rem',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Trap Tab/Shift+Tab focus within `containerRef` while `active` is true.
 */
function useFocusTrap(containerRef, active) {
  useEffect(() => {
    if (!active) return;

    const container = containerRef.current;
    if (!container) return;

    const focusable = () =>
      Array.from(
        container.querySelectorAll(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.closest('[hidden]'));

    const handleKeyDown = (e) => {
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [active, containerRef]);
}

export default function NavBar({ dark, onToggleDark }) {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);

  const hamburgerRef = useRef(null);
  const linksRef = useRef(null);

  const close = useCallback(() => setOpen(false), []);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  // When menu opens, move focus to first item; when it closes, restore to hamburger.
  useEffect(() => {
    if (open) {
      const firstFocusable = linksRef.current?.querySelector('a, button');
      firstFocusable?.focus();
    } else {
      // Only restore focus when hamburger is visible (narrow screens)
      hamburgerRef.current?.focus();
    }
  }, [open]);

  // Close when route changes
  useEffect(() => { close(); }, [pathname, close]);

  // Trap focus inside the mobile menu while it is open
  useFocusTrap(linksRef, open);

  return (
    <nav
      aria-label="Main navigation"
      style={{
        padding: '1rem 2rem',
        background: 'var(--nav-bg)',
        display: 'flex',
        flexWrap: 'wrap',
        gap: '1.5rem',
        alignItems: 'center',
        position: 'relative',
      }}
    >
      <strong style={{ color: 'var(--accent)', fontSize: '1.2rem', flex: 1 }}>💉 VacciChain</strong>

      {/* Hamburger — visible only on narrow screens via CSS */}
      <button
        ref={hamburgerRef}
        className="nav-hamburger"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        aria-controls="nav-links"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'none',          /* overridden by .nav-hamburger media query */
          background: 'none',
          border: 'none',
          color: '#e2e8f0',
          fontSize: '1.5rem',
          lineHeight: 1,
          padding: '0.25rem',
        }}
      >
        {/* Unicode chars have poor SR support — wrap in aria-hidden and use
            the button's aria-label as the accessible name. */}
        <span aria-hidden="true">{open ? '✕' : '☰'}</span>
      </button>

      {/* Nav link list
          On narrow screens: hidden when closed, shown as column when open.
          aria-hidden removes collapsed menu items from the accessibility tree
          so keyboard users cannot accidentally Tab into them while hidden. */}
      <div
        id="nav-links"
        ref={linksRef}
        className={`nav-links${open ? ' nav-links--open' : ''}`}
        aria-hidden={!open ? true : undefined}
        style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', flexWrap: 'wrap' }}
      >
        {NAV_LINKS.map(({ to, label }) => (
          <Link
            key={to}
            to={to}
            aria-current={pathname === to ? 'page' : undefined}
            onClick={close}
            /* Prevent keyboard access to hidden mobile menu items */
            tabIndex={undefined}
          >
            {label}
          </Link>
        ))}
        <DarkModeToggle dark={dark} onToggle={onToggleDark} />
        <WalletIndicator />
      </div>
    </nav>
  );
}
