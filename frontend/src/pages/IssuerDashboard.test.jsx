import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import IssuerDashboard from './IssuerDashboard';

// Mock the hooks
jest.mock('../hooks/useFreighter', () => ({
  useAuth: jest.fn()
}));

jest.mock('../hooks/useVaccination', () => ({
  useVaccination: jest.fn()
}));

import { useAuth } from '../hooks/useFreighter';
import { useVaccination } from '../hooks/useVaccination';

describe('IssuerDashboard', () => {
  const mockConnect = jest.fn();
  const mockIssueVaccination = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
  });

  describe('when not connected', () => {
    beforeEach(() => {
      useAuth.mockReturnValue({ publicKey: null, role: null, connect: mockConnect });
      useVaccination.mockReturnValue({ issueVaccination: mockIssueVaccination, checkIssuerStatus: jest.fn().mockResolvedValue(true), loading: false });
    });

    it('should show connect wallet prompt', () => {
      render(<IssuerDashboard />);

      expect(screen.getByText('Connect your issuer wallet.')).toBeInTheDocument();
    });

    it('should show connect wallet button', () => {
      render(<IssuerDashboard />);

      expect(screen.getByRole('button', { name: /Connect issuer wallet/i })).toBeInTheDocument();
    });

    it('should call connect when button is clicked', async () => {
      render(<IssuerDashboard />);

      const button = screen.getByRole('button', { name: /Connect issuer wallet/i });
      await userEvent.click(button);

      expect(mockConnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('when connected but not issuer', () => {
    beforeEach(() => {
      useAuth.mockReturnValue({ publicKey: 'G1234567890', role: 'user', connect: mockConnect });
      useVaccination.mockReturnValue({ issueVaccination: mockIssueVaccination, checkIssuerStatus: jest.fn().mockResolvedValue(true), loading: false });
    });

    it('should show access denied message', () => {
      render(<IssuerDashboard />);

      expect(screen.getByText('Access denied: issuer role required.')).toBeInTheDocument();
    });
  });

  describe('when connected as issuer', () => {
    beforeEach(() => {
      useAuth.mockReturnValue({ publicKey: 'G1234567890', role: 'issuer', connect: mockConnect });
      useVaccination.mockReturnValue({ issueVaccination: mockIssueVaccination, checkIssuerStatus: jest.fn().mockResolvedValue(true), loading: false });
    });

    it('should render form fields', () => {
      render(<IssuerDashboard />);

      expect(screen.getByLabelText('Patient Stellar Address')).toBeInTheDocument();
      expect(screen.getByLabelText('Vaccine Name')).toBeInTheDocument();
      expect(screen.getByLabelText('Date Administered')).toBeInTheDocument();
    });

    it('should show submit button', () => {
      render(<IssuerDashboard />);

      expect(screen.getByRole('button', { name: /Issue Vaccination NFT/i })).toBeInTheDocument();
    });

    it('should show error for invalid Stellar address', async () => {
      render(<IssuerDashboard />);

      const addressInput = screen.getByLabelText('Patient Stellar Address');
      
      // Use fireEvent instead of userEvent.type to avoid act() warnings
      fireEvent.change(addressInput, { target: { value: 'invalid-address' } });
      fireEvent.blur(addressInput);

      expect(await screen.findByText('Must be a valid Stellar public key (G…, 56 chars)')).toBeInTheDocument();
    });

    it('should show error for empty vaccine name', async () => {
      render(<IssuerDashboard />);

      const vaccineInput = screen.getByLabelText('Vaccine Name');
      fireEvent.change(vaccineInput, { target: { value: 'COVID-19' } });
      fireEvent.change(vaccineInput, { target: { value: '' } });
      fireEvent.blur(vaccineInput);

      expect(await screen.findByText('Vaccine name is required')).toBeInTheDocument();
    });

    it('should show error for future date', async () => {
      render(<IssuerDashboard />);

      const dateInput = screen.getByLabelText('Date Administered');
      fireEvent.change(dateInput, { target: { value: '2099-01-01' } });
      fireEvent.blur(dateInput);

      expect(await screen.findByText('Date cannot be in the future')).toBeInTheDocument();
    });

    it('should disable submit button when loading', () => {
      useVaccination.mockReturnValue({ issueVaccination: mockIssueVaccination, checkIssuerStatus: jest.fn().mockResolvedValue(true), loading: true });

      render(<IssuerDashboard />);

      const submitButton = screen.getByRole('button', { name: /Minting…/i });
      expect(submitButton).toBeDisabled();
    });

    it('should show loading text when loading', () => {
      useVaccination.mockReturnValue({ issueVaccination: mockIssueVaccination, checkIssuerStatus: jest.fn().mockResolvedValue(true), loading: true });

      render(<IssuerDashboard />);

      expect(screen.getByText('Minting…')).toBeInTheDocument();
    });

    it('validates and submits dose metadata', async () => {
      mockIssueVaccination.mockResolvedValue(null);
      render(<IssuerDashboard />);
      const number = await screen.findByLabelText('Dose Number (optional)');
      fireEvent.change(number, { target: { value: '3' } });
      fireEvent.change(screen.getByLabelText('Doses in Series (optional)'), { target: { value: '2' } });
      expect(number).toHaveAttribute('aria-invalid', 'true');
      fireEvent.submit(screen.getByRole('form'));
      expect(mockIssueVaccination).not.toHaveBeenCalled();
      fireEvent.change(number, { target: { value: '1' } });
      fireEvent.submit(screen.getByRole('form'));
      await waitFor(() => expect(mockIssueVaccination).toHaveBeenCalledWith(
        expect.objectContaining({ dose_number: 1, dose_series: 2 })
      ));
    });

    const fillValidForm = () => {
      fireEvent.change(screen.getByLabelText('Patient Stellar Address'), {
        target: { value: 'G12345678901234567890123456789012345678901234567890123456' }
      });
      fireEvent.change(screen.getByLabelText('Vaccine Name'), { target: { value: 'COVID-19' } });
      fireEvent.change(screen.getByLabelText('Date Administered'), { target: { value: '2024-01-15' } });
    };

    const openDialogAndConfirm = async () => {
      fireEvent.click(screen.getByRole('button', { name: /Issue Vaccination NFT/i }));
      const confirmButton = await screen.findByRole('button', { name: /^Confirm/i });
      fireEvent.click(confirmButton);
    };

    it('should call issueVaccination on form submission', async () => {
      mockIssueVaccination.mockResolvedValue(true);

      render(<IssuerDashboard />);

      fillValidForm();
      await openDialogAndConfirm();

      await waitFor(() => {
        expect(mockIssueVaccination).toHaveBeenCalledWith({
          patient_address: 'G12345678901234567890123456789012345678901234567890123456',
          vaccine_name: 'COVID-19',
          date_administered: '2024-01-15'
        });
      });
    });

    it('should open the confirmation dialog with normalized values on submit', async () => {
      render(<IssuerDashboard />);

      fireEvent.change(screen.getByLabelText('Patient Stellar Address'), {
        target: { value: '  G12345678901234567890123456789012345678901234567890123456  ' }
      });
      fireEvent.change(screen.getByLabelText('Vaccine Name'), { target: { value: '  COVID-19  ' } });
      fireEvent.change(screen.getByLabelText('Date Administered'), { target: { value: '2024-01-15' } });

      fireEvent.click(screen.getByRole('button', { name: /Issue Vaccination NFT/i }));

      const dialog = await screen.findByRole('dialog');
      expect(dialog).toBeInTheDocument();
      expect(dialog).toHaveTextContent('G12345678901234567890123456789012345678901234567890123456');
      expect(dialog).toHaveTextContent('COVID-19');
      expect(dialog).toHaveTextContent('2024-01-15');
      expect(mockIssueVaccination).not.toHaveBeenCalled();
    });

    it('should call issueVaccination exactly once when the dialog is confirmed', async () => {
      mockIssueVaccination.mockResolvedValue(true);

      render(<IssuerDashboard />);

      fillValidForm();
      await openDialogAndConfirm();

      await waitFor(() => {
        expect(mockIssueVaccination).toHaveBeenCalledTimes(1);
      });
    });

    it('should close the dialog without submitting when cancelled', async () => {
      render(<IssuerDashboard />);

      fillValidForm();
      fireEvent.click(screen.getByRole('button', { name: /Issue Vaccination NFT/i }));

      const cancelButton = await screen.findByRole('button', { name: /^Cancel/i });
      fireEvent.click(cancelButton);

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      expect(mockIssueVaccination).not.toHaveBeenCalled();
    });

    it('should only submit once for repeated clicks on the confirm button', async () => {
      let resolveIssue;
      mockIssueVaccination.mockImplementation(
        () => new Promise((resolve) => { resolveIssue = resolve; })
      );

      render(<IssuerDashboard />);

      fillValidForm();
      fireEvent.click(screen.getByRole('button', { name: /Issue Vaccination NFT/i }));

      const confirmButton = await screen.findByRole('button', { name: /^Confirm/i });
      fireEvent.click(confirmButton);
      fireEvent.click(confirmButton);
      fireEvent.click(confirmButton);

      expect(mockIssueVaccination).toHaveBeenCalledTimes(1);

      resolveIssue(true);
      await waitFor(() => {
        expect(mockIssueVaccination).toHaveBeenCalledTimes(1);
      });
    });

    it('should only submit once for repeated Enter key presses', async () => {
      let resolveIssue;
      mockIssueVaccination.mockImplementation(
        () => new Promise((resolve) => { resolveIssue = resolve; })
      );

      render(<IssuerDashboard />);

      fillValidForm();
      fireEvent.click(screen.getByRole('button', { name: /Issue Vaccination NFT/i }));

      const confirmButton = await screen.findByRole('button', { name: /^Confirm/i });
      fireEvent.keyDown(confirmButton, { key: 'Enter', code: 'Enter' });
      fireEvent.keyDown(confirmButton, { key: 'Enter', code: 'Enter' });
      fireEvent.click(confirmButton);

      expect(mockIssueVaccination).toHaveBeenCalledTimes(1);

      resolveIssue(true);
      await waitFor(() => {
        expect(mockIssueVaccination).toHaveBeenCalledTimes(1);
      });
    });

    it('should re-enable submit and report an error after a recoverable failure', async () => {
      mockIssueVaccination.mockRejectedValue(new Error('Network error'));

      render(<IssuerDashboard />);

      fillValidForm();
      await openDialogAndConfirm();

      expect(await screen.findByRole('alert')).toHaveTextContent(/Network error/i);

      const submitButton = screen.getByRole('button', { name: /Issue Vaccination NFT/i });
      await waitFor(() => {
        expect(submitButton).toBeEnabled();
      });

      mockIssueVaccination.mockResolvedValue(true);
      await openDialogAndConfirm();

      await waitFor(() => {
        expect(mockIssueVaccination).toHaveBeenCalledTimes(2);
      });
    });

    it('should associate validation errors with their fields via aria-describedby', async () => {
      render(<IssuerDashboard />);

      const addressInput = screen.getByLabelText('Patient Stellar Address');
      fireEvent.change(addressInput, { target: { value: 'invalid-address' } });
      fireEvent.blur(addressInput);

      const error = await screen.findByText('Must be a valid Stellar public key (G…, 56 chars)');
      expect(error).toHaveAttribute('id');
      expect(addressInput).toHaveAttribute('aria-describedby', error.id);
      expect(addressInput).toHaveAttribute('aria-invalid', 'true');
    });

    it('should mark required fields programmatically', () => {
      render(<IssuerDashboard />);

      expect(screen.getByLabelText('Patient Stellar Address')).toBeRequired();
      expect(screen.getByLabelText('Vaccine Name')).toBeRequired();
      expect(screen.getByLabelText('Date Administered')).toBeRequired();
    });
  });
});