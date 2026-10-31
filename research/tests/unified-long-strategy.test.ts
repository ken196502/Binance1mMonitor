import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  UnifiedLongStrategyTracker,
  GOLDEN_PULLBACK_LIVE_DEFAULT_CONFIG,
  DEEP_SUPPORT_LIVE_DEFAULT_CONFIG,
  RANK1_PULLBACK_LIVE_DEFAULT_CONFIG,
  SECOND_WAVE_EXPANSION_LIVE_DEFAULT_CONFIG,
} from '../../src/unified-long-strategy.ts';

test('Default Long strategy configurations match verified specifications (100% Gainers Focus)', () => {
  // 1. 龙头 MA30 黄金生命线回踩做多 (实测 75.7% 胜率, 净收益 +29.74%)
  assert.equal(GOLDEN_PULLBACK_LIVE_DEFAULT_CONFIG.topN, 10);
  assert.equal(GOLDEN_PULLBACK_LIVE_DEFAULT_CONFIG.minDayChange, 25.0);
  assert.equal(GOLDEN_PULLBACK_LIVE_DEFAULT_CONFIG.minPullbackPercent, 10.0);
  assert.equal(GOLDEN_PULLBACK_LIVE_DEFAULT_CONFIG.maxPullbackPercent, 20.0);
  assert.equal(GOLDEN_PULLBACK_LIVE_DEFAULT_CONFIG.maPeriod, 30);
  assert.equal(GOLDEN_PULLBACK_LIVE_DEFAULT_CONFIG.requireMaSlopeUp, true);
  assert.equal(GOLDEN_PULLBACK_LIVE_DEFAULT_CONFIG.requireMacdPositive, true);
  assert.equal(GOLDEN_PULLBACK_LIVE_DEFAULT_CONFIG.holdMinutes, 90);
  assert.equal(GOLDEN_PULLBACK_LIVE_DEFAULT_CONFIG.stopLossPercent, 8.0);
  assert.equal(GOLDEN_PULLBACK_LIVE_DEFAULT_CONFIG.tp1Percent, 3.0);
  assert.equal(GOLDEN_PULLBACK_LIVE_DEFAULT_CONFIG.tp2Percent, 8.0);
  assert.equal(GOLDEN_PULLBACK_LIVE_DEFAULT_CONFIG.leverage, 3);

  // 2. 龙头 MA60 深度托底做多 (实测 77.8% 胜率)
  assert.equal(DEEP_SUPPORT_LIVE_DEFAULT_CONFIG.topN, 10);
  assert.equal(DEEP_SUPPORT_LIVE_DEFAULT_CONFIG.minDayChange, 25.0);
  assert.equal(DEEP_SUPPORT_LIVE_DEFAULT_CONFIG.minPullbackPercent, 14.0);
  assert.equal(DEEP_SUPPORT_LIVE_DEFAULT_CONFIG.maxPullbackPercent, 25.0);
  assert.equal(DEEP_SUPPORT_LIVE_DEFAULT_CONFIG.maPeriod, 60);
  assert.equal(DEEP_SUPPORT_LIVE_DEFAULT_CONFIG.requireMaSlopeUp, true);
  assert.equal(DEEP_SUPPORT_LIVE_DEFAULT_CONFIG.requireMacdPositive, true);
  assert.equal(DEEP_SUPPORT_LIVE_DEFAULT_CONFIG.holdMinutes, 60);
  assert.equal(DEEP_SUPPORT_LIVE_DEFAULT_CONFIG.stopLossPercent, 7.0);
  assert.equal(DEEP_SUPPORT_LIVE_DEFAULT_CONFIG.tp1Percent, 3.0);
  assert.equal(DEEP_SUPPORT_LIVE_DEFAULT_CONFIG.tp2Percent, 8.0);
  assert.equal(DEEP_SUPPORT_LIVE_DEFAULT_CONFIG.leverage, 3);

  // 3. 榜一首次回踩状态机做多 (实测 71.4% 胜率)
  assert.equal(RANK1_PULLBACK_LIVE_DEFAULT_CONFIG.minDayChange, 25.0);
  assert.equal(RANK1_PULLBACK_LIVE_DEFAULT_CONFIG.minPullbackPercent, 10.0);
  assert.equal(RANK1_PULLBACK_LIVE_DEFAULT_CONFIG.maxPullbackPercent, 18.0);
  assert.equal(RANK1_PULLBACK_LIVE_DEFAULT_CONFIG.holdMinutes, 60);
  assert.equal(RANK1_PULLBACK_LIVE_DEFAULT_CONFIG.stopLossPercent, 6.0);
  assert.equal(RANK1_PULLBACK_LIVE_DEFAULT_CONFIG.tp1Percent, 3.5);
  assert.equal(RANK1_PULLBACK_LIVE_DEFAULT_CONFIG.tp2Percent, 8.0);
  assert.equal(RANK1_PULLBACK_LIVE_DEFAULT_CONFIG.leverage, 3);

  // 4. 二浪金叉放量突破做多
  assert.equal(SECOND_WAVE_EXPANSION_LIVE_DEFAULT_CONFIG.topN, 10);
  assert.equal(SECOND_WAVE_EXPANSION_LIVE_DEFAULT_CONFIG.minDayChange, 20.0);
  assert.equal(SECOND_WAVE_EXPANSION_LIVE_DEFAULT_CONFIG.minBarReturn, 0.8);
  assert.equal(SECOND_WAVE_EXPANSION_LIVE_DEFAULT_CONFIG.minBodyRatio, 0.60);
  assert.equal(SECOND_WAVE_EXPANSION_LIVE_DEFAULT_CONFIG.holdMinutes, 45);
  assert.equal(SECOND_WAVE_EXPANSION_LIVE_DEFAULT_CONFIG.stopLossPercent, 5.0);
});

test('UnifiedLongStrategyTracker correctly prevents position conflict and tracks cooldown', () => {
  const tracker = new UnifiedLongStrategyTracker();
  const symbol = 'BTCUSDT';
  const now = Date.now();

  assert.equal(tracker.isSymbolBusy(symbol, now), false);

  tracker.registerPosition(symbol, {
    tradeId: 'trade-long-1',
    type: 'ma30_pullback',
    entryTime: now,
    maxExitTime: now + 90 * 60000,
  });

  assert.equal(tracker.isSymbolBusy(symbol, now + 1000), true);
  assert.equal(tracker.isSymbolBusy(symbol, now + 90 * 60000 + 1), false);

  tracker.closePosition(symbol);
  assert.equal(tracker.isSymbolBusy(symbol, now + 1000), false);
});
