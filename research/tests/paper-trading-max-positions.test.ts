import test from 'node:test';
import assert from 'node:assert/strict';
import { PaperTradingEngine, PAPER_DEFAULT_CONFIG } from '../../src/paper-trading.ts';
import type { Candle } from '../../src/macd.ts';
import type { Ticker24h } from '../../src/binance.ts';

test('PaperTradingEngine: dynamic 20% margin scales with account equity', () => {
  const engine = new PaperTradingEngine({
    initialBalanceUsdt: 100,
    marginRate: 0.20,
    storageFile: null,
  });

  // At 100 USDT equity, dynamic margin should be 20 USDT
  assert.equal(engine.calculateOrderMargin(), 20);

  // Manually open a winning trade that grows equity to 200 USDT
  const candle: Candle = { time: 1000, open: 100, high: 101, low: 99, close: 100, volume: 100 };
  const pos = engine.openPosition({
    symbol: 'WINUSDT',
    dayChangePercent: 30,
    entryPrice: 100,
    entryTime: 1000,
    signal: {
      candle,
      streakCount: 2,
      amp30Percent: 8,
      upperShadowRatio: 0.1,
      greenRatio: 0.8,
      consecutiveGreenBars: 5,
    },
    signalType: 'streak',
  });

  assert.equal(pos.marginUsdt, 20, 'Initial position uses 20% of 100U = 20U');

  // Simulate tick price dropping to TP1 -> TP2
  engine.onTick({ symbol: 'WINUSDT', price: pos.tp1Price - 0.1, qty: 1, time: 2000 });
  engine.onTick({ symbol: 'WINUSDT', price: pos.tp2Price - 0.1, qty: 1, time: 3000 });

  // Now update balance directly to test equity scaling
  const summary1 = engine.getSummary();
  assert.ok(summary1.account.balanceUsdt > 100);

  // If equity is updated to 250 USDT, margin should be 250 * 20% = 50 USDT
  (engine as any).account.balanceUsdt = 250;
  (engine as any).account.equityUsdt = 250;
  assert.equal(engine.calculateOrderMargin(), 50, '20% of 250U equity should be 50U');

  // If equity drops to 60 USDT, margin should be 60 * 20% = 12 USDT
  (engine as any).account.balanceUsdt = 60;
  (engine as any).account.equityUsdt = 60;
  assert.equal(engine.calculateOrderMargin(), 12, '20% of 60U equity should be 12U');

  // If equity drops severely to 15 USDT, margin should be minimum 5 USDT
  (engine as any).account.balanceUsdt = 15;
  (engine as any).account.equityUsdt = 15;
  assert.equal(engine.calculateOrderMargin(), 5, 'Minimum margin floor is 5U');
});

test('PaperTradingEngine: enforces maxPositions and maxPositionsPerStrategy (at least 1 per strategy)', async () => {
  const engine = new PaperTradingEngine({
    initialBalanceUsdt: 100,
    marginRate: 0.20,
    maxPositions: 4,
    maxPositionsPerStrategy: 1, // Each strategy can hold at most 1, guaranteeing slots for other strategies
    storageFile: null,
  });

  const candle: Candle = { time: 1000, open: 100, high: 101, low: 99, close: 100, volume: 100 };
  const mockSignal = {
    candle,
    streakCount: 2,
    amp30Percent: 8,
    upperShadowRatio: 0.1,
    greenRatio: 0.8,
    consecutiveGreenBars: 5,
  };

  // Open 1 position for streak
  engine.openPosition({
    symbol: 'SYM_STREAK_1',
    dayChangePercent: 25,
    entryPrice: 100,
    entryTime: 1000,
    signal: mockSignal,
    signalType: 'streak',
  });
  assert.equal(engine.countPositionsByStrategy('streak'), 1);

  // Open 1 position for rebound
  engine.openPosition({
    symbol: 'SYM_REBOUND_1',
    dayChangePercent: 30,
    entryPrice: 50,
    entryTime: 1000,
    signal: mockSignal,
    signalType: 'rebound',
  });
  assert.equal(engine.countPositionsByStrategy('rebound'), 1);

  // Open 1 position for deep_rebound
  engine.openPosition({
    symbol: 'SYM_DEEP_1',
    dayChangePercent: 20,
    entryPrice: 30,
    entryTime: 1000,
    signal: mockSignal,
    signalType: 'deep_rebound',
  });
  assert.equal(engine.countPositionsByStrategy('deep_rebound'), 1);

  // Open 1 position for extreme_dev
  engine.openPosition({
    symbol: 'SYM_DEV_1',
    dayChangePercent: 35,
    entryPrice: 80,
    entryTime: 1000,
    signal: mockSignal,
    signalType: 'extreme_dev',
  });
  assert.equal(engine.countPositionsByStrategy('extreme_dev'), 1);

  // All 4 strategies hold 1 position simultaneously!
  const state = engine.getState();
  assert.equal(state.activePositions.length, 4, '4 strategies concurrently active');

  // Check each strategy has 1 active
  assert.equal(engine.countPositionsByStrategy('streak'), 1);
  assert.equal(engine.countPositionsByStrategy('rebound'), 1);
  assert.equal(engine.countPositionsByStrategy('deep_rebound'), 1);
  assert.equal(engine.countPositionsByStrategy('extreme_dev'), 1);

  // Attempting to open another streak while streak has reached quota 1 should be prevented in onScan
  const streakTicker: Ticker24h = {
    symbol: 'SYM_STREAK_2',
    priceChangePercent: 25,
    lastPrice: 100,
    quoteVolume: 1000000,
  } as any;

  const candleMap = new Map<string, { candles1m: Candle[]; initialized: boolean }>();
  // 50 candles
  const testCandles: Candle[] = [];
  for (let i = 0; i < 50; i++) {
    testCandles.push({ time: 1000 + i * 60000, open: 100, high: 102, low: 99, close: 101, volume: 100 });
  }
  candleMap.set('SYM_STREAK_2', { candles1m: testCandles, initialized: true });

  const opened = await engine.onScan([streakTicker], candleMap);
  assert.equal(opened.length, 0, 'Should not open second streak when maxPositionsPerStrategy=1');
  assert.equal(engine.hasActivePosition('SYM_STREAK_2'), false);
});
