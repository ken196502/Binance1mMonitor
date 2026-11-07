// Legacy configuration names remain import-compatible; execution lives in strategy-engine.ts.
import type { Candle } from "./macd.ts";
import type { PaperSignalLabel } from "./types.ts";

export interface PeakReboundLiveConfig {
  pullbackX: number; // e.g. 10.0 (%)
  reboundY: number;  // e.g. 4.0 (%)
  shortMa: number;   // e.g. 5
  mediumMa?: number; // e.g. 15 (三均线组合中周期)
  longMa: number;    // e.g. 30 (三均线组合长周期)
  longMaOffsetPercent: number; // e.g. 0.5 (%)
  minGreenRatio20: number; // e.g. 0.65 (近20根1m MACD绿柱占比 > minGreenRatio20)
  requireMaSlopeDown?: boolean; // e.g. true (中长均线向下倾斜)
  minReboundUpCandles?: number; // e.g. 1 (反弹区间最少阳线数量)
  maxFibRetracement?: number;   // e.g. 0.50 (弱势反弹斐波那契回撤上限)
  minUpperShadowRatio?: number; // e.g. 0.30 (信号K线上影线占比阈值)
  requireBearishOrUpperShadow?: boolean; // e.g. true (信号K线需收阴或留显著上影线)
  holdMinutes: number; // e.g. 30
  exitX: number; // Stage 1 denominator (e.g. 35)
  exitN: number; // Stage 2 SL multiplier (e.g. 2.0)
  exitM: number; // Stage 2 TP multiplier (e.g. 1.5)
  stopLossPercent?: number; // 显式大止损比例 (e.g. 10.0%)
  tp1Percent?: number;      // 阶段一止盈比例 (e.g. 4.0%)
  tp2Percent?: number;      // 阶段二止盈比例 (e.g. 8.0%)
  moveSlToEntryAfterTp1?: boolean; // 阶段一达标后移动保本止损
  watchWindowHours: number; // how long to observe after reaching rank 1 (default 48h)
}

export const PEAK_REBOUND_LIVE_DEFAULT_CONFIG: PeakReboundLiveConfig = {
  pullbackX: 10.0,
  reboundY: 4.0,
  shortMa: 5,
  mediumMa: 15,
  longMa: 30,
  longMaOffsetPercent: 0.5,
  minGreenRatio20: 0.55,
  requireMaSlopeDown: true,
  holdMinutes: 30,
  exitX: 35,
  exitN: 2.0,
  exitM: 1.5,
  watchWindowHours: 48,
};

// 黄金双速最优组合 (Dual-Speed Ensemble) 专属长波段配置 (胜率 80.3%, PF 2.42, 3x 杠杆累计收益 +189.6%)
export const DUAL_SPEED_PEAK_REBOUND_CONFIG: PeakReboundLiveConfig = {
  ...PEAK_REBOUND_LIVE_DEFAULT_CONFIG,
  holdMinutes: 90,
  exitM: 2.0,
  stopLossPercent: 10.0,
  tp1Percent: 4.0,
  tp2Percent: 8.0,
  moveSlToEntryAfterTp1: true,
};

export interface WatchState {
  symbol: string;
  enteredAt: number;
  lastRank1Time: number;
  dayChangeAtRank1: number;
  state: 'watching_peak' | 'pulled_back' | 'rebounded';
  peakPrice: number;
  peakTime: number;
  troughPrice: number;
  troughTime: number;
  troughIndex: number;
  cooldownUntil: number;
}

export interface PeakReboundLiveSignal {
  symbol: string;
  time: number;
  dayChangePercent: number;
  peakPrice: number;
  pullbackPercent: number;
  troughPrice: number;
  reboundPercent: number;
  fibRetracement?: number;
  reboundUpCandles?: number;
  upperShadowRatio?: number;
  piercedMa: number;
  mediumMa?: number;
  greenRatio20: number;
  candle: Candle;
}


export type UnifiedSignalType = 'streak' | 'rebound' | 'deep_rebound' | 'hourly_suppression';

