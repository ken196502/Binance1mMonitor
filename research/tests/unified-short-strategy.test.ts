import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  UnifiedShortStrategyTracker,
  STREAK_LIVE_DEFAULT_CONFIG,
  DEEP_REBOUND_LIVE_DEFAULT_CONFIG,
  HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG,
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
  assert.equal(PEAK_REBOUND_LIVE_DEFAULT_CONFIG.minGreenRatio20, 0.55);
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
  assert.equal(STREAK_LIVE_DEFAULT_CONFIG.requireDeaDivergence, true);
  assert.equal(STREAK_LIVE_DEFAULT_CONFIG.deaLookbackMinutes, 30);
  assert.equal(STREAK_LIVE_DEFAULT_CONFIG.requireMacdDivergence, false);
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
  assert.equal(DEEP_REBOUND_LIVE_DEFAULT_CONFIG.minGreenRatio20, 0.55);
  assert.equal(DEEP_REBOUND_LIVE_DEFAULT_CONFIG.requireMaSlopeDown, true);
  assert.equal(DEEP_REBOUND_LIVE_DEFAULT_CONFIG.holdMinutes, 30);
  assert.equal(DEEP_REBOUND_LIVE_DEFAULT_CONFIG.exitX, 35);
  assert.equal(DEEP_REBOUND_LIVE_DEFAULT_CONFIG.exitN, 2.0);
  assert.equal(DEEP_REBOUND_LIVE_DEFAULT_CONFIG.exitM, 4.0);

  // 4. 小时线压制·深跌狂暴狙击 (策略 6)
  assert.equal(HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG.topN, 10);
  assert.equal(HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG.requireSurge, true);
  assert.equal(HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG.xMinutes, 5);
  assert.equal(HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG.ampDivisor, 10);
  assert.equal(HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG.nGreenBars, 3);
  assert.equal(HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG.minDayChange, 10);
  assert.equal(HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG.minDropFrom24h, 20);
  assert.equal(HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG.requireMa60GtMa10GtMa20, true);
  assert.equal(HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG.holdMinutes, 30);
  assert.equal(HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG.exitX, 35);
  assert.equal(HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG.exitN, 2.0);
  assert.equal(HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG.exitM, 3.0);
  assert.equal(HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG.stopLossPercent, 4.0);
  assert.equal(HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG.tp1Percent, 3.0);
  assert.equal(HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG.tp2Percent, 6.0);
  assert.equal(HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG.moveSlToEntryAfterTp1, true);
  assert.equal(HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG.cooldownMinutes, 20);
  assert.equal(HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG.leverage, 3);
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
    streakConfig: { requireDeaDivergence: false, requireMacdDivergence: false, requireBearish: false },
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
  const div = sig.details.streakSignal?.divergence;
  assert.ok(div != null, 'Divergence details should be present');
  assert.ok(div.curHist != null && div.prevHist != null && div.curHist < div.prevHist);
  assert.ok(div.curDif != null && div.prevDif != null && div.curDif < div.prevDif);
});

test('UnifiedShortStrategyTracker triggers 新高顶背离 with Option B (DEA bearish divergence and rollover)', () => {
  const tracker = new UnifiedShortStrategyTracker(); // Uses default STREAK_LIVE_DEFAULT_CONFIG (requireDeaDivergence: true)

  const now = 1700000000000;
  const candles: Candle[] = [];
  let basePrice = 100;

  // 1. Initial surge to establish peak DEA (0..35)
  for (let i = 0; i < 35; i++) {
    const time = now + i * 60000;
    const open = basePrice;
    const close = basePrice + 1.0;
    const high = close + 0.1;
    const low = open + 0.1;
    basePrice = close;
    candles.push({ time, open, high, low, close, volume: 1000 });
  }

  // 2. Slower consolidation/pullback where DEA peaks and begins to plateau (35..45)
  for (let i = 35; i < 45; i++) {
    const time = now + i * 60000;
    const open = basePrice;
    const close = basePrice - 0.2;
    const high = open + 0.1;
    const low = close - 0.1;
    basePrice = close;
    candles.push({ time, open, high, low, close, volume: 1000 });
  }

  // 3. New high push (45..54): Price makes new 24h high, but slower than the initial surge so DEA is lower than 10 mins ago
  for (let i = 45; i < 54; i++) {
    const time = now + i * 60000;
    let open = basePrice;
    let close = basePrice + 0.4;
    let high = close + 0.05;
    let low = open + 0.1;
    if (i === 52) {
      // Completed bar: price touches new high but candle closes red (bearish confirmation bar)
      open = basePrice;
      close = basePrice - 0.3;
      high = open + 0.5;
      low = close - 0.1;
    }
    basePrice = close;
    candles.push({ time, open, high, low, close, volume: 1000 });
  }

  const sig = tracker.checkCandles('DEATEST', 12.0, 2, candles, now + 54 * 60000);
  assert.ok(sig !== null, 'Option B DEA divergence signal should trigger');
  assert.equal(sig.type, 'streak');
  assert.equal(sig.label, '新高顶背离');
  assert.ok(sig.details.streakSignal?.divergence != null);
  assert.ok(sig.details.streakSignal!.divergence!.deaPeakOffsetBars! >= 1);
  assert.ok(sig.details.streakSignal!.divergence!.curDea! < sig.details.streakSignal!.divergence!.maxDea!);
});

