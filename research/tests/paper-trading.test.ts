import test from "node:test";
import assert from "node:assert/strict";
import {
  checkPaperSignal,
  PaperTradingEngine,
  PAPER_DEFAULT_CONFIG,
} from "../../src/paper-trading.ts";
import type { Candle } from "../../src/macd.ts";

function generateTestCandles(count: number, trend: "up" | "flat" | "down" = "up"): Candle[] {
  const candles: Candle[] = [];
  let basePrice = 100;
  const now = Date.now();

  for (let i = 0; i < count; i++) {
    const time = now - (count - i) * 60_000;
    let open = basePrice;
    let close = basePrice;
    let high = basePrice;
    let low = basePrice;

    if (trend === "up") {
      open = basePrice;
      close = basePrice + 1.0; // Up candle
      high = close + 0.1;      // Upper shadow = 0.1 < 0.3 * 1.0 = 0.3
      low = open + 0.2;        // Low is strictly above previous close and above MA
      basePrice = close;
    } else {
      open = basePrice;
      close = basePrice - 1.0;
      high = open + 0.1;
      low = close - 0.1;
      basePrice = close;
    }

    candles.push({ time, open, high, low, close, volume: 1000 });
  }

  return candles;
}

test("checkPaperSignal: correctly detects signals matching 30m amplitude and all criteria", () => {
  // Generate 50 steadily rising candles
  const candles = generateTestCandles(50, "up");
  // Set dayChangePercent = 20%
  // 30m amplitude = (high30 - low30) / low30 = (150.1 - 120.2) / 120.2 = ~24.8%
  // required amp = 20 / 12 = 1.67%, so amp30Percent >> 1.67%
  const signal = checkPaperSignal("TESTUSDT", 20, candles, PAPER_DEFAULT_CONFIG);

  assert.ok(signal != null, "Signal should be detected on rising candles without MA support");
  assert.ok(signal.streakCount >= 2, "Streak count must be >= 2");
  assert.ok(signal.amp30Percent >= 20 / 12, "30m amplitude must exceed 24h / 12");
  assert.ok(signal.upperShadowRatio >= 0.005 && signal.upperShadowRatio < 0.3, "Upper shadow must be between 0.5% and 30%");
  assert.ok(signal.greenRatio > 0.70, "Green ratio must be > 70%");
  assert.ok(signal.consecutiveGreenBars >= 7, "Consecutive green bars must be >= 7");
});

test("checkPaperSignal: rejects flat top candle when upper shadow < 0.5% of body", () => {
  const candles = generateTestCandles(50, "up");
  const closedIdx = candles.length - 2;
  candles[closedIdx].high = candles[closedIdx].close; // Flat top (0 upper shadow)

  const signal = checkPaperSignal("TESTUSDT", 20, candles, PAPER_DEFAULT_CONFIG);
  assert.equal(signal, null, "Should reject flat top candle without upper shadow");
});

test("checkPaperSignal: rejects when 30m amplitude is below 24h / 12", () => {
  // Create flat candles with minimal amplitude
  const candles: Candle[] = [];
  const now = Date.now();
  let basePrice = 100;
  for (let i = 0; i < 50; i++) {
    const time = now - (50 - i) * 60_000;
    const open = basePrice;
    const close = basePrice + 0.01;
    const high = close + 0.002;
    const low = open + 0.005;
    basePrice = close;
    candles.push({ time, open, high, low, close, volume: 1000 });
  }

  // 24h gain = 60%, required amplitude = 60 / 12 = 5%
  // But our candles only moved 0.01 * 30 = 0.3%, so amp < 5%
  const signal = checkPaperSignal("TESTUSDT", 60, candles, PAPER_DEFAULT_CONFIG);
  assert.equal(signal, null, "Should reject when 30m amplitude is insufficient");
});

test("checkPaperSignal: rejects when streak is not up or count < 2", () => {
  const candles = generateTestCandles(50, "down");
  const signal = checkPaperSignal("TESTUSDT", 20, candles, PAPER_DEFAULT_CONFIG);
  assert.equal(signal, null, "Should reject downward streak");
});

