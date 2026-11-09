import type { MA_REQUIREMENTS, MACD_REQUIREMENTS } from "./strategy-spec.ts";
import type { LiveTradingSummary } from "./live-trading-types.ts";
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
  surgeRatio5?: number | null;
  posIn24hRange?: number | null;
  biasRatio30?: number | null;
  goldenCrossAgo?: number | null;
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
  | "w_bottom_divergence" // 策略 1: 左侧3W底背离弹射做多
  | "rebound"             // 策略 2: 首次跌10%弱反弹做空
  | "streak"              // 策略 4: 新高顶背离闪击做空
  | "deep_rebound"        // 策略 5: 跌到20%+次级反弹做空
  | "hourly_suppression"  // 策略 6: 小时线压制做空
  | "kline_stats_short"   // 策略 7: 量化K线统计挖掘做空
  | "kline_stats_long"
  | (string & {});   // 策略 8: 量化K线统计挖掘做多
export type PaperSignalLabel =
  | "左侧3W底背离"
  | "首次跌10%"
  | "新高顶背离"
  | "跌到20%+"
  | "小时线压制"
  | "冲高破位"
  | "回踩支撑"
  | "均线受阻"
  | "空头排列"
  | "多头排列"
  | "均线突破"
  | "量化特征"
  | "量化特征做空"
  | "量化特征做多"
  | (string & {});

export interface KlineStatsStrategyLiveConfig {
  rules?: import("./strategy-rules.ts").FeatureCondition[];
  topN?: number;               // 适用榜单 Top N (默认 10)
  minDayChange?: number;       // 24h 涨幅门槛 (默认 10%)
  intervalWindow: number;      // 冲高/回溯窗口 (如 5m, 10m, 15m)
  ampDivisor: number;          // 冲高涨幅 >= 24h 涨幅 / ampDivisor (如 8, 10, 12)
  maRequirement: typeof MA_REQUIREMENTS[number];
  macdRequirement: typeof MACD_REQUIREMENTS[number];
  holdMinutes: number;         // 持仓分钟数 (如 15m, 30m, 45m)
  tp1Percent: number;          // TP1 止盈 % (如 3.0%)
  tp2Percent: number;          // TP2 止盈 % (如 7.0%)
  stopLossPercent: number;     // 止损 % (如 5.0%)
  moveSlToEntryAfterTp1?: boolean; // TP1 达成后是否移动保本
  cooldownMinutes?: number;    // 同币种冷静期 (默认 20m)
  leverage?: number;           // 策略杠杆
}

