import { render, screen, fireEvent } from '@testing-library/react';
import FreighterBanner from './FreighterBanner';

// Mock useAuth hook
jest.mock('../hooks/useFreighter', () => ({
  useAuth: jest.fn(),
}));

import { useAuth } from '../hooks/useFreighter';

describe('FreighterBanner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders nothing when freighter is installed', () => {
    useAuth.mockReturnValue({ freighterInstalled: true });
    const { container } = render(<FreighterBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders banner when freighter is not installed', () => {
    useAuth.mockReturnValue({ freighterInstalled: false });
    render(<FreighterBanner />);
    expect(screen.getByText(/Freighter wallet not detected/i)).toBeInTheDocument();
  });

  it('renders install link', () => {
    useAuth.mockReturnValue({ freighterInstalled: false });
    render(<FreighterBanner />);
    const link = screen.getByRole('link', { name: /Install Freighter/i });
    expect(link).toHaveAttribute('href', 'https://www.freighter.app/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('renders dismiss button', () => {
    useAuth.mockReturnValue({ freighterInstalled: false });
    render(<FreighterBanner />);
    expect(screen.getByRole('button', { name: /Dismiss/i })).toBeInTheDocument();
  });

  it('hides banner after dismiss', () => {
    useAuth.mockReturnValue({ freighterInstalled: false });
    const { rerender } = render(<FreighterBanner />);
    expect(screen.getByText(/Freighter wallet not detected/i)).toBeInTheDocument();
    
    // Dismiss the banner - component uses internal state
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/i }));
    
    // After dismiss, the component's internal state changes and banner is hidden
    expect(screen.queryByText(/Freighter wallet not detected/i)).not.toBeInTheDocument();
  });

  it('has correct styling', () => {
    useAuth.mockReturnValue({ freighterInstalled: false });
    render(<FreighterBanner />);
    const banner = screen.getByText(/Freighter wallet not detected/i).closest('div');
    expect(banner).toHaveStyle({ background: '#7c3aed', color: '#fff' });
  });

  it('shows banner again after wallet disconnect', () => {
    useAuth.mockReturnValue({ freighterInstalled: true });
    const { rerender } = render(<FreighterBanner />);
    expect(screen.queryByText(/Freighter wallet not detected/i)).not.toBeInTheDocument();

    // Wallet disconnects / extension becomes unavailable
    useAuth.mockReturnValue({ freighterInstalled: false });
    rerender(<FreighterBanner />);
    expect(screen.getByText(/Freighter wallet not detected/i)).toBeInTheDocument();
  });

  it('hides banner after wallet reconnect', () => {
    useAuth.mockReturnValue({ freighterInstalled: false });
    const { rerender } = render(<FreighterBanner />);
    expect(screen.getByText(/Freighter wallet not detected/i)).toBeInTheDocument();

    useAuth.mockReturnValue({ freighterInstalled: true });
    rerender(<FreighterBanner />);
    expect(screen.queryByText(/Freighter wallet not detected/i)).not.toBeInTheDocument();
  });

  it('reflects current wallet state after account change', () => {
    useAuth.mockReturnValue({ freighterInstalled: false, publicKey: 'GABC123' });
    const { rerender } = render(<FreighterBanner />);
    expect(screen.getByText(/Freighter wallet not detected/i)).toBeInTheDocument();

    // Account changes while wallet remains unavailable
    useAuth.mockReturnValue({ freighterInstalled: false, publicKey: 'GDEF456' });
    rerender(<FreighterBanner />);
    expect(screen.getByText(/Freighter wallet not detected/i)).toBeInTheDocument();

    // Wallet becomes available for the new account
    useAuth.mockReturnValue({ freighterInstalled: true, publicKey: 'GDEF456' });
    rerender(<FreighterBanner />);
    expect(screen.queryByText(/Freighter wallet not detected/i)).not.toBeInTheDocument();
  });

  it('resets dismissed state when wallet state changes', () => {
    useAuth.mockReturnValue({ freighterInstalled: false });
    const { rerender } = render(<FreighterBanner />);
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/i }));
    expect(screen.queryByText(/Freighter wallet not detected/i)).not.toBeInTheDocument();

    // Wallet disconnects again - banner should reflect the current state
    useAuth.mockReturnValue({ freighterInstalled: false, publicKey: null });
    rerender(<FreighterBanner />);
    expect(screen.getByText(/Freighter wallet not detected/i)).toBeInTheDocument();
  });
});