import { HOUR, type Bar, type Dataset, type Manifest } from "../types.ts";

export const START = Date.UTC(2025, 0, 6); // Monday, UTC.

export function history(start = START - 100 * HOUR, end = START + 600 * HOUR): Bar[] {
  return Array.from({ length: (end - start) / HOUR }, (_, i) => {
    const close = 100 + Math.sin(i / 11) * 3 + Math.sin(i / 47);
    const open = 100 + Math.sin((i - 1) / 11) * 3 + Math.sin((i - 1) / 47);
    return [start + i * HOUR, open, Math.max(open, close) + 0.02, Math.min(open, close) - 0.02, close, 10000, 1e7];
  });
}
export function manifest(symbol = "AAAUSDT"): Manifest {
  return { version: 1, source: "fixture", fetchedAt: new Date(START).toISOString(), start: START, end: START + 600 * HOUR,
    fetchStart: START - 100 * HOUR, interval: "1h", universeAt: new Date(START).toISOString(),
    contracts: [{ symbol, onboardDate: 0 }], symbols: [symbol], files: {} };
}
export function dataset(): Dataset {
  return { manifest: manifest(), candles: new Map([["AAAUSDT", history()]]) };
}
