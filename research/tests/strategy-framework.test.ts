import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StrategyEngine } from "../../src/strategy-engine.ts";
import { StrategyFeatureMonitor } from "../../src/strategy-features.ts";
import { FeatureWatch } from "../../src/strategy-watch.ts";
import { all, any, rule, ref, evaluateRules, validateRules } from "../../src/strategy-rules.ts";
import { validateStrategies, type StrategyDefinition } from "../../src/strategy-definition.ts";
import { buildStrategyPresets, wBottomPreset, deepReboundPreset, reboundPreset } from "../../src/strategy-presets.ts";
import { PaperTradingEngine, PAPER_DEFAULT_CONFIG } from "../../src/paper-trading.ts";
import { replayStrategies, type MinuteBoard } from "../../src/strategy-replay.ts";
import { computeFeatureVector, evaluateFeatureSpec } from "../../src/features.ts";
import type { Candle } from "../../src/macd.ts";

const M = 60_000;
const now = Math.floor(Date.now() / M) * M;
const bars = (count = 81): Candle[] => Array.from({ length: count }, (_, i) => ({ time: now - (count - 1 - i) * M, open: 100, high: 101, low: 99, close: 100, volume: 10 }));
const ticker = { symbol: "TESTUSDT", lastPrice: 100, priceChangePercent: 20, quoteVolume: 1, highPrice: 140, lowPrice: 90 };
const custom = (id = "custom"): StrategyDefinition => ({ id, label: "自定义特征", side: "SHORT", enabled: true, minBars: 60,
  entry: all(rule("dayChange", ">=", 10)), exit: { holdMinutes: 30, leverage: 3, tp1Percent: 3, tp2Percent: 6, stopLossPercent: 5, moveSlToEntryAfterTp1: true }, cooldownMinutes: 20 });
const engineConfig = { storageFile: null, factorMining: { enabled: false, refreshMinutes: 60, validForMinutes: 720 } };
function cleanup(engine: PaperTradingEngine) { clearTimeout((engine as unknown as { saveTimeout: ReturnType<typeof setTimeout> }).saveTimeout); }

test("all seven active presets compile to serializable feature combinations, with prior exits", () => {
  const specs = buildStrategyPresets(PAPER_DEFAULT_CONFIG);
  validateStrategies(JSON.parse(JSON.stringify(specs)));
  assert.deepEqual(specs.map(s => s.id), ["rebound", "deep_rebound", "streak", "hourly_suppression", "w_bottom_divergence", "kline_stats_short", "kline_stats_long"]);
  assert.deepEqual(specs.map(s => s.exit.holdMinutes), [30, 30, 15, 30, 30, 45, 30]);
  assert.deepEqual(specs.map(s => s.exit.leverage), [3, 3, 3, 3, 3, 3, 3]);
  assert.equal(specs.at(-1)!.enabled, false);
  assert.equal(specs[0].observation?.rank, 1);
});

test("nested conditions support feature comparisons, in/contains and fail closed on missing or invalid data", () => {
  const monitor = new StrategyFeatureMonitor(bars(), ticker, 2);
  const rules = all(rule("rank", "<=", 5), rule("price.high", ">", ref("ma.15.value")),
    any(rule("dayChange", ">", 30), rule("stack", "in", ["tangled", "bull_full"])), rule("stack", "contains", "tang"));
  validateRules(rules);
  assert.equal(evaluateRules(rules, f => monitor.read(f)).pass, true);
  assert.equal(evaluateRules(rule("missing", "!=", 0), () => undefined).pass, false);
  assert.equal(evaluateRules(rule("dayChange", ">=", 0), () => NaN).pass, false);
  assert.throws(() => validateRules({ field: "__proto__.polluted", op: "==", value: true }));
  assert.throws(() => validateRules({ field: "rank", op: "arbitrary", value: 1 }));
  assert.throws(() => validateRules({ all: [] }));
  assert.throws(() => validateStrategies([{ ...custom(), exit: { holdMinutes: 30 } }]));
});

