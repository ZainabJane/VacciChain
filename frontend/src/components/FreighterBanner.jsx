import { useEffect, useState } from 'react';
import { useAuth } from '../hooks/useFreighter';
import ExternalLink from './ExternalLink';

const INSTALL_URL = 'https://www.freighter.app/';

const ERROR_CONTENT = {
  missing_extension: {
    messageKey: 'wallet.errors.missingExtension',
    actionKey: 'wallet.errors.missingExtensionAction',
    action: 'install',
  },
  rejected: {
    messageKey: 'wallet.errors.rejected',
    actionKey: 'wallet.errors.rejectedAction',
    action: 'retry',
  },
  locked: {
    messageKey: 'wallet.errors.locked',
    actionKey: 'wallet.errors.lockedAction',
    action: 'unlock',
  },
  provider_error: {
    messageKey: 'wallet.errors.providerError',
    actionKey: 'wallet.errors.providerErrorAction',
    action: 'retry',
  },
};

function t(key, fallback) {
  return fallback;
}

export default function FreighterBanner() {
  const { freighterInstalled, publicKey } = useAuth();
  const [dismissed, setDismissed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (typeof refreshWalletNetwork !== 'function') return;
    setRefreshing(true);
    try {
      await refreshWalletNetwork();
    } finally {
      setRefreshing(false);
    }
  };

  if (networkMismatch) {
    return (
      <div
        role="alert"
        aria-live="assertive"
        style={{
          background: '#b91c1c', color: '#fff', padding: '0.6rem 1.5rem',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: '1rem', flexWrap: 'wrap',
        }}
      >
        <span>
          ⚠️ Network mismatch: this app is configured for{' '}
          <strong>{configuredNetwork || 'an unknown network'}</strong>, but your wallet is on{' '}
          <strong>{walletNetwork || 'an unknown network'}</strong>. Signing is blocked until the
          networks match. Switch networks in Freighter to match the app configuration, or update
          the app configuration to match your wallet, then retry.
        </span>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          aria-label="Retry wallet network detection"
          style={{
            background: '#fff', color: '#b91c1c', border: 'none', borderRadius: '4px',
            padding: '0.35rem 0.9rem', fontWeight: 600,
            cursor: refreshing ? 'wait' : 'pointer',
          }}
        >
          {refreshing ? 'Checking…' : 'Retry'}
        </button>
      </div>
    );
  }

  // Reset dismissal whenever the wallet connection state changes so stale
  // wallet UI is not shown after a disconnect or account switch.
  useEffect(() => {
    setDismissed(false);
  }, [freighterInstalled, publicKey]);

  const errorCategory = walletError && ERROR_CONTENT[walletError] ? walletError : null;
  const showMissingExtension = !freighterInstalled && !errorCategory;

  if (dismissed) return null;
  if (freighterInstalled && !errorCategory) return null;
  if (!freighterInstalled && !errorCategory && !showMissingExtension) return null;

  const content = errorCategory ? ERROR_CONTENT[errorCategory] : ERROR_CONTENT.missing_extension;

  const message = t(
    content.messageKey,
    errorCategory === 'rejected'
      ? 'Wallet connection was rejected.'
      : errorCategory === 'locked'
        ? 'Your Freighter wallet is locked.'
        : errorCategory === 'provider_error'
          ? 'The wallet provider returned an error.'
          : 'Freighter wallet not detected.'
  );

  const actionText = t(
    content.actionKey,
    content.action === 'install'
      ? 'Install Freighter'
      : content.action === 'unlock'
        ? 'Unlock your wallet in the Freighter extension, then try again.'
        : 'Approve the connection request in Freighter, then try again.'
  );

  return (
    <div
      role="alert"
      aria-live="polite"
      style={{
        background: '#7c3aed', color: '#fff', padding: '0.6rem 1.5rem',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem',
      }}
    >
      <span>
        🦊 Freighter wallet not detected.{' '}
        <ExternalLink href={INSTALL_URL} style={{ color: '#e9d5ff', fontWeight: 600 }}>
          Install the Freighter wallet extension (opens in a new tab)
        </ExternalLink>{' '}
        to connect your wallet and issue or view records.
      </span>
      <button
        onClick={() => setDismissed(true)}
        aria-label={t('wallet.errors.dismiss', 'Dismiss')}
        style={{ background: 'none', border: 'none', color: '#fff', fontSize: '1.2rem', cursor: 'pointer', lineHeight: 1 }}
      >
        ×
      </button>
    </div>
  );
}