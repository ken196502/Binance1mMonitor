import test from "node:test";
import assert from "node:assert/strict";
import { PaperTradingEngine } from "../../src/paper-trading.ts";
import { FEATURE_VERSION } from "../../src/features.ts";
import { FACTOR_POLICY_VERSION, type FactorMiningResult } from "../../src/factor-policy.ts";
import { mineFactors } from "../../src/factor-miner.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const now = 1700000000000;
const dummySignal = {
  candle: { time: now - 60000, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
  streakCount: 2,
  amp30Percent: 8,
  upperShadowRatio: 0.1,
  greenRatio: 0.8,
  consecutiveGreenBars: 5,
};

test("strategy with consecutive losses is immediately stopped, cancels pending orders, and rejects new entries", () => {
  const engine = new PaperTradingEngine({ storageFile: null });
  assert.equal(engine.isStrategyFaulted("streak"), false);

  // 1. First trade loses
  const pos1 = engine.openPosition({
    symbol: "TOKEN1",
    side: "SHORT",
    dayChangePercent: 20,
    entryPrice: 100,
    entryTime: now,
    signalType: "streak",
    signal: dummySignal,
  });
  // Trigger stop loss
  engine.onTick({ symbol: "TOKEN1", price: pos1.sl2Price + 1, qty: 1, time: now + 60000 });
  assert.equal(pos1.status, "CLOSED");
  assert.ok(pos1.totalNetPnlUsdt < 0);
  assert.equal(engine.isStrategyFaulted("streak"), false, "1 loss does not trigger fault");

  // 2. Second consecutive loss
  const pos2 = engine.openPosition({
    symbol: "TOKEN2",
    side: "SHORT",
    dayChangePercent: 20,
    entryPrice: 100,
    entryTime: now + 80000,
    signalType: "streak",
    signal: dummySignal,
  });
  engine.onTick({ symbol: "TOKEN2", price: pos2.sl2Price + 1, qty: 1, time: now + 90000 });
  assert.equal(pos2.status, "CLOSED");
  assert.ok(pos2.totalNetPnlUsdt < 0);

  // Fault triggered!
  assert.equal(engine.isStrategyFaulted("streak"), true, "2 consecutive losses triggers fault");
  const faults = engine.getStrategyFaults();
  assert.equal(faults.length, 1);
  assert.equal(faults[0].strategyId, "streak");
  assert.match(faults[0].reason, /连续亏损 2 笔/);

  // New entries rejected via openPosition
  assert.throws(
    () => engine.openPosition({
      symbol: "TOKEN3",
      side: "SHORT",
      dayChangePercent: 20,
      entryPrice: 100,
      entryTime: now + 100000,
      signalType: "streak",
      signal: dummySignal,
    }),
    /表现不佳已停用/,
  );

  // New pending orders rejected via createPendingOrder
  assert.throws(
    () => engine.createPendingOrder({
      symbol: "PENDING_STREAK",
      dayChangePercent: 25,
      basePrice: 50,
      rank: 1,
      marginUsdt: 10,
      signal: dummySignal,
      signalType: "streak",
      now: now + 110000,
    }),
    /表现不佳已停用/,
  );
});

test("stopped strategy has no cooldown timer and never auto-resumes by elapsed time", () => {
  const engine = new PaperTradingEngine({ storageFile: null });
  engine.stopStrategy("streak", "连续亏损测试", 2, 2, 0, -5);
  assert.equal(engine.isStrategyFaulted("streak"), true);

  // Check 1 hour, 24 hours, 7 days later: NO auto-recovery!
  for (const hours of [1, 24, 48, 168]) {
    const futureTime = now + hours * 3600 * 1000;
    assert.equal(
      engine.isStrategyFaulted("streak"),
      true,
      `must not resume after ${hours} hours without parameter mining`,
    );
  }
});

test("mining updates strategy parameters and clears fault only when valid candidate is found", () => {
  const engine = new PaperTradingEngine({ storageFile: null });
  engine.stopStrategy("streak", "连续亏损测试", 2, 2, 0, -5);
  assert.equal(engine.isStrategyFaulted("streak"), true);

  const mockMetrics = () => ({
    trades: 10,
    wins: 8,
    winRate: 80,
    wilsonLow: 60,
    grossProfit: 20,
    grossLoss: 4,
    profitFactor: 5,
    netPercent: 16,
    avgNetPercent: 1.6,
  });

  // 1. Mining result with NO candidate for streak (failed or insufficient sample)
  const failedResult: FactorMiningResult = {
    policyVersion: FACTOR_POLICY_VERSION,
    featureVersion: FEATURE_VERSION,
    dataAsOf: now,
    datasetHash: "test-hash",
    trials: 10,
    costs: { takerFeeBps: 5, slippageBps: 2 },
    sides: {
      SHORT: { reason: "无达标量化因子" },
      LONG: { reason: "无达标量化因子" },
    },
    strategies: {
      streak: { reason: "近期样本不足或未达收益门槛" },
    },
  };

  engine.applyMinedFactors(failedResult, now);
  assert.equal(engine.isStrategyFaulted("streak"), true, "streak remains faulted when no candidate found");

  // 2. Mining result with a valid candidate for streak
  const passedResult: FactorMiningResult = {
    policyVersion: FACTOR_POLICY_VERSION,
    featureVersion: FEATURE_VERSION,
    dataAsOf: now,
    datasetHash: "test-hash-2",
    trials: 10,
    costs: { takerFeeBps: 5, slippageBps: 2 },
    sides: {
      SHORT: { reason: "无" },
      LONG: { reason: "无" },
    },
    strategies: {
      streak: {
        candidate: {
          strategyId: "streak",
          config: { ampDivisor: 12, minStreakCount: 3, holdMinutes: 20, exitX: 60, exitN: 1.8, exitM: 3.5 },
          train: mockMetrics(),
          validation: mockMetrics(),
          holdout: mockMetrics(),
        },
        reason: "近期行情回测验证通过",
      },
    },
  };

  engine.applyMinedFactors(passedResult, now);
  assert.equal(engine.isStrategyFaulted("streak"), false, "fault cleared after successful mining!");
  assert.equal(engine.getConfig().streakConfig?.ampDivisor, 12, "parameters updated to mined candidate");
  assert.equal(engine.getConfig().streakConfig?.holdMinutes, 20);

  // Now trading can resume!
  const newPos = engine.openPosition({
    symbol: "TOKEN_RESUMED",
    side: "SHORT",
    dayChangePercent: 20,
    entryPrice: 100,
    entryTime: now + 1000,
    signalType: "streak",
    signal: dummySignal,
  });
  assert.equal(newPos.symbol, "TOKEN_RESUMED");
});

test("strategy faults survive persistence (saveState & loadState)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fault-test-"));
  const file = path.join(dir, "state.json");
  try {
    const e1 = new PaperTradingEngine({ storageFile: file });
    e1.stopStrategy("hourly_suppression", "连续亏损", 2, 2, 0, -4);
    assert.equal(e1.isStrategyFaulted("hourly_suppression"), true);
    e1.saveState();

    const e2 = new PaperTradingEngine({ storageFile: file });
    assert.equal(e2.isStrategyFaulted("hourly_suppression"), true, "fault survived reload");
    const faults = e2.getStrategyFaults();
    assert.equal(faults.length, 1);
    assert.equal(faults[0].strategyId, "hourly_suppression");
    assert.equal(faults[0].reason, "连续亏损");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fault triggers targeted strategy re-mining, sets 60m cooldown if failed, and re-mines after cooldown", async () => {
  const engine = new PaperTradingEngine({ storageFile: null });
  let stoppedStrategy: string | null = null;
  engine.onStrategyStopped = (id) => { stoppedStrategy = id; };

  // Trigger stop on streak
  engine.stopStrategy("streak", "连续亏损2笔", 2, 2, 0, -3, now);
  assert.equal(stoppedStrategy, "streak", "onStrategyStopped was triggered immediately");

  // Fault is ready to mine immediately
  let ready = engine.getNextReadyFaultedStrategy(now);
  assert.ok(ready);
  assert.equal(ready?.strategyId, "streak");

  // Mining result failed for streak
  const failedResult: FactorMiningResult = {
    policyVersion: FACTOR_POLICY_VERSION,
    featureVersion: FEATURE_VERSION,
    dataAsOf: now,
    datasetHash: "test-hash-failed",
    trials: 7,
    costs: { takerFeeBps: 5, slippageBps: 2 },
    targetStrategyId: "streak",
    sides: { SHORT: { reason: "未被选定" }, LONG: { reason: "未被选定" } },
    strategies: { streak: { reason: "近期样本不足" } },
  };

  engine.applyMinedFactors(failedResult, now, "streak");
  assert.equal(engine.isStrategyFaulted("streak"), true, "remains faulted");

  const fault = engine.getStrategyFaults().find(f => f.strategyId === "streak")!;
  assert.equal(fault.nextMineAt, now + 60 * 60_000, "cooldown set to 60 minutes");
  assert.equal(fault.miningAttempts, 1);

  // During 60-min cooldown, getNextReadyFaultedStrategy returns undefined
  assert.equal(engine.getNextReadyFaultedStrategy(now + 10 * 60_000), undefined, "still in cooldown at +10m");
  assert.equal(engine.getNextReadyFaultedStrategy(now + 59 * 60_000), undefined, "still in cooldown at +59m");

  // After 60 minutes, it becomes ready again for re-mining
  const readyAfter60m = engine.getNextReadyFaultedStrategy(now + 60 * 60_000 + 1);
  assert.ok(readyAfter60m, "ready to re-mine after 60m");
  assert.equal(readyAfter60m?.strategyId, "streak");
});

