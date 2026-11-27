import { render, screen, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import ErrorBoundary from '../components/ErrorBoundary';

const Boom = () => {
  throw new Error('kaboom');
};

function renderBoundary(ui) {
  return render(<ErrorBoundary>{ui}</ErrorBoundary>);
}

describe('ErrorBoundary (#35)', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders children when no error occurs', () => {
    renderBoundary(<span data-testid="children">hello</span>);
    expect(screen.getByTestId('children')).toBeInTheDocument();
  });

  it('renders an accessible fallback when a child crashes', () => {
    renderBoundary(<Boom />);
    const fallback = screen.getByRole('alert');
    expect(fallback).toBeInTheDocument();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Return home/ })).toBeInTheDocument();
  });

  it('does not render exception details in the fallback', () => {
    renderBoundary(<Boom />);
    const container = screen.getByRole('alert');
    expect(container.textContent).not.toContain('kaboom');
    expect(container.textContent).not.toMatch(/Error/);
    expect(document.body.innerHTML).not.toContain('componentStack');
  });

  it('fallback is accessible', async () => {
    renderBoundary(<Boom />);
    const result = await axe(document.body);
    expect(result).toHaveNoViolations();
  });

  it('retry re-renders the children', () => {
    let flakyCalls = 0;
    const Flaky = () => {
      flakyCalls += 1;
      if (flakyCalls === 1) throw new Error('boom');
      return <span data-testid="flaky">ok</span>;
    };
    renderBoundary(<Flaky />);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('flaky')).toBeInTheDocument();
  });

  it('logs a redacted diagnostic in production', () => {
    const orig = import.meta.env;
    Object.defineProperty(import.meta, 'env', {
      value: { ...orig, PROD: true, DEV: false },
      configurable: true,
    });
    renderBoundary(<Boom />);
    expect(console.error).toHaveBeenCalled();
    const logged = console.error.mock.calls.map(c => JSON.stringify(c)).join(' ');
    expect(logged).not.toContain('kaboom');
    expect(logged).not.toContain('componentStack');
    Object.defineProperty(import.meta, 'env', { value: orig, configurable: true });
  });
});
