// Unified Multi-Signal Short Strategy Engine
// Coordinates:
// 1. 'Extreme MA Extension Short' (冲高极度乖离 - 3m surge >= 24h / 3.5 + MA30 deviation >= 1.5%)
// 2. 'New High Bearish Divergence Short' (新高顶背离 - 24h new high + no MA support + 5m surge + MACD divergence)
// 3. 'Weak Rebound Short' (首次跌到10% / 空弱反弹 - Right-side post-drop rebound MA ceiling)
// 4. 'Deep Rebound Short' (跌到20%+ / 超跌反弹 - Post-dump secondary bounce MA15/30 suppression)

import { Candle, computeMacd, consecutiveStreakAt, calculateSupportMaAt, calculateSma } from './macd.ts';
import {
  PeakReboundLiveConfig,
  PEAK_REBOUND_LIVE_DEFAULT_CONFIG,
  DUAL_SPEED_PEAK_REBOUND_CONFIG,
  PeakReboundStrategyTracker,
  PeakReboundLiveSignal,
} from './peak-rebound-strategy.ts';
import type { PaperSignalLabel } from './types.ts';

export type UnifiedSignalType = 'streak' | 'rebound' | 'deep_rebound' | 'extreme_dev';

export interface ExtremeDevLiveConfig {
  topN: number;               // 默认 10 (涨幅榜 Top 10)
  minDayChange: number;       // 默认 20.0 (24h 涨幅 >= 20%)
  xMinutes: number;           // 默认 3 (3 分钟回溯窗口)
  ampDivisor: number;         // 默认 3.5 (3m 涨幅 >= 24h / 3.5)
  minAbsoluteSurge: number;   // 默认 4.0% (绝对冲高下限)
  deviationPeriod: number;    // 默认 30 (MA30 偏离基准)
  minDeviationPercent: number;// 默认 1.5% (MA30 乖离率 >= 1.5%)
  holdMinutes: number;        // 默认 90 分钟 (大止损长持仓最优波段)
  exitX: number;              // 默认 30
  exitN: number;              // 默认 2.0
  exitM: number;              // 默认 2.0
  stopLossPercent?: number;   // 显式大止损比例 (默认 10.0%)
  tp1Percent?: number;        // 阶段一止盈比例 (默认 4.0%)
  tp2Percent?: number;        // 阶段二止盈比例 (默认 8.0%)
  moveSlToEntryAfterTp1?: boolean; // 阶段一达标后移动保本止损
  cooldownMinutes: number;    // 默认 20 分钟
}

export const EXTREME_DEV_LIVE_DEFAULT_CONFIG: ExtremeDevLiveConfig = {
  topN: 10,
  minDayChange: 20.0,
  xMinutes: 3,
  ampDivisor: 3.5,
  minAbsoluteSurge: 4.0,
  deviationPeriod: 30,
  minDeviationPercent: 1.5,
  holdMinutes: 20,
  exitX: 30,
  exitN: 2.0,
  exitM: 2.0,
  cooldownMinutes: 20,
};

// 黄金双速最优组合 (Dual-Speed Ensemble): 冲高极度乖离长波段参数 (胜率 72.7%, PF 2.18, 3x 杠杆累计收益 +75.5%)
export const DUAL_SPEED_EXTREME_DEV_CONFIG: ExtremeDevLiveConfig = {
  ...EXTREME_DEV_LIVE_DEFAULT_CONFIG,
  holdMinutes: 90,
  stopLossPercent: 10.0,
  tp1Percent: 4.0,
  tp2Percent: 8.0,
  moveSlToEntryAfterTp1: true,
};

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
  // MACD 顶背离配置
  requireMacdDivergence?: boolean; // 是否开启 MACD 顶背离检测 (默认 true)
  divergenceLookbackMin?: number; // 背离前高最小跨度 (默认 10 根)
  divergenceLookbackMax?: number; // 背离前高最大跨度 (默认 120 根)
  requireDoubleDivergence?: boolean; // 是否要求 DIF 与 Hist 双重顶背离 (默认 true)
  requireBearish?: boolean; // 信号K线需收阴确认假突破 (默认 false，开启后规避顺势暴涨冲高风险)
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
  requireMacdDivergence: true,
  divergenceLookbackMin: 10,
  divergenceLookbackMax: 20, // 优化：收窄背离窗口至紧邻双顶 <= 20，避免陈旧高点导致伪背离
  requireDoubleDivergence: true,
  requireBearish: true,      // 优化：信号K线必须收阴确认假突破冲高回落
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
  minGreenRatio20: 0.65,
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

