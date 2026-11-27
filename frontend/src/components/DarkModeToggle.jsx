export default function DarkModeToggle({ dark, onToggle }) {
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  return (
    <button
      onClick={onToggle}
      aria-label={label}
      title={label}
      style={{
        marginLeft: 'auto',
        padding: '0.4rem 0.75rem',
        background: 'transparent',
        border: '1px solid var(--border)',
        borderRadius: 8,
        color: 'var(--text-muted)',
        fontSize: '1rem',
      }}
    >
      <span aria-hidden="true">{dark ? '☀️' : '🌙'}</span>
      <span style={{ marginLeft: '0.4rem' }}>{dark ? 'Light' : 'Dark'}</span>
    </button>
  );
}