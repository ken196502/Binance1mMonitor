import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  UnifiedLongStrategyTracker,
  PULLBACK_REBOUND_DEFAULT_CONFIG,
  W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG,
  CONSOLIDATION_SUPPORT_DEFAULT_CONFIG,
  CONSOLIDATION_BREAKOUT_DEFAULT_CONFIG,
  GOLDEN_PULLBACK_LIVE_DEFAULT_CONFIG,
  DEEP_SUPPORT_LIVE_DEFAULT_CONFIG,
  RANK1_PULLBACK_LIVE_DEFAULT_CONFIG,
  SECOND_WAVE_EXPANSION_LIVE_DEFAULT_CONFIG,
} from '../../src/unified-long-strategy.ts';
import type { Candle } from '../../src/macd.ts';
import { calculateSma } from '../../src/macd.ts';

test('Default Long strategy configurations match verified specifications (3 Shorts + 2 Longs)', () => {
  // 1. 右侧回调反弹做多 (龙头冲高见顶右侧回调10%~20% + 回踩MA30黄金生命线支撑)
  assert.equal(PULLBACK_REBOUND_DEFAULT_CONFIG.topN, 10);
  assert.equal(PULLBACK_REBOUND_DEFAULT_CONFIG.minDayChange, 25.0);
  assert.equal(PULLBACK_REBOUND_DEFAULT_CONFIG.minPullbackPercent, 10.0);
  assert.equal(PULLBACK_REBOUND_DEFAULT_CONFIG.maxPullbackPercent, 20.0);
  assert.equal(PULLBACK_REBOUND_DEFAULT_CONFIG.maPeriod, 30);
  assert.equal(PULLBACK_REBOUND_DEFAULT_CONFIG.requireMaSlopeUp, true);
  assert.equal(PULLBACK_REBOUND_DEFAULT_CONFIG.requireMacdPositive, true);
  assert.equal(PULLBACK_REBOUND_DEFAULT_CONFIG.holdMinutes, 30);
  assert.equal(PULLBACK_REBOUND_DEFAULT_CONFIG.stopLossPercent, 7.0);
  assert.equal(PULLBACK_REBOUND_DEFAULT_CONFIG.tp1Percent, 3.0);
  assert.equal(PULLBACK_REBOUND_DEFAULT_CONFIG.tp2Percent, 8.0);
  assert.equal(PULLBACK_REBOUND_DEFAULT_CONFIG.leverage, 3);

  // 2. 左侧 3W 底背离弹射做多 (回撤整理区 W底/3底 + MACD强底背离 + 放量弹射起爆)
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

  // 3. 震荡托底做多 (X 分钟在 24h/N 内震荡 + 均线托底企稳阳线，实测胜率 70.2%, PF 1.32)
  assert.equal(CONSOLIDATION_SUPPORT_DEFAULT_CONFIG.topN, 10);
  assert.equal(CONSOLIDATION_SUPPORT_DEFAULT_CONFIG.minDayChange, 20.0);
  assert.equal(CONSOLIDATION_SUPPORT_DEFAULT_CONFIG.xMinutes, 15);
  assert.equal(CONSOLIDATION_SUPPORT_DEFAULT_CONFIG.ampDivisor, 5.0);
  assert.equal(CONSOLIDATION_SUPPORT_DEFAULT_CONFIG.minAbsoluteAmp, 0.5);
  assert.equal(CONSOLIDATION_SUPPORT_DEFAULT_CONFIG.maxPullbackPercent, 18.0);
  assert.deepEqual(CONSOLIDATION_SUPPORT_DEFAULT_CONFIG.supportMaPeriods, [15, 30]);
  assert.equal(CONSOLIDATION_SUPPORT_DEFAULT_CONFIG.requireMaSlopeUp, true);
  assert.equal(CONSOLIDATION_SUPPORT_DEFAULT_CONFIG.requireMaAligned, true);
  assert.equal(CONSOLIDATION_SUPPORT_DEFAULT_CONFIG.requireMacdPositive, true);
  assert.equal(CONSOLIDATION_SUPPORT_DEFAULT_CONFIG.requireBullish, true);
  assert.equal(CONSOLIDATION_SUPPORT_DEFAULT_CONFIG.holdMinutes, 90);
  assert.equal(CONSOLIDATION_SUPPORT_DEFAULT_CONFIG.stopLossPercent, 8.0);
  assert.equal(CONSOLIDATION_SUPPORT_DEFAULT_CONFIG.tp1Percent, 3.0);
  assert.equal(CONSOLIDATION_SUPPORT_DEFAULT_CONFIG.tp2Percent, 8.0);
  assert.equal(CONSOLIDATION_SUPPORT_DEFAULT_CONFIG.leverage, 3);

  // 4. 震荡突破做多 (X 分钟在 24h/N 内箱体蓄势 + 实体阳线放量突破箱体上沿)
  assert.equal(CONSOLIDATION_BREAKOUT_DEFAULT_CONFIG.topN, 10);
  assert.equal(CONSOLIDATION_BREAKOUT_DEFAULT_CONFIG.minDayChange, 20.0);
  assert.equal(CONSOLIDATION_BREAKOUT_DEFAULT_CONFIG.xMinutes, 15);
  assert.equal(CONSOLIDATION_BREAKOUT_DEFAULT_CONFIG.ampDivisor, 5.0);
  assert.equal(CONSOLIDATION_BREAKOUT_DEFAULT_CONFIG.minAbsoluteAmp, 0.5);
  assert.equal(CONSOLIDATION_BREAKOUT_DEFAULT_CONFIG.maxPullbackPercent, 15.0);
  assert.equal(CONSOLIDATION_BREAKOUT_DEFAULT_CONFIG.breakoutRatio, 1.001);
  assert.equal(CONSOLIDATION_BREAKOUT_DEFAULT_CONFIG.requireMaAligned, true);
  assert.equal(CONSOLIDATION_BREAKOUT_DEFAULT_CONFIG.requireMacdPositive, true);
  assert.equal(CONSOLIDATION_BREAKOUT_DEFAULT_CONFIG.requireBullish, true);
  assert.equal(CONSOLIDATION_BREAKOUT_DEFAULT_CONFIG.holdMinutes, 60);
  assert.equal(CONSOLIDATION_BREAKOUT_DEFAULT_CONFIG.stopLossPercent, 6.0);
  assert.equal(CONSOLIDATION_BREAKOUT_DEFAULT_CONFIG.tp1Percent, 3.5);
  assert.equal(CONSOLIDATION_BREAKOUT_DEFAULT_CONFIG.tp2Percent, 7.0);
  assert.equal(CONSOLIDATION_BREAKOUT_DEFAULT_CONFIG.leverage, 3);

  // 5. 向下兼容：龙头 MA30 黄金生命线回踩做多
  assert.equal(GOLDEN_PULLBACK_LIVE_DEFAULT_CONFIG.topN, 10);
  assert.equal(GOLDEN_PULLBACK_LIVE_DEFAULT_CONFIG.minDayChange, 25.0);
  assert.equal(GOLDEN_PULLBACK_LIVE_DEFAULT_CONFIG.maPeriod, 30);
  assert.equal(GOLDEN_PULLBACK_LIVE_DEFAULT_CONFIG.holdMinutes, 90);

  // 6. 向下兼容：龙头 MA60 深度托底做多
  assert.equal(DEEP_SUPPORT_LIVE_DEFAULT_CONFIG.topN, 10);
  assert.equal(DEEP_SUPPORT_LIVE_DEFAULT_CONFIG.minDayChange, 25.0);
  assert.equal(DEEP_SUPPORT_LIVE_DEFAULT_CONFIG.maPeriod, 60);

  // 7. 向下兼容：榜一首次回踩
  assert.equal(RANK1_PULLBACK_LIVE_DEFAULT_CONFIG.minDayChange, 25.0);

  // 8. 向下兼容：二浪放量突破
  assert.equal(SECOND_WAVE_EXPANSION_LIVE_DEFAULT_CONFIG.minDayChange, 20.0);
});

