import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MINUTE, type MinuteDataset } from '../gainers-types.ts';
import { HOUR, type Bar, type Frame, type Observation } from '../types.ts';
import { WICK_CONFIG, validateWickConfig, wickCombinations, type WickParameters } from '../wick-config.ts';
import { buildWickSignals, type WickSignal } from '../wick-signals.ts';
import { backtestWick, plannedWickReward, summarizeWick, wickReturn, wilsonInterval } from '../wick-backtest.ts';
import { runWickStudy } from '../wick-study.ts';
import { writeWickReport } from '../wick-report.ts';
import { runWickCommand } from '../wick.ts';
import { manifest, START } from './helpers.ts';
import { calculateMacdGreenBarRatio, consecutiveStreak, calculateStreakGain, calculateSupportMa } from '../../src/macd.ts';

const SYMBOL = 'AAAUSDT';
const config = () => validateWickConfig({ takerFeeBps: 0, slippageBps: 0 });
const parameters: WickParameters = { holdMinutes: 3, firstTakeProfitPercent: 0.1, firstStopLossPercent: 0.1, finalTakeProfitPercent: 0.5, finalStopLossPercent: 0.2 };
function bar(time: number, open = 100, high = 100.05, low = 99.95, close = 100): Bar {
  return [time, open, high, low, close, 10, 1000];
}
function frame(time = START, symbol = SYMBOL, dayChange = 5): Frame {
  const row: Observation = { symbol, rank: 1, time, index: 0, dayChange, quoteVolume: 1, weekChange: null,
    bearish: false, freshCross: false, deaPeakRatio: 0, streak: 0, volumeRatio: 0, change5h: 0, breaksLow: false };
  return { time, eligibleSymbols: 1, boards: { gainers: [row], losers: [], volume: [] } };
}
function data(bars: Bar[], end = START + 10 * HOUR): MinuteDataset {
  return { manifest: { version: 1, interval: '1m', source: 'fixture', fetchedAt: new Date(START).toISOString(), files: {},
    plan: { version: 1, hourlyHash: 'fixture', topN: 10, highWindow: 100, warmupMinutes: 300,
      maxHoldMinutes: 240, start: START, end, ranges: { [SYMBOL]: [[START - 300 * MINUTE, end]] } } },
    candles: new Map([[SYMBOL, bars]]) };
}
function signal(time = START, index = 0): WickSignal {
  return { symbol: SYMBOL, time, index, close: 100, rank: 1, boardTime: Math.floor(time / HOUR) * HOUR,
    dayChangePercent: 5, streakCount: 3, streakGainPercent: 1, requiredGainPercent: 0.5,
    greenCount: 25, greenRatio: 25 / 30, hist: 1, previousHist: 2, supportMa: null };
}
function accelerating(count = 900): Bar[] {
  return Array.from({ length: count }, (_, i) => {
    const open = 100 + i ** 2 * 0.00001, close = 100 + (i + 1) ** 2 * 0.00001;
    return bar(START + (i - 300) * MINUTE, open, close * 1.004, open - 0.00001, close);
  });
}
const simulate = (bars: Bar[], p = parameters, c = config(), signals = [signal()], end = START + HOUR) =>
  backtestWick(data([bar(START - MINUTE), ...bars]), signals, p, c, START, end);
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('config defines one two-stage position, rejects legacy profiles and invalid stage ordering', () => {
  const c = validateWickConfig({ takerFeeBps: 0 });
  assert.equal(c.takerFeeBps, 0);
  assert.equal(WICK_CONFIG.takerFeeBps, 5);
  assert.equal(wickCombinations(c).length, 9);
  for (const invalid of [{ profiles: [] }, { entryOffsetPercent: [0.1] }, { holdMinutes: [1, 1] },
    { trainRatio: 0.9, validationRatio: 0.2 }, { exitPlans: [{ ...c.exitPlans[0], finalTakeProfitPercent: 0.05 }] },
    { exitPlans: [{ ...c.exitPlans[0], finalStopLossPercent: 0.05 }] }]) assert.throws(() => validateWickConfig(invalid));
});

test('signals require 25 of 30 positive hist bars; 24 of 30 is excluded', () => {
  const bars = Array.from({ length: 330 }, (_, i) => {
    const open = 100 + Math.max(0, i - 280) ** 2 * 0.001;
    const close = 100 + Math.max(0, i - 279) ** 2 * 0.001;
    return bar(START + (i - 300) * MINUTE, open, close + 0.001, open, close);
  });
  const c = validateWickConfig({ gainMode: 'fixed', minStreakGainPercent: 0 });
  const signals = buildWickSignals(data(bars), [frame()], c);
  assert.equal(signals[0].time, START + 5 * MINUTE);
  assert.equal(signals[0].greenCount, 25);
  assert.ok(!signals.some(s => s.time === START + 4 * MINUTE));
});

