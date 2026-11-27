import { render, screen, fireEvent } from '@testing-library/react';
import DarkModeToggle from './DarkModeToggle';

describe('DarkModeToggle', () => {
  const originalLocalStorage = window.localStorage;

  afterEach(() => {
    Object.defineProperty(window, 'localStorage', {
      value: originalLocalStorage,
      configurable: true,
      writable: true,
    });
    jest.restoreAllMocks();
  });

  const makeLocalStorageThrow = () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('localStorage is unavailable');
      },
    });
  };

  it('renders toggle button', () => {
    render(<DarkModeToggle dark={false} onToggle={() => {}} />);
    const button = screen.getByRole('button');
    expect(button).toBeInTheDocument();
  });

  it('shows moon emoji when in light mode', () => {
    render(<DarkModeToggle dark={false} onToggle={() => {}} />);
    expect(screen.getByRole('button')).toHaveTextContent('🌙');
  });

  it('shows sun emoji when in dark mode', () => {
    render(<DarkModeToggle dark={true} onToggle={() => {}} />);
    expect(screen.getByRole('button')).toHaveTextContent('☀️');
  });

  it('calls onToggle when clicked', () => {
    const handleToggle = jest.fn();
    render(<DarkModeToggle dark={false} onToggle={handleToggle} />);
    fireEvent.click(screen.getByRole('button'));
    expect(handleToggle).toHaveBeenCalledTimes(1);
  });

  it('has correct aria-label for light mode', () => {
    render(<DarkModeToggle dark={false} onToggle={() => {}} />);
    // In light mode (dark=false), button says "Switch to dark mode"
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Switch to dark mode');
  });

  it('has correct aria-label for dark mode', () => {
    render(<DarkModeToggle dark={true} onToggle={() => {}} />);
    // In dark mode (dark=true), button says "Switch to light mode"
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Switch to light mode');
  });

  it('exposes an accessible name via aria-label', () => {
    render(<DarkModeToggle dark={false} onToggle={() => {}} />);
    expect(screen.getByRole('button', { name: 'Switch to dark mode' })).toBeInTheDocument();
  });

  it('updates aria-label and emoji when theme changes', () => {
    const { rerender } = render(<DarkModeToggle dark={false} onToggle={() => {}} />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Switch to dark mode');
    expect(screen.getByRole('button')).toHaveTextContent('🌙');

    rerender(<DarkModeToggle dark={true} onToggle={() => {}} />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Switch to light mode');
    expect(screen.getByRole('button')).toHaveTextContent('☀️');
  });

  it('remains usable and calls onToggle when localStorage is unavailable', () => {
    makeLocalStorageThrow();
    const handleToggle = jest.fn();

    expect(() =>
      render(<DarkModeToggle dark={false} onToggle={handleToggle} />)
    ).not.toThrow();

    const button = screen.getByRole('button');
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-label', 'Switch to dark mode');

    fireEvent.click(button);
    expect(handleToggle).toHaveBeenCalledTimes(1);
  });

  it('renders in dark mode without throwing when localStorage is unavailable', () => {
    makeLocalStorageThrow();

    expect(() =>
      render(<DarkModeToggle dark={true} onToggle={() => {}} />)
    ).not.toThrow();

    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Switch to light mode');
  });
});