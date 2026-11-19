import { useTranslation } from 'react-i18next';
import CopyButton from './CopyButton';
import NFTCardSkeleton from './NFTCardSkeleton';
import { formatDate, formatCount } from '../i18n/formatters';

async function exportCertificate(record, locale, t) {
  const [{ jsPDF }, QRCode] = await Promise.all([
    import('jspdf'),
    import('qrcode'),
  ]);

  const verifyUrl = `${window.location.origin}/verify/${record.issuer}`;
  const qrDataUrl = await QRCode.toDataURL(verifyUrl, { width: 128, margin: 1 });

  const doc = new jsPDF();
  doc.setFontSize(20);
  doc.text('VacciChain Vaccination Certificate', 105, 20, { align: 'center' });

  const formattedDate = formatDate(record.date_administered, locale, t('nftCard.invalidDate', 'Date unavailable'));

  doc.setFontSize(12);
  doc.text(`Vaccine: ${record.vaccine_name}`, 20, 45);
  doc.text(`Date Administered: ${formattedDate}`, 20, 57);
  doc.text(`Issuer: ${record.issuer?.slice(0, 8)}…${record.issuer?.slice(-4)}`, 20, 69);
  doc.text(`Wallet: ${record.patient?.slice(0, 8) ?? 'N/A'}…${record.patient?.slice(-4) ?? ''}`, 20, 81);
  doc.text(`Token ID: #${record.token_id}`, 20, 93);

  doc.addImage(qrDataUrl, 'PNG', 150, 40, 40, 40);
  doc.setFontSize(8);
  doc.text('Scan to verify on-chain', 155, 84);

  const safeName = record.vaccine_name.replace(/\s+/g, '_');
  doc.save(`VacciChain_${safeName}_${formattedDate}.pdf`);
}

export default function NFTCard({ record, onClick, loading = false }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  if (loading) return <NFTCardSkeleton count={1} />;

  const formattedDate = formatDate(
    record.date_administered,
    locale,
    t('nftCard.invalidDate', 'Date unavailable'),
  );

  return (
    <div
      data-testid="nft-card"
      aria-label={`Vaccination record: ${record.vaccine_name}`}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onClick?.()}
      style={{
        background: '#1e293b',
        border: '1px solid #334155',
        borderRadius: 12,
        padding: '1.25rem',
        marginBottom: '1rem',
        cursor: 'pointer',
        transition: 'border-color 0.15s',
        width: '100%',
        boxSizing: 'border-box',
        minWidth: 0,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = '#38bdf8')}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = '#334155')}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
        <span style={{ fontSize: '1.1rem', fontWeight: 600, color: '#38bdf8', minWidth: 0, wordBreak: 'break-word' }}>
          💉 {record.vaccine_name}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {record.dose_number != null && (
            <span
              aria-label={
                record.dose_series != null
                  ? t('nftCard.doseOfSeries', {
                      dose: formatCount(record.dose_number, locale),
                      series: formatCount(record.dose_series, locale),
                      defaultValue: 'Dose {{dose}} of {{series}}',
                    })
                  : t('nftCard.dose', {
                      dose: formatCount(record.dose_number, locale),
                      defaultValue: 'Dose {{dose}}',
                    })
              }
              style={{
                fontSize: '0.72rem',
                fontWeight: 600,
                padding: '0.15rem 0.5rem',
                borderRadius: 99,
                background: record.dose_series != null && record.dose_number >= record.dose_series
                  ? '#166534'
                  : '#1e3a5f',
                color: record.dose_series != null && record.dose_number >= record.dose_series
                  ? '#86efac'
                  : '#93c5fd',
                whiteSpace: 'nowrap',
              }}
            >
              {record.dose_series != null
                ? t('nftCard.doseCount', {
                    dose: formatCount(record.dose_number, locale),
                    series: formatCount(record.dose_series, locale),
                    defaultValue: '{{dose}}/{{series}} doses',
                  })
                : t('nftCard.dose', {
                    dose: formatCount(record.dose_number, locale),
                    defaultValue: 'Dose {{dose}}',
                  })}
            </span>
          )}
          <span style={{ fontSize: '0.75rem', color: '#94a3b8', display: 'inline-flex', alignItems: 'center' }} aria-label={t('nftCard.tokenId', { id: formatCount(record.token_id, locale), defaultValue: 'Token ID {{id}}' })}>
            #{formatCount(record.token_id, locale)}
            <CopyButton text={String(record.token_id)} label="token ID" />
          </span>
        </div>
      </div>
      <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem', fontSize: '0.9rem' }}>
        {t('nftCard.date', { date: formattedDate, defaultValue: 'Date: {{date}}' })}
      </p>
      <p style={{ color: '#94a3b8', fontSize: '0.8rem', marginTop: '0.25rem' }}>
        Issuer: {record.issuer?.slice(0, 8)}…{record.issuer?.slice(-4)}
      </p>
      <button
        aria-label={`Export certificate for ${record.vaccine_name}`}
        onClick={(e) => { e.stopPropagation(); exportCertificate(record, locale, t); }}
        style={{
          marginTop: '0.75rem',
          padding: '0.35rem 0.85rem',
          fontSize: '0.8rem',
          background: 'transparent',
          border: '1px solid #38bdf8',
          borderRadius: 6,
          color: '#38bdf8',
          cursor: 'pointer',
        }}
      >
        📄 {t('exportCertificate', 'Export Certificate')}
      </button>
    </div>
  );
}