test('signals share inclusive streak gain and MA rules, without future or stale board membership', () => {
  const bars = accelerating(), d = data(bars), frames = [frame()];
  const ss = buildWickSignals(d, frames, config());
  assert.equal(ss[0].time, START);
  near(ss[0].requiredGainPercent, 0.5);
  near(ss[0].streakGainPercent, (bars[299][4] / bars[101][1] - 1) * 100);
  assert.equal(ss.length, 60);
  const fixed = { ...config(), gainMode: 'fixed' as const, minStreakGainPercent: ss[0].streakGainPercent };
  assert.equal(buildWickSignals(d, frames, fixed)[0].time, START);
  assert.ok(buildWickSignals(d, frames, { ...fixed, minStreakGainPercent: fixed.minStreakGainPercent + 1e-8 })[0].time > START);
  assert.equal(buildWickSignals(d, [frame(START, SYMBOL, 0)], config()).length, 0);
  assert.equal(buildWickSignals(d, [frame(START, SYMBOL, 100)], config()).length, 0);
  const supported = structuredClone(bars); supported[299][3] = 1;
  assert.ok(!buildWickSignals(data(supported), frames, config()).some(s => s.time === START));
  const doji = structuredClone(bars); doji[299][1] = doji[299][4];
  assert.ok(!buildWickSignals(data(doji), frames, config()).some(s => s.time === START));
  const future = structuredClone(bars);
  for (const b of future) if (b[0] >= START + 20 * MINUTE) for (let j = 1; j <= 4; j++) b[j] *= 2;
  const prefix = (s: WickSignal[]) => s.filter(v => v.time <= START + 20 * MINUTE);
  assert.deepEqual(prefix(buildWickSignals(data(future), frames, config())), prefix(ss));
  const rotated = buildWickSignals(d, [frame(START, 'OTHER'), frame(START + HOUR)], config());
  assert.equal(rotated[0].time, START + HOUR);
  const broken = data(bars.filter(b => b[0] !== START));
  const reset = buildWickSignals(broken, Array.from({ length: 10 }, (_, i) => frame(START + i * HOUR)), config());
  assert.ok(!reset.some(s => s.time > START && s.time < START + 200 * MINUTE));
  assert.ok(reset.some(s => s.time === START + 200 * MINUTE));
});

test('every free signal directly opens at next open, without waiting for a wick or rejecting gaps', () => {
  const r = simulate([bar(START, 105, 105.05, 104.95, 105)], { ...parameters, holdMinutes: 1 });
  assert.equal(r.metrics.signalCount, 1);
  assert.equal(r.metrics.filled, 1);
  assert.equal(r.trades[0].entryPrice, 105);
  assert.equal(r.trades[0].entryTime, START);
  assert.equal(r.trades[0].reason, 'timeout');
  const d = data([bar(START - MINUTE, 100, 200, 1, 100), bar(START)]);
  const t = backtestWick(d, [signal()], { ...parameters, holdMinutes: 1 }, config(), START, START + HOUR).trades[0];
  assert.equal(t.grossPercent, 0);
});

test('historical rolling indicator values match the monitor with 199 closed plus one forming candle', () => {
  const bars = accelerating();
  const audit = { rankedMinutes: 0, bullishStreakMinutes: 0, gainQualifiedMinutes: 0, noMaMinutes: 0, matchedMinutes: 0 };
  const ss = buildWickSignals(data(bars), [frame()], config(), audit);
  for (const s of ss) {
    const live = bars.slice(s.index - 198, s.index + 2).map(b => ({ time: b[0], open: b[1], high: b[2], low: b[3], close: b[4], volume: b[5] }));
    const streak = consecutiveStreak(live);
    assert.equal(s.greenCount, calculateMacdGreenBarRatio(live.map(b => b.close))!.greenCount);
    assert.equal(s.streakCount, streak.count);
    near(s.streakGainPercent, calculateStreakGain(live, streak)!);
    assert.equal(calculateSupportMa(live), null);
  }
  assert.equal(audit.matchedMinutes, ss.length);
  assert.ok(audit.rankedMinutes >= audit.bullishStreakMinutes && audit.bullishStreakMinutes >= audit.gainQualifiedMinutes
    && audit.gainQualifiedMinutes >= audit.noMaMinutes && audit.noMaMinutes >= audit.matchedMinutes);
});

