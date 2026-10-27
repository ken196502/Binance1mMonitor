// Unified Triple-Signal Short Strategy Engine
// Coordinates:
// 1. 'Streak Short' (连阳悬空 / 空连阳 - Left-side high-level exhaustion)
// 2. 'Weak Rebound Short' (首次跌到10% / 空弱反弹 - Right-side post-drop rebound MA ceiling)
// 3. 'Deep Rebound Short' (跌到20%+ / 超跌死猫跳 - Post-dump secondary bounce MA15/30 suppression)

import { Candle, computeMacd, consecutiveStreakAt, calculateSupportMaAt } from './macd.ts';
import {
  PeakReboundLiveConfig,
  PEAK_REBOUND_LIVE_DEFAULT_CONFIG,
  PeakReboundStrategyTracker,
  PeakReboundLiveSignal,
} from './peak-rebound-strategy.ts';
import type { PaperSignalLabel } from './types.ts';

export type UnifiedSignalType = 'streak' | 'rebound' | 'deep_rebound';

export interface StreakStrategyLiveConfig {
  topN: number;
  minStreakCount: number;
  supportMaPeriods: readonly number[]; // e.g. [3, 7, 15]
  ampDivisor: number; // 30m 振幅 >= 24h 涨幅 / ampDivisor (默认 12)
  minUpperShadowRatio: number; // e.g. 0.005 (0.5%)
  maxUpperShadowRatio: number; // e.g. 0.30 (30%)
  greenWindow?: number; // e.g. 30
  minGreenRatio: number;   // hist > 0 in 30 bars > minGreenRatio (e.g. 0.70)
  minConsecutiveGreenBars: number; // e.g. 7
  holdMinutes: number;            // e.g. 15
  exitX: number;                  // e.g. 50
  exitN: number;                  // e.g. 1.5
  exitM: number;                  // e.g. 3.0
}

export const STREAK_LIVE_DEFAULT_CONFIG: StreakStrategyLiveConfig = {
  topN: 10,
  minStreakCount: 2,
  supportMaPeriods: [3, 7, 15],
  ampDivisor: 12,
  minUpperShadowRatio: 0.005,
  maxUpperShadowRatio: 0.30,
  greenWindow: 30,
  minGreenRatio: 0.70,
  minConsecutiveGreenBars: 7,
  holdMinutes: 15,
  exitX: 50,
  exitN: 1.5,
  exitM: 3.0,
};

export interface DeepReboundLiveConfig {
  pullbackX: number; // e.g. 20.0 (距离 24h 最高点跌超过 20%)
  reboundY: number;  // e.g. 5.0 (距离 10m 最低点反弹超过 5%)
  lowWindowMinutes: number; // e.g. 10 (最近 10 分钟最低点)
  shortMa: number;   // e.g. 15
  longMa: number;    // e.g. 30
  minGreenRatio20: number; // e.g. 0.65 (近 20 根 1m MACD 绿柱占比 > 65%)
  requireMaSlopeDown: boolean; // e.g. true (MA30 向下倾斜确认)
  holdMinutes: number; // e.g. 30 (最高胜率: 30m)
  exitX: number; // e.g. 35
  exitN: number; // e.g. 2.0
  exitM: number; // e.g. 4.0 (胜率 87.5%, PF 7.15)
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

export interface UnifiedLiveConfig {
  reboundConfig?: Partial<PeakReboundLiveConfig>;
  deepReboundConfig?: Partial<DeepReboundLiveConfig>;
  streakConfig?: Partial<StreakStrategyLiveConfig>;
  preventConflict?: boolean; // Prevent double-entry if the same symbol has an active trade (default true)
}

export const UNIFIED_LIVE_DEFAULT_CONFIG: Required<UnifiedLiveConfig> = {
  reboundConfig: PEAK_REBOUND_LIVE_DEFAULT_CONFIG,
  deepReboundConfig: DEEP_REBOUND_LIVE_DEFAULT_CONFIG,
  streakConfig: STREAK_LIVE_DEFAULT_CONFIG,
  preventConflict: true,
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
    streakConfig: StreakStrategyLiveConfig;
    preventConflict: boolean;
  };
  private reboundTracker: PeakReboundStrategyTracker;
  private activePositions = new Map<string, ActivePositionInfo>();
  private deepCooldown = new Map<string, number>();

