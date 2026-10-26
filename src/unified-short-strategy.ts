// Unified Dual-Signal Short Strategy Engine
// Coordinates both 'Streak Short' (Left-side high-level exhaustion) and 'Weak Rebound Short' (Right-side post-drop rebound MA ceiling)

import { Candle, computeMacd, consecutiveStreakAt, calculateSupportMaAt } from './macd.ts';
import {
  PeakReboundLiveConfig,
  PEAK_REBOUND_LIVE_DEFAULT_CONFIG,
  PeakReboundStrategyTracker,
  PeakReboundLiveSignal,
} from './peak-rebound-strategy.ts';

export type UnifiedSignalType = 'streak' | 'rebound';

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

export interface UnifiedLiveConfig {
  reboundConfig?: Partial<PeakReboundLiveConfig>;
  streakConfig?: Partial<StreakStrategyLiveConfig>;
  preventConflict?: boolean; // Prevent double-entry if the same symbol has an active trade (default true)
}

export const UNIFIED_LIVE_DEFAULT_CONFIG: Required<UnifiedLiveConfig> = {
  reboundConfig: PEAK_REBOUND_LIVE_DEFAULT_CONFIG,
  streakConfig: STREAK_LIVE_DEFAULT_CONFIG,
  preventConflict: true,
};

export interface UnifiedLiveSignal {
  id: string;
  type: UnifiedSignalType;
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
    streakConfig: StreakStrategyLiveConfig;
    preventConflict: boolean;
  };
  private reboundTracker: PeakReboundStrategyTracker;
  private activePositions = new Map<string, ActivePositionInfo>();

  constructor(config: UnifiedLiveConfig = {}) {
    this.config = {
      reboundConfig: { ...PEAK_REBOUND_LIVE_DEFAULT_CONFIG, ...config.reboundConfig },
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
   * Evaluates both Rebound Short and Streak Short signals, resolving conflicts.
   * Both strategies are checked; if either is satisfied, a signal is returned.
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

    // 2. Evaluate Weak Rebound Short (Rank 1 watchlist focus)
    // Evaluates any symbol currently tracked on the Rank 1 rebound watchlist
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

    // 3. Evaluate Streak Short (Top N focus)
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
