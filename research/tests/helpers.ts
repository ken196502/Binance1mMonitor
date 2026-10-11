import { HOUR, type Bar, type Dataset, type Manifest, type Parameters, type SearchOptions } from "../types.ts";
import { DEFAULT_GRID } from "../search.ts";

export const START = Date.UTC(2025, 0, 6); // Monday, UTC.
export const PARAMS: Parameters = { holdHours: 5, minStreak: 1, volumeRatio: 0, weekFilter: false,
  dayMovePercent: 0, highRatio: 0.8, stopLossPercent: 0, takeProfitPercent: 0 };
export const OPTIONS: SearchOptions = { topN: 1, stepHours: 1, rounds: 3, trialsPerRound: 4, seed: 42, minTrades: 1,
  trainRatio: 0.6, validationRatio: 0.2, feeBps: 5, slippageBps: 2,
  grid: { ...structuredClone(DEFAULT_GRID), holdHours: [5, 10], minStreak: [1, 2], volumeRatio: [0, 1], weekFilter: [false],
    stopLossPercent: [0, 1], takeProfitPercent: [0, 2] } };

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
