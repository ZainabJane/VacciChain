import { render, screen, act, fireEvent } from '@testing-library/react';
import AnalyticsDashboard from './AnalyticsDashboard';

jest.mock('../hooks/useFreighter', () => ({
  useAuth: jest.fn(),
}));

import { useAuth } from '../hooks/useFreighter';

const mockRates = { rates: [{ vaccine_name: 'COVID-19', count: 120 }, { vaccine_name: 'Flu', count: 80 }] };
const mockIssuers = { issuers: [{ address: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ', count: 50, last_active: '2024-01-15T10:00:00Z' }] };
const mockAnomalies = { anomalies: [] };

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn().mockImplementation((url) => {
    if (url.includes('/analytics/rates')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(mockRates) });
    if (url.includes('/analytics/issuers')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(mockIssuers) });
    if (url.includes('/analytics/anomalies')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(mockAnomalies) });
    return Promise.reject(new Error('Unknown URL'));
  });
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('AnalyticsDashboard', () => {
  it('shows access-restricted message for non-issuers', () => {
    useAuth.mockReturnValue({ role: 'patient', apiFetch: jest.fn() });
    render(<AnalyticsDashboard />);
    expect(screen.getByText(/Access restricted to authorized issuers/i)).toBeInTheDocument();
  });

  it('renders dashboard heading for issuers', async () => {
    useAuth.mockReturnValue({ role: 'issuer', apiFetch: global.fetch });
    await act(async () => { render(<AnalyticsDashboard />); });
    expect(screen.getByText(/Analytics Dashboard/i)).toBeInTheDocument();
  });

  it('renders vaccination rates section', async () => {
    useAuth.mockReturnValue({ role: 'issuer', apiFetch: global.fetch });
    await act(async () => { render(<AnalyticsDashboard />); });
    expect(screen.getByText(/Vaccination Rates by Vaccine Type/i)).toBeInTheDocument();
  });

  it('renders issuer activity section', async () => {
    useAuth.mockReturnValue({ role: 'issuer', apiFetch: global.fetch });
    await act(async () => { render(<AnalyticsDashboard />); });
    expect(screen.getByText(/Issuer Activity/i)).toBeInTheDocument();
  });

  it('renders anomaly flags section', async () => {
    useAuth.mockReturnValue({ role: 'issuer', apiFetch: global.fetch });
    await act(async () => { render(<AnalyticsDashboard />); });
    expect(screen.getByText(/Anomaly Flags/i)).toBeInTheDocument();
  });

  it('shows no anomalies message when list is empty', async () => {
    useAuth.mockReturnValue({ role: 'issuer', apiFetch: global.fetch });
    await act(async () => { render(<AnalyticsDashboard />); });
    expect(screen.getByText(/No anomalies detected/i)).toBeInTheDocument();
  });

  it('shows vaccine names in bar chart', async () => {
    useAuth.mockReturnValue({ role: 'issuer', apiFetch: global.fetch });
    await act(async () => { render(<AnalyticsDashboard />); });
    expect(screen.getByText('COVID-19')).toBeInTheDocument();
    expect(screen.getByText('Flu')).toBeInTheDocument();
  });

  it('shows error message when fetch fails', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));
    useAuth.mockReturnValue({ role: 'issuer', apiFetch: global.fetch });
    await act(async () => { render(<AnalyticsDashboard />); });
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('shows loading state while requests are pending', async () => {
    global.fetch = jest.fn().mockImplementation(() => new Promise(() => {}));
    useAuth.mockReturnValue({ role: 'issuer', apiFetch: jest.fn() });
    render(<AnalyticsDashboard />);
    expect(screen.getByText(/Loading analytics/i)).toBeInTheDocument();
  });

  it('shows empty state when rates are empty', async () => {
    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('/analytics/rates')) return Promise.resolve({ json: () => Promise.resolve({ rates: [] }) });
      if (url.includes('/analytics/issuers')) return Promise.resolve({ json: () => Promise.resolve({ issuers: [] }) });
      if (url.includes('/analytics/anomalies')) return Promise.resolve({ json: () => Promise.resolve({ anomalies: [] }) });
      return Promise.reject(new Error('Unknown URL'));
    });
    useAuth.mockReturnValue({ role: 'issuer', apiFetch: jest.fn() });
    await act(async () => { render(<AnalyticsDashboard />); });
    expect(screen.getByText(/No vaccination data available/i)).toBeInTheDocument();
    expect(screen.getByText(/No issuer activity available/i)).toBeInTheDocument();
  });

  it('shows partial state when only some requests fail', async () => {
    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('/analytics/rates')) return Promise.resolve({ json: () => Promise.resolve(mockRates) });
      if (url.includes('/analytics/issuers')) return Promise.reject(new Error('Network error'));
      if (url.includes('/analytics/anomalies')) return Promise.resolve({ json: () => Promise.resolve(mockAnomalies) });
      return Promise.reject(new Error('Unknown URL'));
    });
    useAuth.mockReturnValue({ role: 'issuer', apiFetch: jest.fn() });
    await act(async () => { render(<AnalyticsDashboard />); });
    expect(screen.getByText(/Some analytics data could not be loaded/i)).toBeInTheDocument();
    expect(screen.getByText('COVID-19')).toBeInTheDocument();
  });

  it('retries failed requests and preserves form state', async () => {
    let failIssuers = true;
    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('/analytics/rates')) return Promise.resolve({ json: () => Promise.resolve(mockRates) });
      if (url.includes('/analytics/issuers')) {
        if (failIssuers) return Promise.reject(new Error('Network error'));
        return Promise.resolve({ json: () => Promise.resolve(mockIssuers) });
      }
      if (url.includes('/analytics/anomalies')) return Promise.resolve({ json: () => Promise.resolve(mockAnomalies) });
      return Promise.reject(new Error('Unknown URL'));
    });
    useAuth.mockReturnValue({ role: 'issuer', apiFetch: jest.fn() });
    await act(async () => { render(<AnalyticsDashboard />); });
    expect(screen.getByText(/Some analytics data could not be loaded/i)).toBeInTheDocument();

    const input = screen.getByLabelText(/Filter by vaccine/i);
    await act(async () => { fireEvent.change(input, { target: { value: 'Flu' } }); });
    expect(input.value).toBe('Flu');

    failIssuers = false;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Retry/i })); });

    expect(screen.queryByText(/Some analytics data could not be loaded/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by vaccine/i).value).toBe('Flu');
  });

  it('auto-refreshes after 60 seconds', async () => {
    useAuth.mockReturnValue({ role: 'issuer', apiFetch: global.fetch });
    await act(async () => { render(<AnalyticsDashboard />); });
    const callsBefore = global.fetch.mock.calls.length;
    await act(async () => { jest.advanceTimersByTime(60_000); });
    expect(global.fetch.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('shows anomaly severity badge when anomalies exist', async () => {
    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('/analytics/rates')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(mockRates) });
      if (url.includes('/analytics/issuers')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(mockIssuers) });
      if (url.includes('/analytics/anomalies')) return Promise.resolve({
        ok: true, status: 200, json: () => Promise.resolve({ anomalies: [{ issuer: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ', count: 200, severity: 'high', reason: 'Spike detected' }] }),
      });
      return Promise.reject(new Error('Unknown URL'));
    });
    useAuth.mockReturnValue({ role: 'issuer', apiFetch: global.fetch });
    await act(async () => { render(<AnalyticsDashboard />); });
    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.getByText('Spike detected')).toBeInTheDocument();
  });

  it('uses same-origin URLs and renders the service response shape', async () => {
    const bodies = {
      '/analytics/rates': { rates: { MMR: 4 } },
      '/analytics/issuers': { issuers: [{ issuer: 'GISSUER1234567890', total_issued: 60, last_ledger: 9 }] },
      '/analytics/anomalies': { flagged_issuers: [{ issuer: 'GISSUER1234567890', total_issued: 60 }] },
    };
    const apiFetch = jest.fn(async (url) => ({ ok: true, status: 200, json: async () => bodies[url] }));
    useAuth.mockReturnValue({ role: 'issuer', apiFetch });
    await act(async () => { render(<AnalyticsDashboard />); });
    expect(apiFetch.mock.calls.map(([url]) => url)).toEqual(Object.keys(bodies));
    expect(screen.getByText('MMR')).toBeInTheDocument();
    expect(screen.getByText('Ledger 9')).toBeInTheDocument();
  });

  it.each([[403, /not authorized/], [502, /unavailable/]])('explains a %i response', async (status, message) => {
    useAuth.mockReturnValue({ role: 'issuer', apiFetch: jest.fn().mockResolvedValue({ ok: false, status }) });
    await act(async () => { render(<AnalyticsDashboard />); });
    expect(screen.getByRole('alert')).toHaveTextContent(message);
  });
});