export interface UnifiedLiveConfig {
  reboundConfig?: Partial<PeakReboundLiveConfig>;
  deepReboundConfig?: Partial<DeepReboundLiveConfig>;
  extremeDevConfig?: Partial<ExtremeDevLiveConfig>;
  streakConfig?: Partial<StreakStrategyLiveConfig>;
  preventConflict?: boolean; // Prevent double-entry if the same symbol has an active trade (default true)
  enableStreak?: boolean;     // 是否启用新高顶背离做空 (默认 true)
  enableRebound?: boolean;    // 是否启用首次跌10%弱反弹做空 (默认 true)
  enableDeepRebound?: boolean;// 是否启用跌20%+超跌反弹做空 (默认 true)
  enableExtremeDev?: boolean; // 是否启用冲高极度乖离做空 (默认 true)
}

export const UNIFIED_LIVE_DEFAULT_CONFIG: Required<UnifiedLiveConfig> = {
  reboundConfig: PEAK_REBOUND_LIVE_DEFAULT_CONFIG,
  deepReboundConfig: DEEP_REBOUND_LIVE_DEFAULT_CONFIG,
  extremeDevConfig: EXTREME_DEV_LIVE_DEFAULT_CONFIG,
  streakConfig: STREAK_LIVE_DEFAULT_CONFIG,
  preventConflict: true,
  enableStreak: true,
  enableRebound: true,
  enableDeepRebound: true,
  enableExtremeDev: true,
};

// 黄金双速最优组合 (Dual-Speed Ensemble): 首次跌10%、跌到20%+、冲高极度乖离走 3x / 10%大止损 / 90m 长波段，新高顶背离保留 15m 闪击战
export const DUAL_SPEED_UNIFIED_CONFIG: Required<UnifiedLiveConfig> = {
  reboundConfig: DUAL_SPEED_PEAK_REBOUND_CONFIG,
  deepReboundConfig: DUAL_SPEED_DEEP_REBOUND_CONFIG,
  extremeDevConfig: DUAL_SPEED_EXTREME_DEV_CONFIG,
  streakConfig: STREAK_LIVE_DEFAULT_CONFIG,
  preventConflict: true,
  enableStreak: true,
  enableRebound: true,
  enableDeepRebound: true,
  enableExtremeDev: true,
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
    extremeDevSignal?: {
      surgePercent: number;
      requiredSurge: number;
      maDeviation: number;
      ma30: number;
    };
    streakSignal?: {
      streakCount: number;
      amp30Percent: number;
      greenRatio: number;
      consecutiveGreenBars: number;
      upperShadowRatio: number;
      divergence?: {
        prevPeakPrice: number;
        prevPeakTime: number;
        curHist: number;
        prevHist: number;
        curDif: number;
        prevDif: number;
      };
    };
  };
}

export interface ActivePositionInfo {
  tradeId: string;
  type: UnifiedSignalType;
  entryTime: number;
  maxExitTime: number;
}

export class UnifiedShortStrategyTracker {
  private config: {
    reboundConfig: PeakReboundLiveConfig;
    deepReboundConfig: DeepReboundLiveConfig;
    extremeDevConfig: ExtremeDevLiveConfig;
    streakConfig: StreakStrategyLiveConfig;
    preventConflict: boolean;
    enableStreak: boolean;
    enableRebound: boolean;
    enableDeepRebound: boolean;
    enableExtremeDev: boolean;
  };
  private reboundTracker: PeakReboundStrategyTracker;
  private activePositions = new Map<string, ActivePositionInfo>();
  private deepCooldown = new Map<string, number>();
  private extremeDevCooldown = new Map<string, number>();