export interface PaperExitParams {
  factorRevision?: string;
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

export interface PaperDirectionStats {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  breakevenTrades: number;
  winRate: number;
  totalNetPnlUsdt: number;
}

export interface PaperTradingStats {
  bySide: Record<"LONG" | "SHORT", PaperDirectionStats>;
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
  strategyRuntime?: import("./strategy-engine.ts").StrategyRuntimeState;
  strategyMonitor?: import("./strategy-engine.ts").StrategyMonitorResult[];
  factorMining?: import("./factor-policy.ts").FactorMiningState;
  account: PaperAccount;
  pendingOrders: PaperPendingOrder[];
  activePositions: PaperPosition[];
  closedPositions: PaperPosition[];
  stats: PaperTradingStats;
  stats24h?: PaperTradingStats;
  updatedAt: string;
  reboundWatchlist?: any[];
  summary?: PaperTradingSummary;
}

export interface PaperTradingSummaryConfig {
  strategies?: import("./strategy-definition.ts").StrategyDefinition[];
  factorMining?: import("./factor-policy.ts").FactorMiningConfig;
  leverage: number;
  streakLeverage?: number;
  trendLeverage?: number;
  longLeverage?: number;
  klineStatsLeverage?: number;
  marginUsdt: number;
  marginRate?: number;             // 单笔保证金占总资产比例 (默认 0.20 即 20%)
  marginPercent?: number;          // 百分比格式 (默认 20%)
  maxPositions?: number;           // 全局最大同时持仓数 (默认 5)
  maxPositionsPerStrategy?: number;// 单策略最大同时持仓数 (默认 1)
  limitDivisor: number;
  holdMinutes: number;
  initialBalanceUsdt: number;
  topN?: number;
  ampDivisor?: number;
  supportMaPeriods?: readonly number[];
  enableStreak?: boolean;
  enableRebound?: boolean;
  enableDeepRebound?: boolean;
  enableHourlySuppression?: boolean;
  enableLongs?: boolean;
  enableWBottomDivergence?: boolean;
  enableKlineStatsShort?: boolean;
  enableKlineStatsLong?: boolean;
  streakConfig?: any;
  reboundConfig?: any;
  deepReboundConfig?: any;
  hourlySuppressionConfig?: any;
  wBottomDivergenceConfig?: any;
  klineStatsShortConfig?: Partial<KlineStatsStrategyLiveConfig>;
  klineStatsLongConfig?: Partial<KlineStatsStrategyLiveConfig>;
}

export interface PaperTradingSummary {
  factorMining?: import("./factor-policy.ts").FactorMiningState & { entryAllowed: Record<"LONG" | "SHORT", boolean> };
  bySide?: Record<"LONG" | "SHORT", PaperDirectionStats>;
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
  stats24h?: PaperTradingStats;
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
  liveTrading?: LiveTradingSummary;
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
  /** 24h 涨跌幅百分比（来自涨跌幅榜快照，未匹配时为 null） */
  dayChangePercent?: number | null;
}

// ---- K线统计与特征挖掘 (K-Line Stats & Feature Analytics) ----
export type MaAlignmentType =
  | "bullish_full"      // 完全多头排列 (MA5 > MA10 > MA20 > MA30 > MA60)
  | "bullish_short"     // 短期多头 (MA5 > MA10 > MA20)
  | "bearish_full"      // 完全空头排列 (MA5 < MA10 < MA20 < MA30 < MA60)
  | "bearish_short"     // 短期空头 (MA5 < MA10 < MA20)
  | "tangled";          // 均线缠绕震荡

export type Ma3BarPattern =
  | "sustained_bull"    // 持续多头 (近3根连续保持多头排列，稳固发散)
  | "fresh_bull"        // 刚成多头 (前两根非多头，最新1~2根刚交叉形成多头，起爆拐点)
  | "sustained_bear"    // 持续空头 (近3根连续保持空头排列，弱势受阻)
  | "fresh_bear"        // 刚成空头 (前两根非空头，最新1~2根刚死叉形成空头，破位拐点)
  | "bull_converging"   // 多头收敛 (多头排列但均线间距收窄走平，动能减弱)
  | "bear_converging"   // 空头收敛 (空头排列但均线间距收窄走平，跌势减缓)
  | "tangled";          // 交织缠绕震荡

export interface Ma3BarStep {
  barIndex: number;
  time: number;
  type: MaAlignmentType;
  label: string;
  orderText: string;
  spreadMa5Ma10: number; // (MA5 - MA10) / MA10 * 100%
  spreadMa5Ma20: number; // (MA5 - MA20) / MA20 * 100%
}

export interface MaItem {
  period: number;
  value: number;
  slope: "up" | "down" | "flat"; // 斜率趋势
  biasPercent: number;           // (close - ma) / ma * 100% 乖离率
  support: boolean;              // low <= ma && close > ma 回踩支撑
  resistance: boolean;           // high >= ma && close < ma 冲高受阻
  isAbove: boolean;              // close > ma
  breakout: boolean;             // open <= ma && close > ma 向上突破
  breakdown: boolean;            // open >= ma && close < ma 向下跌破
}

export interface MaAlignmentInfo {
  type: MaAlignmentType;
  label: string;                 // e.g. "完全多头排列"
  order: number[];               // e.g. [5, 10, 20, 30, 60] 从大到小排列
  orderText: string;             // e.g. "MA5 > MA10 > MA20 > MA30 > MA60"
  mas: Record<number, MaItem>;

