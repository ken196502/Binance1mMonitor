import test from "node:test";
import assert from "node:assert/strict";
import { StrategyFeatureMonitor } from "../../src/strategy-features.ts";
import { StrategyEngine } from "../../src/strategy-engine.ts";
import { streakPreset, quantPreset, wBottomPreset } from "../../src/strategy-presets.ts";
import { computeFeatureVector, evaluateFeatureSpec } from "../../src/features.ts";
import { PaperTradingEngine, PAPER_DEFAULT_CONFIG } from "../../src/paper-trading.ts";
import type { Candle } from "../../src/macd.ts";
import type { Ticker24h } from "../../src/binance.ts";

function createCandles(count: number, basePrice = 100, step = 0.1): Candle[] {
  const candles: Candle[] = [];
  const baseTime = 1700000000000;
  let price = basePrice;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price + step;
    const high = Math.max(open, close) + 0.05;
    const low = Math.min(open, close) - 0.05;
    price = close;
    candles.push({
      time: baseTime + i * 60_000,
      open,
      high,
      low,
      close,
      volume: 1000,
    });
  }
  return candles;
}

test("StrategyFeatureMonitor: maxBullishGain and hasBigBullishCandle detection", () => {
  // 150 normal candles with small 0.1% gains
  const candles = createCandles(150, 100, 0.1);
  const ticker: Ticker24h = { symbol: "TESTUSDT", priceChangePercent: 15, lastPrice: candles[148].close, quoteVolume: 1000000 };

  const monitorNoBigBull = new StrategyFeatureMonitor(candles, ticker, 1, 148);
  assert.equal(monitorNoBigBull.hasBigBullishCandle(120, 5), false);
  assert.equal(monitorNoBigBull.read("hasBigBull120"), false);
  assert.ok((monitorNoBigBull.read("maxBullishGain120") as number) < 5);

  // Inject a 1-minute 5.5% big bullish candle 30 minutes ago (index 118)
  const candlesWithBigBull = createCandles(150, 100, 0.1);
  const targetBarIdx = 148;
  const bigBullIdx = targetBarIdx - 30; // 30 mins ago
  candlesWithBigBull[bigBullIdx].open = 100;
  candlesWithBigBull[bigBullIdx].close = 105.5; // +5.5% 阳线
  candlesWithBigBull[bigBullIdx].high = 106.0;
  candlesWithBigBull[bigBullIdx].low = 99.8;

  const monitorWithBigBull = new StrategyFeatureMonitor(candlesWithBigBull, ticker, 1, targetBarIdx);
  assert.equal(monitorWithBigBull.hasBigBullishCandle(120, 5), true);
  assert.equal(monitorWithBigBull.read("hasBigBull120"), true);
  assert.ok((monitorWithBigBull.read("maxBullishGain120") as number) >= 5.5 - 1e-6);

  // A 4.9% candle is below the 5% threshold
  const candlesWith49 = createCandles(150, 100, 0.1);
  candlesWith49[bigBullIdx].open = 100;
  candlesWith49[bigBullIdx].close = 104.9; // +4.9%
  candlesWith49[bigBullIdx].high = 105.0;
  candlesWith49[bigBullIdx].low = 99.9;
  const monitor49 = new StrategyFeatureMonitor(candlesWith49, ticker, 1, targetBarIdx);
  assert.equal(monitor49.hasBigBullishCandle(120, 5), false);

  // A bearish candle with a 6% drop or 6% range is NOT a 阳线
  const candlesBear = createCandles(150, 100, 0.1);
  candlesBear[bigBullIdx].open = 106;
  candlesBear[bigBullIdx].close = 100; // -5.66% 阴线
  candlesBear[bigBullIdx].high = 107;
  candlesBear[bigBullIdx].low = 99;
  const monitorBear = new StrategyFeatureMonitor(candlesBear, ticker, 1, targetBarIdx);
  assert.equal(monitorBear.hasBigBullishCandle(120, 5), false);

  // A pinbar with long upper shadow but small body (open 100, high 107, close 101.5) is NOT an 大阳线
  const candlesPinbar = createCandles(150, 100, 0.1);
  candlesPinbar[bigBullIdx].open = 100;
  candlesPinbar[bigBullIdx].close = 101.5; // body only +1.5%
  candlesPinbar[bigBullIdx].high = 107;
  candlesPinbar[bigBullIdx].low = 99.5;
  const monitorPinbar = new StrategyFeatureMonitor(candlesPinbar, ticker, 1, targetBarIdx);
  assert.equal(monitorPinbar.hasBigBullishCandle(120, 5), false);

  // A 5% candle 125 minutes ago (outside 120-minute window) is not triggered
  const candlesOldBigBull = createCandles(150, 100, 0.1);
  const oldIdx = targetBarIdx - 125;
  candlesOldBigBull[oldIdx].open = 100;
  candlesOldBigBull[oldIdx].close = 106.0;
  candlesOldBigBull[oldIdx].high = 106.5;
  candlesOldBigBull[oldIdx].low = 99.5;
  const monitorOld = new StrategyFeatureMonitor(candlesOldBigBull, ticker, 1, targetBarIdx);
  assert.equal(monitorOld.hasBigBullishCandle(120, 5), false);
});

