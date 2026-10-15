import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeMacd } from '../../src/macd.ts';
import { isAlertMatch } from '../../src/alert-rule.ts';
import { buildMonitorSignals, closedFiveBars, closedHistFeatures, dailyTrendAt, matchesMonitorEntry } from '../monitor-signals.ts';
import { MONITOR_BASELINE, monitorSearch, validateMonitorGrid } from '../monitor-grid.ts';
import { dailyFromHours, monitorFrames, planMonitorDaily, planMonitorMinutes } from '../monitor-data.ts';
import { MINUTE, type MinuteDataset, type MinuteSignal } from '../gainers-types.ts';
import { DAY, HOUR, type Bar, type Frame, type Observation } from '../types.ts';
import { DEFAULT_ACCOUNT, backtestAccount } from '../futures-account.ts';
import { dataset } from './helpers.ts';

const start = Date.UTC(2026, 9, 4);
const observation = (symbol: string, rank = 1): Observation => ({ symbol, rank, index: 0, time: start, dayChange: 0, quoteVolume: 1,
  weekChange: null, bearish: false, freshCross: false, deaPeakRatio: 0, streak: 0, volumeRatio: 1, change5h: 0, breaksLow: false });
const daily: Bar[] = Array.from({ length: 65 }, (_, i) => [start + (i - 61) * DAY, 100 + i, 101 + i, 99 + i, 100 + i, 1, 1]);
const signal = (): MinuteSignal => ({ symbol: 'ALTUSDT', time: start, rank: 1, boardTime: start, index: 0,
  dif: -5, dea: -6, peakDea: -1, deaPeakRatio: 0, supportMa: null, streak: { direction: 'up', count: 2 },
  monitor: { board: 'gainers', hist1m: 0.2, peakHist1m: 1, hist5m: 0.2, peakHist5m: 1, fiveClosedAt: start,
    lastPrice: 90, max1500: 100, drawdownPercent: 10, change60d: 'up', dailyClosedAt: start, dailyBars: 61 } });

test('historical baseline shares live predicate across histogram states, streaks and price boundaries', () => {
  for (const h1 of [-0.1, 0, 0.2, 0.8, 1]) for (const h5 of [-0.1, 0, 0.2, 0.8])
    for (const direction of ['up', 'down', null] as const) for (const count of [0, 1, 2, 5]) for (const price of [90, 96, 97]) {
      const s = signal(); Object.assign(s.monitor!, { hist1m: h1, hist5m: h5, lastPrice: price }); s.streak = { direction, count };
      const level = (h: number) => h >= 0.8 ? 'high' as const : h >= 0 ? 'mid' as const : 'low' as const;
      const expected = isAlertMatch({ supportMa: null, change60d: 'up', max1500: 100, lastPrice: price,
        diff1mLevel: level(h1), diff5mLevel: level(h5), streakDir: direction, streakCount: count });
      assert.equal(matchesMonitorEntry(s, MONITOR_BASELINE, 0.8), expected);
    }
  const s = signal();
  assert.equal(matchesMonitorEntry(s, MONITOR_BASELINE, 0.8), true); // Negative DEA does not suppress a positive, mid histogram.
  s.monitor!.change60d = 'down'; assert.equal(matchesMonitorEntry(s, MONITOR_BASELINE, 0.8), false);
  s.monitor!.change60d = 'up'; s.supportMa = 'ma5'; assert.equal(matchesMonitorEntry(s, MONITOR_BASELINE, 0.8), false);
  s.supportMa = null; s.monitor!.fiveClosedAt -= 5 * MINUTE; assert.equal(matchesMonitorEntry(s, MONITOR_BASELINE, 0.8), false);
});

test('daily trend uses only known closed days; new listings differ from missing history', () => {
  assert.deepEqual(dailyTrendAt(daily, start), { closedAt: start, bars: 61, trend: 'up' });
  const future = structuredClone(daily); future.at(-1)![4] = 1;
  assert.deepEqual(dailyTrendAt(future, start + 23 * HOUR), dailyTrendAt(daily, start));
  assert.equal(dailyTrendAt(daily.filter((_, i) => i !== 30), start), null);
  assert.equal(dailyTrendAt(daily.slice(59), start), null);
  assert.deepEqual(dailyTrendAt(daily.slice(59), start, start - 2 * DAY), { closedAt: start, bars: 2, trend: 'up' });
  assert.equal(dailyTrendAt(daily.slice(60), start, start - DAY), null);
});

function minutes(): Bar[] {
  return Array.from({ length: 1800 }, (_, i) => {
    const close = 120 - i * 0.02;
    return [start + (i - 1605) * MINUTE, close + 0.01, close + 0.02, close - 0.01, close, 1, 1];
  });
}
test('same-symbol five-minute buckets require all minutes; histogram equals MACD and gaps restart warmup', () => {
  const bars = minutes(), five = closedFiveBars(bars);
  const features = closedHistFeatures(five, 5 * MINUTE), time = start;
  const known = five.filter((b) => b[0] + 5 * MINUTE <= time);
  const macd = computeMacd(known.map((b) => b[4]));
  assert.ok(Math.abs(features.get(time)!.hist - macd.hist.at(-1)!) < 1e-10);
  assert.equal(closedFiveBars(bars.filter((b) => b[0] !== start - MINUTE)).some((b) => b[0] === start - 5 * MINUTE), false);
  assert.equal(closedHistFeatures(closedFiveBars(bars.filter((b) => b[0] !== start - MINUTE)), 5 * MINUTE).has(start + 5 * MINUTE), false);
  assert.equal(closedFiveBars(bars.slice(1))[0][0] % (5 * MINUTE), 0);
});