test("checkPaperSignal: rejects when upper shadow >= 30% of body", () => {
  const candles = generateTestCandles(50, "up");
  const closedIdx = candles.length - 2;
  const body = candles[closedIdx].close - candles[closedIdx].open;
  candles[closedIdx].high = candles[closedIdx].close + body * 0.5; // upper shadow = 50% of body

  const signal = checkPaperSignal("TESTUSDT", 20, candles, PAPER_DEFAULT_CONFIG);
  assert.equal(signal, null, "Should reject when upper shadow is >= 30% of body");
});

test("PaperTradingEngine: 10x leverage, 10u margin, two-stage dynamic exit execution (TP1 -> TP2)", () => {
  const engine = new PaperTradingEngine({
    initialBalanceUsdt: 100,
    leverage: 10,
    marginUsdt: 10,
    exitX: 60,
    exitN: 1.5,
    exitM: 3.0,
    storageFile: null,
  });

  const now = 1700000000000;
  const entryPrice = 100.0;
  const dayChangePercent = 30.0; // 30%

  // Expected levels:
  // tp1Percent = 30 / 60 = 0.5% -> tp1Price = 100 * (1 - 0.005) = 99.5
  // sl1Percent = 30 / 60 = 0.5% -> sl1Price = 100 * (1 + 0.005) = 100.5
  // sl2Percent = 30 * 1.5 / 60 = 0.75% -> sl2Price = 100 * (1 + 0.0075) = 100.75
  // tp2Percent = 30 * 3.0 / 60 = 1.5% -> tp2Price = 100 * (1 - 0.015) = 98.5

  const pos = engine.openPosition({
    symbol: "ALPHAUSDT",
    dayChangePercent,
    rank: 1,
    entryPrice,
    entryTime: now,
    signal: {
      candle: { time: now - 60000, open: 98, high: 100.05, low: 97.9, close: 100, volume: 100 },
      streakCount: 3,
      amp30Percent: 8.5,
      upperShadowRatio: 0.1,
      greenRatio: 0.8,
      consecutiveGreenBars: 8,
    },
  });

  assert.equal(pos.status, "OPEN");
  assert.equal(pos.leverage, 10);
  assert.equal(pos.marginUsdt, 10);
  assert.equal(pos.notionalUsdt, 100);
  assert.equal(pos.remainingFraction, 1.0);
  assert.ok(Math.abs(pos.tp1Price - 99.5) < 1e-4);
  assert.ok(Math.abs(pos.sl1Price - 100.5) < 1e-4);
  assert.ok(Math.abs(pos.sl2Price - 100.75) < 1e-4);
  assert.ok(Math.abs(pos.tp2Price - 98.5) < 1e-4);
  assert.equal(pos.timeoutAt, now + 15 * 60 * 1000);

  // Initial account state
  const acct1 = engine.getAccount();
  assert.equal(acct1.usedMarginUsdt, 10);
  assert.equal(acct1.availableMarginUsdt, 90);

  // Tick 1: Price drops to 99.5 -> triggers Stage 1 Target (TP1)
  engine.onTick({
    symbol: "ALPHAUSDT",
    price: 99.5,
    qty: 10,
    time: now + 60_000,
  });

  const partialPos = engine.getPosition("ALPHAUSDT")!;
  assert.ok(partialPos != null, "Position should still be active");
  assert.equal(partialPos.status, "PARTIAL");
  assert.equal(partialPos.remainingFraction, 0.5);
  assert.equal(partialPos.exits.length, 1);
  assert.equal(partialPos.exits[0].reason, "target");
  assert.ok(partialPos.realizedNetPnlUsdt > 0, "Stage 1 net PnL should be positive");

  // Tick 2: Price drops to 98.5 -> triggers Stage 2 Target (TP2)
  engine.onTick({
    symbol: "ALPHAUSDT",
    price: 98.5,
    qty: 10,
    time: now + 120_000,
  });

  assert.equal(engine.hasActivePosition("ALPHAUSDT"), false, "Position should be closed");
  const summary = engine.getSummary();
  assert.equal(summary.totalTrades, 1);
  assert.equal(summary.winningTrades, 1);
  assert.equal(summary.winRate, 100);
  assert.ok(summary.totalNetPnlUsdt > 0, "Total net PnL should be positive");

  // Account balance updated
  const acct2 = summary.account;
  assert.equal(acct2.usedMarginUsdt, 0);
  assert.ok(acct2.balanceUsdt > 100, "Account balance should increase from realized profit");
  assert.ok(acct2.accountRoiPercent > 0, "Account ROI should be positive");
});

