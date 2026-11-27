import { exportCertificate, getCertificateData } from './certificate';

const mockDoc = { setFontSize: jest.fn(), text: jest.fn(), addImage: jest.fn(), save: jest.fn() };
const mockToDataURL = jest.fn().mockResolvedValue('data:image/png;base64,x');
jest.mock('jspdf', () => ({ jsPDF: jest.fn(() => mockDoc) }));
jest.mock('qrcode', () => ({ toDataURL: (...args) => mockToDataURL(...args) }));

const record = {
  token_id: 7n, patient: 'GPATIENT1234567890', issuer: 'GISSUER1234567890',
  vaccine_name: 'MMR', date_administered: '2024-01-15', dose_number: 1, dose_series: 2,
};

beforeEach(() => jest.clearAllMocks());

it('targets the patient record, not the issuer', async () => {
  await exportCertificate(record);
  expect(mockToDataURL.mock.calls[0][0]).toBe('http://localhost/verify?wallet=GPATIENT1234567890&token=7');
  expect(mockDoc.text.mock.calls.map(([t]) => t)).toContain('Dose: 1 of 2');
  expect(mockDoc.save).toHaveBeenCalledWith('VacciChain_MMR_2024-01-15.pdf');
});

it('does not export credentials or hidden state', async () => {
  await exportCertificate({ ...record, token: 'secret-jwt', api_key: 'secret-key', notes: 'secret-note' });
  expect(JSON.stringify([mockDoc.text.mock.calls, mockToDataURL.mock.calls])).not.toContain('secret');
});

it('handles legacy records and falls back to the known wallet', async () => {
  await exportCertificate({ token_id: 1, vaccine_name: 'Flu' });
  expect(mockDoc.addImage).not.toHaveBeenCalled();
  const { lines, verifyUrl } = getCertificateData({ token_id: 1 }, 'GWALLET');
  expect(lines.join()).not.toMatch(/undefined|null|Dose/);
  expect(verifyUrl).toContain('wallet=GWALLET&token=1');
});