test('signals align both boards, 1500-bar high and closed daily/five-minute data without future leakage', () => {
  const bars = minutes();
  const frames = Array.from({ length: 3 }, (_, i) => ({ time: start + i * HOUR, eligibleSymbols: 1,
    boards: { gainers: [observation('ALTUSDT')], losers: [observation('ALTUSDT', 2)], volume: [] } })) as Frame[];
  const data = { manifest: { plan: { start, end: start + 3 * HOUR } }, candles: new Map([['ALTUSDT', bars]]) } as MinuteDataset;
  const build = (board: 'gainers' | 'losers' = 'gainers') => buildMonitorSignals(data, new Map([['ALTUSDT', daily]]), frames, board, new Map());
  const signals = build(); assert.ok(signals.length > 50);
  const s = signals.find((s) => s.time === start + 4 * MINUTE)!;
  assert.equal(s.monitor!.fiveClosedAt, start);
  assert.equal(s.monitor!.max1500, Math.max(...bars.slice(s.index - 1499, s.index + 1).map((b) => b[2])));
  assert.equal(build('losers')[0].rank, 2); assert.equal(build('losers')[0].monitor!.board, 'losers');
  for (const b of bars) if (b[0] >= start + 4 * MINUTE) for (const j of [1, 2, 3, 4]) b[j] *= 2;
  assert.deepEqual(build().filter((s) => s.time <= start + 4 * MINUTE), signals.filter((s) => s.time <= start + 4 * MINUTE));
});

test('new grid samples all independent state/streak/drawdown families reproducibly', () => {
  const grid = validateMonitorGrid({ highRatio: [0.65, 0.8], fiveHighRatio: [0.65, 0.8],
    diff1mLevel: ['high', 'mid', 'low'], diff5mLevel: ['high', 'mid', 'low'], minuteStreak: [0, 2, -2], minDrawdownPercent: [2, 4],
    holdMinutes: [1, 5], stopLossPercent: [0.2], takeProfitPercent: [2] });
  const search = monitorSearch(grid, 7, 3, 42, 100);
  assert.equal(search.plan.strata, 54); assert.equal(search.candidates.length, 100);
  assert.deepEqual(search, monitorSearch(grid, 7, 3, 42, 100));
  assert.equal(new Set(search.candidates.map((p) => JSON.stringify(p))).size, 100);
  assert.equal(new Set(search.candidates.map((p) => [p.diff1mLevel, p.diff5mLevel, p.minuteStreak, p.minDrawdownPercent].join('/'))).size, 54);
  assert.ok(search.candidates.every((p) => p.diff1mLevel !== 'low' || p.highRatio === 0.65));
  assert.throws(() => monitorSearch(grid, 7, 3, 42, 53), /至少/);
  assert.throws(() => validateMonitorGrid({ ...grid, diff1mLevel: ['bull'] }), /无效/);
  assert.throws(() => validateMonitorGrid({ ...grid, minDrawdownPercent: [-1] }), /无效/);
});

test('both-board plans exclude pinned names and request enough 1m/daily history', () => {
  const hourly = dataset(); hourly.manifest.start = start; hourly.manifest.end = start + HOUR;
  const names = ['BTCUSDT', 'SOLUSDT', ...Array.from({ length: 10 }, (_, i) => `ALT${i}USDT`)];
  const frames = monitorFrames([{ time: start, eligibleSymbols: 12, boards: { gainers: names.map((symbol) => observation(symbol)), losers: [observation('DOWNUSDT')], volume: [] } }]);
  assert.equal(frames[0].boards.gainers.length, 10);
  const plan = planMonitorMinutes(hourly, frames, 60);
  assert.equal(plan.ranges.DOWNUSDT[0][0], start - 1505 * MINUTE);
  assert.equal(plan.ranges.BTCUSDT, undefined);
  assert.equal(planMonitorDaily(hourly, ['DOWNUSDT']).ranges.DOWNUSDT[0], start - 61 * DAY);
});

test('daily reuse requires all 24 hourly candles and preserves OHLC and volume', () => {
  const hours: Bar[] = Array.from({ length: 48 }, (_, i) => [start + i * HOUR, 100 + i, 103 + i, 99 + i, 102 + i, 1, 2]);
  assert.deepEqual(dailyFromHours(hours).get(start), [start, 100, 126, 99, 125, 24, 48]);
  const missing = dailyFromHours(hours.filter((_, i) => i !== 7));
  assert.equal(missing.has(start), false); assert.equal(missing.has(start + DAY), true);
});

test('account uses histogram entry instead of legacy DEA and exports the evidence', () => {
  const s = signal();
  const data = { candles: new Map([['ALTUSDT', [[start - MINUTE, 90, 90, 90, 90, 1, 1], [start, 90, 90, 87, 88, 1, 1]]]]) } as MinuteDataset;
  const p = { ...MONITOR_BASELINE, holdMinutes: 1 };
  const result = backtestAccount(data, [s], p, start, start + MINUTE, DEFAULT_ACCOUNT);
  assert.equal(result.trades.length, 1); assert.equal(result.trades[0].diff1mLevel, 'mid');
  assert.equal(result.trades[0].max1500, 100); assert.equal(result.trades[0].board, 'gainers');
  s.monitor!.lastPrice = 96;
  assert.equal(backtestAccount(data, [s], p, start, start + MINUTE, DEFAULT_ACCOUNT).trades.length, 0);
});