test('first target closes 50%; later final target closes remaining 50%, counting one trade', () => {
  const r = simulate([bar(START, 100, 100.05, 99.8, 99.85), bar(START + MINUTE, 99.85, 99.9, 99.4, 99.45)]);
  const t = r.trades[0];
  assert.equal(r.metrics.trades, 1);
  assert.deepEqual(t.exits.map(e => e.fraction), [0.5, 0.5]);
  assert.deepEqual(t.exits.map(e => e.cumulativeClosedPercent), [50, 100]);
  assert.deepEqual(t.exits.map(e => e.reason), ['target', 'target']);
  near(t.exits[0].exitPrice, 99.9); near(t.exits[1].exitPrice, 99.5);
  near(t.grossPercent, 0.3);
  assert.equal(r.orders[0].remainingFraction, 0);
});

test('a first-stage loss also closes only half and the second stage can recover', () => {
  const r = simulate([bar(START, 100, 100.15, 99.98, 100.05), bar(START + MINUTE, 100.05, 100.1, 99.4, 99.5)]);
  assert.deepEqual(r.trades[0].exits.map(e => e.reason), ['stop', 'target']);
  near(r.trades[0].grossPercent, 0.2);
  assert.equal(r.metrics.firstStopFinalTarget, 1);
});

test('a continuous move can trigger both stages in one minute; ambiguous bars stop first', () => {
  const targets = simulate([bar(START, 100, 100.05, 99.4, 100)]);
  assert.deepEqual(targets.trades[0].exits.map(e => e.reason), ['target', 'target']);
  const stops = simulate([bar(START, 100, 100.3, 99.4, 99.45)]);
  assert.deepEqual(stops.trades[0].exits.map(e => e.reason), ['stop', 'stop']);
  assert.equal(stops.trades[0].ambiguous, true);
  near(stops.trades[0].grossPercent, -0.15);
});

test('stage-two target cannot use a low that may precede stage-one stop', () => {
  const r = simulate([bar(START, 100, 100.15, 99.4, 100), bar(START + MINUTE), bar(START + 2 * MINUTE)]);
  assert.deepEqual(r.trades[0].exits.map(e => e.reason), ['stop', 'timeout']);
  assert.equal(r.trades[0].ignoredUnorderedTarget, true);
  const confirmed = simulate([bar(START, 100, 100.15, 99.4, 99.45)]);
  assert.deepEqual(confirmed.trades[0].exits.map(e => e.reason), ['stop', 'target']);
});

test('first profit can become a whole-position loss; next-open gaps occur before intrabar extremes', () => {
  const r = simulate([bar(START, 100, 100.05, 99.8, 99.85), bar(START + MINUTE, 101, 102, 99, 100)]);
  const t = r.trades[0];
  assert.deepEqual(t.exits.map(e => e.reason), ['target', 'stop']);
  near(t.exits[1].exitPrice, 101);
  near(t.netPercent, -0.45);
  assert.equal(r.metrics.wins, 0);
  assert.equal(r.metrics.firstTargetFinalStop, 1);
  const gapTarget = simulate([bar(START), bar(START + MINUTE, 99, 101, 98, 100)]);
  assert.deepEqual(gapTarget.trades[0].exits.map(e => e.exitPrice), [99, 99]);
});

test('timeout closes only remaining quantity and never resets the original holding deadline', () => {
  const p = { ...parameters, holdMinutes: 2 };
  const partial = simulate([bar(START), bar(START + MINUTE, 100, 100.05, 99.8, 99.85)], p);
  assert.deepEqual(partial.trades[0].exits.map(e => e.reason), ['target', 'timeout']);
  assert.equal(partial.trades[0].exitTime, START + 2 * MINUTE);
  const flat = simulate([bar(START), bar(START + MINUTE)], p);
  assert.deepEqual(flat.trades[0].exits.map(e => e.reason), ['timeout', 'timeout']);
  near(flat.trades[0].exits.reduce((n, e) => n + e.fraction, 0), 1);
});

test('partial positions still block reentry; missing second exits retain ledger but cannot count as wins', () => {
  const p = { ...parameters, holdMinutes: 2 };
  const r = simulate([bar(START, 100, 100.05, 99.8, 100), bar(START + MINUTE), bar(START + 2 * MINUTE), bar(START + 3 * MINUTE)], p, config(),
    [signal(), signal(START + MINUTE, 1), signal(START + 2 * MINUTE, 2)]);
  assert.equal(r.metrics.skippedBusy, 1);
  assert.equal(r.metrics.trades, 2);
  assert.equal(r.trades[1].entryTime, r.trades[0].exitTime);
  const missing = simulate([bar(START, 100, 100.05, 99.8, 100)], p);
  assert.equal(missing.orders[0].remainingFraction, 0.5);
  assert.equal(missing.orders[0].exits.length, 1);
  assert.equal(missing.metrics.partialOrders, 1);
  assert.equal(missing.metrics.trades, 0);
  assert.equal(missing.metrics.winRate, null);
  assert.equal(missing.metrics.filled, 1);
  assert.equal(simulate([], p).metrics.filled, 0);
  const purged = simulate([], p, config(), [signal()], START + MINUTE);
  assert.equal(purged.metrics.purged, 1);
  assert.equal(purged.metrics.missing, 0);
  assert.equal(r.metrics.signalCount, r.metrics.submitted + r.metrics.skippedBusy + r.metrics.purged);
});

