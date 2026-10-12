import { calculateSupportMaAt, consecutiveStreakAt, type Streak } from '../src/macd.ts';
import { matchesStreak, streakText, type StreakParameters } from './streak.ts';
import { validateBars } from './data.ts';
import { MINUTE, type GainersParameters, type MinuteSignal } from './gainers-types.ts';
import type { Bar } from './types.ts';

export const FIFTEEN = 15 * MINUTE;
export const FIFTEEN_RULE = { interval: '15m', warmupBars: 300, highWindow: 100, highRatio: 0.8 } as const;
export const FIFTEEN_AXES = {
  minuteDea: ['any', 'high', 'mid', 'low'],
  minuteDif: ['any', 'bull', 'bear'],
  fifteenDea: ['any', 'high', 'mid', 'low'],
  fifteenDif: ['any', 'bull', 'bear'],
} as const;
export interface FifteenParameters extends StreakParameters {
  fifteenHighRatio?: number;
  minuteDea?: typeof FIFTEEN_AXES.minuteDea[number];
  minuteDif?: typeof FIFTEEN_AXES.minuteDif[number];
  fifteenDea?: typeof FIFTEEN_AXES.fifteenDea[number];
  fifteenDif?: typeof FIFTEEN_AXES.fifteenDif[number];
}
export type MiningParameters = GainersParameters & FifteenParameters;
export interface FifteenFeature {
  closedAt: number; dif: number; dea: number; peakDea: number;
  deaLevel: 'high' | 'mid' | 'low'; direction: 'bull' | 'bear'; supportMa: string | null;
  streak?: Streak;
}

/** Same three-way interpretation as monitor: negative DEA is low, positive non-high is mid. */
export function deaLevel(dea: number, peak: number, highRatio: number = FIFTEEN_RULE.highRatio): FifteenFeature['deaLevel'] {
  return dea > 0 && dea >= highRatio * peak ? 'high' : dea >= 0 ? 'mid' : 'low';
}

/** One snapshot per CLOSED quarter-hour. Gaps restart both EMA and MA warmup. */
export function buildFifteenFeatures(bars: Bar[]): Map<number, FifteenFeature> {
  validateBars(bars, FIFTEEN);
  const result = new Map<number, FifteenFeature>();
  const support = bars.map((b) => ({ time: b[0], open: b[1], close: b[4], low: b[3] }));
  let fast = 0, slow = 0, dea = 0, segment = 0;
  const deas: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (i === 0 || b[0] !== bars[i - 1][0] + FIFTEEN) {
      fast = slow = b[4]; dea = 0; segment = i;
    } else {
      fast += 2 / 13 * (b[4] - fast);
      slow += 2 / 27 * (b[4] - slow);
      dea += 2 / 10 * (fast - slow - dea);
    }
    deas.push(dea);
    if (i - segment + 1 < FIFTEEN_RULE.warmupBars) continue;
    const peakDea = Math.max(...deas.slice(i - FIFTEEN_RULE.highWindow + 1, i + 1));
    const dif = fast - slow, closedAt = b[0] + FIFTEEN;
    result.set(closedAt, { closedAt, dif, dea, peakDea, deaLevel: deaLevel(dea, peakDea),
      direction: dif >= dea ? 'bull' : 'bear', supportMa: calculateSupportMaAt(support, i),
      streak: consecutiveStreakAt(support, i, FIFTEEN) });
  }
  return result;
}

export function attachFifteen(signals: MinuteSignal[], candles: Map<string, Bar[]>): MinuteSignal[] {
  const features = new Map([...candles].map(([symbol, bars]) => [symbol, buildFifteenFeatures(bars)]));
  return signals.map((s) => ({ ...s,
    // Exact expected close prevents reuse of a stale feature across missing bars.
    fifteen: features.get(s.symbol)?.get(Math.floor(s.time / FIFTEEN) * FIFTEEN) ?? null,
  }));
}

export function matchesFifteen(signal: MinuteSignal, p: FifteenParameters): boolean {
  if (p.fifteenDea === undefined && p.fifteenDif === undefined && p.fifteenStreak === undefined && p.fifteenHighRatio === undefined) return true; // legacy 1m-only grid
  const dea = p.fifteenDea ?? 'any', dif = p.fifteenDif ?? 'any';
  const f = signal.fifteen;
  if (!f || f.closedAt !== Math.floor(signal.time / FIFTEEN) * FIFTEEN) return false;
  const level = p.fifteenHighRatio === undefined ? f.deaLevel : deaLevel(f.dea, f.peakDea, p.fifteenHighRatio);
  return (dea === 'any' || level === dea) && (dif === 'any' || f.direction === dif)
    && f.supportMa === null && matchesStreak(f.streak, p.fifteenStreak);
}

export function fifteenText(p: FifteenParameters): string {
  const labels = { any: '不限', high: '高位', mid: '中位', low: '低位', bull: '多头', bear: '空头' };
  return `15m DEA ${labels[p.fifteenDea ?? 'any']} / DIFF ${labels[p.fifteenDif ?? 'any']} / 高位比${p.fifteenHighRatio ?? FIFTEEN_RULE.highRatio} / ${streakText(p.fifteenStreak)} / MA 无支撑（必选）`;
}

export function minuteText(p: FifteenParameters): string {
  const labels = { any: '不限', high: '高位', mid: '中位', low: '低位', bull: '多头', bear: '空头' };
  return `1m DEA ${labels[p.minuteDea ?? 'high']} / DIFF ${labels[p.minuteDif ?? 'bull']} / ${streakText(p.minuteStreak)} / MA 无支撑（必选）`;
}
