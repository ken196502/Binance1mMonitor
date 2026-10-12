import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffLevel, analyzeDiff } from '../../src/macd.ts';

test('diffLevel partitions positive high, positive mid, zero, and negative values', () => {
  // 过去N根diff百分之x且大于0算高
  assert.equal(diffLevel(1.0, 1.0, 0.8), 'high');
  assert.equal(diffLevel(0.8, 1.0, 0.8), 'high');
  assert.equal(diffLevel(0.7, 1.0, 0.6), 'high');

  // 大于0算中（未达高位比例）
  assert.equal(diffLevel(0.799, 1.0, 0.8), 'mid');
  assert.equal(diffLevel(0.1, 1.0, 0.8), 'mid');
  assert.equal(diffLevel(0, 0, 0.8), 'mid');

  // 小于0算低
  assert.equal(diffLevel(-0.0001, 1.0, 0.8), 'low');
  assert.equal(diffLevel(-1.0, -0.5, 0.8), 'low');
  assert.equal(diffLevel(-0.1, 0, 0.8), 'low');
});

test('analyzeDiff computes DIF and high/mid/low classification over past window', () => {
  // < 35 closes should return null
  assert.equal(analyzeDiff(new Array(34).fill(100)), null);

  // Accelerating rising trend -> hist > 0 and at peak -> high
  const rising = Array.from({ length: 60 }, (_, i) => 100 + i * i * 0.1);
  const sigRising = analyzeDiff(rising, { highRatio: 0.8, highWindow: 50 });
  assert.ok(sigRising !== null);
  assert.ok(sigRising.dif > 0);
  assert.equal(sigRising.level, 'high');

  // Falling trend closes -> DIF < 0 -> low
  const falling = Array.from({ length: 60 }, (_, i) => 200 - i * 2);
  const sigFalling = analyzeDiff(falling, { highRatio: 0.8, highWindow: 50 });
  assert.ok(sigFalling !== null);
  assert.ok(sigFalling.dif < 0);
  assert.equal(sigFalling.level, 'low');
});