test("forming/future candles and gaps never enter features or advance observation state", () => {
  const list = bars();
  const before = new StrategyFeatureMonitor(list, ticker, 1);
  list.at(-1)!.high = 1e6; list.at(-1)!.close = 1e6;
  const after = new StrategyFeatureMonitor(list, ticker, 1);
  for (const f of ["surge.5", "ma.15.value", "dif", "pivotLow.8.25.price"]) assert.equal(before.read(f), after.read(f));
  const watched = new StrategyEngine([reboundPreset()]);
  watched.onRank(ticker.symbol, 1, 20, now);
  watched.evaluate(after, now - 2 * M);
  assert.equal(watched.getWatch("rebound").getWatchlist()[0].peakPrice, 0);
  list[70].time += M / 2;
  assert.equal(new StrategyEngine([custom()]).evaluate(new StrategyFeatureMonitor(list, ticker, 1), now).length, 0);
});

test("legacy quant shorthand and generic engine agree over all MA/MACD requirement combinations", async () => {
  const { MA_REQUIREMENTS, MACD_REQUIREMENTS } = await import("../../src/strategy-spec.ts");
  const { quantPreset } = await import("../../src/strategy-presets.ts");
  const list = bars(151);
  list.forEach((b, i) => { b.open += Math.sin(i / 6); b.close += Math.cos(i / 7); b.high = Math.max(b.open, b.close) + 2; b.low = Math.min(b.open, b.close) - 2; });
  const fv = computeFeatureVector(list, ticker, list.length - 2, { rank: 2 })!;
  for (const side of ["LONG", "SHORT"] as const) for (const maRequirement of MA_REQUIREMENTS) for (const macdRequirement of MACD_REQUIREMENTS) {
    const spec = { topN: 5, minDayChange: 10, intervalWindow: 5, ampDivisor: side === "SHORT" ? 100 : 1, maRequirement, macdRequirement };
    const monitor = new StrategyFeatureMonitor(list, ticker, 2);
    const matches = new StrategyEngine([quantPreset(side, spec)]).evaluate(monitor, now);
    assert.equal(matches.length > 0, evaluateFeatureSpec(side, fv, spec).pass, `${side} ${maRequirement} ${macdRequirement}`);
  }
});

test("W-bottom is derived from pivot, bounce and optional confirmation parameters without hidden rank/day caps", () => {
  const list = bars();
  list[64].low = 95;
  list[79] = { ...list[79], open: 96, high: 98, low: 95, close: 97 };
  const spec = wBottomPreset({ topN: 20, minDayChange: 10, requireMacdDivergence: false, requireCatapultBull: false });
  const monitor = new StrategyFeatureMonitor(list, { ...ticker, priceChangePercent: 12 }, 15);
  assert.equal(new StrategyEngine([spec]).evaluate(monitor, now).length, 1);
  spec.entry = all(spec.entry, rule("pivotLow.8.25.bounce", ">=", 10));
  assert.equal(new StrategyEngine([spec]).evaluate(monitor, now).length, 0);
});

test("deep rebound combines a real 24h drawdown, configurable rebound window and strict MA rejection", () => {
  const list = bars();
  for (let i = 0; i < 65; i++) Object.assign(list[i], { open: 120, high: 121, low: 119, close: 120 });
  for (let i = 65; i < 79; i++) Object.assign(list[i], { open: 90, high: 91, low: 89, close: 90 });
  Object.assign(list[79], { open: 90, high: 98, low: 87, close: 88 });
  const spec = deepReboundPreset({ minGreenRatio20: 0 });
  const monitor = new StrategyFeatureMonitor(list, ticker, 30);
  assert.equal(new StrategyEngine([spec]).evaluate(monitor, now).length, 1);
  Object.assign(list[79], { high: 91 });
  assert.equal(new StrategyEngine([spec]).evaluate(new StrategyFeatureMonitor(list, ticker, 30), now).length, 0);
});