export interface StreakStrategyLiveConfig {
  topN: number;
  xMinutes?: number; // 冲高回溯窗口，默认 5 分钟
  ampDivisor: number; // x 分钟内涨幅 >= 24h 涨幅 / ampDivisor (默认 10)
  require24hNewHigh?: boolean; // 是否要求创 24h 新高 (默认 true)
  supportMaPeriods: readonly number[]; // e.g. [3, 7, 15]
  holdMinutes: number;            // e.g. 15
  exitX: number;                  // e.g. 50
  exitN: number;                  // e.g. 1.5
  exitM: number;                  // e.g. 3.0
  // DEA 顶背离配置 (方案 B：实测胜率 85.7%, PF 6.46，大幅优于传统双峰背离)
  requireDeaDivergence?: boolean; // 是否开启 DEA 顶背离检测 (默认 true)
  deaLookbackMinutes?: number;    // DEA 历史峰值回溯窗口 (默认 30 分钟)
  // MACD 双峰顶背离配置 (向下兼容可选)
  requireMacdDivergence?: boolean; // 是否开启传统 MACD 顶背离检测
  divergenceLookbackMin?: number; // 背离前高最小跨度 (默认 10 根)
  divergenceLookbackMax?: number; // 背离前高最大跨度 (默认 20 根)
  requireDoubleDivergence?: boolean; // 是否要求 DIF 与 Hist 双重顶背离 (默认 true)
  requireBearish?: boolean; // 信号K线需收阴确认假突破 (默认 true，开启后规避顺势暴涨冲高风险)
  maxLowerShadowPercent?: number; // 信号K线下影线占价格比例上限 (防止强买盘托底)
  // 向下兼容可选字段 (保留自定义测试支持)
  minStreakCount?: number;
  minUpperShadowRatio?: number;
  maxUpperShadowRatio?: number;
  greenWindow?: number;
  minGreenRatio?: number;
  minConsecutiveGreenBars?: number;
}

export const STREAK_LIVE_DEFAULT_CONFIG: StreakStrategyLiveConfig = {
  topN: 10,
  xMinutes: 5,
  ampDivisor: 10, // 5m 涨幅 >= 24h 涨幅 / 10
  require24hNewHigh: true,
  supportMaPeriods: [3, 7, 15],
  holdMinutes: 15,
  exitX: 50,
  exitN: 1.5,
  exitM: 3.0,
  requireDeaDivergence: true,    // 核心优化方案 B：开启 DEA 顶背离 (DEA 过去 N 分钟达峰且当前拐头向下)
  deaLookbackMinutes: 30,        // 回溯 30m 内 DEA 峰值
  requireMacdDivergence: false,  // 传统双峰背离设为 false (若显式为 true 则使用传统背离)
  divergenceLookbackMin: 10,
  divergenceLookbackMax: 20,
  requireDoubleDivergence: true,
  requireBearish: true,          // 优化：信号K线必须收阴确认假突破冲高回落
};

export interface DeepReboundLiveConfig {
  pullbackX: number; // e.g. 20.0 (距离 24h 最高点跌超过 20%)
  reboundY: number;  // e.g. 5.0 (距离 10m 最低点反弹超过 5%)
  lowWindowMinutes: number; // e.g. 10 (最近 10 分钟最低点)
  shortMa: number;   // e.g. 15
  longMa: number;    // e.g. 30
  minGreenRatio20: number; // e.g. 0.65 (近 20 根 1m MACD 绿柱占比 > 65%)
  requireMaSlopeDown: boolean; // e.g. true (MA30 向下倾斜确认)
  holdMinutes: number; // 默认 90 分钟 (最高胜率与 Calmar 解)
  exitX: number; // e.g. 35
  exitN: number; // e.g. 2.0
  exitM: number; // e.g. 4.0 (胜率 87.5%, PF 7.15)
  stopLossPercent?: number; // 显式大止损比例 (默认 10.0%)
  tp1Percent?: number;      // 阶段一止盈比例 (默认 4.0%)
  tp2Percent?: number;      // 阶段二止盈比例 (默认 8.0%)
  moveSlToEntryAfterTp1?: boolean; // 阶段一达标后移动保本止损
  cooldownMinutes: number; // e.g. 30
}

