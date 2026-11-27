import { render, screen } from '@testing-library/react';
import PatientDashboard from './PatientDashboard';

jest.mock('../hooks/useFreighter', () => ({ useAuth: jest.fn() }));
jest.mock('../hooks/useVaccination', () => ({ useVaccination: jest.fn() }));
jest.mock('../hooks/useConsent', () => ({ useConsent: jest.fn() }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, options) => {
      if (key === 'patient.title') return 'My Vaccination Records';
      if (key === 'patient.recordCount') {
        const count = options?.count;
        const locale = options?.locale;
        if (locale === 'fr') {
          return count === 1 ? '1 dossier' : `${count} dossiers`;
        }
        return count === 1 ? '1 record' : `${count} records`;
      }
      return key;
    },
  }),
}));

import { useAuth } from '../hooks/useFreighter';
import { useVaccination } from '../hooks/useVaccination';
import { useConsent } from '../hooks/useConsent';

const WALLET = 'G12345678901234567890123456789012345678901234567890123456';

describe('PatientDashboard', () => {
  const mockConnect = jest.fn();
  const mockDisconnect = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    useConsent.mockReturnValue({ consented: null, giveConsent: jest.fn(), loading: false });
    useVaccination.mockReturnValue({ records: [], loading: false, error: null, refetch: jest.fn() });
  });

  describe('when not connected', () => {
    beforeEach(() => {
      useAuth.mockReturnValue({ publicKey: null, connect: mockConnect, disconnect: mockDisconnect });
    });

    it('shows connect wallet prompt', () => {
      render(<PatientDashboard />);
      expect(screen.getByText(/Connect your wallet to view records/i)).toBeInTheDocument();
    });

    it('calls connect when button is clicked', () => {
      render(<PatientDashboard />);
      screen.getByRole('button', { name: /Connect Freighter wallet/i }).click();
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('when connected', () => {
    beforeEach(() => {
      useAuth.mockReturnValue({ publicKey: WALLET, connect: mockConnect, disconnect: mockDisconnect });
    });

    it('shows title', () => {
      render(<PatientDashboard />);
      expect(screen.getByText(/My Vaccination Records/i)).toBeInTheDocument();
    });

    it('shows wallet address', () => {
      render(<PatientDashboard />);
      expect(screen.getByText(/Wallet:/i)).toBeInTheDocument();
    });

    it('shows loading skeleton when loading', () => {
      useVaccination.mockReturnValue({ records: [], loading: true, error: null, refetch: jest.fn() });
      render(<PatientDashboard />);
      const styleTag = document.querySelector('style');
      expect(styleTag).not.toBeNull();
      expect(styleTag.textContent).toMatch(/vacciPulse/);
    });

    it('shows empty state when no records', () => {
      render(<PatientDashboard />);
      expect(screen.getByText(/No vaccination records have been issued yet/i)).toBeInTheDocument();
    });

    it('does not show empty state while loading', () => {
      useVaccination.mockReturnValue({ records: [], loading: true, error: null, refetch: jest.fn() });
      render(<PatientDashboard />);
      expect(screen.queryByText(/No vaccination records have been issued yet/i)).not.toBeInTheDocument();
    });

    it('shows plural record count when multiple records exist', () => {
      const records = [
        { token_id: '1', vaccine_name: 'COVID-19', date_administered: '2024-01-15', issuer: 'G123' },
        { token_id: '2', vaccine_name: 'Flu', date_administered: '2023-10-01', issuer: 'G456' },
      ];
      useVaccination.mockReturnValue({ records, loading: false, error: null, refetch: jest.fn() });
      render(<PatientDashboard />);
      expect(screen.getByText(/2 records/i)).toBeInTheDocument();
    });

    it('shows singular record count when exactly one record exists', () => {
      const records = [
        { token_id: '1', vaccine_name: 'COVID-19', date_administered: '2024-01-15', issuer: 'G123' },
      ];
      useVaccination.mockReturnValue({ records, loading: false, error: null, refetch: jest.fn() });
      render(<PatientDashboard />);
      expect(screen.getByText(/^1 record$/i)).toBeInTheDocument();
      expect(screen.queryByText(/1 records/i)).not.toBeInTheDocument();
    });

    it('uses the active locale for record count formatting', () => {
      const records = [
        { token_id: '1', vaccine_name: 'COVID-19', date_administered: '2024-01-15', issuer: 'G123' },
        { token_id: '2', vaccine_name: 'Flu', date_administered: '2023-10-01', issuer: 'G456' },
      ];
      useVaccination.mockReturnValue({ records, loading: false, error: null, refetch: jest.fn() });
      render(<PatientDashboard />);
      const countText = screen.getByText(/records/i).textContent;
      expect(countText).toMatch(/2 records/);
    });

    it('shows error message and retry button on error', () => {
      useVaccination.mockReturnValue({ records: [], loading: false, error: 'Network error', refetch: jest.fn() });
      render(<PatientDashboard />);
      expect(screen.getByText(/Network error/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
    });
  });
});
