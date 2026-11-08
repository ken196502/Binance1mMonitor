import { DEFAULT_FACTOR_MINING as DEFAULTS, factorRanges, factorWindows } from "../../src/factor-settings.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PaperTradingEngine, PAPER_DEFAULT_CONFIG } from "../../src/paper-trading.ts";
import { FEATURE_VERSION } from "../../src/features.ts";
import { DEFAULT_FACTOR_MINING, FACTOR_POLICY_VERSION, MINUTE_MS as M, passesFactorCandidate, type FactorMiningResult, type FactorMetrics } from "../../src/factor-policy.ts";
import { FactorMiningService, runFactorWorker } from "../../src/factor-mining-service.ts";
import { buildFactorBoards, loadFactorDataset, persistFactorBoard, type FactorDataset } from "../../src/factor-data.ts";
import { factorCandidates, factorMetrics, mineFactors } from "../../src/factor-miner.ts";
import type { ReplayStrategy, ReplayTrade } from "../../src/strategy-replay.ts";
import type { Candle } from "../../src/macd.ts";

const now = Math.floor(Date.now() / M) * M;
const candle = { time: now - M, open: 100, high: 101, low: 99, close: 100, volume: 1 };
const signal = { candle, streakCount: 2, amp30Percent: 3, upperShadowRatio: 0.1, greenRatio: 0.8, consecutiveGreenBars: 5 };
const metrics = (): FactorMetrics => ({ trades: 20, wins: 18, winRate: 90, wilsonLow: 69,
  grossProfit: 20, grossLoss: 2, profitFactor: 10, netPercent: 18, avgNetPercent: 0.9 });
const result = (at = now): FactorMiningResult => ({
  policyVersion: FACTOR_POLICY_VERSION, featureVersion: FEATURE_VERSION, dataAsOf: at, datasetHash: "test-hash", trials: 96,
  costs: { takerFeeBps: 5, slippageBps: 2 },
  sides: {
    SHORT: { reason: "通过", candidate: { id: "short", config: { ...PAPER_DEFAULT_CONFIG.klineStatsShortConfig } as any,
      train: metrics(), validation: metrics(), holdout: metrics() } },
    LONG: { reason: "样本不足" },
  },
});
const engine = () => new PaperTradingEngine({ storageFile: null });

test("all new default entries and mined candidates use 3x; manual overrides remain supported", () => {
  const e = engine();
  for (const type of ["streak", "rebound", "deep_rebound", "hourly_suppression", "w_bottom_divergence", "kline_stats_short", "kline_stats_long"] as const) {
    assert.equal(e.getLeverageForSignal(type), 3);
  }
  assert.ok(factorCandidates().every(c => c.leverage === 3));
  assert.equal(PAPER_DEFAULT_CONFIG.hourlySuppressionConfig?.leverage, 3);
  assert.equal(PAPER_DEFAULT_CONFIG.wBottomDivergenceConfig?.leverage, 3);
});

test("only actually validated factors can enter and approvals expire on the short use window", () => {
  const e = engine();
  assert.equal(e.factorEntryAllowed("SHORT", now), false, "preset parameters cannot authorize trading before real validation");
  e.applyMinedFactors(result(), now);
  assert.equal(e.factorEntryAllowed("SHORT", now + DEFAULTS.validForMinutes * M - 1), true);
  assert.equal(e.factorEntryAllowed("SHORT", now + DEFAULTS.validForMinutes * M), false, "outdated factor pauses entry");
  assert.throws(() => e.openPosition({ symbol: "A", entryPrice: 100, entryTime: now + DEFAULTS.validForMinutes * M, dayChangePercent: 20, signal, signalType: "kline_stats_short" }), /因子/);
  e.applyMinedFactors(result(now + DEFAULTS.validForMinutes * M), now + DEFAULTS.validForMinutes * M);
  assert.equal(e.factorEntryAllowed("SHORT", now + DEFAULTS.validForMinutes * M), true);
  assert.equal(e.factorEntryAllowed("SHORT", now + 2 * DEFAULTS.validForMinutes * M), false);
  assert.equal(e.factorEntryAllowed("LONG", now), false);
  assert.equal(e.getConfig().enableKlineStatsLong, false, "mining must preserve the operator's strategy switches");
  e.updateConfig({ klineStatsShortConfig: { holdMinutes: 30 } });
  assert.equal(e.factorEntryAllowed("SHORT", now), false, "manual changes need new validation");
});