test("watch features survive a rolling window, initialize once, expire, and only count candles since trough time", () => {
  const list = bars();
  const watch = new FeatureWatch();
  const spec = { rank: 1, watchWindowHours: 48, pullbackPercent: 10, reboundPercent: 4, historyBars: 120 };
  watch.restoreWatchlist([{ symbol: ticker.symbol, enteredAt: now - M, lastRank1Time: now - M, dayChangeAtRank1: 25,
    state: "rebounded", peakPrice: 140, peakTime: now - 100 * M, troughPrice: 90, troughTime: list[70].time, troughIndex: 490, cooldownUntil: 0 }]);
  const state = watch.observe(ticker.symbol, list.slice(0, -1), spec, now)!;
  list[72].close = 100.5; list[75].close = 100.5;
  const monitor = new StrategyFeatureMonitor(list, ticker, 1);
  assert.equal(monitor.read("watch.upCandles", state), 2);
  assert.equal(state.ready, true);
  assert.equal(watch.observe(ticker.symbol, list.slice(0, -1), spec, now)?.lastBarTime, state.lastBarTime);
  assert.equal(watch.observe(ticker.symbol, list, spec, now + 49 * 3_600_000), undefined);
});

test("evaluating an ineligible higher-priority strategy consumes nothing; only accepted trades start cooldown", () => {
  const engine = new StrategyEngine([custom("first"), custom("second")]);
  const monitor = new StrategyFeatureMonitor(bars(), ticker, 1);
  const matches = engine.evaluate(monitor, now, s => s.id !== "first");
  assert.deepEqual(matches.map(m => m.strategy.id), ["second"]);
  assert.equal(engine.exportState().cooldowns.length, 0);
  engine.commit(matches[0], now);
  assert.deepEqual(engine.evaluate(monitor, now).map(m => m.strategy.id), ["first"]);
  const restored = new StrategyEngine(engine.getStrategies()); restored.restoreState(JSON.parse(JSON.stringify(engine.exportState())));
  assert.deepEqual(restored.evaluate(monitor, now).map(m => m.strategy.id), ["first"]);
});

test("canonical configuration updates are atomic and legacy switches preserve customized feature rules", () => {
  const engine = new PaperTradingEngine(engineConfig);
  try {
    const specs = engine.getConfig().strategies!;
    specs.find(s => s.id === "streak")!.entry = all(rule("rank", "==", 7));
    engine.updateConfig({ strategies: specs });
    engine.updateConfig({ enableStreak: false });
    assert.deepEqual(engine.getConfig().strategies!.find(s => s.id === "streak")!.entry, all(rule("rank", "==", 7)));
    const original = engine.getConfig();
    assert.throws(() => engine.updateConfig({ marginPercent: 15, strategies: [{ ...custom(), entry: { field: "rank", op: "bad", value: 1 } as never }] }));
    assert.deepEqual(engine.getConfig(), original);
    assert.throws(() => engine.updateConfig({ strategies: [custom("same"), custom("same")] }));
    const leaked = engine.getConfig(); leaked.strategies![0].enabled = false;
    assert.deepEqual(engine.getConfig(), original);
  } finally { cleanup(engine); }
});

test("custom strategy executes in live paper and replay with the same closed-bar signal and snapshot exits", async () => {
  const list = bars(); const def = custom();
  const engine = new PaperTradingEngine({ ...engineConfig, strategies: [def] });
  try {
    const opened = await engine.onScan([ticker], new Map([[ticker.symbol, { candles1m: list, initialized: true }]]));
    assert.equal(opened.length, 1);
    assert.equal(opened[0].signalType, def.id);
    const candleMap = new Map([[ticker.symbol, list]]);
    const index = new Map([[ticker.symbol, new Map(list.map((b, i) => [b.time, i]))]]);
    const board: MinuteBoard = new Map([[ticker.symbol, { rank: 1, dayChange: 20, high24h: 140, low24h: 90 }]]);
    const replay = replayStrategies(candleMap, index, list.map(b => b.time), new Map([[now, board]]), [def], { start: now, end: now + M });
    assert.equal(replay.totalTrades, 1);
    assert.equal(replay.trades[0].strategyId, opened[0].signalType);
    assert.equal(replay.trades[0].entryPrice, opened[0].entryPrice);
    engine.updateConfig({ strategies: [{ ...def, exit: { ...def.exit, tp1Percent: 4, leverage: 5 } }] });
    assert.equal(engine.getPosition(ticker.symbol)!.tp1Percent, 3);
    assert.equal(engine.getPosition(ticker.symbol)!.leverage, 3);
  } finally { cleanup(engine); }
});

