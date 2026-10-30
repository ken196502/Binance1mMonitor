import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  UnifiedShortStrategyTracker,
  STREAK_LIVE_DEFAULT_CONFIG,
  DEEP_REBOUND_LIVE_DEFAULT_CONFIG,
  EXTREME_DEV_LIVE_DEFAULT_CONFIG,
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

  // 2. 新高顶背离做空 (彻底替换连阳空) - 64.3% 胜率 (9胜5负, PF 2.54)
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

  // 4. 冲高极度乖离做空 (基底 24h/N + MA30乖离) - 最高胜率参数 (90.9%胜率, 10胜1负, PF 12.09)
  assert.equal(EXTREME_DEV_LIVE_DEFAULT_CONFIG.topN, 10);
  assert.equal(EXTREME_DEV_LIVE_DEFAULT_CONFIG.minDayChange, 20.0);
  assert.equal(EXTREME_DEV_LIVE_DEFAULT_CONFIG.xMinutes, 3);
  assert.equal(EXTREME_DEV_LIVE_DEFAULT_CONFIG.ampDivisor, 3.5);
  assert.equal(EXTREME_DEV_LIVE_DEFAULT_CONFIG.minAbsoluteSurge, 4.0);
  assert.equal(EXTREME_DEV_LIVE_DEFAULT_CONFIG.deviationPeriod, 30);
  assert.equal(EXTREME_DEV_LIVE_DEFAULT_CONFIG.minDeviationPercent, 1.5);
  assert.equal(EXTREME_DEV_LIVE_DEFAULT_CONFIG.holdMinutes, 20);
  assert.equal(EXTREME_DEV_LIVE_DEFAULT_CONFIG.exitX, 30);
  assert.equal(EXTREME_DEV_LIVE_DEFAULT_CONFIG.exitN, 2.0);
  assert.equal(EXTREME_DEV_LIVE_DEFAULT_CONFIG.exitM, 2.0);
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

test('UnifiedShortStrategyTracker triggers 冲高极度乖离 signal when 3m surge and MA30 deviation exceed thresholds', () => {
  const tracker = new UnifiedShortStrategyTracker();

  const now = 1700000000000;
  const candles: Candle[] = [];

  // 46 baseline bars at 100
  for (let i = 0; i < 46; i++) {
    candles.push({
      time: now + i * 60000,
      open: 100,
      high: 100.5,
      low: 99.5,
      close: 100,
      volume: 1000,
    });
  }

  // Bar 46: start surge
  candles.push({
    time: now + 46 * 60000,
    open: 100,
    high: 103,
    low: 100,
    close: 103,
    volume: 5000,
  });

  // Bar 47: continue surge
  candles.push({
    time: now + 47 * 60000,
    open: 103,
    high: 106,
    low: 103,
    close: 106,
    volume: 6000,
  });

  // Bar 48 (targetIndex): spike up to 110 (+10% in 3m)
  candles.push({
    time: now + 48 * 60000,
    open: 106,
    high: 110,
    low: 106,
    close: 110,
    volume: 8000,
  });

  // Bar 49: forming bar
  candles.push({
    time: now + 49 * 60000,
    open: 110,
    high: 110.5,
    low: 109.8,
    close: 110,
    volume: 100,
  });

  const checkTime = now + 49 * 60000;
  const sig = tracker.checkCandles('SURGEUSDT', 25.0, 1, candles, checkTime);

  assert.ok(sig !== null, '冲高极度乖离 signal should trigger');
  assert.equal(sig.type, 'extreme_dev');
  assert.equal(sig.label, '冲高极度乖离');
  assert.equal(sig.symbol, 'SURGEUSDT');
  assert.equal(sig.entryPrice, 110);
  assert.equal(sig.exitParams.holdMinutes, 20);
  assert.equal(sig.exitParams.exitX, 30);
  assert.equal(sig.exitParams.exitN, 2.0);
  assert.equal(sig.exitParams.exitM, 2.0);
  assert.ok(sig.details.extremeDevSignal != null);
  assert.ok(sig.details.extremeDevSignal!.surgePercent >= 9.9);
  assert.ok(sig.details.extremeDevSignal!.maDeviation >= 8.0);

  // Verify conflict protection: symbol should now be busy
  assert.equal(tracker.isSymbolBusy('SURGEUSDT', checkTime), true);

  // Duplicate call should be blocked by conflict prevention
  const duplicateSig = tracker.checkCandles('SURGEUSDT', 25.0, 1, candles, checkTime);
  assert.equal(duplicateSig, null, 'Duplicate signal should be prevented while position active');
});