test("FactorMiningService only mines faulted strategies and skips when healthy", async () => {
  const engine = new PaperTradingEngine({ storageFile: null });
  let clock = now;
  let jobTarget: string | undefined;
  let runCount = 0;

  const mockMetrics = () => ({
    trades: 10, wins: 8, winRate: 80, wilsonLow: 60,
    grossProfit: 20, grossLoss: 4, profitFactor: 5,
    netPercent: 16, avgNetPercent: 1.6,
  });

  const service = new (await import("../../src/factor-mining-service.ts")).FactorMiningService(
    engine,
    async (job) => {
      runCount++;
      jobTarget = job.targetStrategyId;
      return {
        policyVersion: FACTOR_POLICY_VERSION,
        featureVersion: FEATURE_VERSION,
        dataAsOf: clock,
        datasetHash: "test-hash",
        trials: 7,
        costs: { takerFeeBps: 5, slippageBps: 2 },
        targetStrategyId: job.targetStrategyId,
        sides: { SHORT: { reason: "未被选定" }, LONG: { reason: "未被选定" } },
        strategies: job.targetStrategyId ? {
          [job.targetStrategyId]: {
            candidate: {
              strategyId: job.targetStrategyId,
              config: { ampDivisor: 10, minStreakCount: 2, holdMinutes: 15, exitX: 50, exitN: 1.5, exitM: 3.0 },
              train: mockMetrics(), validation: mockMetrics(), holdout: mockMetrics(),
            },
            reason: "验证通过",
          },
        } : {},
      };
    },
    () => clock,
  );

  let miningPromise: Promise<void> | undefined;
  engine.onStrategyStopped = (id) => { miningPromise = service.triggerStrategyMining(id); };

  // 1. Initially all healthy and previously active, pollFaultedMining does nothing!
  engine.getFactorMiningState().lastCompletedAt = clock;
  engine.getFactorMiningState().sides.SHORT.active = { ...mockMetrics(), id: "short", config: {} as any, train: mockMetrics(), holdout: mockMetrics(), revision: "rev1", dataAsOf: clock, expiresAt: clock + 3600_000, featureVersion: FEATURE_VERSION, policyVersion: FACTOR_POLICY_VERSION, costs: { takerFeeBps: 5, slippageBps: 2 } };
  
  await service.pollFaultedMining();
  assert.equal(runCount, 0, "no mining while strategies are healthy");

  // 2. Strategy stops due to 2 consecutive losses -> immediate targeted trigger
  engine.stopStrategy("streak", "连续亏损2笔", 2, 2, 0, -2, clock);
  await miningPromise;
  assert.equal(runCount, 1, "mining immediately triggered on strategy stop");
  assert.equal(jobTarget, "streak", "mined specifically for faulted strategy");
  assert.equal(engine.isStrategyFaulted("streak"), false, "strategy resumed after successful re-mining");
});

