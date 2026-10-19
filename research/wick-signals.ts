import { calculateStreakGain, calculateSupportMaAt, computeMacd, consecutiveStreakAt, SUPPORT_MA_PERIODS } from '../src/macd.ts';
import { isAlertMatch } from '../src/alert-rule.ts';
import { HOUR, type Frame } from './types.ts';
import { MINUTE, type MinuteDataset } from './gainers-types.ts';
import type { WickConfig } from './wick-config.ts';

export const WICK_WARMUP = 199;
export const WICK_GREEN_WINDOW = 30;
export interface WickSignal {
  symbol: string;
  time: number;
  index: number;
  rank: number;
  boardTime: number;
  dayChangePercent: number;
  close: number;
  streakCount: number;
  streakGainPercent: number;
  requiredGainPercent: number;
  greenCount: number;
  greenRatio: number;
  hist: number;
  previousHist: number;
  supportMa: null;
}

export interface WickSignalAudit {
  rankedMinutes: number;
  bullishStreakMinutes: number;
  gainQualifiedMinutes: number;
  noMaMinutes: number;
  matchedMinutes: number;
}
export function buildWickSignals(data: MinuteDataset, frames: Frame[], c: WickConfig, audit?: WickSignalAudit): WickSignal[] {
  const boards = new Map(frames.map(f => [f.time, new Map(f.boards.gainers.map(r => [r.symbol, r]))]));
  const signals: WickSignal[] = [];
  for (const [symbol, bars] of data.candles) {
    // Compute each contiguous segment independently; never carry EMA or streaks across a gap.
    for (let a = 0; a < bars.length;) {
      let b = a + 1;
      while (b < bars.length && bars[b][0] === bars[b - 1][0] + MINUTE) b++;
      const candles = bars.slice(a, b).map(v => ({ time: v[0], open: v[1], low: v[3], close: v[4] }));
      for (let i = Math.max(c.indicatorWindow, ...SUPPORT_MA_PERIODS) - 1; i < candles.length; i++) {
        const candle = candles[i], time = candle.time + MINUTE;
        if (time < data.manifest.plan.start || time >= data.manifest.plan.end) continue;
        const boardTime = Math.floor(time / HOUR) * HOUR;
        const row = boards.get(boardTime)?.get(symbol);
        if (!row || row.rank > c.topN || row.dayChange <= 0 || row.dayChange < c.minDayChangePercent) continue;
        if (audit) audit.rankedMinutes++;
        // Match the monitor's bounded rolling history, excluding its forming candle.
        const window = candles.slice(i - c.indicatorWindow + 1, i + 1), last = window.length - 1;
        const streak = consecutiveStreakAt(window, last, MINUTE);
        if (streak.direction !== 'up' || streak.count < c.minStreakCount) continue;
        if (audit) audit.bullishStreakMinutes++;
        const streakGainPercent = calculateStreakGain(window, streak, last)!;
        const requiredGainPercent = c.gainMode === 'fixed' ? c.minStreakGainPercent : row.dayChange * c.dayGainFraction;
        if (streakGainPercent < requiredGainPercent) continue;
        if (audit) audit.gainQualifiedMinutes++;
        const supportMa = calculateSupportMaAt(window, last);
        if (supportMa != null) continue;
        if (audit) audit.noMaMinutes++;
        const { hist } = computeMacd(window.map(v => v.close));
        const greenCount = hist.slice(-WICK_GREEN_WINDOW).filter(v => v > 0).length;
        const greenRatio = greenCount / WICK_GREEN_WINDOW;
        if (!isAlertMatch({ supportMa, streakDir: streak.direction, streakCount: streak.count, streakGainPercent,
          priceChangePercent: row.dayChange, greenBarRatio30: greenRatio }, false,
        { minStreakCount: c.minStreakCount, minStreakGain: requiredGainPercent, minGreenRatio: c.minGreenRatio })) continue;
        if (audit) audit.matchedMinutes++;
        signals.push({ symbol, time, index: a + i, rank: row.rank, boardTime, dayChangePercent: row.dayChange,
          close: candle.close, streakCount: streak.count, streakGainPercent, requiredGainPercent,
          greenCount, greenRatio, hist: hist[last], previousHist: hist[last - 1], supportMa: null });
      }
      a = b;
    }
  }
  return signals.sort((a, b) => a.time - b.time || a.symbol.localeCompare(b.symbol));
}
