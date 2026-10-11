import assert from "node:assert/strict";
import { test } from "node:test";
import { backtestMinutes, buildMinuteSignals, highBull, runGainersStudy } from "../gainers-backtest.ts";
import { planGainersMinutes } from "../gainers-data.ts";
import { GAINERS_GRID, validateGainersGrid } from "../gainers-config.ts";
import { decodeArchive } from "../gainers-archive.ts";
import { MINUTE, type GainersOptions, type GainersParameters, type MinuteDataset, type MinuteSignal } from "../gainers-types.ts";
import { HOUR, type Bar, type Frame, type Observation } from "../types.ts";
import { dataset, START } from "./helpers.ts";

const SYMBOL = "AAAUSDT";
test("official-format ZIP/CSV decodes minute OHLC and rejects truncated archives", () => {
  // Standard ZIP fixture produced by Python zipfile, independent of the decoder.
  const zip = Buffer.from("UEsDBBQAAAAIANy2S128hIsHggAAAPMAAAAZAAAAQUFBVVNEVC0xbS0yMDI1LTAxLTA2LmNzdlWM/QoCIRDE/+9ZhnANPXwaqZA7ydy6tKO3zw+8SFiZ/e3M8MNFm/zdgYvC4ucFgTdcA78c3hxyObWlu56Zk7ODc44J6Xxzq73kz8A/8Of2c+TVHWg6aZKkRX2gNgRjqjyq8mM4lDEdVwsUVBFiz+uRbyG5N5EcBRP1AlmRgIZuBV9QSwECFAMUAAAACADctktdvISLB4IAAADzAAAAGQAAAAAAAAAAAAAAgAEAAAAAQUFBVVNEVC0xbS0yMDI1LTAxLTA2LmNzdlBLBQYAAAAAAQABAEcAAAC5AAAAAAA=", "base64");
  assert.deepEqual(decodeArchive(zip), [[START, 100, 101, 99, 100.5, 10, 1000], [START + MINUTE, 100.5, 102, 100, 101, 12, 1212]]);
  assert.throws(() => decodeArchive(zip.subarray(0, zip.length - 30)));
});
const parameters: GainersParameters = { highRatio: 0.8, stopLossPercent: 0.2, takeProfitPercent: 2, holdMinutes: 5 };
const options: GainersOptions = { topN: 1, highWindow: 100, rounds: 3, trialsPerRound: 4, seed: 42, minTrades: 1,
  trainRatio: 0.6, validationRatio: 0.2, feeBps: 5, slippageBps: 2,
  grid: { highRatio: [0.8, 0.9], holdMinutes: [5, 10], stopLossPercent: [0.2, 0.5], takeProfitPercent: [1.5, 2] } };
function frame(time: number, symbol = SYMBOL): Frame {
  // All old hourly filters fail. None may gate the new minute strategy.
  const o: Observation = { symbol, rank: 1, time, index: 0, dayChange: -5, quoteVolume: 1,
    weekChange: null, bearish: false, freshCross: false, deaPeakRatio: 0, streak: 0, volumeRatio: 0, change5h: 1, breaksLow: false };
  return { time, eligibleSymbols: 1, boards: { gainers: [o], losers: [], volume: [] } };
}
function minuteData(bars: Bar[], frames = [frame(START)], end = START + 10 * HOUR): MinuteDataset {
  const hourly = dataset(); hourly.manifest.end = end;
  return { manifest: { version: 1, interval: "1m", source: "fixture", fetchedAt: new Date(START).toISOString(),
    plan: planGainersMinutes(hourly, frames, options), files: {} }, candles: new Map([[SYMBOL, bars]]) };
}
function signal(time = START, index = 0): MinuteSignal {
  return { symbol: SYMBOL, rank: 1, boardTime: Math.floor(time / HOUR) * HOUR, time, index, dif: 1, dea: 0.9, peakDea: 1, deaPeakRatio: 0.9 };
}
function bar(time: number, open = 100, high = 100.1, low = 99.9, close = 100): Bar {
  return [time, open, high, low, close, 10, 1000];
}
function accelerating(count: number, start = START - 300 * MINUTE): Bar[] {
  return Array.from({ length: count }, (_, i) => {
    const open = 100 + i * i * 0.00001, close = 100 + (i + 1) ** 2 * 0.00001;
    return bar(start + i * MINUTE, open, close + 0.0001, open - 0.0001, close);
  });
}

