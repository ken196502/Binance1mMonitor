// Shared type definitions for both the Node backend (server.ts) and the React
// frontend (web/). This module is type-only — no runtime side effects — so it is
// safe to import from the browser bundle. Keeps the Status/Row contract in one
// place so server and client never drift apart.

import type { Ticker24h } from "./binance.ts";
import type { MacdState } from "./macd.ts";

export interface Row extends Ticker24h {
  state: MacdState | "n/a" | "err";
  alert: boolean;
  bullish: boolean | null; // DIF ≥ DEA → 多头; null when data is missing
  high: boolean | null; // DEA at/near window peak → 高位; null when data is missing
  streakCount: number;
  streakDir: "up" | "down" | null;
}

export interface Status {
  at: string; // ISO time of last successful refresh
  base: string;
  topN: number;
  highRatio: number;
  highWindow: number;
  gainers: Row[];
  losers: Row[];
  volume: Row[];
  error?: string;
}