export const DEEP_REBOUND_LIVE_DEFAULT_CONFIG: DeepReboundLiveConfig = {
  pullbackX: 20.0,
  reboundY: 5.0,
  lowWindowMinutes: 10,
  shortMa: 15,
  longMa: 30,
  minGreenRatio20: 0.55,
  requireMaSlopeDown: true,
  holdMinutes: 30,
  exitX: 35,
  exitN: 2.0,
  exitM: 4.0,
  cooldownMinutes: 30,
};

// 黄金双速最优组合 (Dual-Speed Ensemble): 跌到20%+ 次级反弹长波段参数 (胜率 83.3%, PF 2.97, 3x 杠杆累计收益 +31.4%)
export const DUAL_SPEED_DEEP_REBOUND_CONFIG: DeepReboundLiveConfig = {
  ...DEEP_REBOUND_LIVE_DEFAULT_CONFIG,
  holdMinutes: 90,
  stopLossPercent: 10.0,
  tp1Percent: 4.0,
  tp2Percent: 8.0,
  moveSlToEntryAfterTp1: true,
};

export interface HourlySuppressionLiveConfig {
  topN: number;               // 适用榜单排名前 N (默认 10)
  requireSurge?: boolean;     // 是否要求结合 base 冲高动能过滤 (默认 true)
  xMinutes?: number;          // 冲高回溯窗口，默认 5 分钟
  ampDivisor?: number;        // x 分钟内冲高涨幅 >= 24h 涨幅 / ampDivisor (默认 10)
  nGreenBars: number;         // 近 N 根已收盘 1m MACD 绿柱 (默认 3 根)
  minDayChange?: number;      // 24h 涨幅门槛 (深跌狂暴狙击默认 10)
  minDropFrom24h?: number;    // 距离 24h 最高价至少跌了 x% (深跌狂暴狙击默认 20%)
  requireMa60GtMa10GtMa20?: boolean; // 是否要求 MA60 > MA10 > MA20 (深跌狂暴狙击默认 true)
  requireCloseBelowMa?: boolean; // 是否要求收盘价受制于 MA60 之下 (默认 false)
  requireMaSlopeDown?: boolean;  // 是否要求 MA60 均线下倾确认 (默认 false)
  requireBearish?: boolean;      // 是否要求信号K线收阴 (默认 false)
  holdMinutes: number;        // 持仓时长 (默认 30 分钟)
  exitX: number;              // 动态退出参数 X (默认 35)
  exitN: number;              // 动态退出止损倍数 N (默认 2.0)
  exitM: number;              // 动态退出止盈倍数 M (默认 3.0)
  stopLossPercent?: number;   // 显式止损比例 (深跌狂暴狙击默认 4.0%)
  tp1Percent?: number;        // 阶段一止盈比例 (深跌狂暴狙击默认 3.0%)
  tp2Percent?: number;        // 阶段二止盈比例 (深跌狂暴狙击默认 6.0%)
  moveSlToEntryAfterTp1?: boolean; // 阶段一止盈后移动保本止损 (默认 true)
  cooldownMinutes: number;    // 同币种冷却时间 (默认 20 分钟)
  leverage?: number;          // 策略专属杠杆 (默认 3x)
}

export const HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG: HourlySuppressionLiveConfig = {
  topN: 10,
  requireSurge: true,
  xMinutes: 5,
  ampDivisor: 10,
  nGreenBars: 3,
  minDayChange: 10,
  minDropFrom24h: 20,
  requireMa60GtMa10GtMa20: true,
  requireCloseBelowMa: false,
  requireMaSlopeDown: false,
  requireBearish: false,
  holdMinutes: 30,
  exitX: 35,
  exitN: 2.0,
  exitM: 3.0,
  stopLossPercent: 4.0,
  tp1Percent: 3.0,
  tp2Percent: 6.0,
  moveSlToEntryAfterTp1: true,
  cooldownMinutes: 20,
  leverage: 3,
};