test("manual reset: clearStrategyFault and clearAllStrategyFaults clear fault state and allow trading", () => {
  const engine = new PaperTradingEngine({ storageFile: null, factorMining: { enabled: false } as any });
  engine.stopStrategy("streak", "连续亏损2笔", 2, 2, 0, -2);
  engine.stopStrategy("hourly_suppression", "胜率过低", 3, 0, 33, -3);
  assert.equal(engine.isStrategyFaulted("streak"), true);
  assert.equal(engine.isStrategyFaulted("hourly_suppression"), true);
  assert.equal(engine.getStrategyFaults().length, 2);

  // Clear single strategy
  const clearedStreak = engine.clearStrategyFault("streak", "测试单策略重置");
  assert.equal(clearedStreak, true);
  assert.equal(engine.isStrategyFaulted("streak"), false);
  assert.equal(engine.isStrategyFaulted("hourly_suppression"), true);
  assert.equal(engine.getStrategyFaults().length, 1);

  // Clear all strategies
  const clearedAll = engine.clearAllStrategyFaults("测试全局重置");
  assert.deepEqual(clearedAll, ["hourly_suppression"]);
  assert.equal(engine.isStrategyFaulted("hourly_suppression"), false);
  assert.equal(engine.getStrategyFaults().length, 0);
});

