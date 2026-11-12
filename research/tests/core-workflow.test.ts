import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PaperTradingEngine } from "../../src/paper-trading.ts";
import { breakevenPrice, calcTradeReturn } from "../../src/trading-core.ts";
import { computeFeatureVector, evaluateFeatureSpec } from "../../src/features.ts";
import { detectIntervalSignals } from "../../src/kline-stats.ts";
import { candlesToChartBars } from "../../src/chart.ts";
import type { Candle } from "../../src/macd.ts";
import { replayStrategies, type ReplayStrategy, type MinuteBoard } from "../strategy-replay.ts";
import { buildMinuteFramesMap, minePrecursorFeatureDistributions, loadAllMinutes } from "../../scripts/mine-strategy.ts";

const MINUTE = 60_000;
const base = Math.floor(Date.now() / MINUTE) * MINUTE;
const bars = (count = 65): Candle[] => Array.from({ length: count }, (_, i) => ({
  time: base + i * MINUTE, open: 100, high: 100.5, low: 99.5, close: 100, volume: 10,
}));
const strategy = (patch: Partial<ReplayStrategy> = {}): ReplayStrategy => ({
  id: "long", side: "LONG", intervalWindow: 5, ampDivisor: 10, maRequirement: "NONE", macdRequirement: "NONE",
  holdMinutes: 30, tp1Percent: 3, tp2Percent: 6, stopLossPercent: 5, leverage: 2,
  ...patch,
});
const indices = (map: Map<string, Candle[]>) => new Map([...map].map(([symbol, list]) => [symbol, new Map(list.map((b, i) => [b.time, i]))]));
const board = (symbols: string[]): MinuteBoard => new Map(symbols.map((symbol, i) => [symbol, { rank: i + 1, dayChange: 20 }]));
function replay(list: Candle[], spec = strategy()) {
  const map = new Map([["TEST", list]]);
  return replayStrategies(map, indices(map), list.map(b => b.time), new Map([[list[60].time, board(["TEST"])]]), [spec], { start: list[60].time, end: list.at(-1)!.time + MINUTE });
}
const signal = { candle: bars()[0], streakCount: 2, amp30Percent: 3, upperShadowRatio: 0.1, greenRatio: 0.8, consecutiveGreenBars: 5 };

test("breakeven stops cover round-trip costs on both sides", () => {
  for (const side of ["LONG", "SHORT"] as const) {
    const price = breakevenPrice(side, 100);
    assert.ok(side === "LONG" ? price > 100 : price < 100);
    assert.ok(Math.abs(calcTradeReturn(side, 100, price).netPercent) < 1e-10);
  }
});

test("replay closes both targets on the entry candle and totals both legs", () => {
  const list = bars();
  list[60] = { ...list[60], high: 106.5, close: 106 };
  const result = replay(list);
  assert.equal(result.totalTrades, 1);
  assert.equal(result.trades[0].reason, "TP2");
  assert.equal(result.trades[0].exitTime, list[60].time + MINUTE);
  const expected = 40 * (calcTradeReturn("LONG", 100, 103).netPercent + calcTradeReturn("LONG", 100, 106).netPercent) / 200;
  assert.ok(Math.abs(result.netPnlUsdt - expected) < 1e-9);
  assert.ok(Math.abs(result.trades[0].totalNetPnlUsdt - expected) < 1e-9);
  assert.equal(result.bySide.LONG.winRate, 100);
  assert.equal(result.bySide.SHORT.totalTrades, 0);
});

test("TP1 followed by a stop charges only remaining half and counts the full trade", () => {
  const list = bars();
  list[60] = { ...list[60], high: 103.1, close: 102 };
  list[61] = { ...list[61], open: 102, high: 102.1, low: 94, close: 96 };
  const result = replay(list, strategy({ moveSlToEntryAfterTp1: false }));
  const expected = 40 * (calcTradeReturn("LONG", 100, 103).netPercent + calcTradeReturn("LONG", 100, 94).netPercent) / 200;
  assert.equal(result.totalTrades, 1);
  assert.equal(result.trades[0].reason, "SL");
  assert.ok(Math.abs(result.netPnlUsdt - expected) < 1e-9);
  assert.equal(result.bySide.LONG.losingTrades, 1);
});

test("conservative replay checks entry-bar stops before targets and settles period-end losses", () => {
  const list = bars();
  list[60] = { ...list[60], high: 107, low: 94 };
  assert.equal(replay(list).trades[0].reason, "SL");
  const quiet = bars();
  quiet[64] = { ...quiet[64], low: 98, close: 98 };
  const result = replay(quiet);
  assert.equal(result.totalTrades, 1);
  assert.equal(result.trades[0].reason, "END_OF_PERIOD");
  assert.ok(result.netPnlUsdt < 0);
  assert.ok(result.maxDrawdownPct > 0);
});

