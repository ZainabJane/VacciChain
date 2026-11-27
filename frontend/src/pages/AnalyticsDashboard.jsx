import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../hooks/useFreighter';
import { pageContainerWide } from '../layout.js';

// Same-origin: the edge proxy forwards /analytics/* to the internal service.
async function readJson(res) {
  if (res.status === 401 || res.status === 403) throw new Error('You are not authorized to view analytics.');
  if (!res.ok) throw new Error('Analytics service is unavailable. Please try again later.');
  try {
    return await res.json();
  } catch {
    throw new Error('Analytics service returned an invalid response.');
  }
}

const normalizeRates = ({ rates = [] }) => (Array.isArray(rates)
  ? rates
  : Object.entries(rates).map(([vaccine_name, count]) => ({ vaccine_name, count })));

const normalizeIssuer = (i) => ({ ...i, address: i.address ?? i.issuer, count: i.count ?? i.total_issued });
const REFRESH_INTERVAL = 60_000;
const STALE_THRESHOLD_MS = 5 * 60_000;

// Analytics is reached through the backend proxy (#37) so the internal
// analytics service is never called directly from the browser.
const ANALYTICS_PREFIX = '/v1/analytics';

const s = {
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.5rem' },
  h2: { color: '#e2e8f0', margin: 0 },
  refreshInfo: { color: '#64748b', fontSize: '0.8rem' },
  section: { background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, padding: '1.25rem', marginBottom: '1.5rem' },
  sectionTitle: { color: '#94a3b8', fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '1rem' },
  error: { color: '#f87171', padding: '0.75rem', background: '#1e293b', borderRadius: 8, marginBottom: '1rem' },
  loading: { color: '#64748b', textAlign: 'center', padding: '2rem 0' },
  sectionError: { color: '#f87171', padding: '0.75rem', background: '#1e293b', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' },
  partialNote: { color: '#fcd34d', fontSize: '0.8rem', marginBottom: '0.75rem' },
  retryBtn: { background: '#0ea5e9', color: '#0f172a', border: 'none', borderRadius: 6, padding: '0.4rem 0.9rem', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' },
  th: { textAlign: 'left', color: '#64748b', fontWeight: 500, padding: '0.5rem 0.75rem', borderBottom: '1px solid #1e293b' },
  td: { padding: '0.6rem 0.75rem', color: '#e2e8f0', borderBottom: '1px solid #1e293b' },
  badge: (severity) => ({
    display: 'inline-block',
    padding: '0.2rem 0.6rem',
    borderRadius: 4,
    fontSize: '0.75rem',
    fontWeight: 600,
    background: severity === 'high' ? '#7f1d1d' : severity === 'medium' ? '#78350f' : '#1e3a5f',
    color: severity === 'high' ? '#fca5a5' : severity === 'medium' ? '#fcd34d' : '#93c5fd',
  }),
  barTrack: { minWidth: 80, background: '#1e293b', borderRadius: 4, height: 18, overflow: 'hidden' },
  barFill: (pct) => ({ width: `${pct}%`, height: '100%', background: '#0ea5e9', borderRadius: 4, transition: 'width 0.4s ease' }),
  noData: { color: '#475569', textAlign: 'center', padding: '1.5rem 0' },
  statusMissing: { color: '#f87171', fontSize: '0.85rem', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' },
  statusDelayed: { color: '#f59e0b', fontSize: '0.85rem', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' },
  statusEmpty: { color: '#94a3b8', fontSize: '0.85rem', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' },
  statusZero: { color: '#93c5fd', fontSize: '0.85rem', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' },
  summaryWrap: { marginTop: '0.75rem', fontSize: '0.85rem', color: '#94a3b8' },
};

// The service returns { rates: { name: count } }; arrays are accepted too.
function parseRates(body) {
  const rates = body?.rates ?? body;
  if (Array.isArray(rates)) return rates;
  if (!rates || typeof rates !== 'object') throw new Error('bad rates');
  return Object.entries(rates).map(([vaccine_name, count]) => ({ vaccine_name, count }));
}

function parseIssuers(body) {
  const list = body?.issuers ?? body;
  if (!Array.isArray(list)) throw new Error('bad issuers');
  return list.map((i) => ({ ...i, address: i.address ?? i.issuer, count: i.count ?? i.total_issued }));
}

function parseAnomalies(body) {
  const list = body?.anomalies ?? body?.flagged_issuers ?? body;
  if (!Array.isArray(list)) throw new Error('bad anomalies');
  return list.map((a) => ({ ...a, count: a.count ?? a.total_issued }));
}

const SOURCES = {
  rates: parseRates,
  issuers: parseIssuers,
  anomalies: parseAnomalies,
};

const isNumber = (n) => typeof n === 'number' && Number.isFinite(n);
// A missing value is never shown as zero.
const formatCount = (n) => (isNumber(n) ? n.toLocaleString() : 'Not reported');
const shorten = (address) => (address ? `${address.slice(0, 8)}…${address.slice(-6)}` : 'Not reported');

function lastActive(issuer) {
  if (issuer.last_active) return new Date(issuer.last_active).toLocaleString();
  if (issuer.last_ledger) return `Ledger ${issuer.last_ledger}`;
  return 'Not reported';
}

function dataStatus(data, lastRefresh) {
  if (data === null) return 'missing';
  if (lastRefresh && Date.now() - lastRefresh.getTime() > STALE_THRESHOLD_MS) return 'delayed';
  if (data.length === 0) return 'empty';
  if (data.every((d) => (d.count ?? 0) === 0)) return 'zero';
  return 'loaded';
}

function StatusBanner({ kind, label }) {
  const styles = {
    missing: s.statusMissing,
    delayed: s.statusDelayed,
    empty: s.statusEmpty,
    zero: s.statusZero,
  };
  const icons = { missing: '⚠️', delayed: '⏳', empty: '📭', zero: '0️⃣' };
  return (
    <p style={styles[kind]} role="status" aria-label={label}>
      {icons[kind]} {label}
    </p>
  );
}

// The table is the textual equivalent of the bars, so both stay in sync.
function CountTable({ caption, headers, rows }) {
  const reported = rows.map((r) => r.count).filter(isNumber);
  const max = Math.max(...reported, 1);
  const total = reported.reduce((a, b) => a + b, 0);
  const missing = rows.length - reported.length;
  return (
    <>
      <p style={s.refreshInfo}>
        Total: {reported.length ? total.toLocaleString() : 'Not reported'} across {rows.length} {rows.length === 1 ? 'row' : 'rows'}.
        {missing > 0 && ` ${missing} not reported.`}
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table style={s.table} aria-label={caption}>
          <thead>
            <tr>{headers.map((h) => <th key={h} scope="col" style={s.th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row" style={{ ...s.td, textAlign: 'left', fontWeight: 400 }} title={r.title}>{r.label}</th>
                <td style={s.td}>
                  {isNumber(r.count) && (
                    <div style={s.barTrack} role="img" aria-label={`${r.label}: ${r.count} of ${total} doses`}>
                      <div style={s.barFill(Math.round((r.count / max) * 100))} />
                    </div>
                  )}
                </td>
                <td style={s.td}>{formatCount(r.count)}</td>
                {r.extra !== undefined && <td style={s.td}>{r.extra}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function BarChart({ data, status }) {
  if (status === 'missing') {
    return <p style={s.noData}>Rates data is missing. Unable to load vaccination rates.</p>;
  }
  if (status === 'delayed') {
    return <p style={s.noData}>Rates data is delayed. Data may not reflect recent activity.</p>;
  }
  if (!data || data.length === 0) return <p style={s.noData}>No vaccination rates recorded.</p>;
  const max = Math.max(...data.map((d) => d.count), 1);
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={s.table} aria-label="Vaccination doses by vaccine type">
        <thead>
          <tr>
            {['Vaccine', 'Share', 'Doses'].map((h) => <th key={h} scope="col" style={s.th}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.vaccine_name}>
              <th scope="row" style={{ ...s.td, textAlign: 'left', fontWeight: 400 }}>{d.vaccine_name}</th>
              <td style={s.td}>
                <div style={s.barTrack} role="img" aria-label={`${d.vaccine_name}: ${d.count} doses`}>
                  <div style={s.barFill(Math.round(((d.count ?? 0) / max) * 100))} />
                </div>
              </td>
              <td style={s.td}>{formatCount(d.count)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RatesSummary({ data, status }) {
  if (status === 'missing' || status === 'delayed') return null;
  if (!data || data.length === 0) return <p style={s.summaryWrap}>No rates to summarize.</p>;
  const total = data.reduce((acc, d) => acc + (d.count ?? 0), 0);
  const top = [...data].sort((a, b) => (b.count ?? 0) - (a.count ?? 0))[0];
  return (
    <div style={s.summaryWrap}>
      Total doses: {total} · {top ? `Top: ${top.vaccine_name} (${top.count})` : ''}
    </div>
  );
}

function RatesChart({ data, status }) {
  return (
    <>
      <BarChart data={data} status={status} />
      <RatesSummary data={data} status={status} />
    </>
  );
}

function IssuerTable({ data, status }) {
  if (status === 'missing') {
    return <p style={s.noData}>Issuer activity data is missing. Unable to load.</p>;
  }
  if (status === 'delayed') {
    return <p style={s.noData}>Issuer activity data is delayed. Data may not reflect recent activity.</p>;
  }
  if (!data || data.length === 0) return <p style={s.noData}>No issuer activity recorded.</p>;
  return (
    <table style={s.table} aria-label="Issuer activity">
      <thead>
        <tr>
          <th style={s.th}>Issuer</th>
          <th style={s.th}>Volume</th>
          <th style={s.th}>Last Active</th>
        </tr>
      </thead>
      <tbody>
        {data.map((issuer) => (
          <tr key={issuer.address}>
            <td style={s.td} title={issuer.address}>
              {issuer.address.slice(0, 8)}…{issuer.address.slice(-6)}
            </td>
            <td style={s.td}>{issuer.count}</td>
            <td style={s.td}>{issuer.last_active ? new Date(issuer.last_active).toLocaleString() : issuer.last_ledger ? `Ledger ${issuer.last_ledger}` : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function IssuerChart({ data, status }) {
  return <IssuerTable data={data} status={status} />;
}

function AnomalyList({ data, status }) {
  if (status === 'missing') {
    return <p style={s.noData}>Anomaly data is missing. Unable to load.</p>;
  }
  if (status === 'delayed') {
    return <p style={s.noData}>Anomaly data is delayed. Data may not reflect recent activity.</p>;
  }
  if (!data || data.length === 0) return <p style={{ ...s.noData, color: '#4ade80' }}>✅ No anomalies detected.</p>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={s.table} aria-label="Anomaly flags">
        <thead>
          <tr>
            {['Issuer', 'Mint Count', 'Severity', 'Reason'].map((h) => <th key={h} scope="col" style={s.th}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.map((a, i) => (
            <tr key={i}>
              <td style={s.td} title={a.issuer}>{shorten(a.issuer)}</td>
              <td style={s.td}>{formatCount(a.count)}</td>
              <td style={s.td}><span style={s.badge(a.severity)}>{a.severity ?? 'medium'}</span></td>
              <td style={s.td}>{a.reason ?? 'Unusual minting volume'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({ id, title, source, empty, children }) {
  const { data, failed, updatedAt } = source;
  let body;
  if (data) body = data.length ? children(data) : <p style={s.noData}>{empty}</p>;
  else if (failed) body = <p style={s.noData}>Data unavailable. This does not mean the value is zero.</p>;
  else body = <p style={s.loading} role="status">Loading…</p>;
  return (
    <section style={s.section} aria-labelledby={id}>
      <h3 id={id} style={s.sectionTitle}>{title}</h3>
      {data && failed && (
        <p style={s.error} role="status">Delayed: showing data from {updatedAt.toLocaleTimeString()}.</p>
      )}
      {body}
    </section>
  );
}

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ratesData, issuersData, anomaliesData] = await Promise.all(
        ['rates', 'issuers', 'anomalies'].map(async (name) => readJson(await apiFetch(`/analytics/${name}`)))
      );

      setRates(normalizeRates(ratesData));
      setIssuers((issuersData.issuers ?? []).map(normalizeIssuer));
      setAnomalies((anomaliesData.flagged_issuers ?? anomaliesData.anomalies ?? []).map(normalizeIssuer));
      setLastRefresh(new Date());
    } catch (e) {
      setError(e.message || 'Failed to load analytics data.');
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    if (role !== 'issuer') return undefined;
    fetchAll();
    timerRef.current = setInterval(fetchAll, REFRESH_INTERVAL);
    return () => clearInterval(timerRef.current);
  }, [fetchAll, role]);

  const rates = sections.rates.data;
  const issuers = sections.issuers.data;
  const anomalies = sections.anomalies.data;
  const loading = sections.rates.status === 'loading' || sections.issuers.status === 'loading' || sections.anomalies.status === 'loading';

  const ratesStatus = loading && rates === null ? 'loading' : dataStatus(rates, lastRefresh);
  const issuersStatus = loading && issuers === null ? 'loading' : dataStatus(issuers, lastRefresh);
  const anomaliesStatus = loading && anomalies === null ? 'loading' : dataStatus(anomalies, lastRefresh);

  if (role !== 'issuer') {
    return (
      <div style={{ ...pageContainerWide, marginTop: '2rem', marginBottom: '2rem' }}>
        <p style={{ color: '#f87171' }}>Access restricted to authorized issuers.</p>
      </div>
    );
  }

  const all = Object.values(sources);
  const anyFailed = all.some((x) => x.failed);
  const times = all.map((x) => x.updatedAt).filter(Boolean);
  // The oldest section decides how fresh the page as a whole is.
  const oldest = times.length ? new Date(Math.min(...times)) : null;

  const ratesStatus = dataStatus(sources.rates.data, sources.rates.updatedAt);
  const issuersStatus = dataStatus(sources.issuers.data, sources.issuers.updatedAt);
  const anomaliesStatus = dataStatus(sources.anomalies.data, sources.anomalies.updatedAt);

  return (
    <div style={{ ...pageContainerWide, marginTop: '2rem', marginBottom: '2rem' }}>
      <div style={s.header}>
        <h2 style={s.h2}>📊 Analytics Dashboard</h2>
        <span style={s.refreshInfo} aria-live="polite">
          {oldest ? `Last updated: ${oldest.toLocaleTimeString()} · auto-refreshes every 60s` : 'No data loaded yet'}
        </span>
      </div>
      <p style={s.refreshInfo}>Time range: the 500 most recent indexed mints.</p>

      {anyFailed && <p style={s.error} role="alert">⚠️ Some analytics data could not be loaded.</p>}

      <Section id="rates-title" title="Vaccination Rates by Vaccine Type" source={sources.rates} empty="No vaccinations recorded in this range.">
        {(data) => (
          <>
            {ratesStatus !== 'loaded' && (
              <StatusBanner
                kind={ratesStatus}
                label={ratesStatus === 'missing' ? 'Rates data is missing.' : ratesStatus === 'delayed' ? 'Rates data is delayed.' : ratesStatus === 'empty' ? 'No vaccination rates recorded.' : 'All vaccination rates are zero.'}
              />
            )}
            <RatesChart data={data} status={ratesStatus} />
          </>
        )}
      </Section>
      <Section id="issuers-title" title="Issuer Activity" source={sources.issuers} empty="No issuers have minted in this range.">
        {(data) => (
          <>
            {(issuersStatus === 'missing' || issuersStatus === 'delayed' || issuersStatus === 'empty') && (
              <StatusBanner
                kind={issuersStatus}
                label={issuersStatus === 'missing' ? 'Issuer activity data is missing.' : issuersStatus === 'delayed' ? 'Issuer activity data is delayed.' : 'No issuer activity recorded.'}
              />
            )}
            <IssuerChart data={data} status={issuersStatus} />
          </>
        )}
      </Section>
      <Section id="anomalies-title" title="Anomaly Flags" source={sources.anomalies} empty="✅ No anomalies detected.">
        {(data) => (
          <>
            {(anomaliesStatus === 'missing' || anomaliesStatus === 'delayed') && (
              <StatusBanner
                kind={anomaliesStatus}
                label={anomaliesStatus === 'missing' ? 'Anomaly data is missing.' : 'Anomaly data is delayed.'}
              />
            )}
            <AnomalyList data={data} status={anomaliesStatus} />
          </>
        )}
      </Section>
    </div>
  );
}
