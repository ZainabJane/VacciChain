import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../hooks/useFreighter';
import useDocumentTitle from '../hooks/useDocumentTitle';
import { pageContainerNarrow } from '../layout.js';

const s = {
  page:    { margin: '2rem 0' },
  table:   { width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' },
  th:      { textAlign: 'left', padding: '0.5rem 0.75rem', borderBottom: '1px solid #334155', color: '#94a3b8' },
  td:      { padding: '0.5rem 0.75rem', borderBottom: '1px solid #1e293b', color: '#e2e8f0', wordBreak: 'break-all' },
  btn:     { padding: '0.45rem 1rem', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.9rem' },
  btnDanger: { padding: '0.45rem 0.75rem', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem' },
  btnSuccess: { padding: '0.45rem 0.75rem', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem', marginRight: '0.4rem' },
  input:   { padding: '0.5rem 0.75rem', background: '#1e293b', border: '1px solid #334155', borderRadius: 6, color: '#e2e8f0', fontSize: '0.9rem', flex: 1 },
  row:     { display: 'flex', gap: '0.75rem', marginBottom: '1.5rem', alignItems: 'center' },
  keyBox:  { marginTop: '1rem', padding: '0.75rem 1rem', background: '#0f172a', borderRadius: 8, color: '#4ade80', fontSize: '0.85rem', wordBreak: 'break-all' },
  badge:   (revoked) => ({ display: 'inline-block', padding: '0.15rem 0.5rem', borderRadius: 4, fontSize: '0.75rem', background: revoked ? '#7f1d1d' : '#14532d', color: revoked ? '#fca5a5' : '#86efac' }),
  statusBadge: (status) => {
    const map = { pending: ['#78350f', '#fde68a'], approved: ['#14532d', '#86efac'], rejected: ['#7f1d1d', '#fca5a5'] };
    const [bg, color] = map[status] || ['#1e293b', '#94a3b8'];
    return { display: 'inline-block', padding: '0.15rem 0.5rem', borderRadius: 4, fontSize: '0.75rem', background: bg, color };
  },
  section: { marginTop: '2.5rem' },
  h3:      { color: 'var(--text)', marginBottom: '1rem', fontSize: '1.1rem' },
};

export default function AdminDashboard() {
  const { publicKey, role, apiFetch } = useAuth();
  const [keys, setKeys]             = useState([]);
  const [label, setLabel]           = useState('');
  const [newKey, setNewKey]         = useState(null);
  const [error, setError]           = useState(null);
  const [loading, setLoading]       = useState(false);
  const [applications, setApps]     = useState([]);
  const [reviewError, setReviewErr] = useState(null);
  const [keysState, setKeysState]   = useState({ status: 'idle', error: null });
  const [appsState, setAppsState]   = useState({ status: 'idle', error: null });

  const fetchKeys = useCallback(async () => {
    setKeysState({ status: 'loading', error: null });
    try {
      const res = await apiFetch('/v1/admin/api-keys');
      if (!res.ok) throw new Error(`Failed to load API keys (${res.status})`);
      const data = await res.json();
      setKeys(Array.isArray(data) ? data : []);
      setKeysState({ status: 'success', error: null });
    } catch (err) {
      setKeysState({ status: 'error', error: err.message || 'Failed to load API keys' });
    }
  }, [apiFetch]);

  const fetchApplications = useCallback(async () => {
    setAppsState({ status: 'loading', error: null });
    try {
      const res = await apiFetch('/v1/onboarding/applications');
      if (!res.ok) throw new Error(`Failed to load applications (${res.status})`);
      const data = await res.json();
      setApps(Array.isArray(data) ? data : []);
      setAppsState({ status: 'success', error: null });
    } catch (err) {
      setAppsState({ status: 'error', error: err.message || 'Failed to load applications' });
    }
  }, [apiFetch]);

  useEffect(() => {
    // Disconnected, loading, and denied states are owned by the route-level
    // RoleGuard; only fetch once the authenticated role is confirmed.
    if (publicKey && role === 'issuer') {
      fetchKeys();
      fetchApplications();
    }
  }, [publicKey, role, fetchKeys, fetchApplications]);

  if (!publicKey) {
    return (
      <div className="page-container page-section content-medium" style={{ ...s.page, ...pageContainerNarrow }}>
        <p style={{ color: '#94a3b8', marginBottom: '1rem' }}>Connect your admin wallet to manage API keys.</p>
        <button style={s.btn} onClick={connect}>Connect Wallet</button>
      </div>
    );
  }

  if (role !== 'issuer') {
    return <div className="page-container page-section content-medium" style={{ ...s.page, ...pageContainerNarrow }}><p style={{ color: '#f87171' }}>Access denied: admin role required.</p></div>;
  }

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!label.trim()) return;
    setLoading(true);
    setError(null);
    setNewKey(null);
    try {
      const res = await apiFetch('/v1/admin/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setNewKey(data.key);
      setLabel('');
      await fetchKeys();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRevoke = async (id) => {
    if (!window.confirm('Revoke this API key? This cannot be undone.')) return;
    await apiFetch(`/v1/admin/api-keys/${id}`, { method: 'DELETE' });
    await fetchKeys();
  };

  const handleReview = async (id, decision) => {
    const note = decision === 'rejected' ? window.prompt('Reason for rejection (optional):') : null;
    setReviewErr(null);
    try {
      const res = await apiFetch(`/v1/onboarding/applications/${id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, reviewer_note: note || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await fetchApplications();
    } catch (err) {
      setReviewErr(err.message);
    }
  };

  return (
    <div className="page-container page-section content-medium" style={{ ...s.page, ...pageContainerNarrow }}>
      <h2 style={{ marginBottom: '1.5rem', color: 'var(--text)' }}>API Key Management</h2>

      <form style={s.row} onSubmit={handleCreate}>
        <input
          style={s.input}
          placeholder="Label (e.g. School District A)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          aria-label="API key label"
          required
        />
        <button style={s.btn} type="submit" disabled={loading} aria-disabled={loading}>
          {loading ? 'Creating…' : 'Create Key'}
        </button>
      </form>

      {error && <p style={{ color: '#f87171', marginBottom: '1rem' }}>{error}</p>}

      {newKey && (
        <div style={s.keyBox} role="alert">
          <strong>New API key (copy now — shown once):</strong>
          <br />
          <code>{newKey}</code>
        </div>
      )}

      {keysState.status === 'loading' && keys.length === 0 ? (
        <p style={{ color: '#94a3b8' }} role="status">Loading API keys…</p>
      ) : keysState.status === 'error' ? (
        <div role="alert" style={{ marginBottom: '1rem' }}>
          <p style={{ color: '#f87171', marginBottom: '0.5rem' }}>{keysState.error}</p>
          <button style={s.btn} onClick={fetchKeys}>Retry</button>
        </div>
      ) : keys.length === 0 ? (
        <p style={{ color: '#64748b' }}>No API keys yet.</p>
      ) : (
        <>
        {keysState.status === 'loading' && (
          <p style={{ color: '#94a3b8', marginBottom: '0.5rem' }} role="status">Refreshing API keys…</p>
        )}
        <table style={s.table} aria-label="API keys">
          <thead>
            <tr>
              <th style={s.th}>Label</th>
              <th style={s.th}>Created</th>
              <th style={s.th}>Status</th>
              <th style={s.th}></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td style={s.td}>{k.label}</td>
                <td style={s.td}>{new Date(k.created_at).toLocaleDateString()}</td>
                <td style={s.td}><span style={s.badge(k.revoked)}>{k.revoked ? 'Revoked' : 'Active'}</span></td>
                <td style={s.td}>
                  {!k.revoked && (
                    <button style={s.btnDanger} onClick={() => handleRevoke(k.id)} aria-label={`Revoke ${k.label}`}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </>
      )}

      {/* ── Issuer Onboarding Applications ── */}
      <div style={s.section}>
        <h3 style={s.h3}>Issuer Onboarding Applications</h3>
        {reviewError && <p style={{ color: '#f87171', marginBottom: '0.75rem' }}>{reviewError}</p>}
        {appsState.status === 'loading' && applications.length === 0 ? (
          <p style={{ color: '#94a3b8' }} role="status">Loading applications…</p>
        ) : appsState.status === 'error' ? (
          <div role="alert" style={{ marginBottom: '1rem' }}>
            <p style={{ color: '#f87171', marginBottom: '0.5rem' }}>{appsState.error}</p>
            <button style={s.btn} onClick={fetchApplications}>Retry</button>
          </div>
        ) : applications.length === 0 ? (
          <p style={{ color: '#64748b' }}>No applications yet.</p>
        ) : (
          <>
          {appsState.status === 'loading' && (
            <p style={{ color: '#94a3b8', marginBottom: '0.5rem' }} role="status">Refreshing applications…</p>
          )}
          <table style={s.table} aria-label="Issuer applications">
            <thead>
              <tr>
                <th style={s.th}>Name</th>
                <th style={s.th}>Country</th>
                <th style={s.th}>License</th>
                <th style={s.th}>Status</th>
                <th style={s.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {applications.map((app) => (
                <tr key={app.id}>
                  <td style={s.td}>{app.name}</td>
                  <td style={s.td}>{app.country}</td>
                  <td style={s.td}>{app.license_number}</td>
                  <td style={s.td}><span style={s.statusBadge(app.status)}>{app.status}</span></td>
                  <td style={s.td}>
                    {app.status === 'pending' && (
                      <>
                        <button style={s.btnSuccess} onClick={() => handleReview(app.id, 'approved')} aria-label={`Approve ${app.name}`}>Approve</button>
                        <button style={s.btnDanger}  onClick={() => handleReview(app.id, 'rejected')} aria-label={`Reject ${app.name}`}>Reject</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </>
        )}
      </div>
    </div>
  );
}