  // 比对最近 3 根 1m K 线的均线动态演化分析
  pattern3Bars?: Ma3BarPattern;  // 3根综合模式
  pattern3BarsLabel?: string;    // e.g. "刚成多头 (起爆交叉)" / "持续3根完全多头"
  history3Bars?: Ma3BarStep[];   // 最近3根各自的排列明细 [T-2, T-1, T]
  transitionText?: string;       // 演化路径文本: e.g. "交织 ➔ 短多 ➔ 完全多头 (加速发散)"
  streakBars?: number;           // 连续保持当前排列状态的根数
  isDiverging?: boolean;         // 均线间距是否在逐根扩大发散
}

export interface OhlcComparisonInfo {
  close: number;
  open: number;
  high: number;
  low: number;
  bodyPercent: number;           // (close - open) / open * 100%
  upperWickPercent: number;      // 上影线百分比
  lowerWickPercent: number;      // 下影线百分比
  isBullish: boolean;            // close >= open
  supports: number[];            // 获得支撑的MA周期列表，如 [10, 20]
  resistances: number[];         // 受到压制的MA周期列表，如 [60]
  aboveCount: number;            // 站上均线条数 (如 4/5)
}

export interface MacdStatsInfo {
  hist: number;
  dif: number;
  dea: number;
  isBullishCross: boolean;       // dif >= dea
  isAboveZero: boolean;          // dif > 0 && dea > 0
  greenBarRatio15: number;       // 近15根绿柱比例
  greenCount15: number;
  greenBarRatio30: number;       // 近30根绿柱比例
  greenCount30: number;
  greenStreak: number;           // 连绿根数
  redStreak: number;             // 连红根数
}

export interface IntervalSignal {
  time: number;                  // 发生时间 / 段终点极值时间 (epoch ms)
  barIndex: number;              // 在当前 bars 中的索引
  type: "surge" | "drop";        // 冲高 / 回撤
  windowMinutes: number;         // 区间长度 (如 5m, 15m)
  intervalChangePercent: number; // 区间实际涨跌幅% / 该段最大振幅%
  dayChangePercent: number;      // 24h 涨幅%
  ratioToDayChange: number;      // 该段振幅 / 24h涨幅 比例 (如 0.125 即 12.5%)
  divisor: number;               // 对应的 1/ratio (如 8.0，即 24h/8)
  price: number;                 // 当时价格 / 极值价格
  maAlignment: MaAlignmentInfo;  // 当时均线排列
  ohlc: OhlcComparisonInfo;      // 当时K线OHLC与均线对比
  macd: MacdStatsInfo;           // 当时MACD绿柱比例

  // 振幅段扩展详细字段
  intervalStartTime?: number;    // 所在区间开始时间
  intervalEndTime?: number;      // 所在区间结束时间
  segmentStartTime?: number;     // 该段起点时间
  segmentEndTime?: number;       // 该段终点时间
  segmentStartPrice?: number;    // 该段起点价格
  segmentEndPrice?: number;      // 该段终点价格
  segmentBarsCount?: number;     // 该段K线根数
  segmentGreenCount?: number;    // 该段内MACD绿柱根数 (hist > 0)
  segmentGreenRatio?: number;    // 该段内绿柱比例 (segmentGreenCount / segmentBarsCount)

  // 【核心因果特性】：达标振幅前一段区间的特征统计 (起爆前兆特征)
  precursor?: PrecursorFeatures;
}

export interface PrecursorFeatures {
  windowMinutes: number;         // 前一段区间考察窗口大小
  startTime: number;             // 前一段区间开始时间
  endTime: number;               // 前一段区间结束时间 (起爆点)
  startBarIndex: number;         // 前一段区间起始 bar 索引
  endBarIndex: number;           // 前一段区间结束 bar 索引 (起爆点 bar)
  greenRatio: number;            // 前一段区间 MACD 绿柱比例
  greenCount: number;            // 前一段区间 MACD 绿柱根数
  totalBars: number;             // 前一段区间 K 线总数
  maAlignment: MaAlignmentInfo;  // 起爆点均线排列状态
  ohlc: OhlcComparisonInfo;      // 起爆点 K 线形态与支撑/阻力
  macd: MacdStatsInfo;           // 起爆点 MACD 状态
  preAmpPercent: number;         // 前一段区间自身振幅% (判断是否窄幅蓄势整理)
}
