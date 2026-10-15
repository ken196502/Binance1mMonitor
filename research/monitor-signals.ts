import { calculateSupportMaAt, consecutiveStreakAt, diffLevel, type DiffLevel } from '../src/macd.ts';
import { isAlertMatch } from '../src/alert-rule.ts';
import { matchesStreak } from './streak.ts';
import { DAY, HOUR, type Bar, type Frame } from './types.ts';
import { MINUTE, type MinuteDataset, type MinuteSignal } from './gainers-types.ts';
import { MONITOR_RULE, type MonitorBoard } from './monitor-data.ts';

export interface MonitorParameters {
  monitorMode?: 'baseline' | 'grid';
  diff1mLevel?: DiffLevel;
  diff5mLevel?: DiffLevel;
  fiveHighRatio?: number;
  minDrawdownPercent?: number;
}
export interface MonitorFeature {
  board: MonitorBoard; hist1m: number; peakHist1m: number; hist5m: number; peakHist5m: number;
  fiveClosedAt: number; lastPrice: number; max1500: number; drawdownPercent: number;
  change60d: 'up' | 'down' | null; dailyClosedAt: number; dailyBars: number;
}
interface HistFeature { dif: number; dea: number; peakDea: number; hist: number; peakHist: number }

/** Only complete UTC-aligned buckets; an absent minute never becomes a synthetic bar. */
export function closedFiveBars(bars: Bar[]): Bar[] {
  const result: Bar[] = [];
  for (let i = 0; i + 4 < bars.length; i++) {
    const first = bars[i];
    if (first[0] % (5 * MINUTE) || bars[i + 4][0] !== first[0] + 4 * MINUTE) continue;
    const group = bars.slice(i, i + 5);
    if (group.some((b, j) => b[0] !== first[0] + j * MINUTE)) continue;
    result.push([first[0], first[1], Math.max(...group.map((b) => b[2])), Math.min(...group.map((b) => b[3])),
      group[4][4], group.reduce((n, b) => n + b[5], 0), group.reduce((n, b) => n + b[6], 0)]);
    i += 4;
  }
  return result;
}
export function closedHistFeatures(bars: Bar[], interval: number, highWindow = MONITOR_RULE.highWindow): Map<number, HistFeature> {
  const result = new Map<number, HistFeature>(), hist: number[] = [], deas: number[] = [];
  let fast = 0, slow = 0, dea = 0, segment = 0;
  for (const [i, b] of bars.entries()) {
    if (i === 0 || b[0] !== bars[i - 1][0] + interval) { fast = slow = b[4]; dea = 0; segment = i; }
    else { fast += 2 / 13 * (b[4] - fast); slow += 2 / 27 * (b[4] - slow); dea += 2 / 10 * (fast - slow - dea); }
    const dif = fast - slow;
    hist.push(2 * (dif - dea)); deas.push(dea);
    if (i - segment + 1 < Math.max(300, highWindow + 35)) continue;
    result.set(b[0] + interval, { dif, dea, hist: hist[i], peakHist: Math.max(...hist.slice(i - highWindow + 1, i + 1)),
      peakDea: Math.max(...deas.slice(i - highWindow + 1, i + 1)) });
  }
  return result;
}

/** Matches live fallback for newly listed symbols, never treats a missing old day as a shorter history. */
export function dailyTrendAt(bars: Bar[], time: number, onboardDate = 0) {
  const closedAt = Math.floor(time / DAY) * DAY;
  const expectedStart = Math.max(closedAt - 61 * DAY, Math.floor(onboardDate / DAY) * DAY);
  const window = bars.filter((b) => b[0] >= expectedStart && b[0] < closedAt);
  if (window.length < 2 || window[0][0] !== expectedStart || window.at(-1)![0] !== closedAt - DAY
    || window.some((b, i) => i > 0 && b[0] !== window[i - 1][0] + DAY)) return null;
  const latest = window.at(-1)![4], first = window[0][4];
  return { closedAt, bars: window.length, trend: latest > first ? 'up' as const : latest < first ? 'down' as const : null };
}

