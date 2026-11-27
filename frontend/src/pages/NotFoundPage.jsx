import { Link } from 'react-router-dom';

const styles = {
  page: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '60vh',
    textAlign: 'center',
    padding: '0 1rem',
  },
  title: { fontSize: '2rem', fontWeight: 700, color: 'var(--text)', marginBottom: '0.5rem' },
  sub: { color: 'var(--text-muted)', fontSize: '1.1rem', marginBottom: '2rem' },
  btn: { padding: '0.75rem 2rem', background: 'var(--btn-primary)', color: '#fff', border: 'none', borderRadius: 8, fontSize: '1rem', cursor: 'pointer' },
};

export default function NotFoundPage() {
  return (
    <div style={styles.page}>
      <h1 style={styles.title}>404 — Page not found</h1>
      <p style={styles.sub}>
        The page you're looking for doesn't exist. Return to the landing page to continue.
      </p>
      <Link to="/" style={styles.btn}>
        Go to landing page
      </Link>
    </div>
  );
}
