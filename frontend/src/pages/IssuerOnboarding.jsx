import { useState } from 'react';
import { useAuth } from '../hooks/useFreighter';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

import { pageContainerNarrow } from '../layout.js';

const s = {
  field:  { display: 'flex', flexDirection: 'column', gap: '0.35rem', marginBottom: '1rem' },
  label:  { color: '#94a3b8', fontSize: '0.85rem' },
  required: { color: '#f87171', marginLeft: '0.25rem' },
  optional: { color: '#64748b', marginLeft: '0.25rem', fontSize: '0.8rem' },
  hint:   { color: '#64748b', fontSize: '0.8rem' },
  input:  { padding: '0.5rem 0.75rem', background: '#1e293b', border: '1px solid #334155', borderRadius: 6, color: '#e2e8f0', fontSize: '0.9rem' },
  inputInvalid: { borderColor: '#f87171' },
  btn:    { padding: '0.55rem 1.25rem', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.9rem', marginTop: '0.5rem' },
  success:{ marginTop: '1rem', padding: '0.75rem 1rem', background: '#14532d', borderRadius: 8, color: '#86efac', fontSize: '0.9rem' },
  error:  { marginTop: '0.5rem', color: '#f87171', fontSize: '0.9rem' },
  fieldError: { color: '#f87171', fontSize: '0.8rem' },
};

export default function IssuerOnboarding() {
  useDocumentTitle('Apply as Issuer — VacciChain');
  const { publicKey, connect, apiFetch } = useAuth();
  const [form, setForm] = useState({ name: '', license_number: '', country: '' });
  const [fieldErrors, setFieldErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(null);
  const [error, setError] = useState(null);

  if (!publicKey) {
    return (
      <div style={{ ...pageContainerNarrow, marginTop: '2rem', marginBottom: '2rem' }}>
        <h2 style={{ color: 'var(--text)', marginBottom: '1rem' }}>Apply for Issuer Status</h2>
        <p style={{ color: '#94a3b8', marginBottom: '1rem' }}>
          Connect your wallet to submit an onboarding request.
        </p>
        <button style={s.btn} onClick={connect}>Connect Wallet</button>
      </div>
    );
  }

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm({ ...form, [name]: value });
    setFieldErrors((prev) => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const validate = () => {
    const errors = {};
    if (!form.name.trim()) errors.name = 'Organization / provider name is required.';
    if (!form.license_number.trim()) errors.license_number = 'License number is required.';
    if (!form.country.trim()) errors.country = 'Country is required.';
    return errors;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (loading) return;
    const errors = validate();
    setFieldErrors(errors);
    setError(null);
    setSuccess(null);
    if (Object.keys(errors).length > 0) {
      const firstInvalid = Object.keys(errors)[0];
      const el = document.getElementById(firstInvalid);
      if (el) el.focus();
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch('/v1/onboarding/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, wallet: publicKey }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Submission failed');
      setSuccess(data.message);
      setForm({ name: '', license_number: '', country: '' });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ ...pageContainerNarrow, marginTop: '2rem', marginBottom: '2rem' }}>
      <h2 style={{ color: 'var(--text)', marginBottom: '0.5rem' }}>Apply for Issuer Status</h2>
      <p style={{ color: '#94a3b8', marginBottom: '1.5rem', fontSize: '0.9rem' }}>
        Submit your details below. An admin will review your application and add you to the
        contract allowlist upon approval.
      </p>

      <form onSubmit={handleSubmit} noValidate>
        <div style={s.field}>
          <label style={s.label} htmlFor="name">
            Organization / Provider Name
            <span style={s.required} aria-hidden="true">*</span>
            <span style={s.optional}>(required)</span>
          </label>
          <input
            id="name" name="name" style={{ ...s.input, ...(fieldErrors.name ? s.inputInvalid : {}) }}
            required aria-required="true"
            aria-invalid={fieldErrors.name ? 'true' : 'false'}
            aria-describedby={fieldErrors.name ? 'name-error' : undefined}
            value={form.name} onChange={handleChange}
            placeholder="City General Hospital"
          />
          {fieldErrors.name && (
            <span id="name-error" style={s.fieldError} role="alert">{fieldErrors.name}</span>
          )}
        </div>
        <div style={s.field}>
          <label style={s.label} htmlFor="license_number">
            License Number
            <span style={s.required} aria-hidden="true">*</span>
            <span style={s.optional}>(required)</span>
          </label>
          <input
            id="license_number" name="license_number" style={{ ...s.input, ...(fieldErrors.license_number ? s.inputInvalid : {}) }}
            required aria-required="true"
            aria-invalid={fieldErrors.license_number ? 'true' : 'false'}
            aria-describedby={fieldErrors.license_number ? 'license_number-error' : undefined}
            value={form.license_number} onChange={handleChange}
            placeholder="MED-12345"
          />
          {fieldErrors.license_number && (
            <span id="license_number-error" style={s.fieldError} role="alert">{fieldErrors.license_number}</span>
          )}
        </div>
        <div style={s.field}>
          <label style={s.label} htmlFor="country">
            Country
            <span style={s.required} aria-hidden="true">*</span>
            <span style={s.optional}>(required)</span>
          </label>
          <input
            id="country" name="country" style={{ ...s.input, ...(fieldErrors.country ? s.inputInvalid : {}) }}
            required aria-required="true"
            aria-invalid={fieldErrors.country ? 'true' : 'false'}
            aria-describedby={fieldErrors.country ? 'country-error' : undefined}
            value={form.country} onChange={handleChange}
            placeholder="Nigeria"
          />
          {fieldErrors.country && (
            <span id="country-error" style={s.fieldError} role="alert">{fieldErrors.country}</span>
          )}
        </div>
        <div style={s.field}>
          <label style={s.label} htmlFor="wallet">
            Wallet Address
            <span style={s.optional}>(read-only)</span>
          </label>
          <input
            id="wallet" name="wallet" style={{ ...s.input, color: '#64748b' }}
            value={publicKey} readOnly aria-readonly="true"
            aria-describedby="wallet-hint"
          />
          <span id="wallet-hint" style={s.hint}>This address is used to identify your application.</span>
        </div>

        <button style={s.btn} type="submit" disabled={loading} aria-disabled={loading}>
          {loading ? 'Submitting…' : 'Submit Application'}
        </button>
      </form>

      {error   && <p style={s.error} role="alert">{error}</p>}
      {success && <div style={s.success} role="status" aria-live="polite">{success}</div>}
    </div>
  );
}
