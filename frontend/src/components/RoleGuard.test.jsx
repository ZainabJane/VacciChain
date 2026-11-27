import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import RoleGuard from './RoleGuard';

vi.mock('../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

import { useAuth } from '../context/AuthContext';

const renderGuard = (props = {}) =>
  render(
    <RoleGuard allowedRoles={['issuer', 'admin']} {...props}>
      <div data-testid="protected-content">Protected Content</div>
    </RoleGuard>
  );

describe('RoleGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a loading indicator while the role is loading', () => {
    useAuth.mockReturnValue({
      isAuthenticated: false,
      isLoading: true,
      role: null,
    });

    renderGuard();

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
  });

  it('shows a sign-in prompt when the user is disconnected', () => {
    useAuth.mockReturnValue({
      isAuthenticated: false,
      isLoading: false,
      role: null,
    });

    renderGuard();

    expect(
      screen.getByText(/sign in/i)
    ).toBeInTheDocument();
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
  });

  it('shows an accessible denial message for a patient hitting an issuer/admin route', () => {
    useAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      role: 'patient',
    });

    renderGuard();

    const denial = screen.getByRole('alert');
    expect(denial).toBeInTheDocument();
    expect(denial).toHaveTextContent(/access denied/i);
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
  });

  it('renders children for an authorized issuer', () => {
    useAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      role: 'issuer',
    });

    renderGuard();

    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders children for an authorized admin', () => {
    useAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      role: 'admin',
    });

    renderGuard();

    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});