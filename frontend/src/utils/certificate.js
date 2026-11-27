/** Link to the public verification page for a patient's record. */
export function buildVerifyUrl(wallet, tokenId, origin = window.location.origin) {
  if (!wallet || tokenId == null) return null;
  return `${origin}/verify?${new URLSearchParams({ wallet, token: String(tokenId) })}`;
}

const shorten = (address) => (address ? `${address.slice(0, 8)}...${address.slice(-4)}` : 'N/A');

/** Allowlisted certificate content: nothing else from the record reaches the PDF. */
export function getCertificateData(record, patientWallet) {
  const patient = record.patient ?? patientWallet;
  const lines = [
    `Vaccine: ${record.vaccine_name ?? 'N/A'}`,
    `Date Administered: ${record.date_administered ?? 'N/A'}`,
    `Issuer: ${shorten(record.issuer)}`,
    `Patient Wallet: ${shorten(patient)}`,
    `Token ID: ${record.token_id != null ? `#${record.token_id}` : 'N/A'}`,
  ];
  if (record.dose_number != null) {
    lines.push(`Dose: ${record.dose_number}${record.dose_series != null ? ` of ${record.dose_series}` : ''}`);
  } else if (record.dose_series != null) {
    lines.push(`Doses in series: ${record.dose_series}`);
  }
  const safe = (value) => String(value ?? 'record').replace(/[^a-zA-Z0-9-]+/g, '_');
  return {
    lines,
    verifyUrl: buildVerifyUrl(patient, record.token_id),
    filename: `VacciChain_${safe(record.vaccine_name)}_${safe(record.date_administered)}.pdf`,
  };
}

export async function exportCertificate(record, patientWallet) {
  const [{ jsPDF }, QRCode] = await Promise.all([import('jspdf'), import('qrcode')]);
  const { lines, verifyUrl, filename } = getCertificateData(record, patientWallet);

  const doc = new jsPDF();
  doc.setFontSize(20);
  doc.text('VacciChain Vaccination Certificate', 105, 20, { align: 'center' });
  doc.setFontSize(12);
  lines.forEach((line, i) => doc.text(line, 20, 45 + i * 12, { maxWidth: 120 }));

  if (verifyUrl) {
    const toDataURL = QRCode.toDataURL ?? QRCode.default.toDataURL;
    doc.addImage(await toDataURL(verifyUrl, { width: 256, margin: 1 }), 'PNG', 150, 40, 40, 40);
    doc.setFontSize(8);
    doc.text('Scan to verify on-chain', 155, 84);
  }
  doc.save(filename);
}
