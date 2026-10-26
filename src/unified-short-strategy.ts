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
  dayGainFraction: number; // streakGain >= dayChange * dayGainFraction (e.g. 0.03)
  minGreenRatio: number;   // hist > 0 in 30 bars > minGreenRatio (e.g. 0.60)
  minConsecutiveGreenBars: number; // e.g. 7
  maxUpperShadowRatio: number;    // e.g. 0.30
  holdMinutes: number;            // e.g. 30
  exitX: number;                  // e.g. 60
  exitN: number;                  // e.g. 1.5
  exitM: number;                  // e.g. 4.0
}

export const STREAK_LIVE_DEFAULT_CONFIG: StreakStrategyLiveConfig = {
  topN: 10,
  minStreakCount: 2,
  dayGainFraction: 0.03,
  minGreenRatio: 0.60,
  minConsecutiveGreenBars: 7,
  maxUpperShadowRatio: 0.30,
  holdMinutes: 30,
  exitX: 60,
  exitN: 1.5,
  exitM: 4.0,
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
      streakGainPercent: number;
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

  /**
   * Process newly closed 1m candle for a given symbol.
   * Evaluates both Rebound Short and Streak Short signals, resolving conflicts.
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

    // 2. Evaluate Weak Rebound Short (Rank 1 focus)
    if (rank === 1) {
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
    streakGainPercent: number;
    greenRatio: number;
    consecutiveGreenBars: number;
    upperShadowRatio: number;
  } | null {
    const cfg = this.config.streakConfig;
    // targetIndex is the latest completed candle
    const targetIndex = candles.length - 2;
    if (targetIndex < 35) return null;

    const streak = consecutiveStreakAt(candles, targetIndex);
    if (streak.direction !== 'up' || streak.count < cfg.minStreakCount) return null;
    const streakCount = streak.count;

    const firstStreakCandle = candles[targetIndex - streakCount + 1];
    const targetCandle = candles[targetIndex];
    if (!firstStreakCandle || firstStreakCandle.open <= 0) return null;

    const streakGainPercent = ((targetCandle.close - firstStreakCandle.open) / firstStreakCandle.open) * 100;
    if (streakGainPercent < dayChangePercent * cfg.dayGainFraction) return null;

    // Check no MA support among MA [3, 5, 10, 15, 20]
    const maSupported = calculateSupportMaAt(candles, targetIndex, [3, 5, 10, 15, 20]);
    if (maSupported !== null) {
      return null; // Supported by MA -> do not short
    }

    // Upper shadow check
    const body = targetCandle.close - targetCandle.open;
    const upperShadow = targetCandle.high - targetCandle.close;
    const upperShadowRatio = body > 0 ? upperShadow / body : 0;
    if (upperShadowRatio >= cfg.maxUpperShadowRatio) return null;

    // MACD 30-bar green ratio and trailing consecutive green bars
    const windowStart = Math.max(0, targetIndex - 29);
    const windowCloses = candles.slice(windowStart, targetIndex + 1).map((c) => c.close);
    if (windowCloses.length < 30) return null;

    const { hist } = computeMacd(candles.slice(0, targetIndex + 1).map((c) => c.close));
    if (hist.length <= targetIndex) return null;

    let greenCount = 0;
    for (let i = targetIndex - 29; i <= targetIndex; i++) {
      if (hist[i] > 0) greenCount++;
    }
    const greenRatio = greenCount / 30;
    if (greenRatio <= cfg.minGreenRatio) return null;

    let consecutiveGreen = 0;
    for (let i = targetIndex; i >= targetIndex - 29; i--) {
      if (hist[i] > 0) consecutiveGreen++;
      else break;
    }
    if (consecutiveGreen < cfg.minConsecutiveGreenBars) return null;

    return {
      streakCount,
      streakGainPercent,
      greenRatio,
      consecutiveGreenBars: consecutiveGreen,
      upperShadowRatio,
    };
  }
}