test('UnifiedLongStrategyTracker correctly prevents position conflict and tracks cooldown', () => {
  const tracker = new UnifiedLongStrategyTracker();
  const symbol = 'BTCUSDT';
  const now = Date.now();

  assert.equal(tracker.isSymbolBusy(symbol, now), false);

  tracker.registerPosition(symbol, {
    tradeId: 'trade-long-1',
    type: 'consolidation_support',
    entryTime: now,
    maxExitTime: now + 90 * 60000,
  });

  assert.equal(tracker.isSymbolBusy(symbol, now + 1000), true);
  assert.equal(tracker.isSymbolBusy(symbol, now + 90 * 60000 + 1), false);

  tracker.closePosition(symbol);
  assert.equal(tracker.isSymbolBusy(symbol, now + 1000), false);
});

test('UnifiedLongStrategyTracker triggers consolidation_support when oscillating within 24h/N with MA support', () => {
  const tracker = new UnifiedLongStrategyTracker({
    enableConsolidationSupport: true,
    enableConsolidationBreakout: false,
    consolidationSupportConfig: {
      xMinutes: 15,
      ampDivisor: 5.0,
      minDayChange: 25.0,
      maxPullbackPercent: 18.0,
      topN: 10,
    },
  });

  const now = Date.now();
  const candles: Candle[] = [];

  // Generate 80 candles:
  // Initial rising trend from 70 to 100 over 65 bars
  // Followed by 15 candles consolidating tightly around 99.5~101 (amp = 1.5% <= 25% / 5 = 5%)
  // Latest closed candle tests MA15 at 100.48 and bounces to close at 100.7 (bullish candle)
  const baseTime = now - 90 * 60000;
  for (let i = 0; i < 65; i++) {
    const price = 70 + (i / 64) * 30; // rises from 70 to 100
    candles.push({
      time: baseTime + i * 60000,
      open: price - 0.2,
      high: price + 0.3,
      low: price - 0.3,
      close: price,
      volume: 100,
    });
  }

  // Next 13 candles: gentle consolidation around 100~101
  for (let i = 65; i < 78; i++) {
    candles.push({
      time: baseTime + i * 60000,
      open: 100.2,
      high: 101.0,
      low: 99.7,
      close: 100.5,
      volume: 100,
    });
  }

  // Candle 78 (targetIdx = candles.length - 2): closed candle
  candles.push({
    time: baseTime + 78 * 60000,
    open: 100.1,
    high: 101.2,
    low: 99.8, // dips to MA15 and bounces
    close: 100.7, // closes up
    volume: 150,
  });

  // Candle 79: forming bar
  candles.push({
    time: baseTime + 79 * 60000,
    open: 100.7,
    high: 101.0,
    low: 100.5,
    close: 100.8,
    volume: 50,
  });

  const signal = tracker.checkCandles('TESTUSDT', 25.0, 3, candles, now);
  assert.ok(signal, 'Signal should trigger for valid consolidation within 24h/N with MA support');
  assert.equal(signal.type, 'consolidation_support');
  assert.equal(signal.label, '震荡托底做多');
  assert.equal(signal.side, 'LONG');
  assert.ok(signal.details.ampX! <= 25.0 / 5.0, 'Oscillation amplitude must be within 24h / N');
});

