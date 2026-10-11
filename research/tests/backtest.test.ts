import assert from "node:assert/strict";
import { test } from "node:test";
import { backtest, buildFrames, shortReturn, summarize } from "../backtest.ts";
import { parseSymbols, validateBars, weekStart } from "../data.ts";
import { runStudy, validateGrid, validateOptions } from "../search.ts";
import { HOUR, type Bar, type Dataset, type Frame, type Observation } from "../types.ts";
import { dataset, manifest, OPTIONS, PARAMS, START } from "./helpers.ts";

test("historical 24h ranks rotate with prices and keep overlap independently across boards", () => {
  const a = dataset();
  const times = a.candles.get("AAAUSDT")!.map((c) => c[0]);
  for (const [symbol, direction, quote] of [["AAAUSDT", 1, 2e7], ["BBBUSDT", -1, 1e7]] as const) {
    a.candles.set(symbol, times.map((time, i) => {
      const slope = i < 200 ? direction : -direction;
      const open = 100 + (i < 200 ? i * direction : (400 - i) * direction) * 0.01;
      const close = open + slope * 0.01;
      return [time, open, Math.max(open, close), Math.min(open, close), close, 100, quote];
    }));
  }
  a.manifest.symbols.push("BBBUSDT");
  a.manifest.contracts.push({ symbol: "BBBUSDT", onboardDate: 0 });
  const frames = buildFrames(a, 1, 1);
  assert.equal(frames[0].boards.gainers[0].symbol, "AAAUSDT");
  assert.equal(frames[0].boards.losers[0].symbol, "BBBUSDT");
  assert.equal(frames[0].boards.volume[0].symbol, "AAAUSDT");
  assert.notEqual(frames[0].boards.gainers[0], frames[0].boards.volume[0]);
  assert.equal(frames[150].boards.gainers[0].symbol, "BBBUSDT");
  assert.equal(frames[150].boards.losers[0].symbol, "AAAUSDT");
  assert.deepEqual(parseSymbols(["币安人生USDT", "BTCUSDT"]), ["BTCUSDT", "币安人生USDT"]);
});

test("historical features are causal within a fixed board and use quote volume/UTC week", () => {
  const a = dataset();
  const original = buildFrames(a, 1, 1);
  assert.equal(original[0].boards.volume[0].quoteVolume, 24e7);
  const bars = a.candles.get("AAAUSDT")!;
  assert.equal(original[0].boards.volume[0].dayChange, (bars[99][4] / bars[76][1] - 1) * 100);
  assert.equal(weekStart(START + 6 * 86400000), START);
  const cutoff = START + 400 * HOUR;
  for (const c of a.candles.get("AAAUSDT")!) if (c[0] >= cutoff) for (let i = 1; i <= 4; i++) c[i] *= 2;
  const changed = buildFrames(a, 1, 1);
  assert.deepEqual(changed.filter((f) => f.time <= cutoff), original.filter((f) => f.time <= cutoff));
  a.candles.set("OTHERUSDT", []);
  assert.throws(() => buildFrames(a, 1, 1), /不属于回测池/);
});

test("invalid OHLC, duplicate timestamps and missing warmup cannot create signals", () => {
  assert.throws(() => validateBars([[START, 100, 90, 80, 100, 1, 1]]));
  const a = dataset();
  const bars = a.candles.get("AAAUSDT")!;
  assert.throws(() => validateBars([bars[0], bars[0]]));
  a.candles.set("AAAUSDT", bars.filter((c) => c[0] !== START - HOUR));
  const frames = buildFrames(a, 1, 1);
  assert.ok(frames.slice(0, 24).every((f) => !f.boards.volume.length));
  assert.equal(frames[24].boards.volume.length, 1);
  assert.equal(frames[24].boards.volume[0].bearish, false); // MACD still warming up.
});

function tradeFixture(): { data: Dataset; frames: Frame[] } {
  const o: Observation = { symbol: "AAAUSDT", rank: 1, index: 0, time: START, dayChange: -10, quoteVolume: 2e9,
    weekChange: -5, bearish: true, freshCross: false, deaPeakRatio: 0, streak: 2, volumeRatio: 2, change5h: -1, breaksLow: true };
  const bars: Bar[] = Array.from({ length: 11 }, (_, i) => [START + (i - 1) * HOUR, 100, 100.1, 97.9, 98, 10, 1000]);
  return { data: { manifest: manifest(), candles: new Map([["AAAUSDT", bars]]) },
    frames: Array.from({ length: 5 }, (_, i) => ({ time: START + i * HOUR, eligibleSymbols: 1, boards: { gainers: [], losers: [], volume: [{ ...o, index: i, time: START + i * HOUR }] } })) };
}