test("factor rejection retires new entries but preserves existing leverage, exits and TP execution", () => {
  const e = engine();
  e.applyMinedFactors(result());
  const config = e.getConfig().klineStatsShortConfig!;
  const pos = e.openPosition({ symbol: "A", entryPrice: 100, entryTime: now, dayChangePercent: 20, signal, signalType: "kline_stats_short",
    exitParams: { ...config, holdMinutes: config.holdMinutes! } });
  const before = structuredClone(pos);
  assert.equal(pos.exitParams?.factorRevision, e.getFactorMiningState().sides.SHORT.active!.revision);
  const rejected = result(now + M);
  rejected.sides.SHORT = { reason: "验证失败" };
  e.applyMinedFactors(rejected, now + M);
  assert.deepEqual(pos, before);
  assert.equal(e.factorEntryAllowed("SHORT", now + M), false);
  e.onTick({ symbol: "A", price: pos.tp2Price - 0.1, qty: 1, time: now + M });
  assert.equal(pos.status, "CLOSED");
  assert.equal(pos.leverage, 3);
});

test("retired factor limit orders cannot fill after a refresh or expiry", () => {
  const e = engine();
  e.applyMinedFactors(result());
  const active = e.getFactorMiningState().sides.SHORT.active!;
  const order = e.createPendingOrder({ symbol: "P", basePrice: 100, dayChangePercent: 20, signal, signalType: "kline_stats_short", now,
    exitParams: { ...active.config, factorRevision: active.revision } });
  assert.ok(e.hasPendingOrder("P"));
  e.applyMinedFactors(result(now + M), now + M);
  assert.equal(e.hasPendingOrder("P"), false);
  e.onTick({ symbol: "P", price: order.limitPrice, qty: 1, time: now + M });
  assert.equal(e.hasActivePosition("P"), false);
});

test("stale, future, version-mismatched and under-sampled results are rejected atomically", () => {
  const e = engine();
  e.applyMinedFactors(result());
  const before = e.getFactorMiningState();
  for (const edit of [
    (r: FactorMiningResult) => { r.dataAsOf = now - 6 * M; },
    (r: FactorMiningResult) => { r.dataAsOf = now + M; },
    (r: FactorMiningResult) => { r.featureVersion = "old"; },
    (r: FactorMiningResult) => { r.costs.takerFeeBps = 10; },
    (r: FactorMiningResult) => { r.sides.SHORT.candidate!.holdout.trades = 0; },
    (r: FactorMiningResult) => { r.sides.SHORT.candidate!.validation = { ...metrics(), wilsonLow: 10 }; },
  ]) {
    const r = result(); edit(r);
    assert.throws(() => e.applyMinedFactors(r, now));
    assert.deepEqual(e.getFactorMiningState(), before);
  }
  const r = result(); r.sides.SHORT.candidate!.validation = { ...metrics(), avgNetPercent: -0.1 };
  assert.equal(passesFactorCandidate(r.sides.SHORT.candidate!), false, "high win rate alone is insufficient");
  assert.throws(() => e.updateConfig({ leverage: 10, factorMining: { enabled: true, refreshMinutes: 720, validForMinutes: 720 } }));
  assert.equal(e.getConfig().leverage, 3);
});