test("portfolio enforces five total positions and one per strategy", () => {
  const map = new Map(Array.from({ length: 7 }, (_, i) => [`SYM${i}`, bars()]));
  const times = bars().map(b => b.time);
  const frames = new Map([[times[60], board([...map.keys()])]]);
  const specs = Array.from({ length: 7 }, (_, i) => strategy({ id: `s${i}` }));
  const result = replayStrategies(map, indices(map), times, frames, specs, { start: times[60], end: times[64] + MINUTE }, { marginPercent: 19 });
  assert.equal(result.maxConcurrentPositions, 5);
  assert.equal(result.totalTrades, 5);
  assert.equal(new Set(result.trades.map(t => t.strategyId)).size, 5);
});

test("paper summaries split complete trades by side, refresh 24h and survive reload", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "core-paper-"));
  try {
    const file = path.join(dir, "state.json");
    const engine = new PaperTradingEngine({ storageFile: file, factorMining: { enabled: false, refreshMinutes: 60, validForMinutes: 720 }, takerFeeBps: 0, slippageBps: 0, stopAtHigh: false, stopAtLow: false });
    for (const side of ["LONG", "SHORT"] as const) {
      const symbol = side;
      engine.openPosition({ symbol, side, signalType: side === "LONG" ? "kline_stats_long" : "kline_stats_short", signal,
        dayChangePercent: 20, entryPrice: 100, entryTime: Date.now(), exitParams: { holdMinutes: 30, tp1Percent: 3, tp2Percent: 6, stopLossPercent: 5 } });
      engine.onTick({ symbol, price: side === "LONG" ? 103.1 : 105, qty: 1, time: Date.now() + 100 });
    }
    assert.equal(engine.getSummary().bySide!.LONG.totalTrades, 0, "partial trades are not yet wins");
    assert.equal(engine.getSummary().bySide!.SHORT.losingTrades, 1);
    engine.onTick({ symbol: "LONG", price: 106.1, qty: 1, time: Date.now() + 200 });
    const state = engine.getState();
    assert.equal(state.stats.bySide.LONG.winRate, 100);
    assert.equal(state.stats24h!.bySide.SHORT.winRate, 0);
    (engine as any).saveState();
    const restored = new PaperTradingEngine({ storageFile: file });
    assert.deepEqual(restored.getState().stats.bySide, state.stats.bySide);
    for (const position of restored.getState().closedPositions) position.closedAt = Date.now() - 25 * 3600_000;
    assert.equal(restored.getSummary().stats24h!.totalTrades, 0, "24h stats expire even with no new ticks");
    engine.reset();
    restored.reset();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("invalid remote shape patches are atomic and unknown enum rules fail closed", () => {
  const engine = new PaperTradingEngine({ storageFile: null });
  const before = engine.getConfig();
  assert.throws(() => engine.updateConfig({ leverage: 20, klineStatsLongConfig: { intervalWindow: 7 } }));
  assert.throws(() => engine.updateConfig({ klineStatsShortConfig: { tp1Percent: 20, tp2Percent: 2 } }));
  assert.throws(() => engine.updateConfig({ klineStatsLongConfig: { maRequirement: "TYPO" as any } }));
  assert.throws(() => engine.updateConfig({ marginPercent: 21 }));
  assert.throws(() => engine.updateConfig({ maxPositions: 6 }));
  assert.throws(() => engine.updateConfig({ maxPositionsPerStrategy: 2 }));
  assert.deepEqual(engine.getConfig(), before);
  const fv = computeFeatureVector(bars(), { symbol: "TEST", priceChangePercent: 20, lastPrice: 100, quoteVolume: 0 }, 60)!;
  assert.equal(evaluateFeatureSpec("LONG", fv, { maRequirement: "TYPO" }).pass, false);
  assert.equal(evaluateFeatureSpec("LONG", fv, { macdRequirement: "TYPO" }).pass, false);
});

test("paper entry and pending orders cannot bypass quotas", () => {
  const engine = new PaperTradingEngine({ storageFile: null, maxPositions: 1 });
  assert.throws(() => engine.openPosition({ symbol: "B", marginUsdt: 21, dayChangePercent: 20, entryPrice: 100, entryTime: base, signal }));
  engine.createPendingOrder({ symbol: "A", dayChangePercent: 20, basePrice: 100, signal });
  assert.throws(() => engine.openPosition({ symbol: "B", dayChangePercent: 20, entryPrice: 100, entryTime: base, signal }));
  assert.throws(() => engine.createPendingOrder({ symbol: "A", dayChangePercent: 20, basePrice: 100, signal }));
});

test("interval precursor never includes the first burst candle and handles negative 24h change", () => {
  const chart = candlesToChartBars(bars(15));
  chart[0].low = 90;
  chart[14].high = 110;
  const events = detectIntervalSignals(chart, -20, { windowMinutes: 60, ampDivisor: 10, mode: "surge" });
  assert.ok(events.length > 0);
  const event = events.find(e => e.segmentStartTime === chart[0].time)!;
  assert.ok(event);
  assert.equal(event.precursor, undefined);
  assert.ok(event.ratioToDayChange > 0);
});

test("minute frames never see the current candle's close or invent a short-window 24h return", () => {
  const list = bars(1442);
  const times = list.map(b => b.time);
  const first = buildMinuteFramesMap([], new Map([["TEST", list]]), times);
  assert.equal(first.get(times[60])!.size, 0);
  list[1440] = { ...list[1440], close: 500, high: 501 };
  const changed = buildMinuteFramesMap([], new Map([["TEST", list]]), times);
  assert.deepEqual(first.get(times[1440]), changed.get(times[1440]));
  assert.notDeepEqual(first.get(times[1441]), changed.get(times[1441]));
});

test("precursor event labels do not cross the training boundary", () => {
  const list = bars(90);
  list[61].high = 110;
  const map = new Map([["TEST", list]]);
  const frames = new Map([[list[60].time, board(["TEST"])]]);
  const partial = minePrecursorFeatureDistributions(map, indices(map), [list[60].time], frames, { start: list[60].time, end: list[65].time }, 15, 10);
  assert.equal(partial.totalSurgeEvents, 0);
  const full = minePrecursorFeatureDistributions(map, indices(map), [list[60].time], frames, { start: list[60].time, end: list[80].time }, 15, 10);
  assert.equal(full.totalSurgeEvents, 1);
});

test("mining reads live JSONL across dates, deduplicates and hashes actual OHLC", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "core-candles-"));
  try {
    const list = bars(3);
    const first = path.join(dir, "TEST-20261104.jsonl");
    const second = path.join(dir, "TEST-20261105.jsonl");
    writeFileSync(first, list.slice(0, 2).map(b => JSON.stringify(b)).join("\n") + "\n");
    writeFileSync(second, list.slice(1).map(b => JSON.stringify(b)).join("\n") + '\n{"time":');
    const result = await loadAllMinutes([dir]);
    assert.equal(result.dataset.candles.get("TEST")!.length, 3);
    assert.deepEqual(result.dataset.candles.get("TEST")!.map(b => b[0]), list.map(b => b.time));
    list[2].high = 102;
    writeFileSync(second, list.slice(1).map(b => JSON.stringify(b)).join("\n"));
    assert.notEqual((await loadAllMinutes([dir])).datasetHash, result.datasetHash);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("feature extraction does not bridge a missing minute", () => {
  const list = bars(65);
  list[63].time += MINUTE;
  assert.equal(computeFeatureVector(list, undefined, 63), null);
});

test("HTTP config accepts remote shape settings and GET cannot reset the account", async () => {
  const { server } = await import("../../src/server.ts");
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const reset = await fetch(`${url}/api/paper-trading/reset`);
    assert.equal(reset.status, 405);
    const resetUnauthorized = await fetch(`${url}/api/paper-trading/reset`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong-password" }),
    });
    assert.equal(resetUnauthorized.status, 401);
    const resetNoBody = await fetch(`${url}/api/paper-trading/reset`, {
      method: "POST", headers: { "Content-Type": "application/json" },
    });
    assert.equal(resetNoBody.status, 401);
    const resetSuccess = await fetch(`${url}/api/paper-trading/reset`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "Abcd#123456" }),
    });
    assert.equal(resetSuccess.status, 200);
    assert.equal((await resetSuccess.json() as any).ok, true);
    const updated = await fetch(`${url}/api/paper-trading/config`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ klineStatsLongConfig: { intervalWindow: 15, ampDivisor: 12, maRequirement: "MA_FRESH_BULL" } }),
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json() as any).config.klineStatsLongConfig.intervalWindow, 15);
    const invalid = await fetch(`${url}/api/paper-trading/config`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxPositions: 6, klineStatsLongConfig: { intervalWindow: 5 } }),
    });
    assert.equal(invalid.status, 400);
    const current = await (await fetch(`${url}/api/paper-trading/config`)).json() as any;
    assert.equal(current.config.klineStatsLongConfig.intervalWindow, 15);
    const state = await (await fetch(`${url}/api/paper-trading`)).json() as any;
    assert.equal(state.stats.bySide.LONG.totalTrades, 0);
    assert.equal(state.stats.bySide.SHORT.totalTrades, 0);

    // Test strategy faults reset endpoint
    const { paperTrading } = await import("../../src/paper-trading.ts");
    paperTrading.stopStrategy("streak", "测试故障", 2, 2, 0, -2);
    assert.equal(paperTrading.isStrategyFaulted("streak"), true);

    const faultReset = await fetch(`${url}/api/paper-trading/strategy-faults/reset`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategyId: "streak" }),
    });
    assert.equal(faultReset.status, 200);
    const faultResetData = await faultReset.json() as any;
    assert.equal(faultResetData.ok, true);
    assert.deepEqual(faultResetData.cleared, ["streak"]);
    assert.equal(paperTrading.isStrategyFaulted("streak"), false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