test("PaperTradingEngine: two-stage recovery (SL1 triggered -> TP2 triggered)", () => {
  const engine = new PaperTradingEngine({
    initialBalanceUsdt: 100,
    leverage: 10,
    marginUsdt: 10,
    exitX: 60,
    exitN: 1.5,
    exitM: 3.0,
    storageFile: null,
  });

  const now = 1700000000000;
  const entryPrice = 100.0;
  const dayChangePercent = 30.0;

  engine.openPosition({
    symbol: "BETAUSDT",
    dayChangePercent,
    rank: 2,
    entryPrice,
    entryTime: now,
    signal: {
      candle: { time: now - 60000, open: 98, high: 100.05, low: 97.9, close: 100, volume: 100 },
      streakCount: 2,
      amp30Percent: 7.2,
      upperShadowRatio: 0.1,
      greenRatio: 0.75,
      consecutiveGreenBars: 7,
    },
  });

  // Tick 1: Price rises to 100.5 -> triggers Stage 1 Stop (SL1)
  engine.onTick({
    symbol: "BETAUSDT",
    price: 100.5,
    qty: 10,
    time: now + 60_000,
  });

  const pos = engine.getPosition("BETAUSDT")!;
  assert.equal(pos.status, "PARTIAL");
  assert.equal(pos.exits[0].reason, "stop");
  assert.ok(pos.realizedNetPnlUsdt < 0, "Stage 1 PnL should be negative");

  // Tick 2: Price reverses and plunges to 98.5 -> triggers Stage 2 Target (TP2)
  engine.onTick({
    symbol: "BETAUSDT",
    price: 98.5,
    qty: 10,
    time: now + 180_000,
  });

  assert.equal(engine.hasActivePosition("BETAUSDT"), false);
  const state = engine.getState();
  const trade = state.closedPositions[0];
  assert.equal(trade.exits.length, 2);
  assert.equal(trade.exits[0].reason, "stop");
  assert.equal(trade.exits[1].reason, "target");
  assert.ok(trade.totalNetPnlUsdt > 0, "Whole-position trade should recover into profit");
  assert.ok(trade.roePercent > 0, "ROE should be positive on recovery");
});

test("PaperTradingEngine: 15-minute timeout closes remaining position at market", () => {
  const engine = new PaperTradingEngine({
    initialBalanceUsdt: 100,
    leverage: 10,
    marginUsdt: 10,
    holdMinutes: 15,
    storageFile: null,
  });

  const now = 1700000000000;
  const entryPrice = 100.0;

  engine.openPosition({
    symbol: "GAMMAUSDT",
    dayChangePercent: 20,
    entryPrice,
    entryTime: now,
    signal: {
      candle: { time: now - 60000, open: 98, high: 100.05, low: 97.9, close: 100, volume: 100 },
      streakCount: 2,
      amp30Percent: 6.0,
      upperShadowRatio: 0.1,
      greenRatio: 0.75,
      consecutiveGreenBars: 7,
    },
  });

  // Price fluctuates without hitting stops/targets
  engine.onTick({
    symbol: "GAMMAUSDT",
    price: 99.8,
    qty: 10,
    time: now + 5 * 60_000,
  });
  assert.equal(engine.getPosition("GAMMAUSDT")?.status, "OPEN");

  // 15 minutes elapse
  engine.onTick({
    symbol: "GAMMAUSDT",
    price: 99.7,
    qty: 10,
    time: now + 15 * 60_000,
  });

  assert.equal(engine.hasActivePosition("GAMMAUSDT"), false, "Position should be closed on timeout");
  const closed = engine.getState().closedPositions[0];
  assert.equal(closed.finalReason, "timeout");
  assert.equal(closed.exits.length, 2);
  assert.equal(closed.exits[0].reason, "timeout");
  assert.equal(closed.exits[1].reason, "timeout");
});