test("scheduler mines while fully invested, never overlaps, and continues the next short refresh cycle", async () => {
  const e = new PaperTradingEngine({ storageFile: null, maxPositions: 1 });
  e.openPosition({ symbol: "A", entryPrice: 100, entryTime: now, dayChangePercent: 20, signal });
  let calls = 0;
  let clock = now;
  let complete!: (r: FactorMiningResult) => void;
  const service = new FactorMiningService(e, () => { calls++; return new Promise(resolve => { complete = resolve; }); }, () => clock);
  const first = service.tick();
  await service.tick();
  assert.equal(calls, 1);
  assert.equal(e.getFactorMiningState().running, true);
  complete(result()); await first;
  await service.tick(); assert.equal(calls, 1);
  clock += DEFAULTS.refreshMinutes * M;
  const second = service.tick();
  complete(result(clock)); await second;
  assert.equal(calls, 2);
  assert.equal(e.getSummary().activeCount, 1);
  assert.equal(e.getFactorMiningState().running, false);
});

test("failed jobs back off, preserve original expiry, and never bypass expiry", async () => {
  const e = engine();
  e.applyMinedFactors(result());
  const expiry = e.getFactorMiningState().sides.SHORT.active!.expiresAt;
  let clock = now;
  const service = new FactorMiningService(e, async () => { throw new Error("no data"); }, () => clock);
  await service.tick();
  assert.equal(e.getFactorMiningState().nextRunAt, now + 15 * M);
  assert.equal(e.getFactorMiningState().sides.SHORT.active!.expiresAt, expiry);
  clock = expiry;
  await service.tick();
  assert.equal(e.factorEntryAllowed("SHORT", clock), false);
});

test("manual edits or disabling automatic mining during a job prevent stale application", async () => {
  for (const disable of [false, true]) {
    const e = engine();
    let complete!: (r: FactorMiningResult) => void;
    const service = new FactorMiningService(e, () => new Promise(resolve => { complete = resolve; }), () => now);
    const job = service.tick();
    e.updateConfig(disable ? { factorMining: { ...DEFAULT_FACTOR_MINING, enabled: false } } : { klineStatsShortConfig: { holdMinutes: 25 } });
    complete(result()); await job;
    assert.equal(e.getFactorMiningState().sides.SHORT.active, undefined);
    if (!disable) assert.equal(e.getConfig().klineStatsShortConfig?.holdMinutes, 25);
  }
});

test("legacy saved defaults migrate once without rewriting existing positions; factor expiry survives reload", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "factor-state-"));
  const file = path.join(dir, "state.json");
  const tracked: PaperTradingEngine[] = [];
  try {
    const e = new PaperTradingEngine({ storageFile: file, streakLeverage: 10 }); tracked.push(e);
    e.openPosition({ symbol: "A", entryPrice: 100, entryTime: now, dayChangePercent: 20, signal });
    e.saveState();
    const raw = JSON.parse(await readFile(file, "utf8"));
    delete raw.leverageDefaultsVersion;
    raw.configOverrides.klineStatsShortConfig.leverage = 10;
    await writeFile(file, JSON.stringify(raw));
    const restored = new PaperTradingEngine({ storageFile: file }); tracked.push(restored);
    assert.equal(restored.getLeverageForSignal("streak"), 3);
    assert.equal(restored.getLeverageForSignal("kline_stats_short"), 3);
    assert.equal(restored.getPosition("A")!.leverage, 10);
    restored.applyMinedFactors(result());
    restored.updateConfig({ streakLeverage: 4 });
    restored.saveState();
    const again = new PaperTradingEngine({ storageFile: file }); tracked.push(again);
    assert.equal(again.getLeverageForSignal("streak"), 4, "one-time migration preserves subsequent explicit settings");
    assert.equal(again.factorEntryAllowed("SHORT", now), true);
    assert.equal(again.factorEntryAllowed("SHORT", now + DEFAULTS.validForMinutes * M), false);
  } finally {
    for (const e of tracked) clearTimeout((e as any).saveTimeout);
    await rm(dir, { recursive: true, force: true });
  }
});

