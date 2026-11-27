import { useTranslation } from 'react-i18next';
import CopyButton from './CopyButton';
import Modal from './Modal';
import { formatDate } from '../i18n/formatters';

const STELLAR_EXPERT_BASE = 'https://stellar.expert/explorer/testnet/tx';

const row = { marginBottom: '1rem' };
const labelStyle = { fontSize: '0.75rem', color: '#64748b', marginBottom: '0.2rem' };
const valueStyle = { fontSize: '0.95rem', color: '#e2e8f0', wordBreak: 'break-all' };

export default function RecordDetailModal({ record, onClose }) {
  const { t, i18n } = useTranslation();

  if (!record) return null;

  const explorerUrl = record.tx_hash ? `${STELLAR_EXPERT_BASE}/${record.tx_hash}` : null;
  const formattedDate = formatDate(record.date_administered, i18n.language, t('modal.invalidDate'));

  return (
    <Modal
      isOpen={Boolean(record)}
      onClose={onClose}
      title={t('modal.title')}
      ariaLabel={t('modal.ariaLabel')}
      closeLabel={t('modal.close')}
    >
      <div style={row}>
        <p style={labelStyle}>{t('modal.vaccineName')}</p>
        <p style={valueStyle}>{record.vaccine_name}</p>
      </div>

      <div style={row}>
        <p style={labelStyle}>{t('modal.dateAdministered')}</p>
        <p style={valueStyle}>{formattedDate}</p>
      </div>

      <div style={row}>
        <p style={labelStyle}>{t('modal.tokenId')}</p>
        <p style={valueStyle}>
          #{record.token_id}
          <CopyButton text={String(record.token_id)} label={t('modal.tokenId')} />
        </p>
      </div>

      <div style={row}>
        <p style={labelStyle}>{t('modal.issuerAddress')}</p>
        <p style={valueStyle}>
          {record.issuer}
          <CopyButton text={record.issuer} label={t('modal.issuerAddress')} />
        </p>
      </div>

      {record.tx_hash && (
        <div style={row}>
          <p style={labelStyle}>{t('modal.txHash')}</p>
          <p style={valueStyle}>
            {record.tx_hash}
            <CopyButton text={record.tx_hash} label={t('modal.txHash')} />
          </p>
        </div>
      )}

      <div style={{ marginTop: '1.5rem' }}>
        {explorerUrl ? (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: 'inline-block', padding: '0.6rem 1.25rem', background: '#0ea5e9', color: '#fff', borderRadius: 8, textDecoration: 'none', fontSize: '0.9rem' }}
          >
            {t('modal.viewExplorer')}
          </a>
        ) : (
          <p style={{ color: '#475569', fontSize: '0.85rem' }}>{t('modal.noTxHash')}</p>
        )}
      </div>
    </Modal>
  );
}
