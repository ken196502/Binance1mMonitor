import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PaperTradingEngine, PAPER_DEFAULT_CONFIG } from "../../src/paper-trading.ts";

test("PaperTradingEngine: differential dual-speed leverage (10x streak vs 3x trend)", () => {
  const engine = new PaperTradingEngine({
    initialBalanceUsdt: 100,
    leverage: 3,
    trendLeverage: 3,
    streakLeverage: 10,
    marginUsdt: 20,
    storageFile: null,
  });

  // Verify leverage resolution
  assert.equal(engine.getLeverageForSignal("streak"), 10);
  assert.equal(engine.getLeverageForSignal("rebound"), 3);
  assert.equal(engine.getLeverageForSignal("deep_rebound"), 3);
  assert.equal(engine.getLeverageForSignal("extreme_dev"), 3);

  const now = Date.now();
  const dummyCandle = { time: now - 60000, open: 100, high: 101, low: 99, close: 100, volume: 100 };
  const dummySignal = {
    candle: dummyCandle,
    streakCount: 3,
    amp30Percent: 8,
    upperShadowRatio: 0.1,
    greenRatio: 0.8,
    consecutiveGreenBars: 8,
  };

  // 1. Open 新高顶背离 (streak) -> expect 10x leverage, 20 USDT margin, 200 USDT notional
  const posStreak = engine.openPosition({
    symbol: "ATHUSDT",
    dayChangePercent: 25,
    rank: 1,
    entryPrice: 100,
    entryTime: now,
    signalType: "streak",
    signal: dummySignal,
  });
  assert.equal(posStreak.leverage, 10);
  assert.equal(posStreak.marginUsdt, 20);
  assert.equal(posStreak.notionalUsdt, 200);

  // 2. Open 首次跌10% (rebound) -> expect 3x leverage, 20 USDT margin, 60 USDT notional
  const posRebound = engine.openPosition({
    symbol: "TRENDUSDT",
    dayChangePercent: 30,
    rank: 1,
    entryPrice: 50,
    entryTime: now + 1000,
    signalType: "rebound",
    signal: dummySignal,
  });
  assert.equal(posRebound.leverage, 3);
  assert.equal(posRebound.marginUsdt, 20);
  assert.equal(posRebound.notionalUsdt, 60);

  // 3. Update configuration dynamically via updateConfig (as done by API)
  const updatedCfg = engine.updateConfig({
    streakLeverage: 8,
    trendLeverage: 2,
    marginUsdt: 25,
  });

  assert.equal(updatedCfg.streakLeverage, 8);
  assert.equal(updatedCfg.trendLeverage, 2);
  assert.equal(updatedCfg.marginUsdt, 25);
  assert.equal(engine.getLeverageForSignal("streak"), 8);
  assert.equal(engine.getLeverageForSignal("rebound"), 2);

  const summary = engine.getSummary();
  assert.equal(summary.config?.streakLeverage, 8);
  assert.equal(summary.config?.trendLeverage, 2);
  assert.equal(summary.config?.marginUsdt, 25);
});

test("PAPER_DEFAULT_CONFIG: has zero dependency on process.env for strategy & trading params", () => {
  assert.equal(PAPER_DEFAULT_CONFIG.leverage, 3);
  assert.equal(PAPER_DEFAULT_CONFIG.trendLeverage, 3);
  assert.equal(PAPER_DEFAULT_CONFIG.streakLeverage, 10);
  assert.equal(PAPER_DEFAULT_CONFIG.marginUsdt, 20);
  assert.equal(PAPER_DEFAULT_CONFIG.initialBalanceUsdt, 100);
  assert.equal(PAPER_DEFAULT_CONFIG.limitDivisor, 0);
  assert.equal(PAPER_DEFAULT_CONFIG.stopAtHigh, true);
});
