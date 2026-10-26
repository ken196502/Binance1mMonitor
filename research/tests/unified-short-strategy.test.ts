import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UnifiedShortStrategyTracker } from '../../src/unified-short-strategy.ts';
import type { Candle } from '../../src/macd.ts';

function createMockCandles(count: number, basePrice = 100): Candle[] {
  const candles: Candle[] = [];
  const now = 1700000000000;
  for (let i = 0; i < count; i++) {
    candles.push({
      time: now + i * 60000,
      open: basePrice,
      high: basePrice + 1,
      low: basePrice - 1,
      close: basePrice,
      volume: 1000,
    });
  }
  return candles;
}

test('UnifiedShortStrategyTracker manages active positions and prevents double-entry conflicts', () => {
  const tracker = new UnifiedShortStrategyTracker({ preventConflict: true });
  const symbol = 'BTCUSDT';
  const now = 1700000000000;

  assert.equal(tracker.isSymbolBusy(symbol, now), false);

  tracker.registerPosition(symbol, {
    tradeId: 'test-1',
    type: 'rebound',
    entryTime: now,
    maxExitTime: now + 30 * 60 * 1000,
  });

  assert.equal(tracker.isSymbolBusy(symbol, now + 10 * 60 * 1000), true);
  assert.equal(tracker.isSymbolBusy(symbol, now + 31 * 60 * 1000), false);

  tracker.registerPosition(symbol, {
    tradeId: 'test-2',
    type: 'streak',
    entryTime: now,
    maxExitTime: now + 15 * 60 * 1000,
  });
  tracker.closePosition(symbol);
  assert.equal(tracker.isSymbolBusy(symbol, now), false);
});

test('UnifiedShortStrategyTracker initializes with custom configs and dispatches rank updates', () => {
  const tracker = new UnifiedShortStrategyTracker({
    reboundConfig: { pullbackX: 12.0, reboundY: 5.0 },
    streakConfig: { exitX: 70 },
  });

  // onRankUpdate should not throw
  tracker.onRankUpdate('ETHUSDT', 25.5, Date.now());

  const mockCandles = createMockCandles(10);
  const sig = tracker.checkCandles('ETHUSDT', 25.5, 1, mockCandles);
  // Not enough candles, should cleanly return null
  assert.equal(sig, null);
});
