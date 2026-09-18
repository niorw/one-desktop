export function ProgressRing({ value, total, size = 30 }: { value: number; total: number; size?: number }) {
  const pct = total > 0 ? value / total : 0;
  const r = (size - 4) / 2;
  const c = 2 * Math.PI * r;
  const off = c * (1 - pct);
  return (
    <span className="pcirc" style={{ width: size, height: size }} title={`${value}/${total}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle
          className="pcirc-fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          style={{
            strokeDasharray: c,
            strokeDashoffset: off,
            transform: `rotate(-90deg)`,
            transformOrigin: `${size / 2}px ${size / 2}px`,
          }}
        />
      </svg>
      <span className="pcirc-txt">{total > 0 ? `${value}/${total}` : "—"}</span>
    </span>
  );
}

// ── Roundtable (chat) tab ──
