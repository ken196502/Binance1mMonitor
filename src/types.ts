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

// ---- 模拟交易 (Paper Trading) ----
export type PaperExitReason = "target" | "stop" | "timeout";
export type PaperSignalType =
  | "streak"
  | "rebound"
  | "deep_rebound"
  | "extreme_dev"
  | "ma30_pullback"
  | "ma60_support"
  | "rank1_first_pullback"
  | "second_wave_expansion";
export type PaperSignalLabel =
  | "连阳悬空"
  | "首次跌10%"
  | "跌到20%+"
  | "空连阳"
  | "空弱反弹"
  | "超跌反弹"
  | "新高顶背离"
  | "冲高极度乖离"
  | "极度乖离"
  | "龙头MA30回踩"
  | "龙头MA60深蹲"
  | "龙头MA30黄金回踩"
  | "龙头MA60深蹲托底"
  | "榜一首次回踩"
  | "龙头二浪突破";

export interface PaperExitParams {
  holdMinutes: number;
  exitX?: number;
  exitN?: number;
  exitM?: number;
  stopLossPercent?: number;       // e.g. 10.0 (%) 显式大止损比例
  tp1Percent?: number;            // e.g. 4.0 (%) 阶段一显式止盈比例
  tp2Percent?: number;            // e.g. 8.0 (%) 阶段二显式止盈比例
  moveSlToEntryAfterTp1?: boolean;// 阶段一止盈后剩余仓位止损移动至保本价 (Breakeven)
  leverage?: number;              // 策略指定专属杠杆倍数
}

export interface PaperExit {
  stage: 1 | 2;
  fraction: number; // 0.5 of initial notional
  exitTime: number; // timestamp ms
  exitPrice: number;
  reason: PaperExitReason;
  grossPnlUsdt: number;
  feeUsdt: number;
  slippageUsdt: number;
  netPnlUsdt: number;
  netPercent: number; // Net return % relative to stage notional
}

export interface PaperPendingOrder {
  id: string; // e.g. `pending-${symbol}-${createdAt}`
  symbol: string;
  side: "SHORT" | "LONG";
  leverage: number;     // 10x or 3x
  marginUsdt: number;   // 10 USDT
  notionalUsdt: number; // 100 USDT
  signalType?: PaperSignalType;
  signalLabel?: PaperSignalLabel;
  exitParams?: PaperExitParams;
  basePrice: number;    // 信号产生时的基准价
  limitPrice: number;   // 做空/做多挂单价
  limitOffsetPercent: number; // 上浮/下浮比例%
  currentPrice: number; // 最新市价
  dayChangePercent: number;
  rank?: number | null;
  amp30Percent: number;
  streakCount: number;
  upperShadowRatio: number;
  greenRatio: number;
  consecutiveGreenBars: number;
  createdAt: number;
  expireAt: number;     // 超时未成交自动撤单
  cancelBelowPrice?: number; // 若行情直接跌破该价格（如跌穿预估TP1），提前撤销挂单
  cancelAbovePrice?: number; // 做多时若行情直接暴涨超过该价格，提前撤销挂单
}

export interface PaperPosition {
  id: string; // e.g. `${symbol}-${entryTime}`
  symbol: string;
  side: "SHORT" | "LONG";
  leverage: number;     // 10x
  marginUsdt: number;   // 10 USDT
  notionalUsdt: number; // 100 USDT (margin * leverage)
  status: "OPEN" | "PARTIAL" | "CLOSED";
  signalType?: PaperSignalType;
  signalLabel?: PaperSignalLabel;
  exitParams?: PaperExitParams;
  entryTime: number;
  entryPrice: number;
  limitPrice?: number;  // 若来自限价挂单成交，记录挂单价格
  currentPrice: number;
  dayChangePercent: number;
  rank?: number | null;
  amp30Percent: number; // 30分钟振幅%
  streakCount: number;
  upperShadowRatio: number;
  greenRatio: number;
  consecutiveGreenBars: number;

