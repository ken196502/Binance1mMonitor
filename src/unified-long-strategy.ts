// Unified Multi-Signal Long Strategy Engine for Binance 24h Top Gainers
// Completely focused on 24h Top Gainers (涨幅榜专属做多体系):
// 1. 'Golden MA30 Pullback Long' (龙头MA30黄金生命线回踩做多 - 75.7% 胜率, +29.74% 净收益)
// 2. 'Deep MA60 Support Long' (龙头MA60深度深蹲托底做多 - 77.8% 胜率, +11.29% 净收益)
// 3. 'Rank 1 First Pullback Long' (榜一首次见顶回踩状态机做多 - 71.4% 胜率)
// 4. 'Second Wave Expansion Long' (龙头回踩二浪金叉放量突破做多 - 68.3% 胜率)

import { Candle, computeMacd, calculateSma } from './macd.ts';

export type UnifiedLongSignalType =
  | 'ma30_pullback'
  | 'ma60_support'
  | 'rank1_first_pullback'
  | 'second_wave_expansion';

export interface GoldenPullbackLiveConfig {
  topN: number;               // 默认 10 (涨幅榜 Top 10)
  minDayChange: number;       // 默认 25.0 (24h 涨幅 >= 25%)
  minPullbackPercent: number; // 默认 10.0 (从 24h 峰值回踩下限 10%)
  maxPullbackPercent: number; // 默认 20.0 (回踩上限 20%，防止大破位)
  maPeriod: number;           // 默认 30 (MA30 黄金生命线)
  requireMaSlopeUp: boolean;  // 默认 true (MA30 向上倾斜确认)
  requireMacdPositive: boolean; // 默认 true (MACD DIF > 0 处于多头大趋势)
  minLowerShadowRatio: number;// 默认 0.40 (下影线占比 >= 40% 或实体阳线)
  holdMinutes: number;        // 默认 90 分钟 (大止损长波段，回测胜率 75.7%)
  stopLossPercent: number;    // 默认 8.0%
  tp1Percent: number;         // 默认 3.0% (阶段一止盈平 50% 移动保本)
  tp2Percent: number;         // 默认 8.0% (阶段二止盈)
  moveSlToEntryAfterTp1: boolean; // 默认 true
  cooldownMinutes: number;    // 默认 20 分钟
  leverage: number;           // 默认 3x
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
  topN: number;               // 默认 10 (涨幅榜 Top 10)
  minDayChange: number;       // 默认 25.0 (24h 涨幅 >= 25%)
  minPullbackPercent: number; // 默认 14.0 (深蹲下限 14%)
  maxPullbackPercent: number; // 默认 25.0 (深蹲上限 25%)
  maPeriod: number;           // 默认 60 (MA60 1小时级别趋势生命线)
  requireMaSlopeUp: boolean;  // 默认 true
  requireMacdPositive: boolean; // 默认 true
  minLowerShadowRatio: number;// 默认 0.45
  holdMinutes: number;        // 默认 60 分钟 (回测胜率 77.8%)
  stopLossPercent: number;    // 默认 7.0%
  tp1Percent: number;         // 默认 3.0%
  tp2Percent: number;         // 默认 8.0%
  moveSlToEntryAfterTp1: boolean; // 默认 true
  cooldownMinutes: number;    // 默认 25 分钟
  leverage: number;           // 默认 3x
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
  minDayChange: number;       // 默认 25.0 (24h 涨幅 >= 25%)
  minPullbackPercent: number; // 默认 10.0
  maxPullbackPercent: number; // 默认 18.0
  holdMinutes: number;        // 默认 60 分钟 (回测胜率 71.4%)
  stopLossPercent: number;    // 默认 6.0%
  tp1Percent: number;         // 默认 3.5%
  tp2Percent: number;         // 默认 8.0%
  moveSlToEntryAfterTp1: boolean; // 默认 true
  cooldownMinutes: number;    // 默认 120 分钟 (状态机单波仅触发一次)
  leverage: number;           // 默认 3x
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
  topN: number;               // 默认 10 (涨幅榜 Top 10)
  minDayChange: number;       // 默认 20.0 (24h 涨幅 >= 20%)
  minBarReturn: number;       // 默认 0.8% (启动阳线实体涨幅 >= 0.8%)
  minBodyRatio: number;       // 默认 0.60 (阳线实体占比 >= 60%)
  holdMinutes: number;        // 默认 45 分钟
  stopLossPercent: number;    // 默认 5.0%
  tp1Percent: number;         // 默认 3.0%
  tp2Percent: number;         // 默认 7.0%
  moveSlToEntryAfterTp1: boolean; // 默认 true
  cooldownMinutes: number;    // 默认 30 分钟
  leverage: number;           // 默认 3x
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
  goldenPullbackConfig?: Partial<GoldenPullbackLiveConfig>;
  deepSupportConfig?: Partial<DeepSupportLiveConfig>;
  rank1PullbackConfig?: Partial<Rank1PullbackLiveConfig>;
  secondWaveConfig?: Partial<SecondWaveExpansionLiveConfig>;
  preventConflict?: boolean;
  enableGoldenPullback?: boolean; // 是否启用龙头 MA30 黄金生命线回踩做多 (默认 true, 胜率 75.7%)
  enableDeepSupport?: boolean;    // 是否启用龙头 MA60 深度大蹲强托底做多 (默认 true, 胜率 77.8%)
  enableRank1Pullback?: boolean;  // 是否启用榜一首次见顶回踩做多 (默认 true)
  enableSecondWave?: boolean;     // 是否启用龙头二浪放量突破做多 (默认 true)
}

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
    dropFrom24h?: number;
    maLevel?: number;
    dif?: number;
    barReturn?: number;
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
    goldenPullbackConfig: GoldenPullbackLiveConfig;
    deepSupportConfig: DeepSupportLiveConfig;
    rank1PullbackConfig: Rank1PullbackLiveConfig;
    secondWaveConfig: SecondWaveExpansionLiveConfig;
    preventConflict: boolean;
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
      goldenPullbackConfig: { ...GOLDEN_PULLBACK_LIVE_DEFAULT_CONFIG, ...config.goldenPullbackConfig },
      deepSupportConfig: { ...DEEP_SUPPORT_LIVE_DEFAULT_CONFIG, ...config.deepSupportConfig },
      rank1PullbackConfig: { ...RANK1_PULLBACK_LIVE_DEFAULT_CONFIG, ...config.rank1PullbackConfig },
      secondWaveConfig: { ...SECOND_WAVE_EXPANSION_LIVE_DEFAULT_CONFIG, ...config.secondWaveConfig },
      preventConflict: config.preventConflict ?? true,
      enableGoldenPullback: config.enableGoldenPullback ?? true,
      enableDeepSupport: config.enableDeepSupport ?? true,
      enableRank1Pullback: config.enableRank1Pullback ?? true,
      enableSecondWave: config.enableSecondWave ?? true,
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
    if (typeof updates.enableGoldenPullback === "boolean") this.config.enableGoldenPullback = updates.enableGoldenPullback;
    if (typeof updates.enableDeepSupport === "boolean") this.config.enableDeepSupport = updates.enableDeepSupport;
    if (typeof updates.enableRank1Pullback === "boolean") this.config.enableRank1Pullback = updates.enableRank1Pullback;
    if (typeof updates.enableSecondWave === "boolean") this.config.enableSecondWave = updates.enableSecondWave;
    if (typeof updates.preventConflict === "boolean") this.config.preventConflict = updates.preventConflict;
  }

  /**
   * Evaluate a newly closed 1m candle for 24h Top Gainers Long entries.
   * Order of evaluation:
   * 1. 龙头 MA30 黄金生命线回踩 (胜率 75.7%)
   * 2. 龙头 MA60 深度大蹲强托底 (胜率 77.8%)
   * 3. 榜一首次见顶回踩状态机 (胜率 71.4%)
   * 4. 龙头二浪金叉放量突破
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
    if (targetIdx < 65) return null;
    const closedCandle = candles[targetIdx];
    if (!closedCandle || closedCandle.close <= 0) return null;

    const lastCooldown = this.cooldownMap.get(symbol) ?? 0;
    if (now < lastCooldown) return null;

    // 1. 策略一：龙头 MA30 黄金生命线回踩做多 (Top Gainers Focus, 胜率 75.7%)
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

    // 2. 策略二：龙头 MA60 深度大蹲强托底做多 (胜率 77.8%)
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

    // 3. 策略三：榜一首次见顶回踩状态机做多 (胜率 71.4%)
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

    // 4. 策略四：龙头二浪金叉放量突破做多
    if (this.config.enableSecondWave) {
      const sig4 = this.checkSecondWaveExpansion(closedCandle, candles, targetIdx, dayChangePercent);
      if (sig4) {
        const cfg = this.config.secondWaveConfig;
        this.cooldownMap.set(symbol, now + cfg.cooldownMinutes * 60 * 1000);
        const signal: UnifiedLongLiveSignal = {
          id: `long-wave2-${symbol}-${closedCandle.time}`,
          type: 'second_wave_expansion',
          label: '龙头二浪金叉突破',
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

      // 踩稳均线且收阳线
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