test("PaperTradingEngine: pending limit order placement (N=100) and fill on upward spike", () => {
  const engine = new PaperTradingEngine({
    initialBalanceUsdt: 100,
    leverage: 10,
    marginUsdt: 10,
    limitDivisor: 100, // N = 100
    limitExpireMinutes: 3,
    storageFile: null,
  });

  const now = 1700000000000;
  const basePrice = 100.0;
  const dayChangePercent = 40.0; // 40% -> offset = 40 / 100 = 0.40%
  // limitPrice = 100 * (1 + 0.004) = 100.4

  const order = engine.createPendingOrder({
    symbol: "LIMITUSDT",
    dayChangePercent,
    basePrice,
    now,
    signal: {
      candle: { time: now - 60000, open: 98, high: 100.05, low: 97.9, close: 100, volume: 100 },
      streakCount: 3,
      amp30Percent: 8.0,
      upperShadowRatio: 0.1,
      greenRatio: 0.8,
      consecutiveGreenBars: 8,
    },
  });

  assert.equal(order.limitPrice, 100.4);
  assert.equal(order.limitOffsetPercent, 0.4);
  assert.equal(engine.hasPendingOrder("LIMITUSDT"), true);
  assert.equal(engine.hasActivePosition("LIMITUSDT"), false);

  // Tick 1: price is 100.2, does not hit limit price (100.4)
  engine.onTick({
    symbol: "LIMITUSDT",
    price: 100.2,
    qty: 10,
    time: now + 10_000,
  });
  assert.equal(engine.hasPendingOrder("LIMITUSDT"), true);
  assert.equal(engine.hasActivePosition("LIMITUSDT"), false);

  // Tick 2: upward spike hits 100.4 -> fills as active short position
  engine.onTick({
    symbol: "LIMITUSDT",
    price: 100.45,
    qty: 10,
    time: now + 20_000,
  });
  assert.equal(engine.hasPendingOrder("LIMITUSDT"), false, "Pending order should be removed after fill");
  assert.equal(engine.hasActivePosition("LIMITUSDT"), true, "Should have active position after fill");

  const pos = engine.getPosition("LIMITUSDT")!;
  assert.equal(pos.entryPrice, 100.4, "Entry price must be the limit order price");
  assert.equal(pos.entryTime, now + 20_000, "Entry time must be fill tick time");
  // TP1 based on 100.4: tp1Percent = 40 / 50 = 0.8% -> 100.4 * (1 - 0.008) = 99.5968
  // SL1 based on 100.4: sl1Percent = 40 / 50 = 0.8% -> 100.4 * (1 + 0.008) = 101.2032
  assert.ok(Math.abs(pos.tp1Price - 100.4 * (1 - 0.008)) < 1e-4);
  assert.ok(Math.abs(pos.sl1Price - 100.4 * (1 + 0.008)) < 1e-4);
});

test("PaperTradingEngine: pending limit order expires after limitExpireMinutes", () => {
  const engine = new PaperTradingEngine({
    initialBalanceUsdt: 100,
    limitDivisor: 100,
    limitExpireMinutes: 3,
    storageFile: null,
  });

  const now = 1700000000000;
  engine.createPendingOrder({
    symbol: "EXPIREUSDT",
    dayChangePercent: 30.0,
    basePrice: 50.0,
    now,
    signal: {
      candle: { time: now - 60000, open: 49, high: 50.02, low: 48.9, close: 50, volume: 100 },
      streakCount: 2,
      amp30Percent: 5.0,
      upperShadowRatio: 0.1,
      greenRatio: 0.75,
      consecutiveGreenBars: 7,
    },
  });

  assert.equal(engine.hasPendingOrder("EXPIREUSDT"), true);

  // Advance time past 3 minutes
  engine.onTick({
    symbol: "EXPIREUSDT",
    price: 50.05,
    qty: 1,
    time: now + 3 * 60_000 + 1000,
  });

  assert.equal(engine.hasPendingOrder("EXPIREUSDT"), false, "Order should expire and be canceled");
  assert.equal(engine.hasActivePosition("EXPIREUSDT"), false);
});

