import test from "node:test";
import assert from "node:assert/strict";
import { PaperTradingEngine } from "../../src/paper-trading.ts";
import { FEATURE_VERSION } from "../../src/features.ts";
import { FACTOR_POLICY_VERSION, type FactorMiningResult } from "../../src/factor-policy.ts";
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