test("short direction, entry at next open, costs on both sides and no overlapping positions", () => {
  assert.deepEqual(shortReturn(100, 90, 0), { grossPercent: 10, netPercent: 10 });
  assert.equal(shortReturn(100, 110, 0).netPercent, -10);
  assert.equal(shortReturn(100, 100, 7).netPercent, -0.14);
  const { data, frames } = tradeFixture();
  const result = backtest(data, frames, "volume", PARAMS, START, START + 10 * HOUR, 7);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].entryTime, START);
  assert.equal(result.trades[0].exitTime, START + 5 * HOUR);
  assert.equal(result.trades[0].grossPercent, 2);
  assert.ok(Math.abs(result.trades[0].netPercent - 1.8614) < 1e-9);
  assert.equal(backtest(data, frames, "gainers", PARAMS, START, START + 10 * HOUR, 7).metrics.trades, 0);
});

test("stops beat targets on ambiguous candles; opening gaps fill at the open", () => {
  const { data, frames } = tradeFixture();
  data.candles.get("AAAUSDT")![1][2] = 102;
  const p = { ...PARAMS, stopLossPercent: 1, takeProfitPercent: 1 };
  const result = backtest(data, frames.slice(0, 1), "volume", p, START, START + 10 * HOUR, 0);
  assert.equal(result.trades[0].reason, "stop");
  assert.equal(result.trades[0].exitPrice, 101);
  const bars = data.candles.get("AAAUSDT")!;
  bars[1] = [START, 100, 100.1, 99.9, 100, 10, 1000];
  bars[2] = [START + HOUR, 103, 104, 102, 103, 10, 1000];
  const gap = backtest(data, frames.slice(0, 1), "volume", p, START, START + 10 * HOUR, 0);
  assert.equal(gap.trades[0].exitPrice, 103);
  assert.equal(gap.trades[0].netPercent, -3);
});

test("split-boundary signals are purged and missing candles never become winning trades", () => {
  const { data, frames } = tradeFixture();
  const edge = backtest(data, frames.slice(0, 1), "volume", PARAMS, START, START + 4 * HOUR, 7);
  assert.equal(edge.metrics.purged, 1);
  assert.equal(edge.metrics.trades, 0);
  data.candles.get("AAAUSDT")!.splice(3, 1);
  const missing = backtest(data, frames.slice(0, 1), "volume", PARAMS, START, START + 10 * HOUR, 7);
  assert.equal(missing.metrics.missing, 1);
  assert.equal(missing.metrics.meanNetPercent, null);
  assert.equal(summarize([]).winRate, null);
});

test("multi-round search is deterministic, unique, single-board, and never selects using test results", () => {
  const data = dataset();
  const original = runStudy(data, "volume", OPTIONS, () => {});
  assert.equal(original.trials.length, 12);
  assert.ok(original.winner);
  assert.deepEqual([...new Set(original.trials.map((t) => t.round))], [1, 2, 3]);
  assert.deepEqual([...new Set(original.trials.map((t) => t.board))], ["volume"]);
  assert.equal(new Set(original.trials.map((t) => JSON.stringify(t.parameters))).size, 12);
  assert.deepEqual(runStudy(data, "volume", OPTIONS, () => {}).trials, original.trials);
  for (const c of data.candles.get("AAAUSDT")!) {
    if (c[0] >= original.split.validationEnd) for (let i = 1; i <= 4; i++) c[i] *= 2;
  }
  const changed = runStudy(data, "volume", OPTIONS, () => {});
  assert.deepEqual(changed.trials, original.trials);
  assert.equal(changed.winner?.trialId, original.winner?.trialId);
  assert.deepEqual(changed.winner?.parameters, original.winner?.parameters);
});

test("insufficient samples produce no winner; malformed search options fail early", () => {
  assert.equal(runStudy(dataset(), "volume", { ...OPTIONS, minTrades: 10000 }, () => {}).winner, null);
  assert.throws(() => validateOptions({ ...OPTIONS, rounds: 0 }));
  assert.throws(() => validateOptions({ ...OPTIONS, trainRatio: 0.9 }));
  assert.throws(() => validateGrid({ ...OPTIONS.grid, holdHours: [0] }));
  assert.throws(() => validateGrid({ ...OPTIONS.grid, extra: [1] }));
});
