import { MINUTE, type MinuteSignal } from './gainers-types.ts';
import { buildClosedFeatures, deaLevel, type FifteenFeature } from './fifteen.ts';
import { matchesStreak, streakText } from './streak.ts';
import type { Bar } from './types.ts';

export const BTC_FIVE = 5 * MINUTE;
export const BTC_FIVE_RULE = { symbol: 'BTCUSDT', interval: '5m', warmupBars: 300, highWindow: 100, highRatio: 0.8 } as const;
export const BTC_FIVE_AXES = {
  btcFiveDea: ['any', 'high', 'mid', 'low'],
  btcFiveDif: ['any', 'bull', 'bear'],
} as const;
export interface BtcFiveParameters {
  btcFiveDea?: typeof BTC_FIVE_AXES.btcFiveDea[number];
  btcFiveDif?: typeof BTC_FIVE_AXES.btcFiveDif[number];
  btcFiveHighRatio?: number;
  btcFiveStreak?: number;
}
export interface BtcFiveFeature extends FifteenFeature { symbol: typeof BTC_FIVE_RULE.symbol }

/** Every ranked symbol shares BTC's market context, even when BTC is off the board. */
export function attachBtcFive(signals: MinuteSignal[], candles: Map<string, Bar[]>): MinuteSignal[] {
  const features = new Map([...buildClosedFeatures(candles.get(BTC_FIVE_RULE.symbol) ?? [], BTC_FIVE)]
    .map(([time, feature]) => [time, { ...feature, symbol: BTC_FIVE_RULE.symbol }]));
  return signals.map((s) => ({ ...s, btcFive: features.get(Math.floor(s.time / BTC_FIVE) * BTC_FIVE) ?? null }));
}

export function matchesBtcFive(signal: MinuteSignal, p: BtcFiveParameters): boolean {
  if (p.btcFiveDea === undefined && p.btcFiveDif === undefined && p.btcFiveHighRatio === undefined && p.btcFiveStreak === undefined) return true;
  const f = signal.btcFive;
  if (!f || f.symbol !== BTC_FIVE_RULE.symbol || f.closedAt !== Math.floor(signal.time / BTC_FIVE) * BTC_FIVE) return false;
  return (p.btcFiveDea === undefined || p.btcFiveDea === 'any' || deaLevel(f.dea, f.peakDea, p.btcFiveHighRatio) === p.btcFiveDea)
    && (p.btcFiveDif === undefined || p.btcFiveDif === 'any' || f.direction === p.btcFiveDif)
    && f.supportMa === null && matchesStreak(f.streak, p.btcFiveStreak);
}

export function btcFiveText(p: BtcFiveParameters): string {
  const labels = { any: '不限', high: '高位', mid: '中位', low: '低位', bull: '多头', bear: '空头' };
  return `BTC 5m DEA ${labels[p.btcFiveDea ?? 'any']} / DIFF ${labels[p.btcFiveDif ?? 'any']} / 高位比${p.btcFiveHighRatio ?? BTC_FIVE_RULE.highRatio} / ${streakText(p.btcFiveStreak)} / MA 无支撑（必选）`;
}
