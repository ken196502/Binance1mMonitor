import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consecutiveStreak, consecutiveStreakAt, type Candle } from '../../src/macd.ts';
import { matchesStreak } from '../streak.ts';
import { MINUTE, type MinuteSignal, type MinuteDataset } from '../gainers-types.ts';
import { FIFTEEN, attachFifteen, matchesFifteen, type MiningParameters } from '../fifteen.ts';
import { buildMinuteSignals, matchesMinuteEntry } from '../gainers-backtest.ts';
import { miningSearch, validateMiningGrid } from '../miner-core.ts';
import { backtestAccount, DEFAULT_ACCOUNT } from '../futures-account.ts';
import type { Bar, Frame } from '../types.ts';

const start = Date.UTC(2026, 0, 5);
const candle = (i: number, open: number, close: number, interval = MINUTE): Candle => ({ time: start + i * interval, open, close, high: Math.max(open, close), low: Math.min(open, close), volume: 1 });
const signal = (time = start): MinuteSignal => ({ symbol: 'BTCUSDT', rank: 1, boardTime: start, time, index: 0, dif: 1, dea: 0.7, peakDea: 1, deaPeakRatio: 0.7, supportMa: null });

test('shared closed-bar streak matches monitor, excludes forming bars, and resets on colour, doji and gaps', () => {
  const c = [candle(0, 99, 100), candle(1, 100, 101), candle(2, 100, 99)];
  assert.deepEqual(consecutiveStreak(c), { count: 2, direction: 'up' });
  assert.deepEqual(consecutiveStreakAt(c, 2), { count: 1, direction: 'down' });
  c[2].close = 110;
  assert.deepEqual(consecutiveStreak(c), { count: 2, direction: 'up' });
  c.push(candle(3, 101, 101), candle(4, 102, 101), candle(5, 103, 101), candle(7, 104, 101));
  assert.deepEqual(consecutiveStreakAt(c, 3), { count: 0, direction: null });
  assert.deepEqual(consecutiveStreakAt(c, 5), { count: 2, direction: 'down' });
  assert.deepEqual(consecutiveStreakAt(c, 6), { count: 1, direction: 'down' });
  assert.deepEqual(consecutiveStreakAt(c, -1), { count: 0, direction: null });
  assert.deepEqual(consecutiveStreakAt([candle(0, 99, 100, FIFTEEN), candle(1, 99, 100, FIFTEEN)], 1, FIFTEEN), { count: 2, direction: 'up' });
});

test('signed thresholds mean at least N bars of the chosen direction, with missing metadata rejected', () => {
  assert.ok(matchesStreak(undefined, 0));
  assert.equal(matchesStreak(undefined, 2), false);
  assert.ok(matchesStreak({ count: 5, direction: 'up' }, 3));
  assert.ok(matchesStreak({ count: 3, direction: 'down' }, -3));
  assert.equal(matchesStreak({ count: 5, direction: 'up' }, -3), false);
  assert.equal(matchesStreak({ count: 2, direction: 'down' }, -3), false);
  assert.equal(matchesStreak({ count: 0, direction: null }, 1), false);
  assert.equal(matchesStreak({ count: 5, direction: 'up' }, NaN), false);
});

test('1m and 15m feature builders retain independent causal streak counts', () => {
  const minuteBars: Bar[] = Array.from({ length: 306 }, (_, i) => {
    const t = start + (i - 300) * MINUTE;
    const open = i >= 297 && i < 300 ? 99 : 101;
    return [t, open, 101, 99, 100, 1, 1];
  });
  // Close is below all MAs (all are 100), so there is no strict MA support.
  const data = { candles: new Map([['BTCUSDT', minuteBars]]), manifest: { plan: { start, end: start + MINUTE, warmupMinutes: 300 } } } as MinuteDataset;
  const frames = [{ time: start, boards: { gainers: [{ symbol: 'BTCUSDT', rank: 1 }] } }] as Frame[];
  const signals = buildMinuteSignals(data, frames, 100, 0.6, true);
  assert.equal(signals.length, 1);
  assert.deepEqual(signals[0].streak, { count: 3, direction: 'up' });
  const fifteenBars: Bar[] = Array.from({ length: 302 }, (_, i) => [start + (i - 300) * FIFTEEN, i >= 298 && i < 300 ? 101 : 99, 101, 99, 100, 1, 1]);
  const originals = attachFifteen([signals[0], { ...signals[0], time: start + 14 * MINUTE }], new Map([['BTCUSDT', fifteenBars]]));
  assert.deepEqual(originals[0].fifteen!.streak, { count: 2, direction: 'down' });
  assert.deepEqual(originals[1].fifteen!.streak, originals[0].fifteen!.streak);
  for (const b of fifteenBars) if (b[0] >= start) { b[1] = 120; b[2] = 120; }
  assert.deepEqual(attachFifteen([signals[0]], new Map([['BTCUSDT', fifteenBars]]))[0], originals[0]);
  assert.ok(matchesMinuteEntry(originals[0], 0.8, { minuteDea: 'any', minuteDif: 'any', minuteStreak: 3 }));
  assert.ok(matchesFifteen(originals[0], { fifteenDea: 'any', fifteenDif: 'any', fifteenStreak: -2 }));
  assert.equal(matchesFifteen(originals[0], { fifteenStreak: 3 }), false);
});

