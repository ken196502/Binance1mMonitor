import test from "node:test";
import assert from "node:assert/strict";
import { computeFeatureVector, evaluateFeatureSpec, FEATURE_VERSION } from "../../src/features.ts";
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