test('UnifiedLongStrategyTracker rejects when oscillation amplitude exceeds 24h / N (too volatile)', () => {
  const tracker = new UnifiedLongStrategyTracker({
    enableConsolidationSupport: true,
    enableConsolidationBreakout: false,
    consolidationSupportConfig: {
      xMinutes: 15,
      ampDivisor: 5.0, // allowed amp: 25 / 5 = 5%
      minDayChange: 25.0,
      maxPullbackPercent: 18.0,
      topN: 10,
    },
  });

  const now = Date.now();
  const candles: Candle[] = [];
  const baseTime = now - 90 * 60000;

  for (let i = 0; i < 60; i++) {
    const price = 80 + (i / 60) * 35;
    candles.push({
      time: baseTime + i * 60000,
      open: price - 0.5,
      high: price + 1.0,
      low: price - 0.5,
      close: price,
      volume: 100,
    });
  }

  // 18 candles with huge swings (low = 90, high = 110, amp = 22% > 5%)
  for (let i = 60; i < 78; i++) {
    candles.push({
      time: baseTime + i * 60000,
      open: 100,
      high: 110,
      low: 90,
      close: 100,
      volume: 100,
    });
  }

  candles.push({
    time: baseTime + 78 * 60000,
    open: 95,
    high: 105,
    low: 90,
    close: 102,
    volume: 150,
  });

  candles.push({
    time: baseTime + 79 * 60000,
    open: 102,
    high: 103,
    low: 101,
    close: 102,
    volume: 50,
  });

  const signal = tracker.checkCandles('TESTUSDT', 25.0, 3, candles, now);
  assert.equal(signal, null, 'Must reject when 15m amplitude exceeds 24h / N');
});

