import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../hooks/useFreighter';

import { pageContainerWide } from '../layout.js';

const ANALYTICS_BASE = import.meta.env.VITE_ANALYTICS_URL || 'http://localhost:8001';
const REFRESH_INTERVAL = 60_000;
const STALE_THRESHOLD_MS = 5 * 60_000;

const s = {
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.5rem' },
  h2: { color: '#e2e8f0', margin: 0 },
  refreshInfo: { color: '#64748b', fontSize: '0.8rem' },
  section: { background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, padding: '1.25rem', marginBottom: '1.5rem' },
  sectionTitle: { color: '#94a3b8', fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '1rem' },
  error: { color: '#f87171', padding: '0.75rem', background: '#1e293b', borderRadius: 8, marginBottom: '1rem' },
  loading: { color: '#64748b', textAlign: 'center', padding: '2rem 0' },
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
  barWrap: { display: 'flex', flexDirection: 'column', gap: '0.6rem' },
  barRow: { display: 'flex', alignItems: 'center', gap: '0.75rem' },
  barLabel: { color: '#94a3b8', fontSize: '0.85rem', minWidth: 140, textAlign: 'right', flexShrink: 0 },
  barTrack: { flex: 1, background: '#1e293b', borderRadius: 4, height: 18, overflow: 'hidden' },
  barFill: (pct) => ({ width: `${pct}%`, height: '100%', background: '#0ea5e9', borderRadius: 4, transition: 'width 0.4s ease' }),
  barCount: { color: '#e2e8f0', fontSize: '0.85rem', minWidth: 40 },
  noData: { color: '#475569', textAlign: 'center', padding: '1.5rem 0' },
  statusMissing: { color: '#f87171', fontSize: '0.85rem', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' },
  statusDelayed: { color: '#f59e0b', fontSize: '0.85rem', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' },
  statusEmpty: { color: '#94a3b8', fontSize: '0.85rem', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' },
  statusZero: { color: '#93c5fd', fontSize: '0.85rem', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' },
  summaryWrap: { marginTop: '0.75rem', fontSize: '0.85rem', color: '#94a3b8' },
};

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
    <div style={s.barWrap} role="list" aria-label="Vaccination rates by vaccine type">
      {data.map((d) => (
        <div key={d.vaccine_name} style={s.barRow} role="listitem">
          <span style={s.barLabel} title={d.vaccine_name}>
            {d.vaccine_name.length > 18 ? d.vaccine_name.slice(0, 17) + '…' : d.vaccine_name}
          </span>
          <div style={s.barTrack} aria-label={`${d.vaccine_name}: ${d.count} doses`}>
            <div style={s.barFill(Math.round((d.count / max) * 100))} />
          </div>
          <span style={s.barCount}>{d.count}</span>
        </div>
      ))}
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
            <td style={s.td}>{issuer.last_active ? new Date(issuer.last_active).toLocaleString() : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
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
    <table style={s.table} aria-label="Anomaly flags">
      <thead>
        <tr>
          <th style={s.th}>Issuer</th>
          <th style={s.th}>Mint Count</th>
          <th style={s.th}>Severity</th>
          <th style={s.th}>Reason</th>
        </tr>
      </thead>
      <tbody>
        {data.map((a, i) => (
          <tr key={i}>
            <td style={s.td} title={a.issuer}>{a.issuer.slice(0, 8)}…{a.issuer.slice(-6)}</td>
            <td style={s.td}>{a.count}</td>
            <td style={s.td}><span style={s.badge(a.severity)}>{a.severity ?? 'medium'}</span></td>
            <td style={s.td}>{a.reason ?? 'Unusual minting volume'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function AnalyticsDashboard() {
  const { role, apiFetch } = useAuth();
  const [rates, setRates] = useState(null);
  const [issuers, setIssuers] = useState(null);
  const [anomalies, setAnomalies] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);
  const timerRef = useRef(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ratesRes, issuersRes, anomaliesRes] = await Promise.all([
        fetch(`${ANALYTICS_BASE}/analytics/rates`),
        fetch(`${ANALYTICS_BASE}/analytics/issuers`),
        fetch(`${ANALYTICS_BASE}/analytics/anomalies`),
      ]);

      const [ratesData, issuersData, anomaliesData] = await Promise.all([
        ratesRes.json(),
        issuersRes.json(),
        anomaliesRes.json(),
      ]);

      setRates(ratesData.rates ?? ratesData);
      setIssuers(issuersData.issuers ?? issuersData);
      setAnomalies(anomaliesData.anomalies ?? anomaliesData);
      setLastRefresh(new Date());
    } catch (e) {
      setError('Failed to load analytics data. Is the analytics service running?');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    timerRef.current = setInterval(fetchAll, REFRESH_INTERVAL);
    return () => clearInterval(timerRef.current);
  }, [fetchAll]);

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

  return (
    <div style={{ ...pageContainerWide, marginTop: '2rem', marginBottom: '2rem' }}>
      <div style={s.header}>
        <h2 style={s.h2}>📊 Analytics Dashboard</h2>
        <span style={s.refreshInfo} aria-live="polite">
          {lastRefresh ? `Last updated: ${lastRefresh.toLocaleTimeString()} · auto-refreshes every 60s` : 'Loading…'}
        </span>
      </div>

      {error && <p style={s.error} role="alert">⚠️ {error}</p>}

      {/* Vaccination Rates */}
      <section style={s.section} aria-labelledby="rates-title">
        <h3 id="rates-title" style={s.sectionTitle}>Vaccination Rates by Vaccine Type</h3>
        {loading && rates === null ? (
          <p style={s.loading}>Loading…</p>
        ) : ratesStatus === 'missing' || ratesStatus === 'delayed' || ratesStatus === 'empty' || ratesStatus === 'zero' ? (
          <>
            <StatusBanner
              kind={ratesStatus}
              label={ratesStatus === 'missing' ? 'Rates data is missing.' : ratesStatus === 'delayed' ? 'Rates data is delayed.' : ratesStatus === 'empty' ? 'No vaccination rates recorded.' : 'All vaccination rates are zero.'}
            />
            <BarChart data={rates} status={ratesStatus} />
            <RatesSummary data={rates} status={ratesStatus} />
          </>
        ) : (
          <>
            <BarChart data={rates} status={ratesStatus} />
            <RatesSummary data={rates} status={ratesStatus} />
          </>
        )}
      </section>

      {/* Issuer Activity */}
      <section style={s.section} aria-labelledby="issuers-title">
        <h3 id="issuers-title" style={s.sectionTitle}>Issuer Activity</h3>
        {loading && issuers === null ? (
          <p style={s.loading}>Loading…</p>
        ) : (
          <>
            {issuersStatus === 'missing' || issuersStatus === 'delayed' || issuersStatus === 'empty' ? (
              <StatusBanner
                kind={issuersStatus}
                label={issuersStatus === 'missing' ? 'Issuer activity data is missing.' : issuersStatus === 'delayed' ? 'Issuer activity data is delayed.' : 'No issuer activity recorded.'}
              />
            ) : null}
            <IssuerTable data={issuers} status={issuersStatus} />
          </>
        )}
      </section>

      {/* Anomaly Flags */}
      <section style={s.section} aria-labelledby="anomalies-title">
        <h3 id="anomalies-title" style={s.sectionTitle}>Anomaly Flags</h3>
        {loading && anomalies === null ? (
          <p style={s.loading}>Loading…</p>
        ) : (
          <>
            {anomaliesStatus === 'missing' || anomaliesStatus === 'delayed' ? (
              <StatusBanner
                kind={anomaliesStatus}
                label={anomaliesStatus === 'missing' ? 'Anomaly data is missing.' : 'Anomaly data is delayed.'}
              />
            ) : null}
            <AnomalyList data={anomalies} status={anomaliesStatus} />
          </>
        )}
      </section>
    </div>
  );
}
