import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateSupportMa, calculateSupportMaAt, SUPPORT_MA_PERIODS, type Candle } from '../../src/macd.ts';

const candle = (close: number, low = close - 1): Candle => ({ time: 0, open: close, high: close + 1, low, close, volume: 1 });

test('support uses the highest qualifying SMA and exactly the monitor periods', () => {
  assert.deepEqual(SUPPORT_MA_PERIODS, [5, 7, 10, 20, 25, 30, 60, 99, 120]);
  const bars = Array.from({ length: 120 }, () => candle(100));
  bars[119] = candle(110, 100.5);
  // SMA5=102 and SMA10=101; both cross the candle, pick the higher line.
  assert.equal(calculateSupportMaAt(bars, 119), 'ma5');
  const onlyLong = Array.from({ length: 120 }, (_, i) => candle(i < 60 ? 109 : 100));
  onlyLong[119] = candle(110, 104);
  assert.equal(calculateSupportMaAt(onlyLong, 119), 'ma120');
});

test('touching an MA boundary is not support; crossing it strictly is support', () => {
  const bars = Array.from({ length: 120 }, () => candle(100));
  assert.equal(calculateSupportMaAt(bars, 119), null); // close equals every MA
  bars[119] = candle(110, 102); // low equals the highest MA5, all others below low
  assert.equal(calculateSupportMaAt(bars, 119), null);
  bars[119] = candle(110, 102 - 1e-8);
  assert.equal(calculateSupportMaAt(bars, 119), 'ma5');
});

test('monitor and historical cutoff agree, excluding both forming and later candles', () => {
  const bars = Array.from({ length: 125 }, (_, i) => candle(100 + i / 10, i === 120 ? 100 : 100 + i / 10));
  const expected = calculateSupportMaAt(bars, 120);
  assert.equal(expected, 'ma5');
  assert.equal(calculateSupportMa(bars.slice(0, 122)), expected);
  for (let i = 121; i < bars.length; i++) bars[i] = candle(1e8, 1);
  assert.equal(calculateSupportMaAt(bars, 120), expected);
  assert.equal(calculateSupportMa(bars.slice(0, 122)), expected);
  assert.equal(calculateSupportMa([]), null);
  assert.equal(calculateSupportMa([candle(100)]), null);
});
