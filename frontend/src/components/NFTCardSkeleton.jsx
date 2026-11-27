const bar = (w, h = 14, mb = 0) => ({
  background: '#1e293b',
  borderRadius: 6,
  width: w,
  height: h,
  marginBottom: mb,
});

const card = {
  border: '1px solid #334155',
  borderRadius: 12,
  padding: '1.25rem',
  marginBottom: '1rem',
};

export default function NFTCardSkeleton({
  count = 3,
  label = 'Loading…',
  ariaLabel,
  role = 'status',
}) {
  const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  const accessibleLabel = ariaLabel || label;

  return (
    <>
      <style>{`
        @keyframes vacciPulse{0%,100%{opacity:.4}50%{opacity:1}}
        .vacci-skeleton-bar{animation:vacciPulse 1.4s ease-in-out infinite}
        @media (prefers-reduced-motion: reduce){
          .vacci-skeleton-bar{animation:none;opacity:.6}
        }
      `}</style>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
            <div className="vacci-skeleton-bar" style={bar('55%', 16)} />
            <div className="vacci-skeleton-bar" style={bar(40)} />
          </div>
          <div className="vacci-skeleton-bar" style={bar('40%', 13, 6)} />
          <div className="vacci-skeleton-bar" style={bar('60%', 12)} />
        </div>
      ))}
    </>
  );
}