test("only positive high DEA and bullish DIF are required, including equality", () => {
  assert.equal(highBull(0.8, 0.8, 1, 0.8), true);
  assert.equal(highBull(0.799, 0.8, 1, 0.8), false);
  assert.equal(highBull(1, 0.799, 1, 0.8), false);
  assert.equal(highBull(1, 0, 1, 0.8), false);
  assert.equal(highBull(0, -1, -1, 0.8), false);
  assert.equal(highBull(NaN, 1, 1, 0.8), false);
  assert.throws(() => validateGainersGrid({ ...GAINERS_GRID, weekFilter: [true] }), /不接受/);
  assert.throws(() => validateGainersGrid({ ...GAINERS_GRID, stopLossPercent: [2] }), /止损/);
  assert.throws(() => validateGainersGrid({ ...GAINERS_GRID, stopLossPercent: [1], takeProfitPercent: [2] }), /≥3/);
});

test("green accelerating minutes trigger without any hourly bearish/day/week/volume filter", () => {
  const frames = [frame(START)], bars = accelerating(360);
  const signals = buildMinuteSignals(minuteData(bars), frames, 100, 0.8);
  assert.equal(signals[0].time, START);
  assert.equal(signals[0].index, 299);
  assert.equal(signals.length, 60);
  assert.ok(signals.every((s) => s.dif > s.dea && bars[s.index][4] > bars[s.index][1]));
  // Change future prices without altering already-closed signals.
  const changed = structuredClone(bars);
  for (const c of changed) if (c[0] >= START + 20 * MINUTE) for (let j = 1; j <= 4; j++) c[j] *= 2;
  const earlier = (ss: MinuteSignal[]) => ss.filter((s) => s.time <= START + 20 * MINUTE);
  assert.deepEqual(earlier(buildMinuteSignals(minuteData(changed), frames, 100, 0.8)), earlier(signals));
});

test("hourly rank membership becomes available exactly at the hour, and gaps require new warmup", () => {
  const bars = accelerating(480), frames = [frame(START, "OTHERUSDT"), frame(START + HOUR)];
  const signals = buildMinuteSignals(minuteData(bars, frames), frames, 100, 0.8);
  assert.equal(signals.length, 60);
  assert.equal(signals[0].time, START + HOUR);
  assert.equal(signals.at(-1)!.time, START + 2 * HOUR - MINUTE);
  const broken = accelerating(660).filter((c) => c[0] !== START);
  const allFrames = Array.from({ length: 6 }, (_, i) => frame(START + i * HOUR));
  const reset = buildMinuteSignals(minuteData(broken, allFrames), allFrames, 100, 0.8);
  assert.ok(reset.some((s) => s.time === START));
  assert.ok(!reset.some((s) => s.time > START && s.time < START + 301 * MINUTE));
  assert.ok(reset.some((s) => s.time >= START + 301 * MINUTE));
});

test("minute plan covers warmup and exits after leaving, merges ranges and clips the end", () => {
  const hourly = dataset(); hourly.manifest.end = START + 20 * HOUR;
  const frames = [frame(START), frame(START + HOUR), frame(START + 10 * HOUR), frame(START + 19 * HOUR)];
  const p = planGainersMinutes(hourly, frames, { ...options, grid: { ...options.grid, holdMinutes: [120] } });
  assert.equal(p.warmupMinutes, 300);
  assert.deepEqual(p.ranges[SYMBOL], [[START - 5 * HOUR, START + 4 * HOUR], [START + 5 * HOUR, START + 13 * HOUR], [START + 14 * HOUR, START + 20 * HOUR]]);
  assert.notEqual(planGainersMinutes(hourly, frames, options).hourlyHash, planGainersMinutes(dataset(), frames, options).hourlyHash);
});

