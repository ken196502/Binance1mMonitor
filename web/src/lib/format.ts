// Formatting helpers, ported verbatim from the original inline dashboard script.

export const fmt = (n: number | null | undefined, d = 4): string =>
  n == null || !isFinite(n as number)
    ? "-"
    : Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

export const pct = (n: number | null | undefined, d = 2): string =>
  n == null || !isFinite(n as number)
    ? "-"
    : (n >= 0 ? "+" : "") + Number(n).toFixed(d) + "%";

export const colClass = (n: number): string => (n > 0 ? "pos" : n < 0 ? "neg" : "muted");
