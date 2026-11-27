import { Component } from 'react';

const SENSITIVE_KEY_PATTERN = /(token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth|authorization|password|secret|api[_-]?key|patient|patient[_-]?id|mrn|ssn|dob|date[_-]?of[_-]?birth|vaccin|immuniz|record|lot[_-]?number|lot|dose|clinic|provider|name|email|phone|address)/i;

const REDACTED = '[REDACTED]';

function redactValue(value, depth = 0) {
  if (depth > 4) return REDACTED;
  if (value == null) return value;
  if (typeof value === 'string') {
    // Redact anything that looks like a bearer token or JWT.
    if (/^bearer\s+/i.test(value)) return REDACTED;
    if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return REDACTED;
    return value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  const result = {};
  for (const key of Object.keys(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = REDACTED;
    } else {
      result[key] = redactValue(value[key], depth + 1);
    }
  }
  return result;
}

function sanitizeError(error) {
  if (!error) return null;
  return {
    name: error.name || 'Error',
    message: typeof error.message === 'string' ? error.message : 'Unknown error',
    // Only include stack in development; it can leak file paths and data.
    ...(import.meta.env.DEV && error.stack ? { stack: error.stack } : {}),
  };
}

export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    if (import.meta.env.DEV) {
      const safeError = sanitizeError(error);
      const safeInfo = info && info.componentStack
        ? { componentStack: info.componentStack }
        : undefined;
      console.error('[ErrorBoundary]', redactValue(safeError), safeInfo ? redactValue(safeInfo) : undefined);
    } else {
      // Production: log only a generic, non-sensitive marker.
      console.error('[ErrorBoundary] An unexpected error occurred.');
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ maxWidth: 500, margin: '4rem auto', padding: '2rem', textAlign: 'center' }}>
          <h2 style={{ color: '#f87171', marginBottom: '0.75rem' }}>Something went wrong</h2>
          <p style={{ color: '#94a3b8', marginBottom: '1.5rem' }}>
            An unexpected error occurred. Please try again.
          </p>
          <button
            style={{ padding: '0.6rem 1.5rem', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}