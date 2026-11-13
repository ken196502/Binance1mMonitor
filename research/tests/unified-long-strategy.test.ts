import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  UnifiedLongStrategyTracker,
  W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG,
} from '../../src/unified-long-strategy.ts';
import { PaperTradingEngine } from '../../src/paper-trading.ts';
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
  assert.equal(W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG.stopLossPercent, 3.5);
  assert.equal(W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG.stopLoss2Percent, 7.0);
  assert.equal(W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG.minBottomFloorRatio, 0.998);
  assert.equal(W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG.filterLowerBottoms, true);
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

  // 35 bars gradual uptrend / flat around 100
  for (let i = 0; i < 35; i++) {
    const price = 95 + (i / 35) * 5;
    candles.push({
      time: baseTime + i * 60000,
      open: price - 0.1,
      high: price + 0.2,
      low: price - 0.1,
      close: price,
      volume: 100,
    });
  }

  // Sharp drop to first bottom at bar 55 (price 90.0, drop ~10%)
  for (let i = 35; i <= 55; i++) {
    const price = 100 - ((i - 34) / 21) * 10;
    candles.push({
      time: baseTime + i * 60000,
      open: price + 0.2,
      high: price + 0.3,
      low: price - 0.2,
      close: price,
      volume: 150,
    });
  }

  // Neckline bounce from 90 to 93.5 (bar 56..65, bounce ~3.8% >= 1.5%)
  for (let i = 56; i <= 65; i++) {
    const price = 90 + ((i - 55) / 10) * 3.5;
    candles.push({
      time: baseTime + i * 60000,
      open: price - 0.1,
      high: price + 0.2,
      low: price - 0.1,
      close: price,
      volume: 80,
    });
  }

  // Slower, gentler drift to second bottom at bar 75 (price 90.1 >= 90.0 -> MACD DIF divergence)
  for (let i = 66; i <= 75; i++) {
    const price = 93.5 - ((i - 65) / 10) * 3.4;
    candles.push({
      time: baseTime + i * 60000,
      open: price + 0.1,
      high: price + 0.2,
      low: price - 0.1,
      close: price,
      volume: 50,
    });
  }

  // Candle 76 (target): catapult green candle breaking previous high
  candles.push({
    time: baseTime + 76 * 60000,
    open: 90.2,
    high: 91.8,
    low: 90.1,
    close: 91.6,
    volume: 200,
  });

  // Candle 77 (forming bar)
  candles.push({
    time: baseTime + 77 * 60000,
    open: 91.6,
    high: 91.9,
    low: 91.5,
    close: 91.8,
    volume: 60,
  });

  const signal = tracker.checkCandles('CATAPULTUSDT', 28.0, 2, candles, now);
  assert.ok(signal, 'Signal should trigger on valid W-bottom');
  assert.equal(signal.type, 'w_bottom_divergence');
  assert.equal(signal.label, '左侧3W底背离');
  assert.equal(signal.side, 'LONG');
  assert.equal(signal.exitParams.stopLossPercent, 3.5);
  assert.equal(signal.exitParams.stopLoss2Percent, 7.0);
});