export function buildMonitorSignals(data: MinuteDataset, daily: Map<string, Bar[]>, frames: Frame[], board: MonitorBoard,
  onboard: Map<string, number>, minDrawdown = 0): MinuteSignal[] {
  const members = new Map(frames.map((f) => [f.time, new Map(f.boards[board].map((r) => [r.symbol, r.rank]))]));
  const signals: MinuteSignal[] = [];
  const { start, end } = data.manifest.plan;
  for (const [symbol, bars] of data.candles) {
    const one = closedHistFeatures(bars, MINUTE), five = closedHistFeatures(closedFiveBars(bars), 5 * MINUTE);
    const support = bars.map((b) => ({ time: b[0], open: b[1], close: b[4], low: b[3] }));
    const dailyCache = new Map<number, ReturnType<typeof dailyTrendAt>>();
    const highs: number[] = []; let head = 0, segment = 0;
    for (let i = 0; i < bars.length; i++) {
      const c = bars[i], time = c[0] + MINUTE;
      if (i === 0 || c[0] !== bars[i - 1][0] + MINUTE) { segment = i; highs.length = 0; head = 0; }
      while (head < highs.length && highs[head] <= i - 1500) head++;
      while (highs.length > head && bars[highs.at(-1)!][2] <= c[2]) highs.pop();
      highs.push(i);
      if (time < start || time >= end || i - segment + 1 < 1500) continue;
      const boardTime = Math.floor(time / HOUR) * HOUR, rank = members.get(boardTime)?.get(symbol);
      if (rank == null) continue;
      const f1 = one.get(time), fiveClosedAt = Math.floor(time / (5 * MINUTE)) * 5 * MINUTE, f5 = five.get(fiveClosedAt);
      if (!f1 || !f5) continue;
      const max1500 = bars[highs[head]][2], drawdownPercent = (1 - c[4] / max1500) * 100;
      if (c[4] >= max1500 * (1 - minDrawdown / 100)) continue;
      const day = Math.floor(time / DAY) * DAY;
      if (!dailyCache.has(day)) dailyCache.set(day, dailyTrendAt(daily.get(symbol) ?? [], time, onboard.get(symbol)));
      const trend = dailyCache.get(day);
      if (!trend || trend.trend !== 'up') continue;
      const supportMa = calculateSupportMaAt(support, i);
      if (supportMa !== null) continue;
      signals.push({ symbol, rank, boardTime, time, index: i, dif: f1.dif, dea: f1.dea, peakDea: f1.peakDea,
        deaPeakRatio: f1.peakDea === 0 ? 0 : f1.dea / f1.peakDea, supportMa, streak: consecutiveStreakAt(support, i),
        monitor: { board, hist1m: f1.hist, peakHist1m: f1.peakHist, hist5m: f5.hist, peakHist5m: f5.peakHist, fiveClosedAt,
          lastPrice: c[4], max1500, drawdownPercent, change60d: trend.trend, dailyClosedAt: trend.closedAt, dailyBars: trend.bars } });
    }
  }
  return signals.sort((a, b) => a.time - b.time || a.symbol.localeCompare(b.symbol));
}

export function matchesMonitorEntry(s: MinuteSignal, p: MonitorParameters & { minuteStreak?: number }, highRatio: number): boolean {
  const f = s.monitor;
  if (!f || !p.monitorMode || s.supportMa !== null || f.change60d !== 'up'
    || f.fiveClosedAt !== Math.floor(s.time / (5 * MINUTE)) * 5 * MINUTE || f.dailyClosedAt !== Math.floor(s.time / DAY) * DAY
    || ![f.hist1m, f.hist5m, f.peakHist1m, f.peakHist5m, f.lastPrice, f.max1500].every(Number.isFinite)) return false;
  const l1 = diffLevel(f.hist1m, f.peakHist1m, highRatio), l5 = diffLevel(f.hist5m, f.peakHist5m, p.fiveHighRatio ?? highRatio);
  if (p.monitorMode === 'baseline') return isAlertMatch({ supportMa: s.supportMa, change60d: f.change60d, max1500: f.max1500,
    lastPrice: f.lastPrice, diff1mLevel: l1, diff5mLevel: l5, streakDir: s.streak?.direction ?? null, streakCount: s.streak?.count ?? 0 });
  return l1 === p.diff1mLevel && l5 === p.diff5mLevel && matchesStreak(s.streak, p.minuteStreak)
    && f.lastPrice < f.max1500 * (1 - (p.minDrawdownPercent ?? 4) / 100);
}
