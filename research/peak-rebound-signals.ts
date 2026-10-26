import { HOUR, type Frame } from './types.ts';
import { MINUTE, type MinuteDataset } from './gainers-types.ts';
import type { PeakReboundSignal } from './peak-rebound-types.ts';
import { computeMacd } from '../src/macd.ts';

export interface WatchlistSymbolInfo {
  symbol: string;
  firstRank1Time: number;
  lastRank1Time: number;
  dayChangeAtRank1: number;
  rank1Hours: number;
}

/** Extract all symbols that ever reached Rank 1 on 24h gainers with positive gain */
export function getRank1Watchlist(frames: Frame[]): Map<string, WatchlistSymbolInfo> {
  const map = new Map<string, WatchlistSymbolInfo>();
  for (const frame of frames) {
    const top = frame.boards.gainers[0];
    if (top && top.rank === 1 && top.dayChange > 0) {
      const existing = map.get(top.symbol);
      if (!existing) {
        map.set(top.symbol, {
          symbol: top.symbol,
          firstRank1Time: frame.time,
          lastRank1Time: frame.time,
          dayChangeAtRank1: top.dayChange,
          rank1Hours: 1,
        });
      } else {
        existing.lastRank1Time = frame.time;
        existing.dayChangeAtRank1 = top.dayChange;
        existing.rank1Hours += 1;
      }
    }
  }
  return map;
}

/** Calculate simple moving average at index i */
export function calculateSma(closes: readonly number[], index: number, period: number): number | null {
  if (index + 1 < period) return null;
  let sum = 0;
  for (let k = 0; k < period; k++) {
    sum += closes[index - k];
  }
  return sum / period;
}

/**
 * Check if candle at index is suppressed by MA:
 * User rule: "多试验几个组合，压制就是上影线比某ma高但收盘比某ma低"
 * High pierced above MA, but close closed below MA.
 */
export function isMaSuppressed(
  candle: { high: number; close: number },
  mas: Record<number, number>,
  periods: readonly number[],
): { suppressed: boolean; piercedMaPeriod: number | null } {
  if (periods.length === 0) return { suppressed: false, piercedMaPeriod: null };

  // All specified periods must have close < MA
  for (const p of periods) {
    const ma = mas[p];
    if (ma == null || candle.close >= ma) {
      return { suppressed: false, piercedMaPeriod: null };
    }
  }

  // At least one period must have high > MA (upper shadow probed above MA)
  let piercedPeriod: number | null = null;
  for (const p of periods) {
    const ma = mas[p];
    if (ma != null && candle.high > ma) {
      piercedPeriod = p;
      break;
    }
  }

  if (piercedPeriod != null) {
    return { suppressed: true, piercedMaPeriod: piercedPeriod };
  }
  return { suppressed: false, piercedMaPeriod: null };
}

export interface BuildSignalsOptions {
  pullbackX: number; // e.g. 5 (%)
  reboundY: number;  // e.g. 2 (%)
  shortMa?: number;  // e.g. 5
  mediumMa?: number; // e.g. 15 (三均线组合中周期)
  longMa?: number;   // e.g. 30 (三均线组合长周期)
  longMaOffsetPercent?: number; // e.g. 1.0 (%)
  minGreenRatio20?: number; // e.g. 0.55 (近20根1m MACD绿柱占比 > minGreenRatio20)
  requireMaSlopeDown?: boolean; // 是否要求中长周期均线向下倾斜
  minReboundUpCandles?: number; // 反弹区间最少阳线数量 (如 1 或 2)
  maxFibRetracement?: number;   // 反弹斐波那契回撤上限 (如 0.50，反弹不超过跌幅50%)
  minUpperShadowRatio?: number; // 信号K线上影线占比阈值 (如 0.30)
  requireBearishOrUpperShadow?: boolean; // 信号K线需收阴或留显著上影线
  maPeriods?: number[]; // fallback e.g. [5] or [5, 10]
  watchWindowHours?: number; // default 48h
}

/**
 * Generate Peak Rebound Short Signals:
 * 1. Coins reaching #1 on 24h gainers are put into watchlist.
 * 2. Peak price tracked from watchlist entry.
 * 3. Price drops by >= X% from peak to establish pullback & local trough.
 * 4. Price rebounds by >= y% from local trough.
 * 5. Candle experiences moving average resistance:
 *    - Optional: long MA > short MA (或三均线 long MA > med MA > short MA) 且 long MA >= candle.high * (1 + longMaOffsetPercent / 100)
 *    - Short MA suppression: candle.high > short MA && candle.close < short MA
 *    - MACD confirmation: last 20 bars green ratio > minGreenRatio20
 *    - Candlestick anatomy: rebound up candles, Fibonacci retracement cap, bearish/upper shadow rejection
 */