test('15m high threshold is independent of 1m and changes its own state classification only', () => {
  const s = { ...signal(), fifteen: { closedAt: start, dea: 0.7, dif: 0.8, peakDea: 1, deaLevel: 'mid' as const, direction: 'bull' as const, supportMa: null } };
  assert.ok(matchesMinuteEntry(s, 0.65, { minuteDea: 'high', minuteDif: 'bull' }));
  assert.ok(matchesFifteen(s, { fifteenDea: 'mid', fifteenHighRatio: 0.8 }));
  assert.equal(matchesFifteen(s, { fifteenDea: 'high', fifteenHighRatio: 0.8 }), false);
  assert.ok(matchesFifteen(s, { fifteenDea: 'high', fifteenHighRatio: 0.65 }));
  assert.equal(matchesMinuteEntry(s, 0.9, { minuteDea: 'high' }), false);
});

const base = { highRatio: [0.6, 0.8], holdMinutes: [3, 5], stopLossPercent: [0.2], takeProfitPercent: [2, 5],
  minuteDea: ['high', 'low'], minuteDif: ['bull', 'bear'], fifteenDea: ['mid', 'low'], fifteenDif: ['bull', 'bear'],
  fifteenHighRatio: [0.65, 0.9], minuteStreak: [0, 3, -5], fifteenStreak: [0, 2, -4] };

test('full Cartesian grid includes unequal/equal thresholds and all mixed streak directions without tying cycles', () => {
  const { candidates, plan } = miningSearch(base, 7, 3, 42);
  assert.equal(plan.exhaustive, true);
  assert.equal(candidates.length, 1296);
  assert.equal(new Set(candidates.map((p) => JSON.stringify(p))).size, candidates.length);
  assert.equal(new Set(candidates.map((p) => `${p.minuteStreak}/${p.fifteenStreak}`)).size, 9);
  assert.ok(candidates.some(p => p.highRatio === 0.8 && p.fifteenHighRatio === 0.65 && p.minuteStreak === 3 && p.fifteenStreak === -4));
  assert.ok(candidates.some(p => p.minuteStreak === 0 && p.fifteenStreak === 0));
  assert.ok(candidates.filter(p=>p.minuteDea==='low').every(p=>p.highRatio===0.6));
  assert.ok(candidates.filter(p=>p.fifteenDea==='low').every(p=>p.fifteenHighRatio===0.65));
});

test('bounded search covers all strata without replacement, is seed reproducible and never exceeds full search', () => {
  const full = miningSearch(base, 7, 3, 42);
  const sample = miningSearch(base, 7, 3, 42, 300);
  assert.equal(sample.plan.exhaustive, false);
  assert.equal(sample.plan.possible, full.candidates.length);
  assert.deepEqual(sample, miningSearch(base, 7, 3, 42, 300));
  assert.notDeepEqual(sample.candidates, miningSearch(base, 7, 3, 43, 300).candidates);
  const signatures = new Set(full.candidates.map(p=>JSON.stringify(p)));
  assert.ok(sample.candidates.every(p=>signatures.has(JSON.stringify(p))));
  assert.equal(new Set(sample.candidates.map(p=>JSON.stringify(p))).size, 300);
  const counts = new Map<string,number>();
  for (const p of sample.candidates) {
    const key = JSON.stringify([p.minuteDea,p.minuteDif,p.fifteenDea,p.fifteenDif,p.minuteStreak,p.fifteenStreak]);
    counts.set(key,(counts.get(key)??0)+1);
  }
  assert.equal(counts.size, sample.plan.strata);
  assert.ok(Math.max(...counts.values()) - Math.min(...counts.values()) <= 1);
  assert.throws(()=>miningSearch(base,7,3,42,10),/覆盖/);
  for (const value of [[1,1], [1.5], [101], ['2'], []]) assert.throws(()=>validateMiningGrid({...base,minuteStreak:value}));
  assert.throws(()=>validateMiningGrid({...base,fifteenHighRatio:[0]}));
});

test('account enforces independent streak pair before margin allocation and exports both observed counts', () => {
  const p: MiningParameters = { highRatio: 0.6, holdMinutes: 1, stopLossPercent: 0.2, takeProfitPercent: 2,
    minuteDea: 'high', minuteDif: 'bull', fifteenDea: 'mid', fifteenDif: 'bull', fifteenHighRatio: 0.9, minuteStreak: 3, fifteenStreak: -2 };
  const s: MinuteSignal = { ...signal(), streak: { count: 3, direction: 'up' }, fifteen: {
    closedAt: start, dea: 0.7, dif: 0.8, peakDea: 1, deaLevel: 'mid', direction: 'bull', supportMa: null, streak: { count: 2, direction: 'down' } } };
  const data = { candles: new Map([['BTCUSDT', [[start-MINUTE,100,100,100,100,1,1],[start,100,100,98,99,1,1]]]]) } as MinuteDataset;
  const result = backtestAccount(data,[s],p,start,start+MINUTE,DEFAULT_ACCOUNT);
  assert.equal(result.trades.length,1);
  assert.equal(result.trades[0].minuteStreakCount,3);
  assert.equal(result.trades[0].fifteenStreakDirection,'down');
  assert.equal(backtestAccount(data,[s],{...p,fifteenStreak:3},start,start+MINUTE,DEFAULT_ACCOUNT).metrics.trades,0);
  assert.equal(backtestAccount(data,[s],{...p,minuteStreak:4},start,start+MINUTE,DEFAULT_ACCOUNT).metrics.trades,0);
  assert.equal(backtestAccount(data,[{...s,fifteen:{...s.fifteen!,supportMa:'ma5'}}],p,start,start+MINUTE,DEFAULT_ACCOUNT).metrics.trades,0);
});
