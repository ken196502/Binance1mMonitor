import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consecutiveStreak, consecutiveStreakAt, type Candle } from '../../src/macd.ts';
import { matchesStreak } from '../streak.ts';
import { MINUTE } from '../gainers-types.ts';

const start = Date.UTC(2026, 0, 5);
const candle = (i: number, open: number, close: number, interval = MINUTE): Candle => ({
  time: start + i * interval,
  open,
  close,
  high: Math.max(open, close),
  low: Math.min(open, close),
  volume: 1,
});

test('shared closed-bar streak matches monitor, excludes forming bars, and resets on colour, doji and gaps', () => {
  const c = [candle(0, 99, 100), candle(1, 100, 101), candle(2, 100, 99)];
  assert.deepEqual(consecutiveStreak(c), { count: 2, direction: 'up' });
  assert.deepEqual(consecutiveStreakAt(c, 2), { count: 1, direction: 'down' });
  c[2].close = 110;
  assert.deepEqual(consecutiveStreak(c), { count: 2, direction: 'up' });
  c.push(candle(3, 101, 101), candle(4, 102, 101), candle(5, 103, 101), candle(7, 104, 101));
  assert.deepEqual(consecutiveStreakAt(c, 3), { count: 0, direction: null });
  assert.deepEqual(consecutiveStreakAt(c, 5), { count: 2, direction: 'down' });
  assert.deepEqual(consecutiveStreakAt(c, 6), { count: 1, direction: 'down' });
  assert.deepEqual(consecutiveStreakAt(c, -1), { count: 0, direction: null });
});

test('signed thresholds mean at least N bars of the chosen direction, with missing metadata rejected', () => {
  assert.ok(matchesStreak(undefined, 0));
  assert.equal(matchesStreak(undefined, 2), false);
  assert.ok(matchesStreak({ count: 5, direction: 'up' }, 3));
  assert.ok(matchesStreak({ count: 3, direction: 'down' }, -3));
  assert.equal(matchesStreak({ count: 5, direction: 'up' }, -3), false);
  assert.equal(matchesStreak({ count: 2, direction: 'down' }, -3), false);
  assert.equal(matchesStreak({ count: 0, direction: null }, 1), false);
  assert.equal(matchesStreak({ count: 5, direction: 'up' }, NaN), false);
});