test("actual board archive has no lookahead and expires after a data gap", () => {
  const tickers = [{ symbol: "A", priceChangePercent: 20, lastPrice: 100, quoteVolume: 1 }];
  const boards = buildFactorBoards([{ observedAt: now + 1000, tickers }], [now, now + M, now + 2 * M, now + 3 * M]);
  assert.equal(boards.get(now)!.size, 0);
  assert.equal(boards.get(now + M)!.get("A")!.rank, 1);
  assert.equal(boards.get(now + 3 * M)!.size, 0);
});

test("rolling loader excludes forming/future candles and rejects stale archives", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "factor-data-"));
  try {
    await mkdir(path.join(dir, "live-1m"));
    const day = new Date(now).toISOString().slice(0, 10).replaceAll("-", "");
    await writeFile(path.join(dir, "live-1m", `A-${day}.jsonl`), [candle, { ...candle, time: now }, { ...candle, time: now + M }].map(b => JSON.stringify(b)).join("\n") + "\n");
    await persistFactorBoard([{ symbol: "A", priceChangePercent: 20, lastPrice: 100, quoteVolume: 1 }], now - 1000, dir);
    const data = await loadFactorDataset(now, dir);
    assert.equal(data.dataAsOf, now);
    assert.equal(data.candles.get("A")!.length, 1);
    await assert.rejects(loadFactorDataset(now + 6 * M, dir), /过期/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function syntheticData(badHoldout = false): FactorDataset {
  const list: Candle[] = [];
  const ranges = factorRanges(now);
  const start = ranges.earliestStart - 500 * M;
  for (let time = start, i = 0; time < now; time += M, i++) {
    const event = i >= 70 && i % 5 === 0;
    const loss = badHoldout && time >= ranges.holdout.start && time < ranges.holdout.end && event;
    list.push({ time, open: 100, close: 100, high: event && !loss ? 107 : 100.1, low: loss ? 95 : 99.9, volume: 1 });
  }
  const times = list.map(b => b.time);
  return { candles: new Map([["A", list]]), indices: new Map([["A", new Map(times.map((t, i) => [t, i]))]]), times,
    boards: new Map(times.map(t => [t, new Map([["A", { rank: 1, dayChange: 20 }]])])), dataAsOf: now, datasetHash: "fixture" };
}
const candidate: ReplayStrategy = { id: "test-long", side: "LONG", intervalWindow: 5, ampDivisor: 8, maRequirement: "NONE", macdRequirement: "NONE",
  holdMinutes: 20, tp1Percent: 2.5, tp2Percent: 5, stopLossPercent: 3, cooldownMinutes: 0, leverage: 3 };

test("actual replay selects using training/validation, then rejects a losing recent holdout", () => {
  const costs = { takerFeeBps: 5, slippageBps: 2 };
  const good = mineFactors(syntheticData(), costs, [candidate]);
  assert.ok(good.sides.LONG.candidate);
  assert.ok(good.sides.LONG.candidate.holdout.trades >= 5);
  const bad = mineFactors(syntheticData(true), costs, [candidate]);
  assert.equal(bad.sides.LONG.candidate, undefined);
  assert.match(bad.sides.LONG.reason, /留出/);
  const costly = mineFactors(syntheticData(), { takerFeeBps: 999, slippageBps: 999 }, [candidate]);
  assert.equal(costly.sides.LONG.candidate, undefined, "replay uses live configured costs");
});

test("zero trades and no-loss profit factors are handled explicitly", () => {
  assert.equal(factorMetrics([]).profitFactor, 0);
  const stats = factorMetrics([{ isWin: true, netPercent: 1 } as ReplayTrade]);
  assert.equal(stats.profitFactor, null);
  assert.equal(stats.trades, 1);
});

test("real isolated worker starts through tsx and reports missing data without trading side effects", async () => {
  // A deliberately old cutoff cannot consume current archives or return an eligible factor.
  await assert.rejects(runFactorWorker({ now: M, costs: { takerFeeBps: 5, slippageBps: 2 } }), /不足|过期|Invalid/);
});

test("archive to real worker to scheduler honors short windows and retires under-sampled factors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "factor-worker-data-"));
  const e = engine();
  const config = { ...DEFAULTS, trainingMinutes: 60, validationMinutes: 0, holdoutMinutes: 15, holdoutPoolHours: [2, 1.5] as [number, number] };
  e.updateConfig({ factorMining: config });
  const approved = result(); approved.windows = factorWindows(config);
  e.applyMinedFactors(approved, now);
  try {
    await mkdir(path.join(root, "live-1m"));
    for (const b of [{ ...candle, time: now - 700 * M }, candle]) {
      const day = new Date(b.time).toISOString().slice(0, 10).replaceAll("-", "");
      const file = path.join(root, "live-1m", `A-${day}.jsonl`);
      await writeFile(file, JSON.stringify(b) + "\n", { flag: "a" });
    }
    await persistFactorBoard([{ symbol: "A", priceChangePercent: 20, lastPrice: 100, quoteVolume: 1 }], now - 1000, root);
    assert.equal((await loadFactorDataset(now, root)).candles.get("A")!.length, 2);
    assert.equal((await loadFactorDataset(now, root, config)).candles.get("A")!.length, 1, "loader trims to configured windows plus warmup");
    const service = new FactorMiningService(e, async job => {
      const mined = await runFactorWorker({ ...job, root });
      assert.deepEqual(mined.windows, factorWindows(config));
      assert.equal(mined.trials, 216);
      return mined;
    }, () => now);
    await service.tick();
    assert.equal(e.getFactorMiningState().lastError, undefined, "insufficient samples is a completed rejection, not a worker failure");
    assert.equal(e.getFactorMiningState().nextRunAt, now + config.refreshMinutes * M);
    assert.equal(e.getFactorMiningState().sides.SHORT.active, undefined);
    assert.match(e.getFactorMiningState().sides.SHORT.reason, /样本不足/);
    assert.equal(e.factorEntryAllowed("SHORT", now), false);
  } finally {
    clearTimeout((e as any).saveTimeout);
    await rm(root, { recursive: true, force: true });
  }
});

test("worker cancellation terminates the owned process", async () => {
  const controller = new AbortController();
  const work = runFactorWorker({ now, costs: { takerFeeBps: 5, slippageBps: 2 } }, controller.signal);
  controller.abort();
  await assert.rejects(work, /已停止/);
});

test("rolling time ranges are short, disjoint, configurable and advance with new data", () => {
  const ranges = factorRanges(now);
  assert.equal((ranges.train.end - ranges.train.start) / M, 720);
  assert.equal((ranges.validation.end - ranges.validation.start) / M, 120);
  assert.equal((ranges.holdout.end - ranges.holdout.start) / M, 120);
  assert.equal(ranges.train.start, now - 16 * 60 * M);
  assert.equal(ranges.train.end, now - 4 * 60 * M);
  assert.equal(ranges.validation.start, now - 4 * 60 * M);
  assert.equal(ranges.validation.end, now - 2 * 60 * M);
  assert.equal(ranges.holdout.start, now - 2 * 60 * M);
  assert.equal(ranges.holdout.end, now);
  assert.equal(factorRanges(now + 15 * M).train.start - ranges.train.start, 15 * M);
  assert.equal((factorRanges(now, { trainingMinutes: 600 }).train.end - factorRanges(now, { trainingMinutes: 600 }).train.start) / M, 600);
  assert.ok(factorCandidates().every(c => c.holdMinutes <= 15 && c.cooldownMinutes === 3));
  assert.equal(DEFAULTS.refreshMinutes, 15);
  assert.equal(DEFAULTS.validForMinutes, 120);
});

test("bad very old regimes do not block a factor validated entirely on the current short window", () => {
  const good = syntheticData();
  const old = Array.from({ length: 90 }, (_, i) => ({ ...candle, time: now - (5000 - i) * M, high: 100.1, low: 80 }));
  const list = [...old, ...good.candles.get("A")!];
  const data = { ...good, candles: new Map([["A", list]]), times: list.map(b => b.time),
    indices: new Map([["A", new Map(list.map((b, i) => [b.time, i]))]]) };
  const selected = mineFactors(data, { takerFeeBps: 5, slippageBps: 2 }, [candidate]);
  assert.ok(selected.sides.LONG.candidate);
  assert.deepEqual(selected.windows, factorWindows());
  assert.deepEqual(selected.sides.LONG.candidate, mineFactors(good, selected.costs, [candidate]).sides.LONG.candidate);
});

test("rejected factors stay rejected across restarts; no baseline renewal on missing approvals", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "factor-no-baseline-"));
  const engines: PaperTradingEngine[] = [];
  try {
    const file = path.join(dir, "state.json");
    const e = new PaperTradingEngine({ storageFile: file }); engines.push(e);
    e.applyMinedFactors(result(), now);
    const rejected = result(); rejected.sides.SHORT = { reason: "最近留出失败" };
    e.applyMinedFactors(rejected, now); e.saveState();
    const restored = new PaperTradingEngine({ storageFile: file }); engines.push(restored);
    assert.equal(restored.getFactorMiningState().sides.SHORT.active, undefined);
    assert.equal(restored.factorEntryAllowed("SHORT", now), false);
    assert.equal(restored.getFactorMiningState().sides.SHORT.reason, "最近留出失败");
    restored.reset();
    assert.equal(restored.factorEntryAllowed("SHORT", now), false);
  } finally {
    engines.forEach(e => clearTimeout((e as any).saveTimeout));
    await rm(dir, { recursive: true, force: true });
  }
});

