import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import VerifyPage from './VerifyPage';

const VALID_WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const OTHER_WALLET = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const MALFORMED_WALLET = 'not-a-valid-wallet';

function renderAt(initialPath) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/verify" element={<VerifyPage />} />
      </Routes>
    </MemoryRouter>
  );
}

function HistoryControls() {
  const navigate = useNavigate();
  return (
    <div>
      <button type="button" onClick={() => navigate(-1)}>
        go-back
      </button>
      <button type="button" onClick={() => navigate(1)}>
        go-forward
      </button>
    </div>
  );
}

function renderWithHistory(initialPath) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <HistoryControls />
      <Routes>
        <Route path="/verify" element={<VerifyPage />} />
      </Routes>
    </MemoryRouter>
  );
}

function mockFetchSuccess(payload) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => payload,
  });
}

function mockFetchEmpty() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ records: [] }),
  });
}

function getInput() {
  return screen.getByRole('textbox');
}

function getSubmitButton() {
  return screen.getByRole('button', { name: /verify/i });
}

describe('VerifyPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('submits exactly one request for a valid address', async () => {
    const fetchMock = mockFetchSuccess({ records: [{ id: '1' }] });
    global.fetch = fetchMock;

    renderAt('/verify');

    fireEvent.change(getInput(), { target: { value: VALID_WALLET } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock.mock.calls[0][0]).toContain(VALID_WALLET);
  });

  it('shows an inline accessible error and makes no request for empty input', async () => {
    const fetchMock = mockFetchSuccess({ records: [] });
    global.fetch = fetchMock;

    renderAt('/verify');

    fireEvent.click(getSubmitButton());

    const error = await screen.findByRole('alert');
    expect(error).toBeInTheDocument();
    expect(error.textContent).toMatch(/valid|required|address/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('trims a whitespace-padded valid address and accepts it', async () => {
    const fetchMock = mockFetchSuccess({ records: [{ id: '1' }] });
    global.fetch = fetchMock;

    renderAt('/verify');

    fireEvent.change(getInput(), { target: { value: `   ${VALID_WALLET}   ` } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock.mock.calls[0][0]).toContain(VALID_WALLET);
    expect(fetchMock.mock.calls[0][0]).not.toContain('%20%20%20');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows an inline accessible error and makes no request for a malformed address', async () => {
    const fetchMock = mockFetchSuccess({ records: [] });
    global.fetch = fetchMock;

    renderAt('/verify');

    fireEvent.change(getInput(), { target: { value: MALFORMED_WALLET } });
    fireEvent.click(getSubmitButton());

    const error = await screen.findByRole('alert');
    expect(error).toBeInTheDocument();
    expect(error.textContent).toMatch(/valid|address/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('populates the field and triggers exactly one request for a valid deep link', async () => {
    const fetchMock = mockFetchSuccess({ records: [{ id: '1' }] });
    global.fetch = fetchMock;

    renderAt(`/verify?wallet=${VALID_WALLET}`);

    await waitFor(() => {
      expect(getInput()).toHaveValue(VALID_WALLET);
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock.mock.calls[0][0]).toContain(VALID_WALLET);
  });

  it('does not display a result for a different wallet after back/forward navigation', async () => {
    const fetchMock = vi.fn().mockImplementation((url) => {
      if (String(url).includes(OTHER_WALLET)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ records: [{ id: 'other-result' }] }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ records: [{ id: 'valid-result' }] }),
      });
    });
    global.fetch = fetchMock;

    renderWithHistory(`/verify?wallet=${VALID_WALLET}`);

    await waitFor(() => {
      expect(getInput()).toHaveValue(VALID_WALLET);
    });

    // Navigate to a different wallet via the input.
    fireEvent.change(getInput(), { target: { value: OTHER_WALLET } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => {
      expect(getInput()).toHaveValue(OTHER_WALLET);
    });

    // Go back in history; the displayed result must match the wallet in the field.
    fireEvent.click(screen.getByRole('button', { name: 'go-back' }));

    await waitFor(() => {
      const fieldValue = getInput().value;
      if (fieldValue === VALID_WALLET) {
        expect(screen.queryByText(/other-result/)).not.toBeInTheDocument();
      }
    });

    // Go forward again; still no stale result for a mismatched wallet.
    fireEvent.click(screen.getByRole('button', { name: 'go-forward' }));

    await waitFor(() => {
      const fieldValue = getInput().value;
      if (fieldValue === OTHER_WALLET) {
        expect(screen.queryByText(/valid-result/)).not.toBeInTheDocument();
      }
    });
  });
});