export interface UnifiedLiveConfig {
  reboundConfig?: Partial<PeakReboundLiveConfig>;
  deepReboundConfig?: Partial<DeepReboundLiveConfig>;
  streakConfig?: Partial<StreakStrategyLiveConfig>;
  hourlySuppressionConfig?: Partial<HourlySuppressionLiveConfig>;
  preventConflict?: boolean; // Prevent double-entry if the same symbol has an active trade (default true)
  enableStreak?: boolean;     // 是否启用新高顶背离做空 (默认 true)
  enableRebound?: boolean;    // 是否启用首次跌10%弱反弹做空 (默认 true)
  enableDeepRebound?: boolean;// 是否启用跌20%+超跌反弹做空 (默认 true)
  enableHourlySuppression?: boolean; // 是否启用小时线压制做空 (默认 true)
}

export const UNIFIED_LIVE_DEFAULT_CONFIG: Required<UnifiedLiveConfig> = {
  reboundConfig: PEAK_REBOUND_LIVE_DEFAULT_CONFIG,
  deepReboundConfig: DEEP_REBOUND_LIVE_DEFAULT_CONFIG,
  streakConfig: STREAK_LIVE_DEFAULT_CONFIG,
  hourlySuppressionConfig: HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG,
  preventConflict: true,
  enableStreak: true,
  enableRebound: true,
  enableDeepRebound: true,
  enableHourlySuppression: true,
};

// 黄金双速最优组合 (Dual-Speed Ensemble): 首次跌10%、跌到20%+ 走 3x / 10%大止损 / 90m 长波段，新高顶背离保留 15m 闪击战
export const DUAL_SPEED_UNIFIED_CONFIG: Required<UnifiedLiveConfig> = {
  reboundConfig: DUAL_SPEED_PEAK_REBOUND_CONFIG,
  deepReboundConfig: DUAL_SPEED_DEEP_REBOUND_CONFIG,
  streakConfig: STREAK_LIVE_DEFAULT_CONFIG,
  hourlySuppressionConfig: HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG,
  preventConflict: true,
  enableStreak: true,
  enableRebound: true,
  enableDeepRebound: true,
  enableHourlySuppression: true,
};

export interface UnifiedLiveSignal {
  id: string;
  type: UnifiedSignalType;
  label: PaperSignalLabel;
  symbol: string;
  time: number;
  dayChangePercent: number;
  entryPrice: number;
  exitParams: {
    holdMinutes: number;
    exitX: number;
    exitN: number;
    exitM: number;
    stopLossPercent?: number;
    tp1Percent?: number;
    tp2Percent?: number;
    moveSlToEntryAfterTp1?: boolean;
    leverage?: number;
  };
  details: {
    reboundSignal?: PeakReboundLiveSignal;
    deepReboundSignal?: {
      dropFrom24h: number;
      reboundFrom10m: number;
      greenRatio20: number;
      ma15: number;
      ma30: number;
    };
    streakSignal?: {
      streakCount: number;
      amp30Percent: number;
      greenRatio: number;
      consecutiveGreenBars: number;
      upperShadowRatio: number;
      divergence?: {
        prevPeakPrice?: number;
        prevPeakTime?: number;
        curHist?: number;
        prevHist?: number;
        curDif?: number;
        prevDif?: number;
        curDea?: number;
        maxDea?: number;
        deaPeakOffsetBars?: number;
      };
    };
    hourlySuppressionSignal?: {
      ma60: number;
      high: number;
      low: number;
      close: number;
      nGreenBars: number;
      xRisePercent?: number;
      dropFrom24h?: number;
    };
  };
}

export interface ActivePositionInfo {
  tradeId: string;
  type: UnifiedSignalType;
  entryTime: number;
  maxExitTime: number;
}


export type UnifiedLongSignalType = 'w_bottom_divergence';

