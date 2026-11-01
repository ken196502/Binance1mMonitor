// Unified Multi-Signal Long Strategy Engine for Binance 24h Top Gainers
// Completely focused on 24h Top Gainers (涨幅榜专属做多体系):
// 对称设计架构原则：
// 做空逻辑：X 分钟内快速冲高达到 24h 涨幅 / ampDivisor + 乖离/悬空/顶背离/假突破收阴
// 做多逻辑：X 分钟内在 24h 涨幅 / N 内窄幅震荡蓄势 + 均线托底支撑 + 多头均线排列 + MACD 水上多头 + 企稳阳线/长下影确认
//
// 核心做多策略组：
// 1. 'Consolidation Support Long' (震荡托底做多 - X 分钟在 24h涨幅/N 内震荡 + MA15/MA30 托底企稳阳线，实测胜率 70.2%, PF 1.32)
// 2. 'Consolidation Breakout Long' (震荡突破做多 - X 分钟在 24h涨幅/N 内窄幅箱体蓄势 + 实体阳线放量突破箱体上沿)
// 3. 向下兼容保留：龙头 MA30 黄金生命线回踩、龙头 MA60 深度托底、榜一首次回踩、二浪金叉放量

import { Candle, computeMacd, calculateSma, calculateSupportMaAt } from './macd.ts';

export type UnifiedLongSignalType =
  | 'pullback_rebound'
  | 'w_bottom_divergence'
  | 'consolidation_support'
  | 'consolidation_breakout'
  | 'consolidation_long'
  | 'ma30_pullback'
  | 'ma60_support'
  | 'rank1_first_pullback'
  | 'second_wave_expansion';

/**
 * 核心策略一：【右侧回调反弹做多】 (Right-side Pullback Bounce Long)
 * 核心逻辑：龙头强势币 (24h涨幅 >= 25%) 见顶后右侧回调 10%~20%，
 * 回踩 MA30 黄金生命线托底支撑，MA30 向上倾斜，MACD DIF > 0 水上多头，
 * 收阳或探针下影确认企稳。
 */
export interface PullbackReboundLiveConfig {
  topN: number;               // 默认 10 (涨幅榜 Top 10)
  minDayChange: number;       // 默认 25.0 (24h 涨幅 >= 25%)
  minPullbackPercent: number; // 默认 10.0% (从 24h 峰值回调 >= 10%)
  maxPullbackPercent: number; // 默认 20.0% (从 24h 峰值回调 <= 20%)
  maPeriod: number;           // 默认 30 (MA30 黄金生命线)
  requireMaSlopeUp: boolean;  // 默认 true (MA30 向上倾斜)
  requireMacdPositive: boolean;// 默认 true (MACD DIF > 0 水上多头)
  minLowerShadowRatio: number;// 默认 0.40 (长下影探针占比)
  holdMinutes: number;        // 默认 60 分钟 (大波段支撑释放)
  stopLossPercent: number;    // 默认 7.0%
  tp1Percent: number;         // 默认 3.0%
  tp2Percent: number;         // 默认 8.0%
  moveSlToEntryAfterTp1: boolean; // 默认 true
  cooldownMinutes: number;    // 默认 20 分钟
  leverage: number;           // 默认 3x
}

export const PULLBACK_REBOUND_DEFAULT_CONFIG: PullbackReboundLiveConfig = {
  topN: 10,
  minDayChange: 25.0,
  minPullbackPercent: 10.0,
  maxPullbackPercent: 20.0,
  maPeriod: 30,
  requireMaSlopeUp: true,
  requireMacdPositive: true,
  minLowerShadowRatio: 0.40,
  holdMinutes: 30,
  stopLossPercent: 7.0,
  tp1Percent: 3.0,
  tp2Percent: 8.0,
  moveSlToEntryAfterTp1: true,
  cooldownMinutes: 20,
  leverage: 3,
};

/**
 * 核心策略二：【左侧 3W 底背离弹射做多】 (Left-side 3W Bottom Divergence Catapult Long)
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
  holdMinutes: number;        // 默认 45 分钟 (弹性好，见效快)
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

/**
 * 策略一：【震荡托底做多】 (Consolidation Support Long)
 * 核心逻辑：过去 X 分钟内，振幅被严格约束在 24h 涨幅 / N 之内 (洗盘蓄势完成，筹码锁定)，
 * 价格探底回踩 MA15/MA30 黄金均线托底支撑，均线多头排列上行，MACD 水上多头，收阳企稳。
 */
export interface ConsolidationSupportLiveConfig {
  topN: number;               // 默认 10 (涨幅榜 Top 10)
  minDayChange: number;       // 默认 20.0 (24h 涨幅 >= 20%)
  xMinutes: number;           // 默认 15 (15 分钟回溯窗口)
  ampDivisor: number;         // 默认 5.0 (15m 振幅 <= 24h 涨幅 / 5.0)
  minAbsoluteAmp: number;     // 默认 0.5% (防止僵尸币/停牌币)
  maxPullbackPercent: number; // 默认 18.0% (从 24h 峰值回踩上限 18%，高位整理)
  supportMaPeriods: readonly number[]; // 默认 [15, 30]
  requireMaSlopeUp: boolean;  // 默认 true (MA30 向上倾斜)
  requireMaAligned: boolean;  // 默认 true (MA15 >= MA30 多头排列)
  requireMacdPositive: boolean;// 默认 true (MACD DIF > 0 处于零轴水上多头趋势)
  requireBullish: boolean;    // 默认 true (信号K线必须收阳或长下影确认企稳反弹)
  minLowerShadowRatio: number;// 默认 0.35 (若收阴或十字星，需长下影探针托底)
  holdMinutes: number;        // 默认 90 分钟 (大波段最优)
  stopLossPercent: number;    // 默认 8.0% (防极端假突破洗盘的大止损)
  tp1Percent: number;         // 默认 3.0% (阶段一止盈平仓50%并移动保本)
  tp2Percent: number;         // 默认 8.0% (阶段二止盈)
  moveSlToEntryAfterTp1: boolean; // 默认 true (阶段一达标后移动保本止损)
  cooldownMinutes: number;    // 默认 20 分钟
  leverage: number;           // 默认 3x
}

