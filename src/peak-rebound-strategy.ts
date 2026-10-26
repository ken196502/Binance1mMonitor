// Strategy: Track 24h gainers rank 1, watch for peak pullback X% and rebound y% with MA resistance
import { type Candle, calculateMacdGreenBarRatio } from './macd.ts';

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
  watchWindowHours: number; // how long to observe after reaching rank 1 (default 48h)
}

export const PEAK_REBOUND_LIVE_DEFAULT_CONFIG: PeakReboundLiveConfig = {
  pullbackX: 10.0,
  reboundY: 4.0,
  shortMa: 5,
  mediumMa: 15,
  longMa: 30,
  longMaOffsetPercent: 0.5,
  minGreenRatio20: 0.65,
  requireMaSlopeDown: true,
  minReboundUpCandles: 1,
  maxFibRetracement: 0.50,
  minUpperShadowRatio: 0.30,
  requireBearishOrUpperShadow: true,
  holdMinutes: 30,
  exitX: 35,
  exitN: 2.0,
  exitM: 1.5,
  watchWindowHours: 48,
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

export class PeakReboundStrategyTracker {
  private config: PeakReboundLiveConfig;
  private watchlist = new Map<string, WatchState>();

  constructor(config: Partial<PeakReboundLiveConfig> = {}) {
    this.config = { ...PEAK_REBOUND_LIVE_DEFAULT_CONFIG, ...config };
  }

  /** Called when 24h ranking is updated */
  public onRankUpdate(topSymbol: string, dayChangePercent: number, now = Date.now()): void {
    if (dayChangePercent <= 0) return;
    const existing = this.watchlist.get(topSymbol);
    if (!existing) {
      this.watchlist.set(topSymbol, {
        symbol: topSymbol,
        enteredAt: now,
        lastRank1Time: now,
        dayChangeAtRank1: dayChangePercent,
        state: 'watching_peak',
        peakPrice: 0,
        peakTime: now,
        troughPrice: Infinity,
        troughTime: now,
        troughIndex: 0,
        cooldownUntil: 0,
      });
    } else {
      existing.lastRank1Time = now;
      existing.dayChangeAtRank1 = dayChangePercent;
    }
  }

  public getWatchlist(): WatchState[] {
    return Array.from(this.watchlist.values());
  }

  /**
   * Check 1m candles for a watched symbol.
   * Returns signal if entry conditions are met on latest closed candle.
   */
  public checkCandles(symbol: string, candles: Candle[], now = Date.now()): PeakReboundLiveSignal | null {
    const item = this.watchlist.get(symbol);
    if (!item) return null;

    // Expire if beyond watch window
    const maxWatchMs = this.config.watchWindowHours * 60 * 60 * 1000;
    if (now - item.lastRank1Time > maxWatchMs) {
      this.watchlist.delete(symbol);
      return null;
    }

    if (now < item.cooldownUntil) return null;

    // Minimum candles required
    const maxMa = Math.max(this.config.shortMa, this.config.mediumMa ?? 0, this.config.longMa, 30);
    if (candles.length < maxMa + 5) return null;

    // Target is latest closed candle (candles array ends with forming candle)
    const targetIdx = candles.length - 2;
    const candle = candles[targetIdx];
    if (!candle) return null;

    // Compute MAs
    const calcMa = (period: number, offsetBars = 0) => {
      let sum = 0;
      for (let k = 0; k < period; k++) sum += candles[targetIdx - offsetBars - k].close;
      return sum / period;
    };
    const maShort = calcMa(this.config.shortMa);
    const maMed = this.config.mediumMa !== undefined ? calcMa(this.config.mediumMa) : null;
    const maLong = calcMa(this.config.longMa);

    if (item.peakPrice === 0) {
      item.peakPrice = candle.high;
      item.peakTime = candle.time;
      item.troughPrice = candle.low;
      item.troughTime = candle.time;
      item.troughIndex = targetIdx;
      item.state = 'watching_peak';
      return null;
    }

    // State machine
    if (item.state === 'watching_peak') {
      if (candle.high >= item.peakPrice) {
        item.peakPrice = candle.high;
        item.peakTime = candle.time;
        item.troughPrice = candle.low;
        item.troughTime = candle.time;
        item.troughIndex = targetIdx;
      } else {
        const pullback = ((item.peakPrice - candle.low) / item.peakPrice) * 100;
        if (pullback >= this.config.pullbackX) {
          item.state = 'pulled_back';
          item.troughPrice = candle.low;
          item.troughTime = candle.time;
          item.troughIndex = targetIdx;
        }
      }
      return null;
    }

    if (item.state === 'pulled_back') {
      if (candle.high > item.peakPrice) {
        item.peakPrice = candle.high;
        item.peakTime = candle.time;
        item.troughPrice = candle.low;
        item.troughTime = candle.time;
        item.troughIndex = targetIdx;
        item.state = 'watching_peak';
        return null;
      }

      if (candle.low < item.troughPrice) {
        item.troughPrice = candle.low;
        item.troughTime = candle.time;
        item.troughIndex = targetIdx;
      }

      const rebound = ((candle.high - item.troughPrice) / item.troughPrice) * 100;
      if (rebound >= this.config.reboundY) {
        item.state = 'rebounded';
      } else {
        return null;
      }
    }

    if (item.state === 'rebounded') {
      if (candle.high > item.peakPrice) {
        item.peakPrice = candle.high;
        item.peakTime = candle.time;
        item.troughPrice = candle.low;
        item.troughTime = candle.time;
        item.troughIndex = targetIdx;
        item.state = 'watching_peak';
        return null;
      }

      if (candle.low < item.troughPrice) {
        item.troughPrice = candle.low;
        item.troughTime = candle.time;
        item.troughIndex = targetIdx;
        item.state = 'pulled_back';
        return null;
      }

      // Check:
      // 1. 均线空头排列: 双均线 maLong > maShort; 三均线 maLong > maMed > maShort
      const isMaAlignment = this.config.mediumMa !== undefined && maMed != null
        ? (maLong > maMed && maMed > maShort)
        : (maLong > maShort);
      // 2. 长周期均线高于上影线最高点 X%: maLong >= candle.high * (1 + this.config.longMaOffsetPercent / 100)
      const isMaLongAboveHigh = maLong >= candle.high * (1 + this.config.longMaOffsetPercent / 100);
      // 3. 短周期均线压制: candle.high > maShort && candle.close < maShort
      const isShortMaSuppressed = candle.high > maShort && candle.close < maShort;
      // 4. 可选: 中长均线向下倾斜
      let isSlopeDown = true;
      if (this.config.requireMaSlopeDown && targetIdx >= 2) {
        const maLongPrev = calcMa(this.config.longMa, 2);
        if (maLong > maLongPrev) isSlopeDown = false;
        if (this.config.mediumMa !== undefined && maMed != null) {
          const maMedPrev = calcMa(this.config.mediumMa, 2);
          if (maMed > maMedPrev) isSlopeDown = false;
        }
      }
      // 5. 近20根1m MACD绿柱占比 > minGreenRatio20
      const closes = candles.map((c) => c.close);
      const macdRatio = calculateMacdGreenBarRatio(closes, targetIdx, 20);
      const greenRatio20 = macdRatio ? macdRatio.ratio : 0;
      const isMacdGreenSatisfied = this.config.minGreenRatio20 <= 0 || greenRatio20 > this.config.minGreenRatio20;

      // 6. 蜡烛图形态与反弹区间校验
      let reboundUpCandles = 0;
      const startIdx = Math.max(0, item.troughIndex);
      for (let k = startIdx; k <= targetIdx; k++) {
        if (candles[k] && candles[k].close > candles[k].open) reboundUpCandles++;
      }
      const totalDrop = item.peakPrice - item.troughPrice;
      const currentReb = candle.high - item.troughPrice;
      const fibRetracement = totalDrop > 0 ? currentReb / totalDrop : 0;
      const range = candle.high - candle.low;
      const upperShadowRatio = range > 0 ? (candle.high - Math.max(candle.open, candle.close)) / range : 0;
      const isBearishCandle = candle.close <= candle.open;

      let isCandleSatisfied = true;
      if (this.config.minReboundUpCandles !== undefined && reboundUpCandles < this.config.minReboundUpCandles) {
        isCandleSatisfied = false;
      }
      if (this.config.maxFibRetracement !== undefined && fibRetracement > this.config.maxFibRetracement) {
        isCandleSatisfied = false;
      }
      if (this.config.requireBearishOrUpperShadow) {
        const minShadow = this.config.minUpperShadowRatio ?? 0.30;
        if (!isBearishCandle && upperShadowRatio < minShadow) {
          isCandleSatisfied = false;
        }
      }

      if (isMaAlignment && isMaLongAboveHigh && isShortMaSuppressed && isSlopeDown && isMacdGreenSatisfied && isCandleSatisfied) {
        const pullback = ((item.peakPrice - item.troughPrice) / item.peakPrice) * 100;
        const rebound = ((candle.high - item.troughPrice) / item.troughPrice) * 100;

        item.cooldownUntil = now + 30 * 60 * 1000;
        item.state = 'watching_peak';
        item.peakPrice = candle.high;
        item.troughPrice = candle.low;

        return {
          symbol,
          time: candle.time,
          dayChangePercent: item.dayChangeAtRank1,
          peakPrice: item.peakPrice,
          pullbackPercent: pullback,
          troughPrice: item.troughPrice,
          reboundPercent: rebound,
          fibRetracement,
          reboundUpCandles,
          upperShadowRatio,
          piercedMa: this.config.shortMa,
          mediumMa: this.config.mediumMa,
          greenRatio20,
          candle,
        };
      }
    }

    return null;
  }
}

export const peakReboundStrategy = new PeakReboundStrategyTracker();
