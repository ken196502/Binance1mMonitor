import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  UnifiedShortStrategyTracker,
  STREAK_LIVE_DEFAULT_CONFIG,
  DEEP_REBOUND_LIVE_DEFAULT_CONFIG,
} from '../../src/unified-short-strategy.ts';
import {
  PEAK_REBOUND_LIVE_DEFAULT_CONFIG,
} from '../../src/peak-rebound-strategy.ts';
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

test('Default strategy configurations match verified specifications', () => {
  // 1. 空弱反弹 (首次跌10%) - 最高胜率参数 (73.9%胜率, 34胜12负, 仅5次止损)
  assert.equal(PEAK_REBOUND_LIVE_DEFAULT_CONFIG.shortMa, 5);
  assert.equal(PEAK_REBOUND_LIVE_DEFAULT_CONFIG.mediumMa, 15);
  assert.equal(PEAK_REBOUND_LIVE_DEFAULT_CONFIG.longMa, 30);
  assert.equal(PEAK_REBOUND_LIVE_DEFAULT_CONFIG.longMaOffsetPercent, 0.5);
  assert.equal(PEAK_REBOUND_LIVE_DEFAULT_CONFIG.pullbackX, 10.0);
  assert.equal(PEAK_REBOUND_LIVE_DEFAULT_CONFIG.reboundY, 4.0);
  assert.equal(PEAK_REBOUND_LIVE_DEFAULT_CONFIG.minGreenRatio20, 0.65);
  assert.equal(PEAK_REBOUND_LIVE_DEFAULT_CONFIG.requireMaSlopeDown, true);
  assert.equal(PEAK_REBOUND_LIVE_DEFAULT_CONFIG.holdMinutes, 30);
  assert.equal(PEAK_REBOUND_LIVE_DEFAULT_CONFIG.exitX, 35);
  assert.equal(PEAK_REBOUND_LIVE_DEFAULT_CONFIG.exitN, 2.0);
  assert.equal(PEAK_REBOUND_LIVE_DEFAULT_CONFIG.exitM, 1.5);

  // 2. 空连阳 (连阳悬空) - 100% 胜率 (7胜0负)
  assert.equal(STREAK_LIVE_DEFAULT_CONFIG.topN, 10);
  assert.equal(STREAK_LIVE_DEFAULT_CONFIG.minStreakCount, 2);
  assert.deepEqual(STREAK_LIVE_DEFAULT_CONFIG.supportMaPeriods, [3, 7, 15]);
  assert.equal(STREAK_LIVE_DEFAULT_CONFIG.ampDivisor, 12);
  assert.equal(STREAK_LIVE_DEFAULT_CONFIG.minUpperShadowRatio, 0.005);
  assert.equal(STREAK_LIVE_DEFAULT_CONFIG.maxUpperShadowRatio, 0.30);
  assert.equal(STREAK_LIVE_DEFAULT_CONFIG.minGreenRatio, 0.70);
  assert.equal(STREAK_LIVE_DEFAULT_CONFIG.minConsecutiveGreenBars, 7);
  assert.equal(STREAK_LIVE_DEFAULT_CONFIG.holdMinutes, 15);
  assert.equal(STREAK_LIVE_DEFAULT_CONFIG.exitX, 50);
  assert.equal(STREAK_LIVE_DEFAULT_CONFIG.exitN, 1.5);
  assert.equal(STREAK_LIVE_DEFAULT_CONFIG.exitM, 3.0);

  // 3. 跌到20%+ (超跌反弹做空) - 最高胜率参数 (87.5%胜率, 7胜1负, PF 7.15)
  assert.equal(DEEP_REBOUND_LIVE_DEFAULT_CONFIG.pullbackX, 20.0);
  assert.equal(DEEP_REBOUND_LIVE_DEFAULT_CONFIG.reboundY, 5.0);
  assert.equal(DEEP_REBOUND_LIVE_DEFAULT_CONFIG.lowWindowMinutes, 10);
  assert.equal(DEEP_REBOUND_LIVE_DEFAULT_CONFIG.shortMa, 15);
  assert.equal(DEEP_REBOUND_LIVE_DEFAULT_CONFIG.longMa, 30);
  assert.equal(DEEP_REBOUND_LIVE_DEFAULT_CONFIG.minGreenRatio20, 0.65);
  assert.equal(DEEP_REBOUND_LIVE_DEFAULT_CONFIG.requireMaSlopeDown, true);
  assert.equal(DEEP_REBOUND_LIVE_DEFAULT_CONFIG.holdMinutes, 30);
  assert.equal(DEEP_REBOUND_LIVE_DEFAULT_CONFIG.exitX, 35);
  assert.equal(DEEP_REBOUND_LIVE_DEFAULT_CONFIG.exitN, 2.0);
  assert.equal(DEEP_REBOUND_LIVE_DEFAULT_CONFIG.exitM, 4.0);
});

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

test('UnifiedShortStrategyTracker triggers streak signal with verified parameters', () => {
  const tracker = new UnifiedShortStrategyTracker();

  // Create 50 rising candles suitable for streak signal
  const candles: Candle[] = [];
  let basePrice = 100;
  const now = 1700000000000;
  for (let i = 0; i < 50; i++) {
    const time = now + i * 60000;
    const open = basePrice;
    const close = basePrice + 1.0;
    const high = close + 0.1; // upper shadow 0.1 / 1.0 = 10% (between 0.5% and 30%)
    const low = open + 0.2;
    basePrice = close;
    candles.push({ time, open, high, low, close, volume: 1000 });
  }

  const sig = tracker.checkCandles('ALPHAUSDT', 20.0, 3, candles, now + 50 * 60000);
  assert.ok(sig !== null, 'Streak signal should trigger');
  assert.equal(sig.type, 'streak');
  assert.equal(sig.exitParams.holdMinutes, 15);
  assert.equal(sig.exitParams.exitX, 50);
  assert.equal(sig.exitParams.exitN, 1.5);
  assert.equal(sig.exitParams.exitM, 3.0);
});