test("restart retains the data-based deadline; a legacy baseline never counts as current evidence", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "factor-deadline-"));
  const engines: PaperTradingEngine[] = [];
  try {
    const file = path.join(dir, "state.json");
    const e = new PaperTradingEngine({ storageFile: file }); engines.push(e);
    e.applyMinedFactors(result(), now); e.saveState();
    const expiry = e.getFactorMiningState().sides.SHORT.active!.expiresAt;
    const restored = new PaperTradingEngine({ storageFile: file }); engines.push(restored);
    assert.equal(restored.getFactorMiningState().sides.SHORT.active!.expiresAt, expiry);
    assert.equal(restored.factorEntryAllowed("SHORT", expiry), false);
    const state = restored.getFactorMiningState(); state.sides.SHORT.active!.revision = "baseline:kline_stats_short:v1";
    restored.setFactorMiningState(state);
    assert.equal(restored.factorEntryAllowed("SHORT", now), false);
  } finally {
    engines.forEach(e => clearTimeout((e as any).saveTimeout));
    await rm(dir, { recursive: true, force: true });
  }
});

test("window changes invalidate approvals, reach the worker, and prevent stale job application", async () => {
  const e = engine(); e.applyMinedFactors(result(), now);
  let input: import("../../src/factor-mining-service.ts").FactorJob | undefined;
  let complete!: (r: FactorMiningResult) => void;
  const service = new FactorMiningService(e, job => { input = job; return new Promise(resolve => { complete = resolve; }); }, () => now);
  const job = service.tick();
  assert.deepEqual(factorWindows(input!.config), factorWindows());
  e.updateConfig({ factorMining: { ...DEFAULTS, validationMinutes: 180 } });
  assert.equal(e.factorEntryAllowed("SHORT", now), false);
  complete(result()); await job;
  assert.match(e.getFactorMiningState().lastError!, /已被修改/);
  assert.throws(() => e.applyMinedFactors(result(), now), /不匹配/);
  const matched = result(); matched.windows = factorWindows(e.getConfig().factorMining);
  e.applyMinedFactors(matched, now);
  assert.equal(e.factorEntryAllowed("SHORT", now), true);
  const before = e.getConfig();
  assert.throws(() => e.updateConfig({ marginPercent: 10, factorMining: { ...DEFAULTS, holdoutMinutes: 0 } }));
  assert.deepEqual(e.getConfig(), before);
});