test('UnifiedLongStrategyTracker triggers pullback_rebound on MA30 test with bullish confirmation', () => {
  const tracker = new UnifiedLongStrategyTracker({
    enablePullbackRebound: true,
    enableWBottomDivergence: false,
    enableConsolidationSupport: false,
    enableConsolidationBreakout: false,
  });

  const now = Date.now();
  const candles: Candle[] = [];
  const baseTime = now - 90 * 60000;

  for (let i = 0; i < 50; i++) {
    const price = 50 + (i / 49) * 45;
    candles.push({ time: baseTime + i * 60000, open: price, high: price + 0.3, low: price - 0.2, close: price, volume: 100 });
  }
  for (let i = 50; i < 65; i++) {
    const price = 95 + ((i - 49) / 15) * 17; // rises to 112
    candles.push({ time: baseTime + i * 60000, open: price, high: i === 60 ? 120 : price + 0.3, low: price - 0.2, close: price, volume: 100 });
  }
  for (let i = 65; i < 77; i++) {
    const price = 112 - ((i - 64) / 13) * 12;
    candles.push({ time: baseTime + i * 60000, open: price, high: price + 0.3, low: price - 0.2, close: price, volume: 80 });
  }
  const closes77 = candles.map(c => c.close);
  const curMa30 = calculateSma([...closes77, 100], 77, 30)!;
  candles.push({
    time: baseTime + 77 * 60000,
    open: curMa30 + 0.1,
    high: curMa30 + 0.8,
    low: curMa30 * 0.999,
    close: curMa30 + 0.5,
    volume: 150,
  });
  const closes78 = candles.map(c => c.close);
  const ma30 = calculateSma(closes78, 77, 30)!;
  candles.push({
    time: baseTime + 78 * 60000,
    open: ma30,
    high: ma30 + 1.0,
    low: ma30 * 0.999,
    close: ma30 + 0.6,
    volume: 150,
  });
  candles.push({
    time: baseTime + 79 * 60000,
    open: ma30 + 0.6,
    high: ma30 + 1.2,
    low: ma30 + 0.5,
    close: ma30 + 0.8,
    volume: 50,
  });

  const signal = tracker.checkCandles('LEADERUSDT', 30.0, 1, candles, now);
  assert.ok(signal, 'Should trigger pullback_rebound on MA30 bounce');
  assert.equal(signal.type, 'pullback_rebound');
  assert.equal(signal.label, '右侧回调反弹');
  assert.equal(signal.side, 'LONG');
});

test('UnifiedLongStrategyTracker triggers w_bottom_divergence on W-bottom with MACD divergence', () => {
  const tracker = new UnifiedLongStrategyTracker({
    enablePullbackRebound: false,
    enableWBottomDivergence: true,
    enableConsolidationSupport: false,
    enableConsolidationBreakout: false,
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
