import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeMaAlignment,
  analyzeOhlcComparison,
  analyzeMacdStats,
  detectIntervalSignals,
} from "../../src/kline-stats.ts";
import type { ChartBar } from "../../src/types.ts";

function createMockBar(partial: Partial<ChartBar> = {}): ChartBar {
  return {
    time: Date.now(),
    open: 100,
    high: 105,
    low: 95,
    close: 102,
    volume: 1000,
    ma: {
      "5": 101,
      "10": 100,
      "20": 98,
      "30": 95,
      "60": 90,
    },
    dif: 0.5,
    dea: 0.2,
    hist: 0.6,
    ...partial,
  };
}

test("analyzeMaAlignment: detects full bullish stack correctly", () => {
  const bars = [createMockBar()];
  const res = analyzeMaAlignment(bars);
  assert.equal(res.type, "bullish_full");
  assert.equal(res.label, "完全多头排列");
  assert.deepEqual(res.order, [5, 10, 20, 30, 60]);
  assert.equal(res.orderText, "MA5 > MA10 > MA20 > MA30 > MA60");
});

test("analyzeMaAlignment: detects full bearish stack correctly", () => {
  const bars = [
    createMockBar({
      ma: {
        "5": 80,
        "10": 85,
        "20": 90,
        "30": 95,
        "60": 100,
      },
    }),
  ];
  const res = analyzeMaAlignment(bars);
  assert.equal(res.type, "bearish_full");
  assert.equal(res.label, "完全空头排列");
  assert.deepEqual(res.order, [60, 30, 20, 10, 5]);
});

test("analyzeOhlcComparison: accurately identifies support and resistance", () => {
  // Candle tests low at 99, bounces to close at 101. MA10 is at 100.
  // low <= 100 && close > 100 -> MA10 is support!
  const bar = createMockBar({
    open: 100.5,
    high: 103,
    low: 99.5,
    close: 101.5,
    ma: {
      "5": 101,
      "10": 100,
      "20": 98,
      "30": 95,
      "60": 102, // high (103) >= 102 && close (101.5) < 102 -> MA60 is resistance!
    },
  });
  const res = analyzeOhlcComparison([bar]);
  assert.ok(res.supports.includes(10), "MA10 should be a support");
  assert.ok(res.resistances.includes(60), "MA60 should be resistance");
});

test("analyzeMacdStats: calculates green bar ratio and streaks", () => {
  const bars: ChartBar[] = [];
  // Generate 30 bars, 25 positive and last 5 negative
  for (let i = 0; i < 30; i++) {
    const isGreen = i < 25;
    bars.push(
      createMockBar({
        hist: isGreen ? 0.5 : -0.5,
        dif: isGreen ? 1.0 : -0.5,
        dea: 0,
      }),
    );
  }
  const res = analyzeMacdStats(bars);
  assert.equal(res.greenCount30, 25);
  assert.equal(res.greenBarRatio30, 25 / 30);
  assert.equal(res.redStreak, 5);
  assert.equal(res.greenStreak, 0);
});

test("detectIntervalSignals: marks interval rise >= 24h change / ampDivisor", () => {
  const bars: ChartBar[] = [];
  const baseTime = 1700000000000;
  // Day change = +20%
  // 5m surge: from low 100 to high 103 = +3%
  // ratio = 3% / 20% = 0.15 (15% >= 10%, divisor = 10)
  for (let i = 0; i < 10; i++) {
    const price = 100 + i * 0.4;
    bars.push(
      createMockBar({
        time: baseTime + i * 60000,
        open: price,
        close: price + 0.3,
        low: price - 0.1,
        high: price + 0.4,
      }),
    );
  }

  const signals = detectIntervalSignals(bars, 20.0, {
    windowMinutes: 5,
    ampDivisor: 10,
    mode: "surge",
  });

  assert.ok(signals.length > 0, "Should detect at least 1 qualified surge interval");
  const first = signals[0];
  assert.equal(first.type, "surge");
  assert.ok(first.ratioToDayChange >= 0.1);
  assert.equal(first.dayChangePercent, 20.0);
  assert.ok(first.maAlignment != null);
  assert.ok(first.ohlc != null);
  assert.ok(first.macd != null);
});