test("new definitions and runtime state persist without changing old positions", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "strategy-framework-"));
  const engines: PaperTradingEngine[] = [];
  try {
    const file = path.join(dir, "state.json");
    const engine = new PaperTradingEngine({ ...engineConfig, storageFile: file, strategies: [custom()] }); engines.push(engine);
    await engine.onScan([ticker], new Map([[ticker.symbol, { candles1m: bars(), initialized: true }]]));
    engine.saveState();
    const restored = new PaperTradingEngine({ ...engineConfig, storageFile: file }); engines.push(restored);
    assert.deepEqual(restored.getConfig().strategies, engine.getConfig().strategies);
    assert.deepEqual(restored.getStrategyEngine().exportState(), engine.getStrategyEngine().exportState());
    assert.equal(restored.getPosition(ticker.symbol)!.tp1Percent, 3);
  } finally { engines.forEach(cleanup); rmSync(dir, { recursive: true, force: true }); }
});

test("live and replay use the same symbol/strategy priority when portfolio capacity is scarce", async () => {
  const first = { ...custom("first"), entry: all(rule("dayChange", ">", 30)) }, second = custom("second");
  const list = bars();
  const tickers = [{ ...ticker, symbol: "AAAUSDT", priceChangePercent: 20 }, { ...ticker, symbol: "BBBUSDT", priceChangePercent: 40 }];
  const engine = new PaperTradingEngine({ ...engineConfig, maxPositions: 1, strategies: [first, second] });
  try {
    const live = await engine.onScan(tickers, new Map(tickers.map(t => [t.symbol, { candles1m: list, initialized: true }])));
    const candleMap = new Map(tickers.map(t => [t.symbol, list]));
    const indexes = new Map(tickers.map(t => [t.symbol, new Map(list.map((b, i) => [b.time, i]))]));
    const board: MinuteBoard = new Map(tickers.map((t, i) => [t.symbol, { rank: i + 1, dayChange: t.priceChangePercent }]));
    const replay = replayStrategies(candleMap, indexes, list.map(b => b.time), new Map([[now, board]]), [first, second], { start: now, end: now + M }, { maxPositions: 1 });
    assert.equal(live[0].symbol, "AAAUSDT");
    assert.equal(replay.trades[0].symbol, live[0].symbol);
    assert.equal(replay.trades[0].strategyId, live[0].signalType);
  } finally { cleanup(engine); }
});

test("rebound preset emits only after observed pullback/rebound and keeps peak/trough evidence", () => {
  const list = bars();
  for (let i = 0; i < 65; i++) Object.assign(list[i], { open: 120, high: 121, low: 119, close: 120 });
  for (let i = 65; i < 79; i++) Object.assign(list[i], { open: 90, high: 91, low: 89, close: 90 });
  Object.assign(list[79], { open: 90, high: 94, low: 87, close: 88 });
  const spec = reboundPreset({ minGreenRatio20: 0 });
  const engine = new StrategyEngine([spec]);
  engine.getWatch(spec.id).restoreWatchlist([{ symbol: ticker.symbol, enteredAt: now - 100 * M, lastRank1Time: now - M,
    dayChangeAtRank1: 25, state: "pulled_back", peakPrice: 140, peakTime: now - 100 * M, troughPrice: 85, troughTime: now - 10 * M, troughIndex: 999, cooldownUntil: 0 }]);
  const matches = engine.evaluate(new StrategyFeatureMonitor(list, ticker, 40), now);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].observation?.peakPrice, 140);
  assert.equal(matches[0].observation?.troughPrice, 85);
  assert.equal(matches[0].time, list[79].time + M);
  engine.commit(matches[0], now);
  assert.equal(engine.getWatch(spec.id).getWatchlist()[0].state, "watching_peak");
  assert.equal(matches[0].observation?.peakPrice, 140, "execution must not overwrite signal evidence");
  assert.equal(engine.evaluate(new StrategyFeatureMonitor(list, ticker, 40), now).length, 0);
});
