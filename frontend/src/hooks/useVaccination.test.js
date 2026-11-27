import { renderHook, act, waitFor } from '@testing-library/react';
import { useVaccination, cache } from './useVaccination';

jest.mock('./useFreighter', () => ({ useAuth: jest.fn() }));
jest.mock('./useToast', () => ({ useToast: jest.fn() }));

import { useAuth } from './useFreighter';
import { useToast } from './useToast';

const WALLET = 'GABCDEF1234567890';
const RECORDS = [{ token_id: '1', vaccine_name: 'COVID-19', date_administered: '2024-01-15', issuer: 'GISSUER' }];

let mockApiFetch;

beforeEach(() => {
  jest.clearAllMocks();
  cache.clear();

  mockApiFetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: RECORDS }),
  });
  useAuth.mockReturnValue({ apiFetch: mockApiFetch });
});

describe('useVaccination', () => {
  it('fetches records on mount when cache is empty', async () => {
    const { result } = renderHook(() => useVaccination(WALLET));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(mockApiFetch).toHaveBeenCalledWith(
      `/v1/vaccination/${WALLET}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(result.current.records).toEqual(RECORDS);
    expect(result.current.error).toBeNull();
  });

  it('returns cached data within 30 seconds without fetching again', async () => {
    // First render — populates cache
    const { result: r1, unmount: u1 } = renderHook(() => useVaccination(WALLET));
    await waitFor(() => expect(r1.current.loading).toBe(false));
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    u1();

    // Second render — should use cache
    const { result: r2 } = renderHook(() => useVaccination(WALLET));
    expect(r2.current.records).toEqual(RECORDS);
    expect(r2.current.loading).toBe(false);
    // No additional fetch
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });

  it('fetches when cache is stale (older than 30 seconds)', async () => {
    // First render — populates cache
    const { result: r1, unmount: u1 } = renderHook(() => useVaccination(WALLET));
    await waitFor(() => expect(r1.current.loading).toBe(false));
    u1();

    // Manually expire the cache by manipulating Date.now
    const realNow = Date.now;
    jest.spyOn(Date, 'now').mockReturnValue(realNow() + 31_000);

    const { result: r2 } = renderHook(() => useVaccination(WALLET));
    await waitFor(() => expect(r2.current.loading).toBe(false));

    expect(mockApiFetch).toHaveBeenCalledTimes(2);

    Date.now.mockRestore();
  });

  it('refetch bypasses cache and fetches fresh data', async () => {
    const { result } = renderHook(() => useVaccination(WALLET));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockApiFetch).toHaveBeenCalledTimes(1);

    await act(async () => { await result.current.refetch(); });

    expect(mockApiFetch).toHaveBeenCalledTimes(2);
  });

  it('aborts in-flight request on unmount', async () => {
    let capturedSignal;
    mockApiFetch.mockImplementation((_url, opts) => {
      capturedSignal = opts.signal;
      return new Promise(() => {}); // never resolves
    });

    const { unmount } = renderHook(() => useVaccination(WALLET));

    // Give the effect time to fire
    await act(async () => {});

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal.aborted).toBe(false);

    unmount();

    expect(capturedSignal.aborted).toBe(true);
  });

  it('sets error state on failed fetch', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Unauthorized' }),
    });

    const { result } = renderHook(() => useVaccination(WALLET));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('Unauthorized');
    expect(result.current.records).toEqual([]);
  });

  it('does not fetch when walletAddress is null', () => {
    renderHook(() => useVaccination(null));
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  describe('diagnostics redaction', () => {
    const SENSITIVE_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.secret-access-token.signature';
    const PATIENT_ID = 'PATIENT-1234567890';
    const VACCINE_DETAILS = 'COVID-19 dose 2 lot ABC123';

    let consoleErrorSpy;
    let consoleWarnSpy;
    let consoleLogSpy;
    let toastMock;

    const collectConsoleOutput = () =>
      [...consoleErrorSpy.mock.calls, ...consoleWarnSpy.mock.calls, ...consoleLogSpy.mock.calls]
        .map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
        .join('\n');

    const expectNoSensitiveLeak = (output) => {
      expect(output).not.toContain(SENSITIVE_TOKEN);
      expect(output).not.toContain(PATIENT_ID);
      expect(output).not.toContain(VACCINE_DETAILS);
    };

    beforeEach(() => {
      toastMock = jest.fn();
      useToast.mockReturnValue(toastMock);
      consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleErrorSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });

    it('redacts sensitive fields from error state on failed fetch', async () => {
      mockApiFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({
          error: `Failed for ${PATIENT_ID} with token ${SENSITIVE_TOKEN} (${VACCINE_DETAILS})`,
          access_token: SENSITIVE_TOKEN,
          patient_id: PATIENT_ID,
          records: RECORDS,
        }),
      });

      const { result } = renderHook(() => useVaccination(WALLET));
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.error).toBeTruthy();
      expect(result.current.error).not.toContain(SENSITIVE_TOKEN);
      expect(result.current.error).not.toContain(PATIENT_ID);
      expect(result.current.error).not.toContain(VACCINE_DETAILS);
      expect(result.current.records).toEqual([]);
    });

    it('does not log raw sensitive payloads on failed fetch', async () => {
      mockApiFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({
          error: `Failed for ${PATIENT_ID} with token ${SENSITIVE_TOKEN}`,
          access_token: SENSITIVE_TOKEN,
          patient_id: PATIENT_ID,
          records: RECORDS,
        }),
      });

      const { result } = renderHook(() => useVaccination(WALLET));
      await waitFor(() => expect(result.current.loading).toBe(false));

      expectNoSensitiveLeak(collectConsoleOutput());
    });

    it('does not leak sensitive fields through toasts on failed fetch', async () => {
      mockApiFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({
          error: `Failed for ${PATIENT_ID} with token ${SENSITIVE_TOKEN}`,
          access_token: SENSITIVE_TOKEN,
          patient_id: PATIENT_ID,
          records: RECORDS,
        }),
      });

      const { result } = renderHook(() => useVaccination(WALLET));
      await waitFor(() => expect(result.current.loading).toBe(false));

      const toastOutput = toastMock.mock.calls
        .map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
        .join('\n');
      expectNoSensitiveLeak(toastOutput);
    });

    it('redacts sensitive fields when the request throws', async () => {
      mockApiFetch.mockRejectedValue(
        new Error(`Network failure for ${PATIENT_ID} token=${SENSITIVE_TOKEN} ${VACCINE_DETAILS}`)
      );

      const { result } = renderHook(() => useVaccination(WALLET));
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.error).toBeTruthy();
      expect(result.current.error).not.toContain(SENSITIVE_TOKEN);
      expect(result.current.error).not.toContain(PATIENT_ID);
      expect(result.current.error).not.toContain(VACCINE_DETAILS);
      expectNoSensitiveLeak(collectConsoleOutput());
    });

    it('does not log raw vaccination records on successful fetch', async () => {
      const { result } = renderHook(() => useVaccination(WALLET));
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.records).toEqual(RECORDS);
      expectNoSensitiveLeak(collectConsoleOutput());
    });
  });
});