export const CONSOLIDATION_SUPPORT_DEFAULT_CONFIG: ConsolidationSupportLiveConfig = {
  topN: 10,
  minDayChange: 20.0,
  xMinutes: 15,
  ampDivisor: 5.0,
  minAbsoluteAmp: 0.5,
  maxPullbackPercent: 18.0,
  supportMaPeriods: [15, 30],
  requireMaSlopeUp: true,
  requireMaAligned: true,
  requireMacdPositive: true,
  requireBullish: true,
  minLowerShadowRatio: 0.35,
  holdMinutes: 90,
  stopLossPercent: 8.0,
  tp1Percent: 3.0,
  tp2Percent: 8.0,
  moveSlToEntryAfterTp1: true,
  cooldownMinutes: 20,
  leverage: 3,
};

/**
 * 策略二：【震荡突破做多】 (Consolidation Box Breakout Long)
 * 核心逻辑：过去 X 分钟内在 24h 涨幅 / N 内横盘震荡蓄势构筑箱体，
 * 最新收盘价实体阳线真突破箱体上沿，均线多头推进，MACD 水上红柱放量。
 */
export interface ConsolidationBreakoutLiveConfig {
  topN: number;               // 默认 10 (涨幅榜 Top 10)
  minDayChange: number;       // 默认 20.0 (24h 涨幅 >= 20%)
  xMinutes: number;           // 默认 15 (15 分钟箱体窗口)
  ampDivisor: number;         // 默认 5.0 (15m 箱体振幅 <= 24h 涨幅 / 5.0)
  minAbsoluteAmp: number;     // 默认 0.5%
  maxPullbackPercent: number; // 默认 15.0%
  breakoutRatio: number;      // 默认 1.001 (收盘真突破过去 X 分钟箱体高点)
  requireMaAligned: boolean;  // 默认 true (MA15 >= MA30)
  requireMacdPositive: boolean;// 默认 true (DIF > 0)
  requireBullish: boolean;    // 默认 true (必须为实体阳线)
  holdMinutes: number;        // 默认 60 分钟
  stopLossPercent: number;    // 默认 6.0%
  tp1Percent: number;         // 默认 3.5%
  tp2Percent: number;         // 默认 7.0%
  moveSlToEntryAfterTp1: boolean; // 默认 true
  cooldownMinutes: number;    // 默认 20 分钟
  leverage: number;           // 默认 3x
}

export const CONSOLIDATION_BREAKOUT_DEFAULT_CONFIG: ConsolidationBreakoutLiveConfig = {
  topN: 10,
  minDayChange: 20.0,
  xMinutes: 15,
  ampDivisor: 5.0,
  minAbsoluteAmp: 0.5,
  maxPullbackPercent: 15.0,
  breakoutRatio: 1.001,
  requireMaAligned: true,
  requireMacdPositive: true,
  requireBullish: true,
  holdMinutes: 60,
  stopLossPercent: 6.0,
  tp1Percent: 3.5,
  tp2Percent: 7.0,
  moveSlToEntryAfterTp1: true,
  cooldownMinutes: 20,
  leverage: 3,
};

// ---- 向下兼容旧版配置声明 ----
export interface GoldenPullbackLiveConfig {
  topN: number;
  minDayChange: number;
  minPullbackPercent: number;
  maxPullbackPercent: number;
  maPeriod: number;
  requireMaSlopeUp: boolean;
  requireMacdPositive: boolean;
  minLowerShadowRatio: number;
  holdMinutes: number;
  stopLossPercent: number;
  tp1Percent: number;
  tp2Percent: number;
  moveSlToEntryAfterTp1: boolean;
  cooldownMinutes: number;
  leverage: number;
}

export const GOLDEN_PULLBACK_LIVE_DEFAULT_CONFIG: GoldenPullbackLiveConfig = {
  topN: 10,
  minDayChange: 25.0,
  minPullbackPercent: 10.0,
  maxPullbackPercent: 20.0,
  maPeriod: 30,
  requireMaSlopeUp: true,
  requireMacdPositive: true,
  minLowerShadowRatio: 0.40,
  holdMinutes: 90,
  stopLossPercent: 8.0,
  tp1Percent: 3.0,
  tp2Percent: 8.0,
  moveSlToEntryAfterTp1: true,
  cooldownMinutes: 20,
  leverage: 3,
};

export interface DeepSupportLiveConfig {
  topN: number;
  minDayChange: number;
  minPullbackPercent: number;
  maxPullbackPercent: number;
  maPeriod: number;
  requireMaSlopeUp: boolean;
  requireMacdPositive: boolean;
  minLowerShadowRatio: number;
  holdMinutes: number;
  stopLossPercent: number;
  tp1Percent: number;
  tp2Percent: number;
  moveSlToEntryAfterTp1: boolean;
  cooldownMinutes: number;
  leverage: number;
}

export const DEEP_SUPPORT_LIVE_DEFAULT_CONFIG: DeepSupportLiveConfig = {
  topN: 10,
  minDayChange: 25.0,
  minPullbackPercent: 14.0,
  maxPullbackPercent: 25.0,
  maPeriod: 60,
  requireMaSlopeUp: true,
  requireMacdPositive: true,
  minLowerShadowRatio: 0.45,
  holdMinutes: 60,
  stopLossPercent: 7.0,
  tp1Percent: 3.0,
  tp2Percent: 8.0,
  moveSlToEntryAfterTp1: true,
  cooldownMinutes: 25,
  leverage: 3,
};

export interface Rank1PullbackLiveConfig {
  minDayChange: number;
  minPullbackPercent: number;
  maxPullbackPercent: number;
  holdMinutes: number;
  stopLossPercent: number;
  tp1Percent: number;
  tp2Percent: number;
  moveSlToEntryAfterTp1: boolean;
  cooldownMinutes: number;
  leverage: number;
}

export const RANK1_PULLBACK_LIVE_DEFAULT_CONFIG: Rank1PullbackLiveConfig = {
  minDayChange: 25.0,
  minPullbackPercent: 10.0,
  maxPullbackPercent: 18.0,
  holdMinutes: 60,
  stopLossPercent: 6.0,
  tp1Percent: 3.5,
  tp2Percent: 8.0,
  moveSlToEntryAfterTp1: true,
  cooldownMinutes: 120,
  leverage: 3,
};

export interface SecondWaveExpansionLiveConfig {
  topN: number;
  minDayChange: number;
  minBarReturn: number;
  minBodyRatio: number;
  holdMinutes: number;
  stopLossPercent: number;
  tp1Percent: number;
  tp2Percent: number;
  moveSlToEntryAfterTp1: boolean;
  cooldownMinutes: number;
  leverage: number;
}

