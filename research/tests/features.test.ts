import test from "node:test";
import assert from "node:assert/strict";
import { computeFeatureVector, evaluateFeatureSpec, FEATURE_VERSION } from "../../src/features.ts";
import { validateStrategySpec } from "../../src/strategy-spec.ts";
import type { Candle } from "../../src/macd.ts";
import type { Ticker24h } from "../../src/binance.ts";

function generateSyntheticCandles(count: number, startPrice = 100): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;
  const baseTime = 1700000000000;
  for (let i = 0; i < count; i++) {
    const change = Math.sin(i / 10) * 1.5 + (i % 3 === 0 ? 0.8 : -0.4);
    const open = price;
    const close = Math.max(1, price + change);
    const high = Math.max(open, close) + 0.5;
    const low = Math.min(open, close) - 0.5;
    price = close;
    candles.push({
      time: baseTime + i * 60_000,
      open,
      high,
      low,
      close,
      volume: 1000 + (i % 10) * 100,
    });
  }
  return candles;
}

test("computeFeatureVector: extracts correct features with valid bounds", () => {
  const candles = generateSyntheticCandles(200);
  const ticker: Ticker24h = {
    symbol: "BTCUSDT",
    lastPrice: candles[198].close,
    priceChangePercent: 25.0,
    quoteVolume: 1000000,
    highPrice: 150.0,
    lowPrice: 90.0,
    openPrice: 100.0,
  };

  const fv = computeFeatureVector(candles, ticker, 198, { rank: 2 });
  assert.ok(fv !== null);
  assert.equal(fv.version, FEATURE_VERSION);
  assert.equal(fv.rank, 2);
  assert.equal(fv.dayChange, 25.0);
  assert.equal(fv.highChange24h, 50.0);
  assert.ok(fv.posIn24hRange >= 0 && fv.posIn24hRange <= 1);
  assert.ok(fv.surge[5] >= 0);
  assert.ok(fv.surgeRatio[5] >= 0);
  assert.ok(fv.ma[10].value > 0);
  assert.ok(fv.greenRatio[15] >= 0 && fv.greenRatio[15] <= 1);
});

test("M3 Warmup Consistency: 500 bars vs 2000 bars produce identical indicators (< 1e-9)", () => {
  const longCandles = generateSyntheticCandles(1000);
  const targetIdx = 800; // in the long series
  const slice500 = longCandles.slice(targetIdx - 499, targetIdx + 2); // 500 completed + 1 forming
  const sliceTargetIdx = 499;

  const ticker: Ticker24h = {
    symbol: "ETHUSDT",
    lastPrice: longCandles[targetIdx].close,
    priceChangePercent: 18.5,
    quoteVolume: 5000000,
    highPrice: 200.0,
    lowPrice: 80.0,
  };

  const fvFromLong = computeFeatureVector(longCandles, ticker, targetIdx);
  const fvFromSlice = computeFeatureVector(slice500, ticker, sliceTargetIdx);

  assert.ok(fvFromLong !== null);
  assert.ok(fvFromSlice !== null);

  assert.ok(Math.abs(fvFromLong.dif - fvFromSlice.dif) < 1e-9, `dif diff: ${Math.abs(fvFromLong.dif - fvFromSlice.dif)}`);
  assert.ok(Math.abs(fvFromLong.dea - fvFromSlice.dea) < 1e-9, `dea diff: ${Math.abs(fvFromLong.dea - fvFromSlice.dea)}`);
  assert.ok(Math.abs(fvFromLong.hist - fvFromSlice.hist) < 1e-9, `hist diff: ${Math.abs(fvFromLong.hist - fvFromSlice.hist)}`);
  assert.ok(Math.abs(fvFromLong.ma[20].value - fvFromSlice.ma[20].value) < 1e-9);
  assert.ok(Math.abs(fvFromLong.ma[60].value - fvFromSlice.ma[60].value) < 1e-9);
  assert.equal(fvFromLong.stack, fvFromSlice.stack);
});