test('UnifiedShortStrategyTracker triggers 小时线压制 when high > MA60 && low < MA60 with last N green MACD bars', () => {
  const tracker = new UnifiedShortStrategyTracker({
    enableStreak: false,
    enableRebound: false,
    enableDeepRebound: false,
    enableHourlySuppression: true,
    hourlySuppressionConfig: {
      topN: 10,
      nGreenBars: 3,
      holdMinutes: 30,
      tp1Percent: 3.0,
      tp2Percent: 6.0,
      stopLossPercent: 4.0,
      moveSlToEntryAfterTp1: true,
      leverage: 3,
    },
  });

  const now = 1700000000000;
  // Build candles with MA60 > MA10 > MA20 and 24h drop >= 20%
  // Candle 0..45: high baseline around 105, with 24h peak at 135 (drop from 135 to 101 is 25.1%)
  // MA60 is around ~103.5
  const candles: Candle[] = [];
  for (let i = 0; i < 46; i++) {
    candles.push({
      time: now + i * 60000,
      open: 105,
      high: i === 0 ? 135.0 : 105.2, // 24h peak 135.0
      low: 104.8,
      close: 105,
      volume: 1000,
    });
  }
  // Middle candles 46..58: dip to 98 -> pull MA20 lower to ~99.2
  for (let i = 46; i < 59; i++) {
    candles.push({
      time: now + i * 60000,
      open: 98,
      high: 98.2,
      low: 97.8,
      close: 98,
      volume: 1000,
    });
  }
  // Recent candles 59..67: rising 98..101.5 -> MA10 ~ 100.2, MACD green
  for (let i = 59; i < 68; i++) {
    const p = 98 + (i - 59) * 0.4;
    candles.push({
      time: now + i * 60000,
      open: p,
      high: p + 0.3,
      low: p - 0.1,
      close: p + 0.2,
      volume: 1200,
    });
  }

  // Candle 68 (target candle, index = 68 when length is 70):
  // Touches MA60 (~103): High=104.0 > MA60, Low=99.0 < MA60
  candles.push({
    time: now + 68 * 60000,
    open: 101.5,
    high: 104.0, // High > MA60 (~103)
    low: 99.0,   // Low < MA60 (~103)
    close: 101.0,
    volume: 1500,
  });

  // Candle 69 (still forming bar)
  candles.push({
    time: now + 69 * 60000,
    open: 101.0,
    high: 101.2,
    low: 100.8,
    close: 101.0,
    volume: 100,
  });

  const sig = tracker.checkCandles('HOURTEST', 15.0, 3, candles, now + 69 * 60000);
  assert.ok(sig !== null, 'Hourly suppression signal should trigger');
  assert.equal(sig.type, 'hourly_suppression');
  assert.equal(sig.label, '小时线压制');
  assert.equal(sig.exitParams.holdMinutes, 30);
  assert.equal(sig.exitParams.tp1Percent, 3.0);
  assert.equal(sig.exitParams.tp2Percent, 6.0);
  assert.equal(sig.exitParams.stopLossPercent, 4.0);
  assert.equal(sig.exitParams.moveSlToEntryAfterTp1, true);
  assert.equal(sig.exitParams.leverage, 3);
  assert.ok(sig.details.hourlySuppressionSignal != null);
  assert.equal(sig.details.hourlySuppressionSignal.nGreenBars, 3);
  assert.ok(sig.details.hourlySuppressionSignal.high > sig.details.hourlySuppressionSignal.ma60);
  assert.ok(sig.details.hourlySuppressionSignal.low < sig.details.hourlySuppressionSignal.ma60);
  assert.ok(sig.details.hourlySuppressionSignal.xRisePercent != null);
  assert.ok(sig.details.hourlySuppressionSignal.xRisePercent >= 1.5);

  // Test minDropFrom24h filtering: drop 25.1% passes minDropFrom24h=20%, but fails minDropFrom24h=30%
  const trackerWithHighDrop = new UnifiedShortStrategyTracker({
    enableHourlySuppression: true,
    hourlySuppressionConfig: {
      ...tracker.getConfig().hourlySuppressionConfig,
      minDropFrom24h: 30.0,
    },
  });
  const sigDropFiltered = trackerWithHighDrop.checkCandles('HOURTEST', 15.0, 3, candles, now + 71 * 60000);
  assert.equal(sigDropFiltered, null, 'Should filter out when dropFrom24h (25.1%) < 30.0%');

  // Test requireMa60GtMa10GtMa20 filtering
  // In `flatCandles`, all flat around 100, so MA60 ~ MA10 ~ MA20 (no strict hierarchy)
  const flatCandles: Candle[] = [];
  for (let i = 0; i < 70; i++) {
    flatCandles.push({
      time: now + i * 60000,
      open: 100,
      high: i === 68 ? 102 : 100.2,
      low: i === 68 ? 98 : 99.8,
      close: 100,
      volume: 1000,
    });
  }
  const sigFlatFiltered = tracker.checkCandles('HOURTEST', 15.0, 3, flatCandles, now + 72 * 60000);
  assert.equal(sigFlatFiltered, null, 'Should filter out when MA60 > MA10 > MA20 is not satisfied');
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