test('weighted exits charge entry once, exit actual quantities and aggregate whole-trade win rate and RR', () => {
  const c = validateWickConfig({});
  const win = simulate([bar(START, 100, 100.05, 99.4, 99.45)], parameters, c);
  const loss = simulate([bar(START, 100, 100.3, 99.95, 100.2)], parameters, c);
  const t = win.trades[0];
  near(t.entryFeePercent, 0.05);
  near(t.exitFeePercent, 0.04985);
  near(t.slippagePercent, 0.03994);
  near(t.netPercent, 0.16021);
  near(t.netPercent, t.exits.reduce((n, e) => n + e.netPercent, 0));
  near(t.netPercent, plannedWickReward(parameters, c).bothTargetsNetPercent);
  near(loss.trades[0].netPercent, plannedWickReward(parameters, c).bothStopsNetPercent);
  const m = summarizeWick([...win.trades, ...win.trades, ...loss.trades], [...win.orders, ...win.orders, ...loss.orders]);
  assert.equal(m.trades, 3);
  near(m.winRate!, 200 / 3);
  near(m.realizedRewardRisk!, t.netPercent / -loss.trades[0].netPercent);
  near(m.profitFactor!, 2 * m.realizedRewardRisk!);
  assert.equal(win.metrics.profitFactor, null);
  assert.equal(wilsonInterval(0, 0), null);
  assert.ok(wilsonInterval(10, 10)![0] < 100);
  near(wickReturn(100, 100, 'timeout', c).netPercent, -0.14);
});

test('joint selection is causal, fixed baseline uses all days, and exports reconcile both stages', async () => {
  const end = START + 10 * HOUR, hourly = { ...manifest(), end };
  const frames = Array.from({ length: 10 }, (_, i) => frame(START + i * HOUR));
  const c = validateWickConfig({ minTrades: 5, holdMinutes: [2, 3] });
  const run = (bars: Bar[], cfg = c) => runWickStudy(hourly, data(bars, end), frames, cfg, () => {});
  const bars = accelerating(), study = run(bars);
  assert.ok(study.winner?.test.trades);
  const changed = structuredClone(bars);
  for (const b of changed) if (b[0] >= study.split.validationEnd) for (let j = 1; j <= 4; j++) b[j] *= 2;
  const second = run(changed);
  assert.deepEqual(study.trials, second.trials);
  assert.equal(study.winner.trialId, second.winner!.trialId);
  assert.equal(run(bars, { ...c, minTrades: 10000 }).winner, null);
  assert.equal(study.baseline.metrics.signalCount, study.signals.length);
  assert.deepEqual(study.baseline.parameters, wickCombinations(c)[0]);
  const directory = await mkdtemp(path.join(tmpdir(), 'wick-test-'));
  try {
    await writeWickReport(study, frames, directory);
    const saved = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
    assert.equal(saved.engineSha256.length, 64);
    assert.equal(saved.closePlan.finalCumulativePercent, 100);
    assert.equal(saved.version, 3);
    const summary = await readFile(path.join(directory, 'summary.csv'), 'utf8');
    assert.equal(summary.trim().split('\n').length, 5);
    const exits = await readFile(path.join(directory, 'baseline-exits.csv'), 'utf8');
    assert.equal(exits.trim().split('\n').length, 1 + study.baseline.trades.length * 2);
    assert.match(exits.split('\n')[0], /fraction_of_initial/);
    await assert.rejects(writeWickReport(study, frames, directory), /非空/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI rejects conflicts and unknown flags before I/O', async () => {
  await assert.rejects(runWickCommand([]), /--data/);
  await assert.rejects(runWickCommand(['--data', 'unused', '--offline', '--fetch-only']), /不能同时/);
  await assert.rejects(runWickCommand(['--data', 'unused', '--start', '2025-01-01', '--days', '1']), /不能同时/);
  await assert.rejects(runWickCommand(['--data', 'unused', '--grid', 'x']), /Unknown option/);
});