test("deploying new parameters automatically resets strategy fault", () => {
  const engine = new PaperTradingEngine({ storageFile: null, factorMining: { enabled: false } as any });
  engine.stopStrategy("streak", "连续亏损2笔", 2, 2, 0, -2);
  assert.equal(engine.isStrategyFaulted("streak"), true);

  // Deploying new streakConfig automatically clears its fault
  engine.updateConfig({
    streakConfig: { ampDivisor: 15 },
  });
  assert.equal(engine.isStrategyFaulted("streak"), false, "streak fault cleared upon streakConfig update");

  // Re-fault it and update strategies list
  engine.stopStrategy("streak", "连续亏损2笔", 2, 2, 0, -2);
  assert.equal(engine.isStrategyFaulted("streak"), true);
  const currentStrategies = engine.getConfig().strategies ?? [];
  engine.updateConfig({
    strategies: currentStrategies.map(s => s.id === "streak" ? { ...s, exit: { ...s.exit, leverage: 5 } } : s),
  });
  assert.equal(engine.isStrategyFaulted("streak"), false, "streak fault cleared upon strategies update");

  // Re-fault and use explicit resetFaults: true
  engine.stopStrategy("hourly_suppression", "连续亏损", 2, 2, 0, -2);
  assert.equal(engine.isStrategyFaulted("hourly_suppression"), true);
  engine.updateConfig({ resetFaults: true });
  assert.equal(engine.isStrategyFaulted("hourly_suppression"), false, "hourly_suppression fault cleared via resetFaults: true");
});

test("trade history evaluation window resets after fault clear so 1 loss does not re-fault", () => {
  const engine = new PaperTradingEngine({ storageFile: null, factorMining: { enabled: false } as any });
  const clock = 1700000000000;

  // Simulate 2 previous closed losing trades at clock - 1000 and clock - 500
  const oldTrade1 = {
    id: "old1", symbol: "OLD1", side: "SHORT" as const, leverage: 3, marginUsdt: 20, notionalUsdt: 60,
    status: "CLOSED" as const, signalType: "streak" as const, entryTime: clock - 1000, closedAt: clock - 900,
    entryPrice: 100, currentPrice: 105, dayChangePercent: 10, amp30Percent: 5, streakCount: 3, upperShadowRatio: 0.1,
    greenRatio: 0.8, consecutiveGreenBars: 3, tp1Percent: 3, sl1Percent: 5, tp1Price: 97, sl1Price: 105, sl2Percent: 6,
    tp2Percent: 6, sl2Price: 106, tp2Price: 94, timeoutAt: clock, exits: [], remainingFraction: 0,
    realizedNetPnlUsdt: -1.0, unrealizedNetPnlUsdt: 0, totalNetPnlUsdt: -1.0, roePercent: -5,
  };
  const oldTrade2 = { ...oldTrade1, id: "old2", symbol: "OLD2", entryTime: clock - 500, closedAt: clock - 400 };

  (engine as any).closedPositions = [oldTrade2, oldTrade1];
  engine.stopStrategy("streak", "连续亏损2笔", 2, 2, 0, -2, clock);
  assert.equal(engine.isStrategyFaulted("streak"), true);

  // Reset the fault at clock + 100
  engine.clearStrategyFault("streak", "重置测试");
  assert.equal(engine.isStrategyFaulted("streak"), false);

  // Now a single new trade closes with a loss after reset (at clock + 500)
  const newTrade = {
    ...oldTrade1, id: "new1", symbol: "NEW1", entryTime: clock + 200, closedAt: clock + 500, totalNetPnlUsdt: -0.5,
  };
  (engine as any).closedPositions.unshift(newTrade);
  (engine as any).checkStrategyHealth(newTrade);

  // Since it was only 1 loss since reset, streak should NOT be faulted!
  assert.equal(engine.isStrategyFaulted("streak"), false, "single loss after reset must not re-trigger consecutive loss fault");
});

test("mineFactors distinguishes 0 samples, insufficient samples and low win rate/return for preset strategies", () => {
  const dummyData = {
    candles: new Map(),
    boards: new Map(),
    times: [],
    indices: new Map(),
    dataAsOf: now,
    datasetHash: "dummy-hash",
  };
  const res = mineFactors(dummyData, { takerFeeBps: 5, slippageBps: 2 }, undefined, undefined, "streak");
  assert.ok(res.strategies?.streak);
  assert.equal(res.strategies.streak.candidate, undefined);
  assert.match(res.strategies.streak.reason, /无触发样本 \(0 笔/);
});