  constructor(config: UnifiedLiveConfig = {}) {
    this.config = {
      reboundConfig: { ...PEAK_REBOUND_LIVE_DEFAULT_CONFIG, ...config.reboundConfig },
      deepReboundConfig: { ...DEEP_REBOUND_LIVE_DEFAULT_CONFIG, ...config.deepReboundConfig },
      extremeDevConfig: { ...EXTREME_DEV_LIVE_DEFAULT_CONFIG, ...config.extremeDevConfig },
      streakConfig: { ...STREAK_LIVE_DEFAULT_CONFIG, ...config.streakConfig },
      preventConflict: config.preventConflict ?? true,
      enableStreak: config.enableStreak ?? true,
      enableRebound: config.enableRebound ?? true,
      enableDeepRebound: config.enableDeepRebound ?? true,
      enableExtremeDev: config.enableExtremeDev ?? true,
    };
    this.reboundTracker = new PeakReboundStrategyTracker(this.config.reboundConfig);
  }

  /** Update 24h ranking info (dispatches to underlying trackers) */
  public onRankUpdate(topSymbol: string, dayChangePercent: number, now = Date.now()): void {
    this.reboundTracker.onRankUpdate(topSymbol, dayChangePercent, now);
  }

  /** Register an active position (or mark when a trade closes) */
  public registerPosition(symbol: string, info: ActivePositionInfo): void {
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

  public getReboundTracker(): PeakReboundStrategyTracker {
    return this.reboundTracker;
  }

  public getReboundWatchlist() {
    return this.reboundTracker.getWatchlist();
  }

  public updateConfig(updates: Partial<UnifiedLiveConfig>): void {
    if (typeof updates.enableStreak === "boolean") this.config.enableStreak = updates.enableStreak;
    if (typeof updates.enableRebound === "boolean") this.config.enableRebound = updates.enableRebound;
    if (typeof updates.enableDeepRebound === "boolean") this.config.enableDeepRebound = updates.enableDeepRebound;
    if (typeof updates.enableExtremeDev === "boolean") this.config.enableExtremeDev = updates.enableExtremeDev;
    if (typeof updates.preventConflict === "boolean") this.config.preventConflict = updates.preventConflict;
  }

  /**
   * Process newly closed 1m candle for a given symbol.
   * Evaluates all 3 signals without conflict:
   * 1. 信号二: 首次跌到10% (Peak Rebound Short)
   * 2. 信号三: 跌到20%+ (Deep Rebound Short)
   * 3. 信号一: 连阳悬空 (Streak Short)
   * If any triggers, an active position is registered preventing double entries.
   */
  public checkCandles(
    symbol: string,
    dayChangePercent: number,
    rank: number,
    candles: Candle[],
    now = Date.now()
  ): UnifiedLiveSignal | null {
    if (dayChangePercent <= 0) return null;

    // 1. Check position conflict
    if (this.config.preventConflict && this.isSymbolBusy(symbol, now)) {
      return null;
    }

    // 2. 信号二: 首次跌到 10% (Rank 1 watchlist focus)
    if (this.config.enableRebound) {
      const reboundSig = this.reboundTracker.checkCandles(symbol, candles, now);
      if (reboundSig) {
        const exitParams = {
          holdMinutes: this.config.reboundConfig.holdMinutes,
          exitX: this.config.reboundConfig.exitX,
          exitN: this.config.reboundConfig.exitN,
          exitM: this.config.reboundConfig.exitM,
          stopLossPercent: this.config.reboundConfig.stopLossPercent,
          tp1Percent: this.config.reboundConfig.tp1Percent,
          tp2Percent: this.config.reboundConfig.tp2Percent,
          moveSlToEntryAfterTp1: this.config.reboundConfig.moveSlToEntryAfterTp1,
        };
        const signal: UnifiedLiveSignal = {
          id: `reb-${symbol}-${reboundSig.time}`,
          type: 'rebound',
          label: '首次跌10%',
          symbol,
          time: reboundSig.time,
          dayChangePercent,
          entryPrice: reboundSig.candle.close,
          exitParams,
          details: { reboundSignal: reboundSig },
        };
        if (this.config.preventConflict) {
          this.registerPosition(symbol, {
            tradeId: signal.id,
            type: 'rebound',
            entryTime: signal.time,
            maxExitTime: signal.time + exitParams.holdMinutes * 60 * 1000,
          });
        }
        return signal;
      }
    }

    // 3. 信号三: 跌到 20%+ (Deep Rebound Short)
    if (this.config.enableDeepRebound) {
      const deepSig = this.checkDeepReboundSignal(symbol, dayChangePercent, candles, now);
      if (deepSig) {
        const exitParams = {
          holdMinutes: this.config.deepReboundConfig.holdMinutes,
          exitX: this.config.deepReboundConfig.exitX,
          exitN: this.config.deepReboundConfig.exitN,
          exitM: this.config.deepReboundConfig.exitM,
          stopLossPercent: this.config.deepReboundConfig.stopLossPercent,
          tp1Percent: this.config.deepReboundConfig.tp1Percent,
          tp2Percent: this.config.deepReboundConfig.tp2Percent,
          moveSlToEntryAfterTp1: this.config.deepReboundConfig.moveSlToEntryAfterTp1,
        };
        const targetIdx = candles.length - 2;
        const closedCandle = candles[targetIdx];
        const signal: UnifiedLiveSignal = {
          id: `deep-${symbol}-${closedCandle.time}`,
          type: 'deep_rebound',
          label: '跌到20%+',
          symbol,
          time: closedCandle.time + 60 * 1000,
          dayChangePercent,
          entryPrice: closedCandle.close,
          exitParams,
          details: { deepReboundSignal: deepSig },
        };
        if (this.config.preventConflict) {
          this.registerPosition(symbol, {
            tradeId: signal.id,
            type: 'deep_rebound',
            entryTime: signal.time,
            maxExitTime: signal.time + exitParams.holdMinutes * 60 * 1000,
          });
        }
        return signal;
      }
    }

    // 3. 信号一: 新高顶背离 (Top N focus, 创24h新高+MACD双背离+悬空假突破收阴，10x 专属闪击战，优先于冲高乖离)
    if (this.config.enableStreak && rank <= this.config.streakConfig.topN) {
      const streakSig = this.checkStreakSignal(symbol, dayChangePercent, candles);
      if (streakSig) {
        const exitParams = {
          holdMinutes: this.config.streakConfig.holdMinutes,
          exitX: this.config.streakConfig.exitX,
          exitN: this.config.streakConfig.exitN,
          exitM: this.config.streakConfig.exitM,
          stopLossPercent: undefined,
          tp1Percent: undefined,
          tp2Percent: undefined,
          moveSlToEntryAfterTp1: false,
        };
        const closedCandle = candles[candles.length - 2];
        const signalLabel: PaperSignalLabel = '新高顶背离';
        const signal: UnifiedLiveSignal = {
          id: `str-${symbol}-${closedCandle.time}`,
          type: 'streak',
          label: signalLabel,
          symbol,
          time: closedCandle.time + 60 * 1000,
          dayChangePercent,
          entryPrice: closedCandle.close,
          exitParams,
          details: { streakSignal: streakSig },
        };
        if (this.config.preventConflict) {
          this.registerPosition(symbol, {
            tradeId: signal.id,
            type: 'streak',
            entryTime: signal.time,
            maxExitTime: signal.time + exitParams.holdMinutes * 60 * 1000,
          });
        }
        return signal;
      }
    }

    // 4. 信号四: 冲高极度乖离 (Extreme MA Extension Short: 未创顶背离但 3m 极端垂直暴涨脱离 MA30)
    if (this.config.enableExtremeDev && rank <= this.config.extremeDevConfig.topN) {
      const devSig = this.checkExtremeDevSignal(symbol, dayChangePercent, candles, now);
      if (devSig) {
        const exitParams = {
          holdMinutes: this.config.extremeDevConfig.holdMinutes,
          exitX: this.config.extremeDevConfig.exitX,
          exitN: this.config.extremeDevConfig.exitN,
          exitM: this.config.extremeDevConfig.exitM,
          stopLossPercent: this.config.extremeDevConfig.stopLossPercent,
          tp1Percent: this.config.extremeDevConfig.tp1Percent,
          tp2Percent: this.config.extremeDevConfig.tp2Percent,
          moveSlToEntryAfterTp1: this.config.extremeDevConfig.moveSlToEntryAfterTp1,
        };
        const closedCandle = candles[candles.length - 2];
        const signalLabel: PaperSignalLabel = '冲高极度乖离';
        const signal: UnifiedLiveSignal = {
          id: `dev-${symbol}-${closedCandle.time}`,
          type: 'extreme_dev',
          label: signalLabel,
          symbol,
          time: closedCandle.time + 60 * 1000,
          dayChangePercent,
          entryPrice: closedCandle.close,
          exitParams,
          details: { extremeDevSignal: devSig },
        };
        if (this.config.preventConflict) {
          this.registerPosition(symbol, {
            tradeId: signal.id,
            type: 'extreme_dev',
            entryTime: signal.time,
            maxExitTime: signal.time + exitParams.holdMinutes * 60 * 1000,
          });
        }
        return signal;
      }
    }

    return null;
  }

  /** Micro-structure evaluation of Deep Rebound Short (跌到20%+) */
  private checkDeepReboundSignal(
    symbol: string,
    dayChangePercent: number,
    candles: Candle[],
    now = Date.now()
  ): {
    dropFrom24h: number;
    reboundFrom10m: number;
    greenRatio20: number;
    ma15: number;
    ma30: number;
  } | null {
    const cfg = this.config.deepReboundConfig;
    const cooldown = this.deepCooldown.get(symbol) ?? 0;
    if (now < cooldown) return null;

    const targetIdx = candles.length - 2;
    if (targetIdx < 35) return null;

    const candle = candles[targetIdx];
    if (!candle || candle.close <= 0 || candle.open <= 0) return null;

    // 1. 24h rolling high (过去至多 1440 根 K 线)
    const start24h = Math.max(0, targetIdx - 1439);
    let high24h = 0;
    for (let k = start24h; k <= targetIdx; k++) {
      if (candles[k].high > high24h) high24h = candles[k].high;
    }
    if (high24h <= 0) return null;

    const dropFrom24h = ((high24h - candle.close) / high24h) * 100;
    if (dropFrom24h < cfg.pullbackX) return null;

    // 2. 10m rolling low
    const windowBars = cfg.lowWindowMinutes ?? 10;
    const startLow = Math.max(0, targetIdx - windowBars + 1);
    let low10m = Infinity;
    for (let k = startLow; k <= targetIdx; k++) {
      if (candles[k].low < low10m) low10m = candles[k].low;
    }
    if (!Number.isFinite(low10m) || low10m <= 0) return null;

    const reboundFrom10m = ((candle.high - low10m) / low10m) * 100;
    if (reboundFrom10m < cfg.reboundY) return null;

    // 3. MA15 & MA30
    const calcMa = (period: number, offsetBars = 0) => {
      let sum = 0;
      for (let k = 0; k < period; k++) sum += candles[targetIdx - offsetBars - k].close;
      return sum / period;
    };
    if (targetIdx < Math.max(cfg.shortMa, cfg.longMa) + 2) return null;

    const ma15 = calcMa(cfg.shortMa);
    const ma30 = calcMa(cfg.longMa);
    const ma30Prev = calcMa(cfg.longMa, 2);

    // 均线压制: 1mClose < MA15 < 1mHigh
    if (!(candle.close < ma15 && ma15 < candle.high)) return null;

    // 均线排列: MA15 < MA30
    if (!(ma15 < ma30)) return null;

    // MA30 下倾确认
    if (cfg.requireMaSlopeDown && ma30 > ma30Prev) return null;

    // 4. MACD 动能: 近 20 根 1m MACD 绿柱占比 > minGreenRatio20
    let greenRatio20 = 0;
    if (cfg.minGreenRatio20 > 0) {
      const { hist } = computeMacd(candles.map((c) => c.close));
      if (hist.length <= targetIdx) return null;
      let greenCount = 0;
      for (let k = targetIdx - 19; k <= targetIdx; k++) {
        if (hist[k] > 0) greenCount++;
      }
      greenRatio20 = greenCount / 20;
      if (greenRatio20 <= cfg.minGreenRatio20) return null;
    }

    // 设置冷却时间
    this.deepCooldown.set(symbol, now + (cfg.cooldownMinutes ?? 30) * 60 * 1000);

    return {
      dropFrom24h,
      reboundFrom10m,
      greenRatio20,
      ma15,
      ma30,
    };
  }

  /** Micro-structure evaluation of Extreme MA Extension Short (冲高极度乖离做空) */
  private checkExtremeDevSignal(
    symbol: string,
    dayChangePercent: number,
    candles: Candle[],
    now = Date.now()
  ): {
    surgePercent: number;
    requiredSurge: number;
    maDeviation: number;
    ma30: number;
  } | null {
    const cfg = this.config.extremeDevConfig;
    if (dayChangePercent < cfg.minDayChange) return null;

    // Cooldown check
    const lastCooldown = this.extremeDevCooldown.get(symbol) ?? 0;
    if (now < lastCooldown) return null;

    const targetIndex = candles.length - 2;
    const minRequiredBars = Math.max(35, cfg.deviationPeriod + 5);
    if (targetIndex < minRequiredBars - 1) return null;

    const candle = candles[targetIndex];
    if (!candle || candle.close <= 0) return null;

    // 1. X 分钟冲高检验 (trough-to-close)
    const xMinutes = cfg.xMinutes;
    const startX = Math.max(0, targetIndex - xMinutes + 1);
    let minLow = Infinity;
    for (let k = startX; k <= targetIndex; k++) {
      if (candles[k].low < minLow) minLow = candles[k].low;
    }
    if (minLow <= 0) return null;

    const surge = ((candle.close - minLow) / minLow) * 100;
    const requiredSurge = dayChangePercent / cfg.ampDivisor;
    if (surge < requiredSurge || surge < cfg.minAbsoluteSurge) return null;

    // 2. 均线乖离检验 (Close / MA30 - 1 >= minDeviationPercent)
    const closes = candles.map((c) => c.close);
    const ma30 = calculateSma(closes, targetIndex, cfg.deviationPeriod);
    if (ma30 == null || ma30 <= 0) return null;
    const maDeviation = ((candle.close - ma30) / ma30) * 100;
    if (maDeviation < cfg.minDeviationPercent) return null;

    // Set cooldown
    this.extremeDevCooldown.set(symbol, now + cfg.cooldownMinutes * 60 * 1000);

    return {
      surgePercent: surge,
      requiredSurge,
      maDeviation,
      ma30,
    };
  }

  /** Micro-structure evaluation of New High Bearish Divergence (新高顶背离，彻底替换连阳空) */
  private checkStreakSignal(
    symbol: string,
    dayChangePercent: number,
    candles: Candle[]
  ): {
    streakCount: number;
    amp30Percent: number;
    greenRatio: number;
    consecutiveGreenBars: number;
    upperShadowRatio: number;
    divergence?: {
      prevPeakPrice: number;
      prevPeakTime: number;
      curHist: number;
      prevHist: number;
      curDif: number;
      prevDif: number;
    };
  } | null {
    const cfg = this.config.streakConfig;
    // targetIndex is the latest completed candle
    const targetIndex = candles.length - 2;
    const minRequiredBars = Math.max(35, ...cfg.supportMaPeriods);
    if (targetIndex < minRequiredBars - 1) return null;

    const candle = candles[targetIndex];
    if (!candle || candle.close <= 0 || candle.open <= 0) return null;

    // 1. 创 24h 新高 (默认开启，要求当前 high 为过去 1440 根 K 线的最高点)
    if (cfg.require24hNewHigh ?? true) {
      const lookback24hStart = Math.max(0, targetIndex - 1440);
      let prev24hMax = 0;
      for (let k = lookback24hStart; k < targetIndex; k++) {
        if (candles[k].high > prev24hMax) prev24hMax = candles[k].high;
      }
      if (candle.high < prev24hMax) return null;
    }

    // 2. X 分钟内冲高涨幅达到 24h 涨幅 / N (默认 X=5m, N=10)
    const xMinutes = cfg.xMinutes ?? 5;
    const xStart = Math.max(0, targetIndex - xMinutes + 1);
    let xMinLow = Infinity;
    for (let k = xStart; k <= targetIndex; k++) {
      if (candles[k].low < xMinLow) xMinLow = candles[k].low;
    }
    if (xMinLow <= 0) return null;
    const xRisePercent = ((candle.high - xMinLow) / xMinLow) * 100;
    const requiredRise = dayChangePercent / (cfg.ampDivisor ?? 10);
    if (xRisePercent < requiredRise) return null;

    // 3. 均线 MA [3, 7, 15] 均无支撑 (悬空)
    const maSupported = calculateSupportMaAt(candles, targetIndex, cfg.supportMaPeriods);
    if (maSupported !== null) {
      return null; // Supported by MA -> do not short
    }

    // 4. 可选：显式指定了最小连阳数时才校验连阳 (向下兼容自定义测试；若开启 requireBearish 则校验冲高至顶点的前置连阳)
    if (cfg.minStreakCount !== undefined && cfg.minStreakCount > 0) {
      const evalIndex = cfg.requireBearish ? targetIndex - 1 : targetIndex;
      if (evalIndex >= 0) {
        const streak = consecutiveStreakAt(candles, evalIndex);
        if (streak.direction !== 'up' || streak.count < cfg.minStreakCount) return null;
      }
    }

    // 5. 可选：显式指定了上影线比例时才校验上影线 (兼顾阳线与假突破冲高收阴线)
    const body = Math.abs(candle.close - candle.open);
    const upperShadow = Math.max(0, candle.high - Math.max(candle.close, candle.open));
    const upperShadowRatio = body > 0 ? upperShadow / body : 0;
    if (cfg.minUpperShadowRatio !== undefined && cfg.maxUpperShadowRatio !== undefined) {
      if (upperShadowRatio < cfg.minUpperShadowRatio || upperShadowRatio >= cfg.maxUpperShadowRatio) {
        return null;
      }
    }

    // 5b. 可选：要求信号K线收阴确认假突破回落
    if (cfg.requireBearish && candle.close >= candle.open) {
      return null;
    }

    // 5c. 可选：下影线占比过滤 (防止下探强买盘托底)
    if (cfg.maxLowerShadowPercent !== undefined) {
      const lowerShadow = Math.min(candle.close, candle.open) - candle.low;
      const lowerShadowPct = (lowerShadow / candle.open) * 100;
      if (lowerShadowPct > cfg.maxLowerShadowPercent) {
        return null;
      }
    }

    // 6. MACD 计算与双重顶背离检测 (Bearish Divergence)
    const { hist, dif } = computeMacd(candles.map((c) => c.close));
    if (hist.length <= targetIndex || dif.length <= targetIndex) return null;

    let divergenceInfo: {
      prevPeakPrice: number;
      prevPeakTime: number;
      curHist: number;
      prevHist: number;
      curDif: number;
      prevDif: number;
    } | undefined;

    if (cfg.requireMacdDivergence ?? true) {
      const lookbackMin = cfg.divergenceLookbackMin ?? 10;
      const lookbackMax = cfg.divergenceLookbackMax ?? 120;
      const searchStart = Math.max(0, targetIndex - lookbackMax);
      const searchEnd = Math.max(0, targetIndex - lookbackMin);

      if (searchEnd <= searchStart) return null;

      let prevPeakIdx = -1;
      let prevPeakHigh = 0;
      for (let k = searchStart; k <= searchEnd; k++) {
        if (candles[k].high > prevPeakHigh) {
          prevPeakHigh = candles[k].high;
          prevPeakIdx = k;
        }
      }

      if (prevPeakIdx < 0) return null;
      // 价格创出更高高点 (新高)
      if (candle.high < prevPeakHigh) return null;

      const curHist = hist[targetIndex];
      const prevHist = hist[prevPeakIdx];
      const curDif = dif[targetIndex];
      const prevDif = dif[prevPeakIdx];

      // 柱体顶背离：当前绿柱小于前高时的绿柱
      if (curHist >= prevHist) return null;

      // 如果要求双重顶背离，DIF 快线也必须背离
      if ((cfg.requireDoubleDivergence ?? true) && curDif >= prevDif) return null;

      divergenceInfo = {
        prevPeakPrice: prevPeakHigh,
        prevPeakTime: candles[prevPeakIdx].time,
        curHist,
        prevHist,
        curDif,
        prevDif,
      };
    }

    const streak = consecutiveStreakAt(candles, targetIndex);
    return {
      streakCount: streak.count,
      amp30Percent: xRisePercent,
      greenRatio: 0,
      consecutiveGreenBars: 0,
      upperShadowRatio,
      divergence: divergenceInfo,
    };
  }
}