test('UnifiedLongStrategyTracker strictly rejects when bottoms are lowering (过滤底比底低 / 破位)', () => {
  const tracker = new UnifiedLongStrategyTracker({
    enableWBottomDivergence: true,
  });

  const now = Date.now();
  const baseTime = now - 90 * 60000;

  // Helper to build base candles
  const makeCandles = (secondBottomLow: number, intermediateLow: number) => {
    const candles: Candle[] = [];
    for (let i = 0; i < 35; i++) {
      const price = 95 + (i / 35) * 5;
      candles.push({ time: baseTime + i * 60000, open: price - 0.1, high: price + 0.2, low: price - 0.1, close: price, volume: 100 });
    }
    for (let i = 35; i <= 55; i++) {
      const price = 100 - ((i - 34) / 21) * 10;
      candles.push({ time: baseTime + i * 60000, open: price + 0.2, high: price + 0.3, low: price - 0.2, close: price, volume: 150 });
    }
    for (let i = 56; i <= 65; i++) {
      const price = 90 + ((i - 55) / 10) * 3.5;
      candles.push({ time: baseTime + i * 60000, open: price - 0.1, high: price + 0.2, low: price - 0.1, close: price, volume: 80 });
    }
    for (let i = 66; i <= 75; i++) {
      const price = 93.5 - ((i - 65) / 10) * (93.5 - secondBottomLow);
      const lowVal = (i === 70 && intermediateLow < secondBottomLow) ? intermediateLow : price - 0.1;
      candles.push({ time: baseTime + i * 60000, open: price + 0.1, high: price + 0.2, low: Math.min(price - 0.1, lowVal), close: price, volume: 50 });
    }
    candles.push({ time: baseTime + 76 * 60000, open: secondBottomLow + 0.1, high: secondBottomLow + 1.6, low: secondBottomLow, close: secondBottomLow + 1.5, volume: 200 });
    candles.push({ time: baseTime + 77 * 60000, open: secondBottomLow + 1.5, high: secondBottomLow + 1.8, low: secondBottomLow + 1.4, close: secondBottomLow + 1.7, volume: 60 });
    return candles;
  };

  // Case 1: Second bottom is LOWER than first bottom (88.0 < 90.0 -> 底比底低)
  const lowerBottomCandles = makeCandles(88.0, 89.0);
  const sigLower = tracker.checkCandles('LOWERUSDT', 28.0, 2, lowerBottomCandles, now);
  assert.equal(sigLower, null, 'Should filter out when second bottom is lower than first bottom');

  // Case 2: Intermediate bar plunged below first bottom (88.0 < 90.0 -> 中途破位下探)
  const breakdownCandles = makeCandles(90.1, 88.0);
  const sigBreakdown = tracker.checkCandles('BREAKUSDT', 28.0, 2, breakdownCandles, now);
  assert.equal(sigBreakdown, null, 'Should filter out when intermediate low breaks below bottom support');
});

test('PaperTradingEngine: executes two-stage stop loss independently (SL1 cuts 50%, SL2 cuts remaining 50%)', () => {
  const engine = new PaperTradingEngine({
    initialBalanceUsdt: 100,
    marginUsdt: 20,
    leverage: 3,
    takerFeeBps: 0,
    slippageBps: 0,
    stopAtLow: false,
    storageFile: null,
  });

  const now = 1700000000000;
  const pos = engine.openPosition({
    symbol: "TWOSTAGEUSDT",
    side: "LONG",
    dayChangePercent: 25.0,
    entryPrice: 100.0,
    entryTime: now,
    signalType: "w_bottom_divergence",
    exitParams: {
      holdMinutes: 30,
      tp1Percent: 3.0,
      tp2Percent: 8.0,
      stopLossPercent: 3.5,
      stopLoss2Percent: 7.0,
      moveSlToEntryAfterTp1: true,
      leverage: 3,
    },
    signal: {
      candle: { time: now - 60000, open: 101, high: 102, low: 99.5, close: 100, volume: 1000 },
      streakCount: 0,
      amp30Percent: 10.0,
      upperShadowRatio: 0,
      greenRatio: 0,
      consecutiveGreenBars: 0,
    },
  });

  // Verify SL1 and SL2 are different percentages and price levels
  assert.equal(pos.sl1Percent, 3.5);
  assert.equal(pos.sl2Percent, 7.0);
  assert.ok(Math.abs(pos.sl1Price - 96.5) < 1e-4);
  assert.ok(Math.abs(pos.sl2Price - 93.0) < 1e-4);

  // 1. Tick reaches 96.5 -> triggers Stage 1 stop loss ONLY
  engine.onTick({ symbol: "TWOSTAGEUSDT", price: 96.5, time: now + 60000 });
  assert.equal(pos.remainingFraction, 0.5, "Stage 1 stop must cut 50% of the position");
  assert.equal(pos.status, "PARTIAL");
  assert.equal(pos.exits.length, 1);
  assert.equal(pos.exits[0].stage, 1);
  assert.equal(pos.exits[0].reason, "stop");

  // 2. Price recovers slightly to 95.0 -> position remains PARTIAL
  engine.onTick({ symbol: "TWOSTAGEUSDT", price: 95.0, time: now + 120000 });
  assert.equal(pos.remainingFraction, 0.5);
  assert.equal(pos.status, "PARTIAL");

  // 3. Price drops to 93.0 -> triggers Stage 2 stop loss
  engine.onTick({ symbol: "TWOSTAGEUSDT", price: 93.0, time: now + 180000 });
  assert.equal(pos.remainingFraction, 0, "Stage 2 stop must close remaining 50%");
  assert.equal(pos.status, "CLOSED");
  assert.equal(pos.exits.length, 2);
  assert.equal(pos.exits[1].stage, 2);
  assert.equal(pos.exits[1].reason, "stop");
  assert.equal(pos.finalReason, "stop");
});
