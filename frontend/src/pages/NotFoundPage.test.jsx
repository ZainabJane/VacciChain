import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import NotFoundPage from './NotFoundPage';

describe('NotFoundPage', () => {
  it('renders an accessible 404 page with a link to the landing page', () => {
    render(
      <MemoryRouter initialEntries={['/unknown-path']}>
        <Routes>
          <Route path="/" element={<NotFoundPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      screen.getByRole('heading', { name: /404 — Page not found/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/doesn't exist/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /go to landing page/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/');
  });
});
