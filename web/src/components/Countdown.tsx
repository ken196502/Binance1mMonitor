interface CountdownProps {
  remaining: number; // seconds until next refresh
  total: number; // full cycle length (5)
}

// Small SVG ring that depletes over `total` seconds, with the integer countdown
// (5 → 1) in the middle. Sits next to the title; driven by App's tick.
export function Countdown({ remaining, total }: CountdownProps) {
  const r = 13;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, remaining / total));
  const offset = c * (1 - frac);
  const n = Math.max(1, Math.ceil(remaining)); // 5 .. 1, never 0
  return (
    <span className="countdown" title="距下次刷新">
      <svg width="30" height="30" viewBox="0 0 30 30">
        <circle cx="15" cy="15" r={r} fill="none" stroke="var(--border)" strokeWidth="2.5" />
        <circle
          className="ring"
          cx="15"
          cy="15"
          r={r}
          fill="none"
          stroke="var(--amber)"
          strokeWidth="2.5"
          strokeDasharray={c}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform="rotate(-90 15 15)"
        />
        <text x="15" y="15" textAnchor="middle" dominantBaseline="central" fontSize="11" fill="var(--text)">
          {n}
        </text>
      </svg>
    </span>
  );
}