test("StrategyEngine: automatically retreats from shorting when a >=5% 1m big bullish candle exists within 120m", () => {
  const candles = createCandles(150, 100, 0.1);
  const targetBarIdx = 148;
  const bigBullIdx = targetBarIdx - 40; // 40 minutes ago
  candles[bigBullIdx].open = 100;
  candles[bigBullIdx].close = 105.2; // 5.2% 大阳线
  candles[bigBullIdx].high = 105.5;
  candles[bigBullIdx].low = 99.8;

  const ticker: Ticker24h = { symbol: "SHORTTEST", priceChangePercent: 20, lastPrice: candles[targetBarIdx].close, quoteVolume: 1000000 };
  const monitor = new StrategyFeatureMonitor(candles, ticker, 1, targetBarIdx);
  const now = candles[targetBarIdx].time + 60_000;

  // 1. Short strategy (streak) must be rejected with the retreat failure reason
  const shortStrategy = streakPreset({ requireDeaDivergence: false, requireMacdDivergence: false, requireBearish: false });
  const engineShort = new StrategyEngine([shortStrategy]);
  const matchesShort = engineShort.evaluate(monitor, now);
  assert.equal(matchesShort.length, 0, "Short match must be blocked");
  const resultsShort = engineShort.getResults();
  assert.equal(resultsShort[0].pass, false);
  assert.equal(resultsShort[0].failedReason, "120分钟内存在>=5%大阳线退避");

  // 2. Long strategy (wBottom) should NOT be blocked by the short retreat rule
  const longStrategy = wBottomPreset();
  const engineLong = new StrategyEngine([longStrategy]);
  engineLong.evaluate(monitor, now);
  const resultsLong = engineLong.getResults();
  assert.notEqual(resultsLong[0].failedReason, "120分钟内存在>=5%大阳线退避");

  // 3. If avoidBigBull1m is explicitly false, short strategy evaluates normal entry rules
  const shortStrategyNoAvoid = { ...shortStrategy, avoidBigBull1m: false };
  const engineOverride = new StrategyEngine([shortStrategyNoAvoid]);
  engineOverride.evaluate(monitor, now);
  const resultsOverride = engineOverride.getResults();
  assert.notEqual(resultsOverride[0].failedReason, "120分钟内存在>=5%大阳线退避");
});

test("features: FeatureVector computes hasBigBull120 and evaluateFeatureSpec blocks shorting", () => {
  const candles = createCandles(150, 100, 0.1);
  const targetIdx = 148;
  candles[targetIdx - 20].open = 100;
  candles[targetIdx - 20].close = 105.8;
  candles[targetIdx - 20].high = 106.0;
  candles[targetIdx - 20].low = 99.5;

  const ticker: Ticker24h = { symbol: "FVTEST", priceChangePercent: 25, lastPrice: candles[targetIdx].close, quoteVolume: 1000000 };
  const fv = computeFeatureVector(candles, ticker, targetIdx, { rank: 1 });
  assert.ok(fv !== null);
  assert.equal(fv.hasBigBull120, true);
  assert.ok((fv.maxBullishGain120 ?? 0) >= 5.8 - 1e-6);

  // evaluateFeatureSpec for SHORT should reject
  const shortSpec = { intervalWindow: 5, ampDivisor: 10 };
  const shortEval = evaluateFeatureSpec("SHORT", fv, shortSpec);
  assert.equal(shortEval.pass, false);
  assert.equal(shortEval.failedReason, "120分钟内存在>=5%大阳线退避");

  // evaluateFeatureSpec for LONG should not be blocked by big bull retreat
  const longEval = evaluateFeatureSpec("LONG", fv, shortSpec);
  assert.notEqual(longEval.failedReason, "120分钟内存在>=5%大阳线退避");
});

test("PaperTradingEngine onScan: retreats from shorting symbols with 1m >=5% big bullish candle", async () => {
  const engine = new PaperTradingEngine({
    ...PAPER_DEFAULT_CONFIG,
    storageFile: null,
  });

  const baseTime = Date.now() - 150 * 60_000;
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < 150; i++) {
    const open = price;
    const close = price + 0.1;
    const high = close + 0.05;
    const low = open - 0.05;
    price = close;
    candles.push({ time: baseTime + i * 60_000, open, high, low, close, volume: 1000 });
  }

  const targetBarIdx = 148;
  // Plant a 5.2% big bullish candle 15 minutes ago
  candles[targetBarIdx - 15].open = 100;
  candles[targetBarIdx - 15].close = 105.2;
  candles[targetBarIdx - 15].high = 105.5;
  candles[targetBarIdx - 15].low = 99.9;

  const ticker: Ticker24h = { symbol: "PUMP1M", priceChangePercent: 30, lastPrice: candles[targetBarIdx].close, quoteVolume: 5000000 };
  const candleMap = new Map([
    ["PUMP1M", { candles1m: candles, initialized: true }],
  ]);

  const opened = await engine.onScan([ticker], candleMap);
  // No short position or pending order should be opened
  assert.equal(opened.length, 0);
  assert.equal(engine.getSummary().activePositions.length, 0);
  assert.equal(engine.getPendingOrders().length, 0);

  // Monitor results should document the retreat reason for short strategies
  const shortResults = (engine.getState().strategyMonitor ?? []).filter(r => r.symbol === "PUMP1M" && r.failedReason?.includes("大阳线退避"));
  assert.ok(shortResults.length > 0, "Short strategies must record big bullish candle retreat in monitor");
  assert.equal(shortResults[0].failedReason, "120分钟内存在>=5%大阳线退避");
});
