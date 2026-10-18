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
  dea?: number | null;
  deaLevel?: "high" | "mid" | "low" | null; // 高位 / 中 (DEA≥0) / 低 (DEA<0)
  diff1m?: number | null;
  diff1mLevel?: "high" | "mid" | "low" | null; // 1m DIFF: 过去N根百分之x且>0算高，>0算中，<0算低
  diff5m?: number | null;
  diff5mLevel?: "high" | "mid" | "low" | null;
  diff15m?: number | null;
  diff15mLevel?: "high" | "mid" | "low" | null;
  weekChangePercent?: number | null;
  change60d?: "up" | "down" | null;
  supportMa?: string | null; // 支撑MA，如 "ma10"，无支撑为 null
  streakCount: number;
  streakDir: "up" | "down" | null;
  streakGainPercent?: number | null; // 连阳期间累计涨幅%
  greenBarRatio30?: number | null; // 近30根1m MACD 绿柱占比 (0~1)
  greenBarCount30?: number | null; // 近30根1m MACD 绿柱数量
  rank?: number | null; // 榜单自然排名 1..10，置顶或跌出时为 null
  prevRank?: number | null; // 上期自然排名 1..10
  rankChange?: "up" | "down" | null; // "up": 上升; "down": 下跌; null: 无变化/未对比
  rankDelta?: number | null; // 名次变动差值（如上升2位为 +2，下降3位为 -3，新进为 null）
  isDropped?: boolean; // 是否跌出前十
  isPinned?: boolean; // 是否置顶
  max1500?: number | null; // 兼容保留
  maxHour?: number | null;
  hourFirstClose?: number | null;
  hourFirstLow?: number | null;
}

export interface AlertSymbolItem {
  symbol: string;
  priceChangePercent?: number | null;
  streakCount: number;
  streakDir: "up" | "down" | null;
  streakGainPercent?: number | null;
  greenBarRatio30?: number | null;
  greenBarCount30?: number | null;
  diff1mLevel?: "high" | "mid" | "low" | null;
  supportMa?: string | null;
  rank?: number | null;
  rankChange?: "up" | "down" | null;
  rankDelta?: number | null;
  isDropped?: boolean;
}

export interface BoardAlertInfo {
  name: string;
  count: number;
  symbols: string[];
  items?: AlertSymbolItem[];
  triggered: boolean; // count >= min
}

export interface HighBullSummary {
  min: number;
  triggered: boolean; // 任意一个榜单 count >= min
  gainers: BoardAlertInfo;
  losers?: BoardAlertInfo;
  volume?: BoardAlertInfo;
}

// Keep HighBearSummary / HighBearState alias to prevent breaking existing types
export type HighBearSummary = HighBullSummary;
export interface HighBearState extends HighBullSummary {
  since?: string;
}

export interface Status {
  at: string; // ISO time of last successful refresh
  base: string;
  topN: number;
  highRatio: number;
  highWindow: number;
  highBull?: HighBullSummary; // present on successful refreshes
  highBear?: HighBullSummary; // backwards compatibility alias
  gainers: Row[];
  losers: Row[];
  volume?: Row[];
  error?: string;
}