test("small stop pays both sides' costs; no cooldown after the stop", () => {
  const bars = [bar(START - MINUTE), bar(START, 100, 100.3), bar(START + MINUTE, 100, 100.1, 97.9, 98)];
  const result = backtestMinutes(minuteData(bars), [signal(), signal(START + MINUTE, 1)], parameters, START, START + HOUR, 7);
  assert.equal(result.trades.length, 2);
  assert.equal(result.trades[0].reason, "stop");
  assert.ok(Math.abs(result.trades[0].netPercent - (-0.34014)) < 1e-8);
  assert.equal(result.trades[1].entryTime, result.trades[0].exitTime);
  assert.equal(result.trades[1].reason, "target");
  assert.ok(Math.abs(result.trades[1].netPercent - 1.8614) < 1e-8);
});

test("same-minute ambiguity is stop-first, but an opening gap happens before intrabar prices", () => {
  const ambiguous = backtestMinutes(minuteData([bar(START - MINUTE), bar(START, 100, 101, 97)]), [signal()], parameters, START, START + HOUR, 0).trades[0];
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(ambiguous.reason, "stop");
  assert.equal(ambiguous.exitPrice, 100.2);
  for (const [open, reason] of [[102, "stop"], [97, "target"]] as const) {
    const bars = [bar(START - MINUTE), bar(START), bar(START + MINUTE, open, 103, 96, open)];
    const t = backtestMinutes(minuteData(bars), [signal()], parameters, START, START + HOUR, 0).trades[0];
    assert.equal(t.reason, reason);
    assert.equal(t.exitPrice, open);
    assert.equal(t.ambiguous, false);
  }
});

test("one position per symbol; timeout, missing bars and split boundaries use minute resolution", () => {
  const bars = Array.from({ length: 12 }, (_, i) => bar(START + (i - 1) * MINUTE));
  const signals = Array.from({ length: 10 }, (_, i) => signal(START + i * MINUTE, i));
  const result = backtestMinutes(minuteData(bars), signals, parameters, START, START + 10 * MINUTE, 0);
  assert.equal(result.trades.length, 2);
  assert.deepEqual(result.trades.map((t) => t.reason), ["timeout", "timeout"]);
  assert.equal(result.trades[1].exitTime, START + 10 * MINUTE);
  assert.equal(backtestMinutes(minuteData(bars), [signal()], parameters, START, START + 4 * MINUTE, 0).metrics.purged, 1);
  const missing = bars.filter((b) => b[0] !== START + MINUTE);
  const m = backtestMinutes(minuteData(missing), [signal()], parameters, START, START + HOUR, 0).metrics;
  assert.equal(m.missing, 1);
  assert.equal(m.trades, 0);
  assert.equal(m.meanNetPercent, null);
});

test("multiround search is deterministic and final-test price changes cannot select parameters", () => {
  const hourly = dataset(); hourly.manifest.end = START + 10 * HOUR;
  const frames = Array.from({ length: 10 }, (_, i) => frame(START + i * HOUR));
  const bars = accelerating(900);
  const data = minuteData(bars, frames);
  const run = (d: MinuteDataset) => runGainersStudy(hourly, d, frames, structuredClone(options), () => {});
  const a = run(data), b = run(data);
  assert.equal(a.trials.length, 12);
  assert.deepEqual(a.trials, b.trials);
  assert.deepEqual(a.winner, b.winner);
  assert.ok(a.winner && a.winner.test.trades > 0);
  const changed = structuredClone(data);
  for (const c of changed.candles.get(SYMBOL)!) if (c[0] >= a.split.validationEnd) for (let j = 1; j <= 4; j++) c[j] *= 2;
  const other = run(changed);
  assert.deepEqual(other.trials, a.trials);
  assert.deepEqual(other.winner?.parameters, a.winner.parameters);
  assert.notDeepEqual(other.winner?.test, a.winner.test);
});
