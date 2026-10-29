// Unified Triple-Signal Short Strategy Engine
// Coordinates:
// 1. 'New High Bearish Divergence Short' (新高顶背离 - 24h new high + no MA support + Xm surge + MACD divergence, replaced legacy Streak Short)
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
  divergenceLookbackMax: 120,
  requireDoubleDivergence: true,
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

    // 4. 信号一: 新高顶背离 (Top N focus, 彻底替换连阳空)
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

    // 4. 可选：显式指定了最小连阳数时才校验连阳 (向下兼容自定义测试，默认不管连阳)
    if (cfg.minStreakCount !== undefined && cfg.minStreakCount > 0) {
      const streak = consecutiveStreakAt(candles, targetIndex);
      if (streak.direction !== 'up' || streak.count < cfg.minStreakCount) return null;
    }

    // 5. 可选：显式指定了上影线比例时才校验上影线
    const body = candle.close - candle.open;
    const upperShadow = Math.max(0, candle.high - candle.close);
    const upperShadowRatio = body > 0 ? upperShadow / body : 0;
    if (cfg.minUpperShadowRatio !== undefined && cfg.maxUpperShadowRatio !== undefined) {
      if (upperShadowRatio < cfg.minUpperShadowRatio || upperShadowRatio >= cfg.maxUpperShadowRatio) {
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

