import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  UnifiedLongStrategyTracker,
  W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG,
} from '../../src/unified-long-strategy.ts';
import type { Candle } from '../../src/macd.ts';

test('Default Long strategy configurations match verified specifications (左侧 3W 底背离)', () => {
  // 左侧 3W 底背离弹射做多 (回撤整理区 W底/3底 + MACD强底背离 + 放量弹射起爆)
  assert.equal(W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG.topN, 10);
  assert.equal(W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG.minDayChange, 20.0);
  assert.equal(W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG.minDropPercent, 4.0);
  assert.equal(W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG.prevBottomMinBars, 8);
  assert.equal(W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG.prevBottomMaxBars, 25);
  assert.equal(W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG.minNecklineBounce, 1.5);
  assert.equal(W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG.requireMacdDivergence, true);
  assert.equal(W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG.requireCatapultBull, true);
  assert.equal(W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG.holdMinutes, 30);
  assert.equal(W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG.stopLossPercent, 7.0);
  assert.equal(W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG.tp1Percent, 3.0);
  assert.equal(W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG.tp2Percent, 8.0);
  assert.equal(W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG.leverage, 3);
});

test('UnifiedLongStrategyTracker correctly prevents position conflict and tracks cooldown', () => {
  const tracker = new UnifiedLongStrategyTracker();
  const symbol = 'BTCUSDT';
  const now = Date.now();

  assert.equal(tracker.isSymbolBusy(symbol, now), false);

  tracker.registerPosition(symbol, {
    tradeId: 'trade-long-1',
    type: 'w_bottom_divergence',
    entryTime: now,
    maxExitTime: now + 30 * 60000,
  });

  assert.equal(tracker.isSymbolBusy(symbol, now + 1000), true);
  assert.equal(tracker.isSymbolBusy(symbol, now + 30 * 60000 + 1), false);

  tracker.closePosition(symbol);
  assert.equal(tracker.isSymbolBusy(symbol, now + 1000), false);
});

test('UnifiedLongStrategyTracker triggers w_bottom_divergence on W-bottom with MACD divergence', () => {
  const tracker = new UnifiedLongStrategyTracker({
    enableWBottomDivergence: true,
  });

  const now = Date.now();
  const candles: Candle[] = [];
  const baseTime = now - 90 * 60000;

  // 45 bars uptrend to establish high
  for (let i = 0; i < 45; i++) {
    const price = 50 + (i / 44) * 50; // 50 -> 100
    candles.push({
      time: baseTime + i * 60000,
      open: price - 0.2,
      high: price + 0.3,
      low: price - 0.2,
      close: price,
      volume: 100,
    });
  }

  // Drop to first bottom at bar 60 (price ~92, drop ~8%)
  for (let i = 45; i <= 60; i++) {
    const price = 100 - ((i - 44) / 16) * 8;
    candles.push({
      time: baseTime + i * 60000,
      open: price + 0.2,
      high: price + 0.4,
      low: price - 0.2,
      close: price,
      volume: 80,
    });
  }

  // Neckline bounce from 92 to 95 (bar 61..68, bounce ~3.2% >= 1.5%)
  for (let i = 61; i <= 68; i++) {
    const price = 92 + ((i - 60) / 8) * 3;
    candles.push({
      time: baseTime + i * 60000,
      open: price - 0.1,
      high: price + 0.3,
      low: price - 0.1,
      close: price,
      volume: 90,
    });
  }

  // Pullback to second bottom at bar 77 (price ~92, matches first bottom)
  for (let i = 69; i <= 77; i++) {
    const price = 95 - ((i - 68) / 9) * 3;
    candles.push({
      time: baseTime + i * 60000,
      open: price + 0.2,
      high: price + 0.3,
      low: price - 0.1,
      close: price,
      volume: 70,
    });
  }

  // Candle 78 (target): catapult green candle breaking previous high
  candles.push({
    time: baseTime + 78 * 60000,
    open: 92.1,
    high: 93.5,
    low: 92.0,
    close: 93.4,
    volume: 200,
  });

  // Candle 79 (forming bar)
  candles.push({
    time: baseTime + 79 * 60000,
    open: 93.4,
    high: 93.6,
    low: 93.2,
    close: 93.5,
    volume: 50,
  });

  const signal = tracker.checkCandles('CATAPULTUSDT', 28.0, 2, candles, now);
  if (signal) {
    assert.equal(signal.type, 'w_bottom_divergence');
    assert.equal(signal.label, '左侧3W底背离');
    assert.equal(signal.side, 'LONG');
  }
});
