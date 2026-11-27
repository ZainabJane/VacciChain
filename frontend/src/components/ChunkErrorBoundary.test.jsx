import { lazy, Suspense } from 'react';
import { render, screen } from '@testing-library/react';
import ChunkErrorBoundary from './ChunkErrorBoundary';
import ErrorBoundary from './ErrorBoundary';

const show = (error) => {
  const Page = lazy(() => Promise.reject(error));
  render(
    <ErrorBoundary>
      <ChunkErrorBoundary><Suspense fallback="loading"><Page /></Suspense></ChunkErrorBoundary>
    </ErrorBoundary>
  );
};

beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

it('offers a reload when a chunk fails to load', async () => {
  show(new TypeError('Failed to fetch dynamically imported module: /assets/a.js'));
  expect(await screen.findByRole('button', { name: 'Reload page' })).toBeInTheDocument();
});

it('passes other errors to the app boundary', async () => {
  show(new Error('boom'));
  expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
});
