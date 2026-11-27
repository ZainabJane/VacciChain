import { render, screen, fireEvent } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary';

// Suppress expected console.error/warn noise from error boundary during tests.
beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  console.error.mockRestore();
  console.warn.mockRestore();
});

function Bomb({ message }) {
  throw new Error(message || 'Test explosion');
}

function GoodChild() {
  return <p>All good</p>;
}

describe('ErrorBoundary', () => {
  it('renders children when there is no error', () => {
    render(
      <ErrorBoundary>
        <GoodChild />
      </ErrorBoundary>,
    );
    expect(screen.getByText('All good')).toBeInTheDocument();
  });

  it('renders fallback UI when a child throws', () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument();
  });

  it('fallback has a "Try again" button', () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument();
  });

  it('fallback has a "Return home" link', () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('link', { name: /Return home/i })).toBeInTheDocument();
  });

  it('resets and re-renders children after clicking "Try again"', () => {
    let shouldThrow = true;
    function Conditional() {
      if (shouldThrow) throw new Error('oops');
      return <p>Recovered</p>;
    }

    const { rerender } = render(
      <ErrorBoundary>
        <Conditional />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();

    // Fix the underlying cause then reset the boundary.
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: /Try again/i }));

    rerender(
      <ErrorBoundary>
        <Conditional />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Recovered')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not render raw exception details in the fallback', () => {
    render(
      <ErrorBoundary>
        <Bomb message="at SomeModule (/src/secret/path.js:42:7)" />
      </ErrorBoundary>,
    );
    // The raw stack-frame-looking message must not appear verbatim.
    expect(screen.queryByText(/\/src\/secret\/path\.js/)).not.toBeInTheDocument();
    // A safe generic message should be shown instead.
    expect(screen.getByText(/unexpected error/i)).toBeInTheDocument();
  });

  it('fallback role="alert" is accessible', () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    // aria-live="assertive" is set to ensure AT announces it immediately.
    expect(alert).toHaveAttribute('aria-live', 'assertive');
  });

  it('renders a custom fallback when the fallback prop is supplied', () => {
    const customFallback = ({ message, onReset }) => (
      <div>
        <p data-testid="custom-msg">{message}</p>
        <button onClick={onReset}>Restart</button>
      </div>
    );

    render(
      <ErrorBoundary fallback={customFallback}>
        <Bomb message="Custom boundary test" />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId('custom-msg')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Restart/i })).toBeInTheDocument();
  });
});
