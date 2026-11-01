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

test('Default strategy configurations match verified specifications', () => {
  // 1. 空弱反弹 (首次跌10%) - 核心做空 (策略 2)
  assert.equal(PEAK_REBOUND_LIVE_DEFAULT_CONFIG.shortMa, 5);
  assert.equal(PEAK_REBOUND_LIVE_DEFAULT_CONFIG.mediumMa, 15);
  assert.equal(PEAK_REBOUND_LIVE_DEFAULT_CONFIG.longMa, 30);
  assert.equal(PEAK_REBOUND_LIVE_DEFAULT_CONFIG.longMaOffsetPercent, 0.5);
  assert.equal(PEAK_REBOUND_LIVE_DEFAULT_CONFIG.pullbackX, 10.0);
  assert.equal(PEAK_REBOUND_LIVE_DEFAULT_CONFIG.reboundY, 4.0);
  assert.equal(PEAK_REBOUND_LIVE_DEFAULT_CONFIG.minGreenRatio20, 0.35);
  assert.equal(PEAK_REBOUND_LIVE_DEFAULT_CONFIG.requireMaSlopeDown, true);
  assert.equal(PEAK_REBOUND_LIVE_DEFAULT_CONFIG.holdMinutes, 30);
  assert.equal(PEAK_REBOUND_LIVE_DEFAULT_CONFIG.exitX, 35);
  assert.equal(PEAK_REBOUND_LIVE_DEFAULT_CONFIG.exitN, 2.0);
  assert.equal(PEAK_REBOUND_LIVE_DEFAULT_CONFIG.exitM, 1.5);

  // 2. 新高顶背离做空 (策略 4) - 闪击做空
  assert.equal(STREAK_LIVE_DEFAULT_CONFIG.topN, 10);
  assert.equal(STREAK_LIVE_DEFAULT_CONFIG.xMinutes, 5);
  assert.equal(STREAK_LIVE_DEFAULT_CONFIG.ampDivisor, 10);
  assert.equal(STREAK_LIVE_DEFAULT_CONFIG.require24hNewHigh, true);
  assert.deepEqual(STREAK_LIVE_DEFAULT_CONFIG.supportMaPeriods, [3, 7, 15]);
  assert.equal(STREAK_LIVE_DEFAULT_CONFIG.holdMinutes, 15);
  assert.equal(STREAK_LIVE_DEFAULT_CONFIG.exitX, 50);
  assert.equal(STREAK_LIVE_DEFAULT_CONFIG.exitN, 1.5);
  assert.equal(STREAK_LIVE_DEFAULT_CONFIG.exitM, 3.0);
  assert.equal(STREAK_LIVE_DEFAULT_CONFIG.requireMacdDivergence, true);
  assert.equal(STREAK_LIVE_DEFAULT_CONFIG.divergenceLookbackMin, 10);
  assert.equal(STREAK_LIVE_DEFAULT_CONFIG.divergenceLookbackMax, 20);
  assert.equal(STREAK_LIVE_DEFAULT_CONFIG.requireDoubleDivergence, true);
  assert.equal(STREAK_LIVE_DEFAULT_CONFIG.requireBearish, true);

  // 3. 跌到20%+ (超跌反弹做空, 策略 5)
  assert.equal(DEEP_REBOUND_LIVE_DEFAULT_CONFIG.pullbackX, 20.0);
  assert.equal(DEEP_REBOUND_LIVE_DEFAULT_CONFIG.reboundY, 5.0);
  assert.equal(DEEP_REBOUND_LIVE_DEFAULT_CONFIG.lowWindowMinutes, 10);
  assert.equal(DEEP_REBOUND_LIVE_DEFAULT_CONFIG.shortMa, 15);
  assert.equal(DEEP_REBOUND_LIVE_DEFAULT_CONFIG.longMa, 30);
  assert.equal(DEEP_REBOUND_LIVE_DEFAULT_CONFIG.minGreenRatio20, 0.35);
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
  const tracker = new UnifiedShortStrategyTracker({
    streakConfig: { requireMacdDivergence: false, requireBearish: false },
  });

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

test('UnifiedShortStrategyTracker triggers 新高顶背离 signal when MACD bearish divergence occurs', () => {
  const tracker = new UnifiedShortStrategyTracker({
    streakConfig: {
      requireMacdDivergence: true,
      requireDoubleDivergence: true,
      divergenceLookbackMin: 10,
      divergenceLookbackMax: 50,
    },
  });

  const now = 1700000000000;
  const candles: Candle[] = [];
  let basePrice = 100;

  // Wave 1: 0..30 (Fast rise to establish initial peak with strong MACD)
  for (let i = 0; i < 30; i++) {
    const time = now + i * 60000;
    const open = basePrice;
    const close = basePrice + 1.2;
    const high = close + 0.1;
    const low = open + 0.2;
    basePrice = close;
    candles.push({ time, open, high, low, close, volume: 1000 });
  }

  // Pullback: 30..42 (Consolidation/dip)
  for (let i = 30; i < 42; i++) {
    const time = now + i * 60000;
    const open = basePrice;
    const close = basePrice - 0.3;
    const high = open + 0.1;
    const low = close - 0.1;
    basePrice = close;
    candles.push({ time, open, high, low, close, volume: 1000 });
  }

  // Wave 2: 42..55 (Slower rise to higher high, creating lower MACD peak and ending with a bearish confirmation bar)
  for (let i = 42; i < 55; i++) {
    const time = now + i * 60000;
    let open = basePrice;
    let close = basePrice + 0.35;
    let high = close + 0.05;
    let low = open + 0.1;
    if (i === 53) {
      // Completed signal candle closes red to confirm bearish divergence false breakout
      open = basePrice;
      close = basePrice - 0.4;
      high = open + 0.4;
      low = close - 0.1;
    }
    basePrice = close;
    candles.push({ time, open, high, low, close, volume: 1000 });
  }

  const sig = tracker.checkCandles('BETAUSDT', 12.0, 2, candles, now + 55 * 60000);
  assert.ok(sig !== null, '新高顶背离 signal should trigger');
  assert.equal(sig.type, 'streak');
  assert.equal(sig.label, '新高顶背离');
  assert.ok(sig.details.streakSignal?.divergence != null, 'Divergence details should be present');
  assert.ok(sig.details.streakSignal!.divergence!.curHist < sig.details.streakSignal!.divergence!.prevHist);
  assert.ok(sig.details.streakSignal!.divergence!.curDif < sig.details.streakSignal!.divergence!.prevDif);
});

test('UnifiedShortStrategyTracker saves and restores reboundWatchlist', () => {
  const tracker1 = new UnifiedShortStrategyTracker();
  tracker1.onRankUpdate('TESTUSDT', 35.0, 1000);
  const list = tracker1.getReboundWatchlist();
  assert.equal(list.length, 1);
  assert.equal(list[0].symbol, 'TESTUSDT');

  const tracker2 = new UnifiedShortStrategyTracker();
  tracker2.restoreReboundWatchlist(list);
  const restored = tracker2.getReboundWatchlist();
  assert.equal(restored.length, 1);
  assert.equal(restored[0].symbol, 'TESTUSDT');
  assert.equal(restored[0].dayChangeAtRank1, 35.0);
});