  constructor(config: UnifiedLiveConfig = {}) {
    this.config = {
      reboundConfig: { ...PEAK_REBOUND_LIVE_DEFAULT_CONFIG, ...config.reboundConfig },
      deepReboundConfig: { ...DEEP_REBOUND_LIVE_DEFAULT_CONFIG, ...config.deepReboundConfig },
      streakConfig: { ...STREAK_LIVE_DEFAULT_CONFIG, ...config.streakConfig },
      preventConflict: config.preventConflict ?? true,
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
    const reboundSig = this.reboundTracker.checkCandles(symbol, candles, now);
    if (reboundSig) {
      const exitParams = {
        holdMinutes: this.config.reboundConfig.holdMinutes,
        exitX: this.config.reboundConfig.exitX,
        exitN: this.config.reboundConfig.exitN,
        exitM: this.config.reboundConfig.exitM,
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

    // 3. 信号三: 跌到 20%+ (Deep Rebound Short)
    const deepSig = this.checkDeepReboundSignal(symbol, dayChangePercent, candles, now);
    if (deepSig) {
      const exitParams = {
        holdMinutes: this.config.deepReboundConfig.holdMinutes,
        exitX: this.config.deepReboundConfig.exitX,
        exitN: this.config.deepReboundConfig.exitN,
        exitM: this.config.deepReboundConfig.exitM,
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

    // 4. 信号一: 连阳悬空 (Top N focus)
    if (rank <= this.config.streakConfig.topN) {
      const streakSig = this.checkStreakSignal(symbol, dayChangePercent, candles);
      if (streakSig) {
        const exitParams = {
          holdMinutes: this.config.streakConfig.holdMinutes,
          exitX: this.config.streakConfig.exitX,
          exitN: this.config.streakConfig.exitN,
          exitM: this.config.streakConfig.exitM,
        };
        const closedCandle = candles[candles.length - 2];
        const signal: UnifiedLiveSignal = {
          id: `str-${symbol}-${closedCandle.time}`,
          type: 'streak',
          label: '连阳悬空',
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

  /** Micro-structure evaluation of streak short conditions */
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
  } | null {
    const cfg = this.config.streakConfig;
    // targetIndex is the latest completed candle
    const targetIndex = candles.length - 2;
    const minRequiredBars = Math.max(35, (cfg.greenWindow ?? 30) + 5, ...cfg.supportMaPeriods);
    if (targetIndex < minRequiredBars - 1) return null;

    const candle = candles[targetIndex];
    if (!candle || candle.close <= 0 || candle.open <= 0) return null;

    // 1. 至少连续 minStreakCount 根阳线 (默认 >= 2 连阳)
    const streak = consecutiveStreakAt(candles, targetIndex);
    if (streak.direction !== 'up' || streak.count < cfg.minStreakCount) return null;
    const streakCount = streak.count;

    // 2. 30 分钟振幅 >= 24h 涨幅 / ampDivisor (默认 12)
    const window30 = candles.slice(targetIndex - 30 + 1, targetIndex + 1);
    const maxHigh = Math.max(...window30.map((c) => c.high));
    const minLow = Math.min(...window30.map((c) => c.low));
    if (minLow <= 0) return null;
    const amp30Percent = ((maxHigh - minLow) / minLow) * 100;
    if (amp30Percent < dayChangePercent / cfg.ampDivisor) {
      return null;
    }

    // 3. 均线 MA [3, 7, 15] 均无支撑
    const maSupported = calculateSupportMaAt(candles, targetIndex, cfg.supportMaPeriods);
    if (maSupported !== null) {
      return null; // Supported by MA -> do not short
    }

    // 4. 最后一根阳线上影线介于 0.5% 与 30% 之间 (0.5% <= 上影线比率 < 30%)
    const body = candle.close - candle.open;
    const upperShadow = Math.max(0, candle.high - candle.close);
    const upperShadowRatio = body > 0 ? upperShadow / body : 0;
    const minShadow = cfg.minUpperShadowRatio ?? 0.005;
    if (upperShadowRatio < minShadow || upperShadowRatio >= cfg.maxUpperShadowRatio) {
      return null;
    }

    // 5. 近 30 根已收盘 1m MACD 绿柱占比严格 > 70%
    const { hist } = computeMacd(candles.map((c) => c.close));
    if (hist.length <= targetIndex) return null;

    const greenWindow = cfg.greenWindow ?? 30;
    const greenStart = targetIndex - greenWindow + 1;
    if (greenStart < 0) return null;
    let greenCount = 0;
    for (let i = greenStart; i <= targetIndex; i++) {
      if (hist[i] > 0) greenCount++;
    }
    const greenRatio = greenCount / greenWindow;
    if (greenRatio <= cfg.minGreenRatio) return null;

    // 6. 末尾连续 >= 7 根 MACD 全绿柱
    let consecutiveGreen = 0;
    for (let i = targetIndex; i >= 0; i--) {
      if (hist[i] > 0) consecutiveGreen++;
      else break;
    }
    if (consecutiveGreen < cfg.minConsecutiveGreenBars) return null;

    return {
      streakCount,
      amp30Percent,
      greenRatio,
      consecutiveGreenBars: consecutiveGreen,
      upperShadowRatio,
    };
  }
}