test("PaperTradingEngine: reset restores account balance and clears all orders/positions", () => {
  const engine = new PaperTradingEngine({
    initialBalanceUsdt: 100,
    storageFile: null,
  });

  const now = 1700000000000;
  // 1. Create a pending order
  engine.createPendingOrder({
    symbol: "PENDING1",
    dayChangePercent: 25,
    basePrice: 10,
    now,
    signal: {
      candle: { time: now - 60000, open: 9.8, high: 10.01, low: 9.7, close: 10, volume: 100 },
      streakCount: 2,
      amp30Percent: 5.0,
      upperShadowRatio: 0.1,
      greenRatio: 0.8,
      consecutiveGreenBars: 7,
    },
  });

  // 2. Open an active position
  engine.openPosition({
    symbol: "ACTIVE1",
    dayChangePercent: 30,
    entryPrice: 20,
    entryTime: now,
    signal: {
      candle: { time: now - 60000, open: 19.5, high: 20.02, low: 19.4, close: 20, volume: 100 },
      streakCount: 2,
      amp30Percent: 6.0,
      upperShadowRatio: 0.1,
      greenRatio: 0.8,
      consecutiveGreenBars: 7,
    },
  });

  assert.equal(engine.getPendingOrders().length, 1);
  assert.equal(engine.hasActivePosition("ACTIVE1"), true);

  // 3. Reset
  engine.reset();

  assert.equal(engine.getPendingOrders().length, 0, "Pending orders should be empty after reset");
  assert.equal(engine.hasActivePosition("ACTIVE1"), false, "Active positions should be empty after reset");
  assert.equal(engine.getState().closedPositions.length, 0, "Closed positions should be empty after reset");
  assert.equal(engine.getAccount().balanceUsdt, 100, "Account balance should be restored to initial 100 USDT");
  assert.equal(engine.getAccount().totalPnlUsdt, 0);
  assert.equal(engine.getSummary().totalTrades, 0);
});