  tp1Percent: number;
  sl1Percent: number;
  tp1Price: number;
  sl1Price: number;

  sl2Percent: number;
  tp2Percent: number;
  sl2Price: number;
  tp2Price: number;

  timeoutAt: number;
  moveSlToEntryAfterTp1?: boolean;
  isBreakevenArmed?: boolean;

  exits: PaperExit[];
  remainingFraction: number; // 1.0 -> 0.5 -> 0.0

  realizedNetPnlUsdt: number;
  unrealizedNetPnlUsdt: number;
  totalNetPnlUsdt: number;
  roePercent: number; // (totalNetPnlUsdt / marginUsdt) * 100%
  closedAt?: number;
  finalReason?: PaperExitReason;
}

export interface PaperAccount {
  initialBalanceUsdt: number; // 100 USDT
  balanceUsdt: number;        // 已实现余额
  equityUsdt: number;         // 净值 (余额 + 浮动盈亏)
  usedMarginUsdt: number;     // 已占用保证金
  availableMarginUsdt: number;// 可用保证金
  totalPnlUsdt: number;       // 累计总净盈亏
  accountRoiPercent: number;  // 账户总回报率%
}

export interface PaperTradingStats {
  initialBalanceUsdt: number;
  balanceUsdt: number;
  equityUsdt: number;
  accountRoiPercent: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  breakevenTrades: number;
  winRate: number; // 0..100
  totalNetPnlUsdt: number;
  grossGainsUsdt: number;
  grossLossesUsdt: number;
  profitFactor: number;
  avgTradePnlUsdt: number;
  realizedRewardRisk: number | null;
}

export interface PaperTradingState {
  account: PaperAccount;
  pendingOrders: PaperPendingOrder[];
  activePositions: PaperPosition[];
  closedPositions: PaperPosition[];
  stats: PaperTradingStats;
  updatedAt: string;
  summary?: PaperTradingSummary;
}

export interface PaperTradingSummaryConfig {
  leverage: number;
  streakLeverage?: number;
  trendLeverage?: number;
  longLeverage?: number;
  marginUsdt: number;
  marginRate?: number;             // 单笔保证金占总资产比例 (默认 0.20 即 20%)
  marginPercent?: number;          // 百分比格式 (默认 20%)
  maxPositions?: number;           // 全局最大同时持仓数 (默认 5)
  maxPositionsPerStrategy?: number;// 单策略最大同时持仓数 (默认 1)
  limitDivisor: number;
  holdMinutes: number;
  initialBalanceUsdt: number;
}

export interface PaperTradingSummary {
  account: PaperAccount;
  pendingOrders: PaperPendingOrder[];
  pendingCount: number;
  activeCount: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalNetPnlUsdt: number;
  profitFactor: number;
  activePositions: PaperPosition[];
  config?: PaperTradingSummaryConfig;
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
  paperTrading?: PaperTradingSummary;
  error?: string;
}

// ---- 图表（前端 TradingView Lightweight Charts）----
/** 一根 1m K 线及其叠加指标。前端只做渲染，指标口径全部由后端算好，
 *  保证图表与监控表格里的 MACD / 均线是同一套数值。 */
export interface ChartBar {
  time: number; // 开盘时间（epoch 毫秒，对齐整分钟）
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** 各周期均线，键为周期的十进制字符串（如 "5"）；预热不足时为 null（前端断线不画） */
  ma: Record<string, number | null>;
  dif: number; // MACD 快线 DIF(EMA12-EMA26)
  dea: number; // MACD 慢线 DEA(DIF 的 EMA9)
  hist: number; // MACD 柱 = 2 × (DIF - DEA)
}

export interface ChartPayload {
  symbol: string;
  interval: "1m";
  updatedAt: string;
  /** 数据来源：monitor = 复用监控已维护的 K 线缓存（含 WS 实时推进）；rest = 独立 REST 拉取 */
  source: "monitor" | "rest";
  maPeriods: number[];
  macd: { fast: number; slow: number; signal: number };
  bars: ChartBar[];
}