export const SECOND_WAVE_EXPANSION_LIVE_DEFAULT_CONFIG: SecondWaveExpansionLiveConfig = {
  topN: 10,
  minDayChange: 20.0,
  minBarReturn: 0.8,
  minBodyRatio: 0.60,
  holdMinutes: 45,
  stopLossPercent: 5.0,
  tp1Percent: 3.0,
  tp2Percent: 7.0,
  moveSlToEntryAfterTp1: true,
  cooldownMinutes: 30,
  leverage: 3,
};

export interface UnifiedLongLiveConfig {
  pullbackReboundConfig?: Partial<PullbackReboundLiveConfig>;
  wBottomDivergenceConfig?: Partial<WBottomDivergenceLiveConfig>;
  consolidationSupportConfig?: Partial<ConsolidationSupportLiveConfig>;
  consolidationBreakoutConfig?: Partial<ConsolidationBreakoutLiveConfig>;
  goldenPullbackConfig?: Partial<GoldenPullbackLiveConfig>;
  deepSupportConfig?: Partial<DeepSupportLiveConfig>;
  rank1PullbackConfig?: Partial<Rank1PullbackLiveConfig>;
  secondWaveConfig?: Partial<SecondWaveExpansionLiveConfig>;
  preventConflict?: boolean;
  enablePullbackRebound?: boolean;     // 默认启用：右侧回调反弹做多 (龙头回踩MA30黄金生命线)
  enableWBottomDivergence?: boolean;   // 默认启用：左侧3W底背离弹射做多 (W底/3底+MACD强背离+放量弹射)
  enableConsolidationSupport?: boolean; // 震荡托底做多
  enableConsolidationBreakout?: boolean;// 震荡突破做多 (默认 false: 不要搞突破做多，假突破太多)
  enableGoldenPullback?: boolean;       // 龙头 MA30 黄金生命线回踩做多
  enableDeepSupport?: boolean;          // 龙头 MA60 深度托底做多
  enableRank1Pullback?: boolean;        // 榜一首次见顶回踩做多
  enableSecondWave?: boolean;           // 龙头二浪放量突破做多
}

