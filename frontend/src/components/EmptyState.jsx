export default function EmptyState({
  icon = '🩺',
  title,
  message = 'No vaccination records have been issued yet.',
  actionLabel,
  onAction,
  actionDisabled = false,
  variant = 'empty',
}) {
  const isPartial = variant === 'partial';
  const isError = variant === 'error';

  const borderColor = isError ? 'var(--danger, #dc2626)' : 'var(--border)';
  const textColor = isError ? 'var(--danger, #dc2626)' : 'var(--text-muted)';

  return (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      style={{
        textAlign: 'center',
        padding: '3rem 1rem',
        background: 'var(--input-bg)',
        border: `1px ${isPartial || isError ? 'solid' : 'dashed'} ${borderColor}`,
        borderRadius: 12,
        color: textColor,
      }}
    >
      <span aria-hidden="true" style={{ fontSize: '2.5rem', display: 'block', marginBottom: '0.75rem' }}>
        {icon}
      </span>
      {title && (
        <p style={{ fontWeight: 600, margin: '0 0 0.5rem', color: 'var(--text, inherit)' }}>{title}</p>
      )}
      <p style={{ margin: 0 }}>{message}</p>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          disabled={actionDisabled}
          style={{
            marginTop: '1rem',
            padding: '0.5rem 1.25rem',
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--surface, transparent)',
            color: 'var(--text, inherit)',
            cursor: actionDisabled ? 'not-allowed' : 'pointer',
            opacity: actionDisabled ? 0.6 : 1,
          }}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}