/**
 * 核心策略一：【左侧 3W 底背离弹射做多】 (Left-side 3W Bottom Divergence Catapult Long)
 * 核心逻辑：龙头强势币冲高后从近期高点深蹲回撤 >= 4%，在 10~30 根 K 线内形成 W 底 / 3探底整理区。
 * 第一底在 8~25 根前，两底之间有波峰反弹 >= 1.5% 构成颈线；
 * 当前第二底与前底平齐或微创新低，但 MACD 快线 DIF 与 Hist 柱体双重显著抬高 (强底背离)，
 * 当前收出放量弹射阳线启动起爆。实测胜率 76.6%, PF 1.99!
 */
export interface WBottomDivergenceLiveConfig {
  topN: number;               // 默认 10 (涨幅榜 Top 10)
  minDayChange: number;       // 默认 20.0 (24h 涨幅 >= 20%)
  minDropPercent: number;     // 默认 4.0% (近30根从高点回撤 >= 4%)
  prevBottomMinBars: number;  // 默认 8 (第一底距离当前最小根数)
  prevBottomMaxBars: number;  // 默认 25 (第一底距离当前最大根数)
  minNecklineBounce: number;  // 默认 1.5% (两底之间波峰反弹幅度 >= 1.5%)
  maxBottomToleranceRatio: number; // 默认 1.005 (当前底 <= 前低 * 1.005)
  minBottomFloorRatio: number;     // 默认 0.970 (当前底 >= 前低 * 0.970，防止深跌破位)
  requireMacdDivergence: boolean;  // 默认 true (DIF 和 Hist 双重抬高)
  requireCatapultBull: boolean;    // 默认 true (收阳且收盘突破前根高点)
  holdMinutes: number;        // 默认 30 分钟 (弹性好，见效快)
  stopLossPercent: number;    // 默认 7.0%
  tp1Percent: number;         // 默认 3.0%
  tp2Percent: number;         // 默认 8.0%
  moveSlToEntryAfterTp1: boolean; // 默认 true
  cooldownMinutes: number;    // 默认 20 分钟
  leverage: number;           // 默认 3x
}

export const W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG: WBottomDivergenceLiveConfig = {
  topN: 10,
  minDayChange: 20.0,
  minDropPercent: 4.0,
  prevBottomMinBars: 8,
  prevBottomMaxBars: 25,
  minNecklineBounce: 1.5,
  maxBottomToleranceRatio: 1.005,
  minBottomFloorRatio: 0.970,
  requireMacdDivergence: true,
  requireCatapultBull: true,
  holdMinutes: 30,
  stopLossPercent: 7.0,
  tp1Percent: 3.0,
  tp2Percent: 8.0,
  moveSlToEntryAfterTp1: true,
  cooldownMinutes: 20,
  leverage: 3,
};

export interface UnifiedLongLiveConfig {
  wBottomDivergenceConfig?: Partial<WBottomDivergenceLiveConfig>;
  preventConflict?: boolean;
  enableWBottomDivergence?: boolean;
}

export const UNIFIED_LONG_LIVE_DEFAULT_CONFIG: Required<UnifiedLongLiveConfig> = {
  wBottomDivergenceConfig: W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG,
  preventConflict: true,
  enableWBottomDivergence: true,
};

export interface UnifiedLongLiveSignal {
  id: string;
  type: UnifiedLongSignalType;
  label: string;
  symbol: string;
  time: number;
  dayChangePercent: number;
  entryPrice: number;
  side: 'LONG';
  exitParams: {
    holdMinutes: number;
    stopLossPercent: number;
    tp1Percent: number;
    tp2Percent: number;
    moveSlToEntryAfterTp1: boolean;
    leverage: number;
  };
  details: {
    ampX?: number;
    maxAllowedAmp?: number;
    boxAmp?: number;
    dropFrom24h?: number;
    maLevel?: number;
    dif?: number;
    barReturn?: number;
    drop30?: number;
    prevLow?: number;
    difNow?: number;
    difPrev?: number;
  };
}

export interface ActiveLongPositionInfo {
  tradeId: string;
  type: UnifiedLongSignalType;
  entryTime: number;
  maxExitTime: number;
}