export function buildPeakReboundSignals(
  data: MinuteDataset,
  frames: Frame[],
  options: BuildSignalsOptions,
): PeakReboundSignal[] {
  const {
    pullbackX,
    reboundY,
    shortMa = options.maPeriods?.[0] ?? 5,
    mediumMa = options.mediumMa,
    longMa = 30,
    longMaOffsetPercent = 0,
    minGreenRatio20,
    requireMaSlopeDown = false,
    minReboundUpCandles = options.minReboundUpCandles,
    maxFibRetracement = options.maxFibRetracement,
    minUpperShadowRatio = options.minUpperShadowRatio,
    requireBearishOrUpperShadow = options.requireBearishOrUpperShadow,
    maPeriods = mediumMa !== undefined ? [shortMa, mediumMa, longMa] : [shortMa],
    watchWindowHours = 48,
  } = options;
  const watchlist = getRank1Watchlist(frames);
  const signals: PeakReboundSignal[] = [];
  const maxPeriod = Math.max(65, shortMa, mediumMa ?? 0, longMa, ...maPeriods);

  for (const [symbol, info] of watchlist) {
    const bars = data.candles.get(symbol);
    if (!bars || bars.length === 0) continue;

    const watchStart = info.firstRank1Time;
    const watchEnd = info.lastRank1Time + watchWindowHours * HOUR;

    // Split bars into contiguous segments
    for (let a = 0; a < bars.length; ) {
      let b = a + 1;
      while (b < bars.length && bars[b][0] === bars[b - 1][0] + MINUTE) b++;
      const segment = bars.slice(a, b);

      if (segment.length >= maxPeriod) {
        const closes = segment.map((bar) => bar[4]);
        const { hist } = computeMacd(closes);

        // State machine across this contiguous segment
        let state: 'idle' | 'watching_peak' | 'pulled_back' | 'rebounded' = 'idle';
        let peakPrice = 0;
        let peakTime = 0;
        let troughPrice = Infinity;
        let troughTime = 0;
        let troughIndex = 0;
        let cooldownUntil = 0;

        for (let i = maxPeriod - 1; i < segment.length; i++) {
          const bar = segment[i];
          const time = bar[0];
          const candle = {
            time: bar[0],
            open: bar[1],
            high: bar[2],
            low: bar[3],
            close: bar[4],
          };

          if (time < watchStart || time > watchEnd) {
            state = 'idle';
            continue;
          }

          if (time < cooldownUntil) {
            continue;
          }

          // Precompute MAs
          const mas: Record<number, number> = {};
          for (const p of [3, 5, 7, 10, 15, 20, 30]) {
            const val = calculateSma(closes, i, p);
            if (val != null) mas[p] = val;
          }

          if (state === 'idle') {
            peakPrice = candle.high;
            peakTime = time;
            troughPrice = candle.low;
            troughTime = time;
            troughIndex = i;
            state = 'watching_peak';
            continue;
          }

          if (state === 'watching_peak') {
            if (candle.high >= peakPrice) {
              peakPrice = candle.high;
              peakTime = time;
              troughPrice = candle.low;
              troughTime = time;
              troughIndex = i;
            } else {
              const currentPullback = ((peakPrice - candle.low) / peakPrice) * 100;
              if (currentPullback >= pullbackX) {
                state = 'pulled_back';
                troughPrice = candle.low;
                troughTime = time;
                troughIndex = i;
              }
            }
            continue;
          }

          if (state === 'pulled_back') {
            if (candle.high > peakPrice) {
              // Higher high formed, reset peak
              peakPrice = candle.high;
              peakTime = time;
              troughPrice = candle.low;
              troughTime = time;
              troughIndex = i;
              state = 'watching_peak';
              continue;
            }

            if (candle.low < troughPrice) {
              troughPrice = candle.low;
              troughTime = time;
              troughIndex = i;
            }

            const currentRebound = ((candle.high - troughPrice) / troughPrice) * 100;
            if (currentRebound >= reboundY) {
              state = 'rebounded';
              // Check MA suppression immediately on this rebound candle
            }
          }

          if (state === 'rebounded') {
            if (candle.high > peakPrice) {
              // New peak breaks out, reset
              peakPrice = candle.high;
              peakTime = time;
              troughPrice = candle.low;
              troughTime = time;
              troughIndex = i;
              state = 'watching_peak';
              continue;
            }

            if (candle.low < troughPrice) {
              // Broke lower than previous trough, update trough and stay in pulled_back
              troughPrice = candle.low;
              troughTime = time;
              troughIndex = i;
              state = 'pulled_back';
              continue;
            }

            // In rebound phase: test MA suppression
            const maShort = mas[shortMa] ?? calculateSma(closes, i, shortMa);
            const maMed = mediumMa !== undefined ? (mas[mediumMa] ?? calculateSma(closes, i, mediumMa)) : null;
            const maLong = mas[longMa] ?? calculateSma(closes, i, longMa);

            let satisfiesCondition = false;
            let piercedMa = shortMa;

            if (options.shortMa !== undefined && options.longMa !== undefined) {
              if (maShort != null && maLong != null) {
                // 1. 均线排列确认: 双均线 maLong > maShort; 三均线 maLong > maMed > maShort
                const isMaAlignment = mediumMa !== undefined && maMed != null
                  ? (maLong > maMed && maMed > maShort)
                  : (maLong > maShort);

                // 2. 长均线作为空头天花板
                const isMaLongAboveHigh = maLong >= candle.high * (1 + longMaOffsetPercent / 100);

                // 3. 短周期均线阻击
                const isShortMaSuppressed = candle.high > maShort && candle.close < maShort;

                // 4. 可选: 均线向下倾斜
                let isSlopeDown = true;
                if (requireMaSlopeDown && i >= 2) {
                  const maLongPrev = calculateSma(closes, i - 2, longMa);
                  if (maLongPrev != null && maLong > maLongPrev) isSlopeDown = false;
                  if (mediumMa !== undefined && maMed != null) {
                    const maMedPrev = calculateSma(closes, i - 2, mediumMa);
                    if (maMedPrev != null && maMed > maMedPrev) isSlopeDown = false;
                  }
                }

                satisfiesCondition = isMaAlignment && isMaLongAboveHigh && isShortMaSuppressed && isSlopeDown;
              }
            } else {
              const { suppressed, piercedMaPeriod } = isMaSuppressed(candle, mas, maPeriods);
              satisfiesCondition = suppressed && piercedMaPeriod != null;
              if (piercedMaPeriod != null) piercedMa = piercedMaPeriod;
            }

            // MACD 20-bar green ratio check: hist > 0 in the last 20 closed bars
            let greenRatio20 = 0;
            if (i >= 19 && hist.length > i) {
              let greenCount = 0;
              for (let k = i - 19; k <= i; k++) {
                if (hist[k] > 0) greenCount++;
              }
              greenRatio20 = greenCount / 20;
            }

            if (minGreenRatio20 !== undefined && greenRatio20 <= minGreenRatio20) {
              satisfiesCondition = false;
            }

            // Candlestick anatomy and micro-structure checks
            const reboundSlice = segment.slice(troughIndex, i + 1);
            let reboundUpCandles = 0;
            for (const b of reboundSlice) {
              if (b[4] > b[1]) reboundUpCandles++;
            }
            const totalDrop = peakPrice - troughPrice;
            const currentReb = candle.high - troughPrice;
            const fibRetracement = totalDrop > 0 ? (currentReb / totalDrop) : 0;
            const range = candle.high - candle.low;
            const upperShadowRatio = range > 0 ? (candle.high - Math.max(candle.open, candle.close)) / range : 0;
            const isBearishCandle = candle.close <= candle.open;

            if (minReboundUpCandles !== undefined && reboundUpCandles < minReboundUpCandles) {
              satisfiesCondition = false;
            }
            if (maxFibRetracement !== undefined && fibRetracement > maxFibRetracement) {
              satisfiesCondition = false;
            }
            if (requireBearishOrUpperShadow) {
              const minShadow = minUpperShadowRatio ?? 0.30;
              if (!isBearishCandle && upperShadowRatio < minShadow) {
                satisfiesCondition = false;
              }
            }

            if (satisfiesCondition) {
              const currentPullback = ((peakPrice - troughPrice) / peakPrice) * 100;
              const currentRebound = ((candle.high - troughPrice) / troughPrice) * 100;

              signals.push({
                symbol,
                time: time + MINUTE, // next bar open
                index: a + i,
                boardTime: Math.floor(time / HOUR) * HOUR,
                dayChangePercent: info.dayChangeAtRank1,
                rank: 1,
                peakPrice,
                peakTime,
                pullbackPercent: currentPullback,
                troughPrice,
                troughTime,
                reboundPercent: currentRebound,
                fibRetracement,
                reboundUpCandles,
                upperShadowRatio,
                shortMa,
                mediumMa,
                longMa,
                longMaOffsetPercent,
                greenRatio20,
                maPeriod: piercedMa,
                maPeriods: [...maPeriods],
                maValues: mas,
                close: candle.close,
                high: candle.high,
                low: candle.low,
                open: candle.open,
              });

              // Cooldown for 30 minutes after signal before resetting
              cooldownUntil = time + 30 * MINUTE;
              state = 'idle';
            }
          }
        }
      }
      a = b;
    }
  }

  return signals.sort((a, b) => a.time - b.time || a.symbol.localeCompare(b.symbol));
}
