import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregate1mTo5m, update5mFrom1m, calculateMaxHour, FIVE_MIN_MS, ONE_HOUR_MS, type Candle } from '../../src/macd.ts';

test('aggregate1mTo5m aggregates 1m candles into 5m buckets correctly', () => {
  const baseTime = 1700000000000 - (1700000000000 % FIVE_MIN_MS); // aligned to 5m

  // 5 one-minute candles within the same 5m bucket
  const candles1m: Candle[] = [
    { time: baseTime + 0 * 60000, open: 100, high: 105, low: 98, close: 102, volume: 10 },
    { time: baseTime + 1 * 60000, open: 102, high: 108, low: 101, close: 106, volume: 15 },
    { time: baseTime + 2 * 60000, open: 106, high: 110, low: 104, close: 105, volume: 20 },
    { time: baseTime + 3 * 60000, open: 105, high: 107, low: 95, close: 99, volume: 25 },
    { time: baseTime + 4 * 60000, open: 99, high: 103, low: 97, close: 101, volume: 30 },
  ];

  const aggregated = aggregate1mTo5m(candles1m);
  assert.equal(aggregated.length, 1);
  const bar = aggregated[0];
  assert.equal(bar.time, baseTime);
  assert.equal(bar.open, 100);       // first open
  assert.equal(bar.high, 110);       // max high
  assert.equal(bar.low, 95);         // min low
  assert.equal(bar.close, 101);      // last close
  assert.equal(bar.volume, 100);     // 10 + 15 + 20 + 25 + 30
});

test('update5mFrom1m updates forming 5m candle and appends new buckets locally', () => {
  const baseTime = 1700000000000 - (1700000000000 % FIVE_MIN_MS);

  // Initial 100 historical 5m candles
  const cached5m: Candle[] = Array.from({ length: 100 }, (_, i) => ({
    time: baseTime - (100 - i) * FIVE_MIN_MS,
    open: 100 + i,
    high: 102 + i,
    low: 99 + i,
    close: 101 + i,
    volume: 50,
  }));

  // Forming 1m candles for the current forming 5m candle (baseTime)
  const candles1m: Candle[] = [
    { time: baseTime, open: 200, high: 205, low: 198, close: 202, volume: 10 },
    { time: baseTime + 60000, open: 202, high: 210, low: 201, close: 208, volume: 15 },
  ];

  const updated = update5mFrom1m(cached5m, candles1m, 100);
  assert.equal(updated.length, 100);
  const lastBar = updated[updated.length - 1];
  assert.equal(lastBar.time, baseTime);
  assert.equal(lastBar.open, 200);
  assert.equal(lastBar.high, 210);
  assert.equal(lastBar.low, 198);
  assert.equal(lastBar.close, 208);
  assert.equal(lastBar.volume, 25);

  // When next minute arrives (time baseTime + 120000), forming candle updates
  const candles1mNext: Candle[] = [
    ...candles1m,
    { time: baseTime + 120000, open: 208, high: 215, low: 207, close: 212, volume: 20 },
  ];

  const updated2 = update5mFrom1m(updated, candles1mNext, 100);
  assert.equal(updated2.length, 100);
  const lastBar2 = updated2[updated2.length - 1];
  assert.equal(lastBar2.time, baseTime);
  assert.equal(lastBar2.high, 215);
  assert.equal(lastBar2.close, 212);
  assert.equal(lastBar2.volume, 45);
});

test('calculateMaxHour returns null on empty candles and calculates highest price from recent hour start', () => {
  assert.equal(calculateMaxHour([]), null);

  const baseHour = 1700000000000 - (1700000000000 % ONE_HOUR_MS); // 整点
  const prevHourTime = baseHour - 60000; // 整点前一分钟

  const candles: Candle[] = [
    { time: prevHourTime, open: 200, high: 250, low: 190, close: 200, volume: 10 }, // 属于上一小时，即使 high=250 也应被忽略
    { time: baseHour, open: 100, high: 105, low: 98, close: 102, volume: 10 },
    { time: baseHour + 60000, open: 102, high: 120, low: 100, close: 110, volume: 15 },
    { time: baseHour + 120000, open: 110, high: 115, low: 105, close: 108, volume: 20 },
  ];

  // 1. 最近整点到当前最高价应为 120 (排除上一小时的 250)
  assert.equal(calculateMaxHour(candles), 120);

  // 2. 提供 lastPrice 低于最高价时，最高价仍为 120
  assert.equal(calculateMaxHour(candles, 112), 120);

  // 3. 提供 lastPrice 高于 K 线最高价（盘中新高）时，取该 lastPrice
  assert.equal(calculateMaxHour(candles, 125), 125);
});