test("merged window limits are validated atomically and stored window preferences survive restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "factor-window-config-"));
  const engines: PaperTradingEngine[] = [];
  try {
    const file = path.join(dir, "state.json");
    const e = new PaperTradingEngine({ storageFile: file }); engines.push(e);
    e.updateConfig({ factorMining: { ...DEFAULTS, trainingMinutes: 3900, refreshMinutes: 30, validForMinutes: 120 } });
    const before = e.getConfig();
    // The patch alone fits, but together with the retained training window it exceeds 72 h.
    assert.throws(() => e.updateConfig({ marginPercent: 10, factorMining: {
      enabled: true, refreshMinutes: 30, validForMinutes: 120, validationMinutes: 400,
    } }), /72 小时/);
    assert.deepEqual(e.getConfig(), before);
    e.saveState();
    const restored = new PaperTradingEngine({ storageFile: file }); engines.push(restored);
    assert.deepEqual(restored.getConfig().factorMining, before.factorMining);
  } finally {
    engines.forEach(e => clearTimeout((e as any).saveTimeout));
    await rm(dir, { recursive: true, force: true });
  }
});

test("reprocessing the same data never renews its deadline; fresh evidence replaces the revision", () => {
  const e = engine(); e.applyMinedFactors(result(), now);
  const first = e.getFactorMiningState().sides.SHORT.active!;
  e.applyMinedFactors(result(), now + M);
  assert.equal(e.getFactorMiningState().sides.SHORT.active!.expiresAt, first.expiresAt);
  const fresh = result(now + 15 * M);
  fresh.sides.SHORT.candidate!.config.holdMinutes = 5;
  e.applyMinedFactors(fresh, now + 15 * M);
  const next = e.getFactorMiningState().sides.SHORT.active!;
  assert.notEqual(next.revision, first.revision);
  assert.equal(next.expiresAt, now + (15 + DEFAULTS.validForMinutes) * M);
  assert.equal(e.getConfig().klineStatsShortConfig!.holdMinutes, 5);
  assert.equal(e.factorEntryAllowed("SHORT", now + 15 * M), true);
});