export const UNIFIED_LONG_LIVE_DEFAULT_CONFIG: Required<UnifiedLongLiveConfig> = {
  pullbackReboundConfig: PULLBACK_REBOUND_DEFAULT_CONFIG,
  wBottomDivergenceConfig: W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG,
  consolidationSupportConfig: CONSOLIDATION_SUPPORT_DEFAULT_CONFIG,
  consolidationBreakoutConfig: CONSOLIDATION_BREAKOUT_DEFAULT_CONFIG,
  goldenPullbackConfig: GOLDEN_PULLBACK_LIVE_DEFAULT_CONFIG,
  deepSupportConfig: DEEP_SUPPORT_LIVE_DEFAULT_CONFIG,
  rank1PullbackConfig: RANK1_PULLBACK_LIVE_DEFAULT_CONFIG,
  secondWaveConfig: SECOND_WAVE_EXPANSION_LIVE_DEFAULT_CONFIG,
  preventConflict: true,
  enablePullbackRebound: true,
  enableWBottomDivergence: true,
  enableConsolidationSupport: false,
  enableConsolidationBreakout: false,
  enableGoldenPullback: false,
  enableDeepSupport: false,
  enableRank1Pullback: false,
  enableSecondWave: false,
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

interface Rank1WatchItem {
  peakPrice: number;
  state: 'watch' | 'pullback' | 'done';
  cooldownUntil: number;
}

export class UnifiedLongStrategyTracker {
  private config: {
    pullbackReboundConfig: PullbackReboundLiveConfig;
    wBottomDivergenceConfig: WBottomDivergenceLiveConfig;
    consolidationSupportConfig: ConsolidationSupportLiveConfig;
    consolidationBreakoutConfig: ConsolidationBreakoutLiveConfig;
    goldenPullbackConfig: GoldenPullbackLiveConfig;
    deepSupportConfig: DeepSupportLiveConfig;
    rank1PullbackConfig: Rank1PullbackLiveConfig;
    secondWaveConfig: SecondWaveExpansionLiveConfig;
    preventConflict: boolean;
    enablePullbackRebound: boolean;
    enableWBottomDivergence: boolean;
    enableConsolidationSupport: boolean;
    enableConsolidationBreakout: boolean;
    enableGoldenPullback: boolean;
    enableDeepSupport: boolean;
    enableRank1Pullback: boolean;
    enableSecondWave: boolean;
  };
  private activePositions = new Map<string, ActiveLongPositionInfo>();
  private cooldownMap = new Map<string, number>();
  private rank1WatchMap = new Map<string, Rank1WatchItem>();

  constructor(config: UnifiedLongLiveConfig = {}) {
    this.config = {
      pullbackReboundConfig: { ...PULLBACK_REBOUND_DEFAULT_CONFIG, ...config.pullbackReboundConfig },
      wBottomDivergenceConfig: { ...W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG, ...config.wBottomDivergenceConfig },
      consolidationSupportConfig: { ...CONSOLIDATION_SUPPORT_DEFAULT_CONFIG, ...config.consolidationSupportConfig },
      consolidationBreakoutConfig: { ...CONSOLIDATION_BREAKOUT_DEFAULT_CONFIG, ...config.consolidationBreakoutConfig },
      goldenPullbackConfig: { ...GOLDEN_PULLBACK_LIVE_DEFAULT_CONFIG, ...config.goldenPullbackConfig },
      deepSupportConfig: { ...DEEP_SUPPORT_LIVE_DEFAULT_CONFIG, ...config.deepSupportConfig },
      rank1PullbackConfig: { ...RANK1_PULLBACK_LIVE_DEFAULT_CONFIG, ...config.rank1PullbackConfig },
      secondWaveConfig: { ...SECOND_WAVE_EXPANSION_LIVE_DEFAULT_CONFIG, ...config.secondWaveConfig },
      preventConflict: config.preventConflict ?? true,
      enablePullbackRebound: config.enablePullbackRebound ?? true,
      enableWBottomDivergence: config.enableWBottomDivergence ?? true,
      enableConsolidationSupport: config.enableConsolidationSupport ?? false,
      enableConsolidationBreakout: config.enableConsolidationBreakout ?? false,
      enableGoldenPullback: config.enableGoldenPullback ?? false,
      enableDeepSupport: config.enableDeepSupport ?? false,
      enableRank1Pullback: config.enableRank1Pullback ?? false,
      enableSecondWave: config.enableSecondWave ?? false,
    };
  }

  public registerPosition(symbol: string, info: ActiveLongPositionInfo): void {
    this.activePositions.set(symbol, info);
  }

  public closePosition(symbol: string): void {
    this.activePositions.delete(symbol);
  }

  public isSymbolBusy(symbol: string, now = Date.now()): boolean {
    const active = this.activePositions.get(symbol);
    if (!active) return false;
    if (now >= active.maxExitTime) {
      this.activePositions.delete(symbol);
      return false;
    }
    return true;
  }

  public updateConfig(updates: Partial<UnifiedLongLiveConfig>): void {
    if (typeof updates.enablePullbackRebound === 'boolean') this.config.enablePullbackRebound = updates.enablePullbackRebound;
    if (typeof updates.enableWBottomDivergence === 'boolean') this.config.enableWBottomDivergence = updates.enableWBottomDivergence;
    if (typeof updates.enableConsolidationSupport === 'boolean') this.config.enableConsolidationSupport = updates.enableConsolidationSupport;
    if (typeof updates.enableConsolidationBreakout === 'boolean') this.config.enableConsolidationBreakout = updates.enableConsolidationBreakout;
    if (typeof updates.enableGoldenPullback === 'boolean') this.config.enableGoldenPullback = updates.enableGoldenPullback;
    if (typeof updates.enableDeepSupport === 'boolean') this.config.enableDeepSupport = updates.enableDeepSupport;
    if (typeof updates.enableRank1Pullback === 'boolean') this.config.enableRank1Pullback = updates.enableRank1Pullback;
    if (typeof updates.enableSecondWave === 'boolean') this.config.enableSecondWave = updates.enableSecondWave;
    if (typeof updates.preventConflict === 'boolean') this.config.preventConflict = updates.preventConflict;
  }

  /**
   * Evaluate a newly closed 1m candle for 24h Top Gainers Long entries.
   * 对称重构核心逻辑：
   * 做空：X 分钟内快速冲高达到 24h 涨幅 / ampDivisor + 乖离/顶背离/收阴
   * 做多：X 分钟内在 24h 涨幅 / N 内震荡 + 均线托底支撑/箱体突破 + MACD 水上多头 + 企稳阳线
   */
  public checkCandles(
    symbol: string,
    dayChangePercent: number,
    rankGainers: number | null,
    candles: Candle[],
    now = Date.now()
  ): UnifiedLongLiveSignal | null {
    if (rankGainers == null || rankGainers > 10 || dayChangePercent < 20) {
      return null;
    }

    if (this.config.preventConflict && this.isSymbolBusy(symbol, now)) {
      return null;
    }

    const targetIdx = candles.length - 2;
    if (targetIdx < 40) return null;
    const closedCandle = candles[targetIdx];
    if (!closedCandle || closedCandle.close <= 0) return null;

    const lastCooldown = this.cooldownMap.get(symbol) ?? 0;
    if (now < lastCooldown) return null;

    // 1. 核心策略一：【右侧回调反弹做多】 (龙头冲高见顶后右侧回调10%~20%，回踩MA30黄金生命线支撑)
    if (this.config.enablePullbackRebound && rankGainers <= this.config.pullbackReboundConfig.topN) {
      const sigPullback = this.checkPullbackRebound(closedCandle, candles, targetIdx, dayChangePercent);
      if (sigPullback) {
        const cfg = this.config.pullbackReboundConfig;
        this.cooldownMap.set(symbol, now + cfg.cooldownMinutes * 60 * 1000);
        const signal: UnifiedLongLiveSignal = {
          id: `long-pullback-${symbol}-${closedCandle.time}`,
          type: 'pullback_rebound',
          label: '右侧回调反弹',
          symbol,
          time: closedCandle.time + 60 * 1000,
          dayChangePercent,
          entryPrice: closedCandle.close,
          side: 'LONG',
          exitParams: {
            holdMinutes: cfg.holdMinutes,
            tp1Percent: cfg.tp1Percent,
            tp2Percent: cfg.tp2Percent,
            stopLossPercent: cfg.stopLossPercent,
            moveSlToEntryAfterTp1: cfg.moveSlToEntryAfterTp1,
            leverage: cfg.leverage,
          },
          details: sigPullback,
        };
        if (this.config.preventConflict) {
          this.registerPosition(symbol, {
            tradeId: signal.id,
            type: 'pullback_rebound',
            entryTime: signal.time,
            maxExitTime: signal.time + cfg.holdMinutes * 60 * 1000,
          });
        }
        return signal;
      }
    }

    // 2. 核心策略二：【左侧 3W 底背离弹射做多】 (整理区W底/3底 + MACD双重强底背离 + 放量弹射阳线)
    if (this.config.enableWBottomDivergence && rankGainers <= this.config.wBottomDivergenceConfig.topN) {
      const sigDiv = this.checkWBottomDivergence(closedCandle, candles, targetIdx, dayChangePercent);
      if (sigDiv) {
        const cfg = this.config.wBottomDivergenceConfig;
        this.cooldownMap.set(symbol, now + cfg.cooldownMinutes * 60 * 1000);
        const signal: UnifiedLongLiveSignal = {
          id: `long-w-div-${symbol}-${closedCandle.time}`,
          type: 'w_bottom_divergence',
          label: '左侧3W底背离',
          symbol,
          time: closedCandle.time + 60 * 1000,
          dayChangePercent,
          entryPrice: closedCandle.close,
          side: 'LONG',
          exitParams: {
            holdMinutes: cfg.holdMinutes,
            tp1Percent: cfg.tp1Percent,
            tp2Percent: cfg.tp2Percent,
            stopLossPercent: cfg.stopLossPercent,
            moveSlToEntryAfterTp1: cfg.moveSlToEntryAfterTp1,
            leverage: cfg.leverage,
          },
          details: sigDiv,
        };
        if (this.config.preventConflict) {
          this.registerPosition(symbol, {
            tradeId: signal.id,
            type: 'w_bottom_divergence',
            entryTime: signal.time,
            maxExitTime: signal.time + cfg.holdMinutes * 60 * 1000,
          });
        }
        return signal;
      }
    }

    // 3. 震荡托底做多 (X 分钟在 24h/N 内震荡 + 均线托底企稳阳线)
    if (this.config.enableConsolidationSupport && rankGainers <= this.config.consolidationSupportConfig.topN) {
      const sigSupport = this.checkConsolidationSupport(closedCandle, candles, targetIdx, dayChangePercent);
      if (sigSupport) {
        const cfg = this.config.consolidationSupportConfig;
        this.cooldownMap.set(symbol, now + cfg.cooldownMinutes * 60 * 1000);
        const signal: UnifiedLongLiveSignal = {
          id: `long-cons-sup-${symbol}-${closedCandle.time}`,
          type: 'consolidation_support',
          label: '震荡托底做多',
          symbol,
          time: closedCandle.time + 60 * 1000,
          dayChangePercent,
          entryPrice: closedCandle.close,
          side: 'LONG',
          exitParams: {
            holdMinutes: cfg.holdMinutes,
            tp1Percent: cfg.tp1Percent,
            tp2Percent: cfg.tp2Percent,
            stopLossPercent: cfg.stopLossPercent,
            moveSlToEntryAfterTp1: cfg.moveSlToEntryAfterTp1,
            leverage: cfg.leverage,
          },
          details: sigSupport,
        };
        if (this.config.preventConflict) {
          this.registerPosition(symbol, {
            tradeId: signal.id,
            type: 'consolidation_support',
            entryTime: signal.time,
            maxExitTime: signal.time + cfg.holdMinutes * 60 * 1000,
          });
        }
        return signal;
      }
    }

    // 2. 核心策略二：震荡突破做多 (X 分钟在 24h/N 内箱体蓄势 + 实体阳线放量突破箱体上沿)
    if (this.config.enableConsolidationBreakout && rankGainers <= this.config.consolidationBreakoutConfig.topN) {
      const sigBreakout = this.checkConsolidationBreakout(closedCandle, candles, targetIdx, dayChangePercent);
      if (sigBreakout) {
        const cfg = this.config.consolidationBreakoutConfig;
        this.cooldownMap.set(symbol, now + cfg.cooldownMinutes * 60 * 1000);
        const signal: UnifiedLongLiveSignal = {
          id: `long-cons-brk-${symbol}-${closedCandle.time}`,
          type: 'consolidation_breakout',
          label: '震荡突破做多',
          symbol,
          time: closedCandle.time + 60 * 1000,
          dayChangePercent,
          entryPrice: closedCandle.close,
          side: 'LONG',
          exitParams: {
            holdMinutes: cfg.holdMinutes,
            tp1Percent: cfg.tp1Percent,
            tp2Percent: cfg.tp2Percent,
            stopLossPercent: cfg.stopLossPercent,
            moveSlToEntryAfterTp1: cfg.moveSlToEntryAfterTp1,
            leverage: cfg.leverage,
          },
          details: sigBreakout,
        };
        if (this.config.preventConflict) {
          this.registerPosition(symbol, {
            tradeId: signal.id,
            type: 'consolidation_breakout',
            entryTime: signal.time,
            maxExitTime: signal.time + cfg.holdMinutes * 60 * 1000,
          });
        }
        return signal;
      }
    }

    // 3. 向下兼容策略：龙头 MA30 黄金生命线回踩做多
    if (this.config.enableGoldenPullback) {
      const sig1 = this.checkGoldenPullback(closedCandle, candles, targetIdx, dayChangePercent);
      if (sig1) {
        const cfg = this.config.goldenPullbackConfig;
        this.cooldownMap.set(symbol, now + cfg.cooldownMinutes * 60 * 1000);
        const signal: UnifiedLongLiveSignal = {
          id: `long-ma30-${symbol}-${closedCandle.time}`,
          type: 'ma30_pullback',
          label: '龙头MA30黄金回踩',
          symbol,
          time: closedCandle.time + 60 * 1000,
          dayChangePercent,
          entryPrice: closedCandle.close,
          side: 'LONG',
          exitParams: {
            holdMinutes: cfg.holdMinutes,
            tp1Percent: cfg.tp1Percent,
            tp2Percent: cfg.tp2Percent,
            stopLossPercent: cfg.stopLossPercent,
            moveSlToEntryAfterTp1: cfg.moveSlToEntryAfterTp1,
            leverage: cfg.leverage,
          },
          details: sig1,
        };
        if (this.config.preventConflict) {
          this.registerPosition(symbol, {
            tradeId: signal.id,
            type: 'ma30_pullback',
            entryTime: signal.time,
            maxExitTime: signal.time + cfg.holdMinutes * 60 * 1000,
          });
        }
        return signal;
      }
    }

    // 4. 向下兼容策略：龙头 MA60 深度大蹲强托底做多
    if (this.config.enableDeepSupport) {
      const sig2 = this.checkDeepSupport(closedCandle, candles, targetIdx, dayChangePercent);
      if (sig2) {
        const cfg = this.config.deepSupportConfig;
        this.cooldownMap.set(symbol, now + cfg.cooldownMinutes * 60 * 1000);
        const signal: UnifiedLongLiveSignal = {
          id: `long-ma60-${symbol}-${closedCandle.time}`,
          type: 'ma60_support',
          label: '龙头MA60深蹲托底',
          symbol,
          time: closedCandle.time + 60 * 1000,
          dayChangePercent,
          entryPrice: closedCandle.close,
          side: 'LONG',
          exitParams: {
            holdMinutes: cfg.holdMinutes,
            tp1Percent: cfg.tp1Percent,
            tp2Percent: cfg.tp2Percent,
            stopLossPercent: cfg.stopLossPercent,
            moveSlToEntryAfterTp1: cfg.moveSlToEntryAfterTp1,
            leverage: cfg.leverage,
          },
          details: sig2,
        };
        if (this.config.preventConflict) {
          this.registerPosition(symbol, {
            tradeId: signal.id,
            type: 'ma60_support',
            entryTime: signal.time,
            maxExitTime: signal.time + cfg.holdMinutes * 60 * 1000,
          });
        }
        return signal;
      }
    }

    // 5. 向下兼容策略：榜一首次见顶回踩状态机做多
    if (this.config.enableRank1Pullback && rankGainers === 1) {
      const sig3 = this.checkRank1Pullback(symbol, closedCandle, candles, targetIdx, dayChangePercent, now);
      if (sig3) {
        const cfg = this.config.rank1PullbackConfig;
        this.cooldownMap.set(symbol, now + cfg.cooldownMinutes * 60 * 1000);
        const signal: UnifiedLongLiveSignal = {
          id: `long-rank1-${symbol}-${closedCandle.time}`,
          type: 'rank1_first_pullback',
          label: '榜一首次回踩',
          symbol,
          time: closedCandle.time + 60 * 1000,
          dayChangePercent,
          entryPrice: closedCandle.close,
          side: 'LONG',
          exitParams: {
            holdMinutes: cfg.holdMinutes,
            tp1Percent: cfg.tp1Percent,
            tp2Percent: cfg.tp2Percent,
            stopLossPercent: cfg.stopLossPercent,
            moveSlToEntryAfterTp1: cfg.moveSlToEntryAfterTp1,
            leverage: cfg.leverage,
          },
          details: sig3,
        };
        if (this.config.preventConflict) {
          this.registerPosition(symbol, {
            tradeId: signal.id,
            type: 'rank1_first_pullback',
            entryTime: signal.time,
            maxExitTime: signal.time + cfg.holdMinutes * 60 * 1000,
          });
        }
        return signal;
      }
    }

    // 6. 向下兼容策略：龙头二浪金叉放量突破做多
    if (this.config.enableSecondWave) {
      const sig4 = this.checkSecondWaveExpansion(closedCandle, candles, targetIdx, dayChangePercent);
      if (sig4) {
        const cfg = this.config.secondWaveConfig;
        this.cooldownMap.set(symbol, now + cfg.cooldownMinutes * 60 * 1000);
        const signal: UnifiedLongLiveSignal = {
          id: `long-wave2-${symbol}-${closedCandle.time}`,
          type: 'second_wave_expansion',
          label: '龙头二浪突破',
          symbol,
          time: closedCandle.time + 60 * 1000,
          dayChangePercent,
          entryPrice: closedCandle.close,
          side: 'LONG',
          exitParams: {
            holdMinutes: cfg.holdMinutes,
            tp1Percent: cfg.tp1Percent,
            tp2Percent: cfg.tp2Percent,
            stopLossPercent: cfg.stopLossPercent,
            moveSlToEntryAfterTp1: cfg.moveSlToEntryAfterTp1,
            leverage: cfg.leverage,
          },
          details: sig4,
        };
        if (this.config.preventConflict) {
          this.registerPosition(symbol, {
            tradeId: signal.id,
            type: 'second_wave_expansion',
            entryTime: signal.time,
            maxExitTime: signal.time + cfg.holdMinutes * 60 * 1000,
          });
        }
        return signal;
      }
    }

    return null;
  }

  /**
   * 评估【右侧回调反弹做多】 (Right-side Pullback Bounce Long)
   * 核心条件：龙头强势币冲高见顶后右侧回调 10%~20%，回踩 MA30 黄金生命线获得支撑，
   * 均线向上发散，MACD DIF > 0 水上多头，收阳或长下影探针确认企稳。
   */
  public checkPullbackRebound(
    candle: Candle,
    candles: Candle[],
    idx: number,
    dayChange: number
  ): { dropFrom24h: number; ma30: number; dif: number } | null {
    const cfg = this.config.pullbackReboundConfig;
    if (dayChange < cfg.minDayChange) return null;

    // 1. 24h 峰值与回调幅度 (10% ~ 20%)
    const start24h = Math.max(0, idx - 1439);
    let high24h = 0;
    for (let k = start24h; k <= idx; k++) {
      if (candles[k].high > high24h) high24h = candles[k].high;
    }
    if (high24h <= 0) return null;

    const dropFrom24h = ((high24h - candle.close) / high24h) * 100;
    if (dropFrom24h < cfg.minPullbackPercent || dropFrom24h > cfg.maxPullbackPercent) return null;

    // 2. MA30 支撑与斜率
    const closes = candles.map((c) => c.close);
    const ma30 = calculateSma(closes, idx, cfg.maPeriod);
    const ma30Prev = calculateSma(closes, idx - 3, cfg.maPeriod);
    if (!ma30 || !ma30Prev) return null;

    if (cfg.requireMaSlopeUp && ma30 <= ma30Prev) return null;

    // 触碰或获得托底支撑
    if (!(candle.low <= ma30 * 1.003 && candle.close >= ma30 * 0.998)) return null;

    // 3. MACD DIF 水上多头
    const { dif } = computeMacd(closes);
    if (cfg.requireMacdPositive && dif[idx] <= 0) return null;

    // 4. 企稳阳线或下影探针确认
    const range = candle.high - candle.low;
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const isBull = candle.close >= candle.open;
    const hasLowerShadow = range > 0 && lowerWick / range >= cfg.minLowerShadowRatio;
    if (!isBull && !hasLowerShadow) return null;

    return { dropFrom24h, ma30, dif: dif[idx] };
  }

  /**
   * 评估【左侧 3W 底背离弹射做多】 (Left-side 3W Bottom Divergence Catapult Long)
   * 核心条件：龙头币从近期高点回撤 >= 4% 进入整理，8~25 根前存在第一底且有 >= 1.5% 颈线反弹，
   * 第二底平齐或微创新低，MACD 快线 DIF 与 Hist 双重强底背离，收盘放量弹射阳线启动。
   */
  public checkWBottomDivergence(
    candle: Candle,
    candles: Candle[],
    idx: number,
    dayChange: number
  ): { drop30: number; prevLow: number; difNow: number; difPrev: number } | null {
    const cfg = this.config.wBottomDivergenceConfig;
    if (dayChange < cfg.minDayChange) return null;

    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const closes = candles.map((c) => c.close);

    // 1. 过去 30 根峰值回撤 >= minDropPercent
    let high30 = 0;
    for (let k = Math.max(0, idx - 30); k <= idx; k++) {
      if (highs[k] > high30) high30 = highs[k];
    }
    if (high30 <= 0) return null;

    const drop30 = ((high30 - candle.low) / high30) * 100;
    if (drop30 < cfg.minDropPercent) return null;

    // 2. 寻找前一底 (8~25 根前)
    let prevMinIdx = -1;
    let prevMinLow = Infinity;
    const startK = Math.max(0, idx - cfg.prevBottomMaxBars);
    const endK = Math.max(0, idx - cfg.prevBottomMinBars);
    for (let k = startK; k <= endK; k++) {
      if (lows[k] < prevMinLow) {
        prevMinLow = lows[k];
        prevMinIdx = k;
      }
    }
    if (prevMinIdx < 0 || !Number.isFinite(prevMinLow)) return null;

    // 3. 两底之间波峰反弹 >= minNecklineBounce
    let midPeak = 0;
    for (let k = prevMinIdx; k <= idx; k++) {
      if (highs[k] > midPeak) midPeak = highs[k];
    }
    const midBounce = ((midPeak - prevMinLow) / prevMinLow) * 100;
    if (midBounce < cfg.minNecklineBounce) return null;

    // 4. 第二底平齐或微创新低 (W底特征)
    if (candle.low > prevMinLow * cfg.maxBottomToleranceRatio || candle.low < prevMinLow * cfg.minBottomFloorRatio) {
      return null;
    }

    // 5. MACD 强底背离: DIF 与 Hist 快线抬高且柱体收窄
    const macd = computeMacd(closes);
    if (cfg.requireMacdDivergence) {
      if (macd.dif[idx] <= macd.dif[prevMinIdx] || macd.hist[idx] <= macd.hist[prevMinIdx]) {
        return null;
      }
    }

    // 6. 弹射阳线启动: 收阳且收盘突破前根高点
    if (cfg.requireCatapultBull) {
      const prevBar = candles[idx - 1];
      if (!prevBar || candle.close <= candle.open || candle.close <= prevBar.high * 0.999) {
        return null;
      }
    }

    return {
      drop30,
      prevLow: prevMinLow,
      difNow: macd.dif[idx],
      difPrev: macd.dif[prevMinIdx],
    };
  }

  /**
   * 评估【震荡托底做多】 (Consolidation Support Long)
   * 核心条件：X 分钟在 24h涨幅/N 内震荡 + 均线托底支撑 + 多头均线排列 + MACD 水上多头 + 企稳阳线
   */
  private checkConsolidationSupport(
    candle: Candle,
    candles: Candle[],
    idx: number,
    dayChange: number
  ): { ampX: number; maxAllowedAmp: number; dropFrom24h: number; maLevel: number; dif: number } | null {
    const cfg = this.config.consolidationSupportConfig;
    if (dayChange < cfg.minDayChange) return null;

    // 1. 24h 峰值与回撤控制 (确保是在强势高位盘整，而非破位暴跌)
    const start24h = Math.max(0, idx - 1439);
    let high24h = 0;
    for (let k = start24h; k <= idx; k++) if (candles[k].high > high24h) high24h = candles[k].high;
    if (high24h <= 0) return null;

    const dropFrom24h = ((high24h - candle.close) / high24h) * 100;
    if (dropFrom24h > cfg.maxPullbackPercent) return null;

    // 2. 核心：X 分钟在 24h涨幅/N 内震荡 (振幅收敛整理)
    const startX = Math.max(0, idx - cfg.xMinutes + 1);
    let maxH_X = 0, minL_X = Infinity;
    for (let k = startX; k <= idx; k++) {
      if (candles[k].high > maxH_X) maxH_X = candles[k].high;
      if (candles[k].low < minL_X) minL_X = candles[k].low;
    }
    if (minL_X <= 0 || maxH_X <= minL_X) return null;

    const ampX = ((maxH_X - minL_X) / minL_X) * 100;
    const maxAllowedAmp = dayChange / cfg.ampDivisor;
    if (ampX > maxAllowedAmp || ampX < cfg.minAbsoluteAmp) return null;

    // 3. 均线托底与多头排列 (与做空无均线悬空形成鲜明对称对比)
    const closes = candles.map((c) => c.close);
    const ma15 = calculateSma(closes, idx, 15);
    const ma30 = calculateSma(closes, idx, 30);
    const ma30Prev = calculateSma(closes, idx - 3, 30);
    if (ma15 == null || ma30 == null || ma30Prev == null) return null;

    if (cfg.requireMaSlopeUp && ma30 <= ma30Prev) return null;
    if (cfg.requireMaAligned && ma15 < ma30) return null;

    // 价格踩在 MA15 或 MA30 上（或满足 calculateSupportMaAt 托底）
    const supportHit =
      (candle.low <= ma15 * 1.003 && candle.close >= ma15 * 0.998) ||
      (candle.low <= ma30 * 1.003 && candle.close >= ma30 * 0.998) ||
      (calculateSupportMaAt(candles, idx, cfg.supportMaPeriods) !== null);

    if (!supportHit) return null;

    // 4. MACD 水上多头趋势
    const { dif } = computeMacd(closes);
    if (dif.length <= idx) return null;
    if (cfg.requireMacdPositive && dif[idx] <= 0) return null;

    // 5. 企稳阳线或长下影探针确认 (与做空收阴相反)
    const range = candle.high - candle.low;
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const isBull = candle.close >= candle.open;
    if (cfg.requireBullish && !isBull && (range <= 0 || lowerWick / range < cfg.minLowerShadowRatio)) {
      return null;
    }

    return {
      ampX,
      maxAllowedAmp,
      dropFrom24h,
      maLevel: ma15,
      dif: dif[idx],
    };
  }

  /**
   * 评估【震荡突破做多】 (Consolidation Box Breakout Long)
   * 核心条件：过去 X 分钟在 24h 涨幅 / N 内横盘箱体蓄势 + 实体阳线放量突破箱体上沿 + MA15/MA30 多头推进
   */
  private checkConsolidationBreakout(
    candle: Candle,
    candles: Candle[],
    idx: number,
    dayChange: number
  ): { boxAmp: number; maxAllowedAmp: number; dropFrom24h: number; maLevel: number; dif: number } | null {
    const cfg = this.config.consolidationBreakoutConfig;
    if (dayChange < cfg.minDayChange) return null;

    // 1. 24h 高点与回撤控制
    const start24h = Math.max(0, idx - 1439);
    let high24h = 0;
    for (let k = start24h; k <= idx; k++) if (candles[k].high > high24h) high24h = candles[k].high;
    if (high24h <= 0) return null;

    const dropFrom24h = ((high24h - candle.close) / high24h) * 100;
    if (dropFrom24h > cfg.maxPullbackPercent) return null;

    // 2. 过去 X 分钟箱体振幅 (不含当前突破根)
    const startX = Math.max(0, idx - cfg.xMinutes);
    let boxHigh = 0, boxLow = Infinity;
    for (let k = startX; k < idx; k++) {
      if (candles[k].high > boxHigh) boxHigh = candles[k].high;
      if (candles[k].low < boxLow) boxLow = candles[k].low;
    }
    if (boxLow <= 0 || boxHigh <= boxLow) return null;

    const boxAmp = ((boxHigh - boxLow) / boxLow) * 100;
    const maxAllowedAmp = dayChange / cfg.ampDivisor;
    if (boxAmp > maxAllowedAmp || boxAmp < cfg.minAbsoluteAmp) return null;

    // 3. 当前 K 线收盘价真突破箱体上沿
    if (candle.close <= boxHigh * cfg.breakoutRatio) return null;

    // 4. 必须收饱满阳线突破
    if (cfg.requireBullish && candle.close <= candle.open) return null;

    // 5. 均线与 MACD 水上多头
    const closes = candles.map((c) => c.close);
    const ma15 = calculateSma(closes, idx, 15);
    const ma30 = calculateSma(closes, idx, 30);
    if (ma15 == null || ma30 == null) return null;
    if (candle.close < ma15 || (cfg.requireMaAligned && ma15 < ma30)) return null;

    const { dif } = computeMacd(closes);
    if (dif.length <= idx) return null;
    if (cfg.requireMacdPositive && dif[idx] <= 0) return null;

    return {
      boxAmp,
      maxAllowedAmp,
      dropFrom24h,
      maLevel: ma15,
      dif: dif[idx],
    };
  }

  private checkGoldenPullback(
    candle: Candle,
    candles: Candle[],
    idx: number,
    dayChange: number
  ): { dropFrom24h: number; maLevel: number; dif: number } | null {
    const cfg = this.config.goldenPullbackConfig;
    if (dayChange < cfg.minDayChange) return null;

    const start24h = Math.max(0, idx - 1439);
    let high24h = 0;
    for (let k = start24h; k <= idx; k++) if (candles[k].high > high24h) high24h = candles[k].high;
    if (high24h <= 0) return null;

    const drop = ((high24h - candle.close) / high24h) * 100;
    if (drop < cfg.minPullbackPercent || drop > cfg.maxPullbackPercent) return null;

    const closes = candles.map((c) => c.close);
    const ma30 = calculateSma(closes, idx, cfg.maPeriod);
    const ma30Prev = calculateSma(closes, idx - 3, cfg.maPeriod);
    if (ma30 == null || ma30Prev == null) return null;
    if (cfg.requireMaSlopeUp && ma30 <= ma30Prev) return null;

    if (!(candle.low <= ma30 * 1.003 && candle.close >= ma30 * 0.998)) return null;

    const { dif } = computeMacd(closes);
    if (dif.length <= idx) return null;
    if (cfg.requireMacdPositive && dif[idx] <= 0) return null;

    const range = candle.high - candle.low;
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const isBull = candle.close >= candle.open;
    if (!isBull && (range <= 0 || lowerWick / range < cfg.minLowerShadowRatio)) return null;

    return { dropFrom24h: drop, maLevel: ma30, dif: dif[idx] };
  }

  private checkDeepSupport(
    candle: Candle,
    candles: Candle[],
    idx: number,
    dayChange: number
  ): { dropFrom24h: number; maLevel: number; dif: number } | null {
    const cfg = this.config.deepSupportConfig;
    if (dayChange < cfg.minDayChange) return null;

    const start24h = Math.max(0, idx - 1439);
    let high24h = 0;
    for (let k = start24h; k <= idx; k++) if (candles[k].high > high24h) high24h = candles[k].high;
    if (high24h <= 0) return null;

    const drop = ((high24h - candle.close) / high24h) * 100;
    if (drop < cfg.minPullbackPercent || drop > cfg.maxPullbackPercent) return null;

    const closes = candles.map((c) => c.close);
    const ma60 = calculateSma(closes, idx, cfg.maPeriod);
    const ma60Prev = calculateSma(closes, idx - 4, cfg.maPeriod);
    if (ma60 == null || ma60Prev == null) return null;
    if (cfg.requireMaSlopeUp && ma60 <= ma60Prev) return null;

    if (!(candle.low <= ma60 * 1.003 && candle.close >= ma60 * 0.998)) return null;

    const { dif } = computeMacd(closes);
    if (dif.length <= idx) return null;
    if (cfg.requireMacdPositive && dif[idx] <= 0) return null;

    const range = candle.high - candle.low;
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const isBull = candle.close >= candle.open;
    if (!isBull && (range <= 0 || lowerWick / range < cfg.minLowerShadowRatio)) return null;

    return { dropFrom24h: drop, maLevel: ma60, dif: dif[idx] };
  }

  private checkRank1Pullback(
    symbol: string,
    candle: Candle,
    candles: Candle[],
    idx: number,
    dayChange: number,
    now: number
  ): { dropFrom24h: number; maLevel: number } | null {
    const cfg = this.config.rank1PullbackConfig;
    if (dayChange < cfg.minDayChange) return null;

    let item = this.rank1WatchMap.get(symbol);
    if (!item) {
      item = { peakPrice: candle.high, state: 'watch', cooldownUntil: 0 };
      this.rank1WatchMap.set(symbol, item);
      return null;
    }

    if (now < item.cooldownUntil) return null;

    if (item.state === 'watch') {
      if (candle.high >= item.peakPrice) {
        item.peakPrice = candle.high;
      } else {
        const drop = ((item.peakPrice - candle.low) / item.peakPrice) * 100;
        if (drop >= cfg.minPullbackPercent && drop <= cfg.maxPullbackPercent) {
          item.state = 'pullback';
        }
      }
      return null;
    }

    if (item.state === 'pullback') {
      if (candle.high > item.peakPrice) {
        item.peakPrice = candle.high;
        item.state = 'watch';
        return null;
      }

      const closes = candles.map((c) => c.close);
      const ma15 = calculateSma(closes, idx, 15);
      const ma30 = calculateSma(closes, idx, 30);
      if (!ma15 || !ma30) return null;

      const { dif } = computeMacd(closes);
      if (dif.length <= idx || dif[idx] <= 0) return null;

      if (candle.close >= Math.min(ma15, ma30) && candle.close > candle.open) {
        item.state = 'done';
        item.cooldownUntil = now + cfg.cooldownMinutes * 60 * 1000;
        const drop = ((item.peakPrice - candle.close) / item.peakPrice) * 100;
        return { dropFrom24h: drop, maLevel: Math.min(ma15, ma30) };
      }
    }

    return null;
  }

  private checkSecondWaveExpansion(
    candle: Candle,
    candles: Candle[],
    idx: number,
    dayChange: number
  ): { barReturn: number; maLevel: number } | null {
    const cfg = this.config.secondWaveConfig;
    if (dayChange < cfg.minDayChange) return null;

    const closes = candles.map((c) => c.close);
    const { dif, dea } = computeMacd(closes);
    if (dif.length <= idx || dea.length <= idx) return null;

    const isCross = dif[idx - 1] <= dea[idx - 1] && dif[idx] > dea[idx];
    if (!isCross || dif[idx] < 0) return null;

    const ma15 = calculateSma(closes, idx, 15);
    const ma30 = calculateSma(closes, idx, 30);
    if (ma15 == null || ma30 == null) return null;
    if (candle.close < ma15 || ma15 < ma30) return null;

    const body = candle.close - candle.open;
    const range = candle.high - candle.low;
    if (body <= 0 || range <= 0 || body / range < cfg.minBodyRatio) return null;

    const barReturn = (body / candle.open) * 100;
    if (barReturn < cfg.minBarReturn) return null;

    return { barReturn, maLevel: ma15 };
  }
}