test("evaluateFeatureSpec: matches both traditional enum requirements and rules grammar", () => {
  const candles = generateSyntheticCandles(200);
  const ticker: Ticker24h = {
    symbol: "SOLUSDT",
    lastPrice: candles[198].close,
    priceChangePercent: 30.0,
    quoteVolume: 2000000,
  };
  const fv = computeFeatureVector(candles, ticker, 198, { rank: 1 });
  assert.ok(fv !== null);

  // Test rank filter
  const resPass = evaluateFeatureSpec("SHORT", fv, { topN: 5, minDayChange: 10, ampDivisor: 100 });
  assert.equal(resPass.pass, true);

  const resFailRank = evaluateFeatureSpec("SHORT", fv, { topN: 0 });
  assert.equal(resFailRank.pass, false);

  const resFailDayChange = evaluateFeatureSpec("SHORT", fv, { minDayChange: 50 });
  assert.equal(resFailDayChange.pass, false);
});

test("24h highest gain range (24h最高涨幅区间): filters out short candidates < 20% and enforces bounds", () => {
  const candles = generateSyntheticCandles(200);
  
  // Coin A: 24h最高涨幅只有 15% (< 20%)，做空失败概率极大，应被拦截
  const tickerLowSurge: Ticker24h = {
    symbol: "LOWSURGEUSDT",
    lastPrice: candles[198].close,
    priceChangePercent: 12.0,
    quoteVolume: 1000000,
    highPrice: 115.0,
    openPrice: 100.0,
  };
  const fvLow = computeFeatureVector(candles, tickerLowSurge, 198, { rank: 3 });
  assert.ok(fvLow !== null);
  assert.equal(fvLow.highChange24h, 15.0);

  // 未满足 minHighChange24h: 20
  const checkLow = evaluateFeatureSpec("SHORT", fvLow, { topN: 10, minHighChange24h: 20 });
  assert.equal(checkLow.pass, false);
  assert.match(checkLow.failedReason ?? "", /highChange24h/);

  // Coin B: 24h最高涨幅 35% (>= 20%)，满足门槛允许做空
  const tickerHighSurge: Ticker24h = {
    symbol: "HIGHSURGEUSDT",
    lastPrice: candles[198].close,
    priceChangePercent: 15.0, // 当前涨幅虽回撤至 15%，但 24h 最高曾冲至 35%
    quoteVolume: 5000000,
    highPrice: 135.0,
    openPrice: 100.0,
  };
  const fvHigh = computeFeatureVector(candles, tickerHighSurge, 198, { rank: 2 });
  assert.ok(fvHigh !== null);
  assert.equal(fvHigh.highChange24h, 35.0);

  const checkHigh = evaluateFeatureSpec("SHORT", fvHigh, { topN: 10, minHighChange24h: 20, ampDivisor: 100 });
  assert.equal(checkHigh.pass, true);

  // 区间上限过滤测试 (如 [20%, 30%])
  const checkRangeFail = evaluateFeatureSpec("SHORT", fvHigh, { minHighChange24h: 20, maxHighChange24h: 30 });
  assert.equal(checkRangeFail.pass, false);
  assert.match(checkRangeFail.failedReason ?? "", /highChange24h/);

  const checkRangePass = evaluateFeatureSpec("SHORT", fvHigh, { minHighChange24h: 20, maxHighChange24h: 50, ampDivisor: 100 });
  assert.equal(checkRangePass.pass, true);
});

test("validateStrategySpec: validates 24h highest gain interval and bounds", () => {
  assert.doesNotThrow(() => validateStrategySpec({ minHighChange24h: 20, maxHighChange24h: 100 }));
  assert.doesNotThrow(() => validateStrategySpec({ minHighChange24h: 20 }));
  assert.throws(() => validateStrategySpec({ minHighChange24h: 50, maxHighChange24h: 20 }), /maxHighChange24h 不能小于 minHighChange24h/);
  assert.throws(() => validateStrategySpec({ minHighChange24h: -5 }), /minHighChange24h/);
});