test("PaperTradingEngine: records signalType and signalLabel for 连阳悬空, 首次跌10%, and 跌到20%+", () => {
  const engine = new PaperTradingEngine({
    initialBalanceUsdt: 100,
    leverage: 10,
    marginUsdt: 10,
    storageFile: null,
  });

  const now = 1700000000000;

  // 1. Open streak signal position
  const streakPos = engine.openPosition({
    symbol: "STRKUSDT",
    dayChangePercent: 25.0,
    rank: 2,
    entryPrice: 50.0,
    entryTime: now,
    signalType: "streak",
    signalLabel: "连阳悬空",
    exitParams: { holdMinutes: 15, exitX: 50, exitN: 1.5, exitM: 3.0 },
    signal: {
      candle: { time: now - 60000, open: 49, high: 50.02, low: 48.9, close: 50, volume: 100 },
      streakCount: 3,
      amp30Percent: 5.0,
      upperShadowRatio: 0.1,
      greenRatio: 0.8,
      consecutiveGreenBars: 8,
    },
  });

  assert.equal(streakPos.signalType, "streak");
  assert.equal(streakPos.signalLabel, "连阳悬空");
  assert.equal(streakPos.exitParams?.holdMinutes, 15);
  assert.equal(streakPos.exitParams?.exitX, 50);

  // 2. Create rebound pending order (Signal 2: 首次跌10%)
  const reboundOrder = engine.createPendingOrder({
    symbol: "REBUSDT",
    dayChangePercent: 35.0,
    rank: 1,
    basePrice: 100.0,
    signalType: "rebound",
    signalLabel: "首次跌10%",
    exitParams: { holdMinutes: 30, exitX: 35, exitN: 2.0, exitM: 1.5 },
    now,
    signal: {
      candle: { time: now - 60000, open: 101, high: 101.5, low: 99.5, close: 100, volume: 100 },
      streakCount: 1,
      amp30Percent: 12.0,
      upperShadowRatio: 0.35,
      greenRatio: 0.7,
      consecutiveGreenBars: 3,
    },
  });

  assert.equal(reboundOrder.signalType, "rebound");
  assert.equal(reboundOrder.signalLabel, "首次跌10%");
  assert.equal(reboundOrder.exitParams?.exitX, 35);

  // 3. Fill the rebound pending order
  engine.onTick({
    symbol: "REBUSDT",
    price: reboundOrder.limitPrice,
    qty: 1,
    time: now + 30000,
  });

  const reboundPos = engine.getPosition("REBUSDT")!;
  assert.ok(reboundPos != null);
  assert.equal(reboundPos.signalType, "rebound");
  assert.equal(reboundPos.signalLabel, "首次跌10%");
  assert.equal(reboundPos.exitParams?.exitX, 35);
  assert.equal(reboundPos.exitParams?.exitN, 2.0);
  assert.equal(reboundPos.exitParams?.exitM, 1.5);
  assert.equal(reboundPos.exitParams?.holdMinutes, 30);

  // 4. Create and fill deep_rebound position (Signal 3: 跌到20%+)
  const deepPos = engine.openPosition({
    symbol: "DEEPUSDT",
    dayChangePercent: 18.0,
    rank: 5,
    entryPrice: 80.0,
    entryTime: now + 60000,
    signalType: "deep_rebound",
    exitParams: { holdMinutes: 30, exitX: 35, exitN: 2.0, exitM: 4.0 },
    signal: {
      candle: { time: now, open: 79, high: 80.5, low: 78.5, close: 80, volume: 100 },
      streakCount: 1,
      amp30Percent: 6.0,
      upperShadowRatio: 0.2,
      greenRatio: 0.75,
      consecutiveGreenBars: 4,
    },
  });

  assert.equal(deepPos.signalType, "deep_rebound");
  assert.equal(deepPos.signalLabel, "跌到20%+"); // Auto-mapped by formatSignalLabel
  assert.equal(deepPos.exitParams?.holdMinutes, 30);
  assert.equal(deepPos.exitParams?.exitM, 4.0);
});

test("PaperTradingEngine: executes extreme stop loss at candle high or spiking tick price when stopAtHigh=true", () => {
  const engine = new PaperTradingEngine({
    initialBalanceUsdt: 100,
    leverage: 10,
    marginUsdt: 10,
    takerFeeBps: 0,
    slippageBps: 0,
    stopAtHigh: true,
    storageFile: null,
  });

  const now = 1700000000000;
  // entry = 100, dayChange = 30%, exitX = 50 -> sl1 = 30/50 = 0.6% -> sl1Price = 100.6
  engine.openPosition({
    symbol: "EXTREMEUSDT",
    dayChangePercent: 30.0,
    entryPrice: 100.0,
    entryTime: now,
    signal: {
      candle: { time: now - 60000, open: 98, high: 100.05, low: 97.9, close: 100, volume: 100 },
      streakCount: 2,
      amp30Percent: 7.2,
      upperShadowRatio: 0.1,
      greenRatio: 0.75,
      consecutiveGreenBars: 7,
    },
  });

  // Tick triggers SL1 with price=100.7 and currentCandleHigh=101.5 (extreme upper wick)
  engine.onTick(
    {
      symbol: "EXTREMEUSDT",
      price: 100.7,
      qty: 1,
      time: now + 30000,
    },
    101.5
  );

  const pos = engine.getPosition("EXTREMEUSDT")!;
  assert.equal(pos.status, "PARTIAL");
  assert.equal(pos.exits[0].reason, "stop");
  // Exit price must be the extreme candle high (101.5), not the standard sl1Price (100.6)
  assert.equal(pos.exits[0].exitPrice, 101.5);
  // Gross loss on 50 USDT notional = 50 * (100 - 101.5) / 100 = -0.75 USDT
  assert.ok(Math.abs(pos.realizedNetPnlUsdt - (-0.75)) < 1e-4);
});