test("expired pending orders are canceled while established positions retain their original exits", () => {
  const e = engine(); e.applyMinedFactors(result(), now);
  const p = e.openPosition({ symbol: "A", entryPrice: 100, entryTime: now, dayChangePercent: 20, signal, signalType: "kline_stats_short" });
  e.updateConfig({ limitExpireMinutes: 120 });
  // One order per strategy: use a second engine to isolate order expiry from the position quota.
  const orders = engine(); orders.updateConfig({ limitExpireMinutes: 120 }); orders.applyMinedFactors(result(), now);
  const order = orders.createPendingOrder({ symbol: "B", basePrice: 100, dayChangePercent: 20, signal, signalType: "kline_stats_short", now });
  const expiry = orders.getFactorMiningState().sides.SHORT.active!.expiresAt;
  const frozen = { tp1: p.tp1Price, tp2: p.tp2Price, timeout: p.timeoutAt };
  orders.onTick({ symbol: "B", price: order.limitPrice, qty: 1, time: expiry });
  assert.equal(orders.hasPendingOrder("B"), false);
  assert.equal(orders.hasActivePosition("B"), false);
  assert.equal(e.factorEntryAllowed("SHORT", expiry), false);
  assert.deepEqual({ tp1: p.tp1Price, tp2: p.tp2Price, timeout: p.timeoutAt }, frozen);
});
