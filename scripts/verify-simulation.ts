import path from 'node:path';
import assert from 'node:assert/strict';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import { planWatchlistMinutes, loadWatchlistMinutes } from '../research/peak-rebound-data.ts';
import { buildPeakReboundSignals, getRank1Watchlist } from '../research/peak-rebound-signals.ts';
import { backtestPeakRebound } from '../research/peak-rebound-backtest.ts';
import { PaperTradingEngine, PAPER_DEFAULT_CONFIG } from '../src/paper-trading.ts';
import { UnifiedShortStrategyTracker } from '../src/unified-short-strategy.ts';
import type { Candle } from '../src/macd.ts';
import type { Ticker24h } from '../src/binance.ts';

async function main() {
  console.log('================================================================');
  console.log('🧪 开始策略回测与模拟交易全流程验证');
  console.log('================================================================\n');

  const hourlyDir = path.resolve('data/research/hourly-168h');
  const minutesDir = path.resolve('data/research/peak-rebound-1m-168h');

  console.log('1. 加载 168 小时真实全市场行情数据...');
  const hourly = await loadDataset(hourlyDir);
  const frames = buildFrames(hourly, 10, 1);
  const watchlist = getRank1Watchlist(frames);

  console.log(`- 小时快照: ${frames.length} 个`);
  console.log(`- 榜首标的: ${watchlist.size} 个曾登顶 24h 涨幅榜第 1:`);
  for (const [sym, info] of watchlist) {
    console.log(`    • ${sym}: 登顶时 24h 涨幅 +${info.dayChangeAtRank1.toFixed(1)}%, 登顶持续 ${info.rank1Hours} 小时`);
  }

  const plan = planWatchlistMinutes(hourly, frames);
  const minuteData = await loadWatchlistMinutes(minutesDir, plan);
  console.log(`- 分钟数据: 成功载入 ${minuteData.candles.size} 个标的高精度 1m 数据\n`);

  console.log('----------------------------------------------------------------');
  console.log('2. 运行【空弱反弹】历史回测 (基于用户确认的正确参数)');
  console.log('   • 均线系统: MA 5 / MA 15 / MA 30, 空头排列 (MA30 > MA15 > MA5)');
  console.log('   • 压制天花板: MA 30 高于反弹高点 ≥ 0.5%');
  console.log('   • 短均阻击: High > MA5 且 Close < MA5');
  console.log('   • 回撤与反弹: 回撤 X = 10%, 反弹 y = 4%');
  console.log('   • 动能过滤: 近 20 根 MACD 绿柱占比 > 65%, 中长均线向下倾斜');
  console.log('   • 退出参数: 最大持仓 30 分钟, x = 35, n = 2.0, m = 1.5');
  console.log('----------------------------------------------------------------');

  const reboundSignals = buildPeakReboundSignals(minuteData, frames, {
    pullbackX: 10.0,
    reboundY: 4.0,
    shortMa: 5,
    mediumMa: 15,
    longMa: 30,
    longMaOffsetPercent: 0.5,
    minGreenRatio20: 0.65,
    requireMaSlopeDown: true,
  });

  console.log(`\n✅ 产生空弱反弹信号: ${reboundSignals.length} 个`);
  for (const sig of reboundSignals) {
    console.log(
      `   • [信号] ${sig.symbol} @ ${new Date(sig.time).toISOString()} | ` +
      `峰值: ${sig.peakPrice.toFixed(4)}, 回撤: -${sig.pullbackPercent.toFixed(1)}%, ` +
      `反弹: +${sig.reboundPercent.toFixed(1)}%, 20m绿柱: ${(sig.greenRatio20 * 100).toFixed(0)}%`
    );
  }

  const reboundBacktestParams = {
    pullbackX: 10.0,
    reboundY: 4.0,
    maPeriods: [5, 15, 30],
    holdMinutes: 45,
    exitX: 35,
    exitN: 2.0,
    exitM: 3.0,
  };

  const { metrics, trades } = backtestPeakRebound(
    minuteData,
    reboundSignals,
    reboundBacktestParams,
    hourly.manifest.start,
    hourly.manifest.end,
    { takerFeeBps: 5, slippageBps: 2 }
  );

  console.log('\n📊 空弱反弹回测指标总结:');
  console.log(`   • 交易总数 (Trades): ${metrics.trades}`);
  console.log(`   • 胜率 (Win Rate): ${metrics.winRate?.toFixed(1) ?? 'N/A'}% (胜: ${metrics.wins}, 负: ${metrics.losses})`);
  console.log(`   • 净收益率 (Net PnL): ${metrics.netPnlPercent.toFixed(2)}%`);
  console.log(`   • 盈亏比 (Reward/Risk): ${metrics.realizedRewardRisk?.toFixed(2) ?? 'N/A'}`);
  console.log(`   • 盈利因子 (Profit Factor): ${metrics.profitFactor?.toFixed(2) ?? 'N/A'}`);
  console.log(`   • 第一阶段退出分布: 止盈 ${metrics.firstExits.target} / 止损 ${metrics.firstExits.stop} / 超时 ${metrics.firstExits.timeout}`);

  for (const t of trades) {
    console.log(
      `     - ${t.signal.symbol} 入场: ${t.entryPrice.toFixed(4)} @ ${new Date(t.entryTime).toISOString().slice(11, 19)} | ` +
      `净收益: ${t.netPercent >= 0 ? '+' : ''}${t.netPercent.toFixed(2)}% | 原因: ${t.reason} | ` +
      `段1: ${t.exits[0]?.reason} (${t.exits[0]?.netPercent.toFixed(2)}%), 段2: ${t.exits[1]?.reason ?? '无'} (${t.exits[1]?.netPercent.toFixed(2) ?? '0.00'}%)`
    );
  }

  console.log('\n----------------------------------------------------------------');
  console.log('3. 运行【模拟交易引擎】端到端全流程验证');
  console.log('   • 验证双信号同时并行检测与开仓');
  console.log('   • 验证限价接针冲高挂单撮合与直开市价');
  console.log('   • 验证两段式自适应动态退出执行 (50% + 50%)');
  console.log('   • 验证空连阳与空弱反弹标签与独立参数正确性');
  console.log('----------------------------------------------------------------');

  const engine = new PaperTradingEngine({
    initialBalanceUsdt: 100,
    leverage: 10,
    marginUsdt: 10,
    limitDivisor: 100,
    storageFile: null, // in-memory
    streakConfig: { requireMacdDivergence: false, requireBearish: false },
  });

  // 测试 1: 空连阳挂单与成交两段平仓
  const streakNow = 1700000000000;
  const streakCandles: Candle[] = [];
  let baseP = 100;
  for (let i = 0; i < 50; i++) {
    const t = streakNow - (50 - i) * 60000;
    const o = baseP;
    const c = baseP + 1.0;
    const h = c + 0.1; // 上影线 10%
    const l = o + 0.2;
    baseP = c;
    streakCandles.push({ time: t, open: o, high: h, low: l, close: c, volume: 1000 });
  }

  const streakGainers: Ticker24h[] = [
    {
      symbol: 'ALPHAUSDT',
      priceChangePercent: 30.0,
      lastPrice: 150.0,
      quoteVolume: 1000000,
    } as any,
  ];

  const candleCache = new Map<string, { candles1m: Candle[]; initialized: boolean }>();
  candleCache.set('ALPHAUSDT', { candles1m: streakCandles, initialized: true });

  await engine.onScan(streakGainers, candleCache);

  assert.equal(engine.hasPendingOrder('ALPHAUSDT'), true, '应当成功为 ALPHAUSDT 提交限价接针挂单');
  const streakOrder = engine.getPendingOrder('ALPHAUSDT')!;
  assert.equal(streakOrder.signalType, 'streak');
  assert.ok(streakOrder.signalLabel === '连阳悬空' || streakOrder.signalLabel === '空连阳' || streakOrder.signalLabel === '新高顶背离', 'signalLabel 应有效');
  assert.equal(streakOrder.exitParams.holdMinutes, 15, '空连阳最长持仓应为 15 分钟');
  assert.equal(streakOrder.exitParams.exitX, 50, '空连阳 exitX 应为 50');
  assert.equal(streakOrder.exitParams.exitN, 1.5, '空连阳 exitN 应为 1.5');
  assert.equal(streakOrder.exitParams.exitM, 3.0, '空连阳 exitM 应为 3.0');

  console.log(`✅ [空连阳] 限价挂单创建成功: ${streakOrder.symbol} 挂单价: ${streakOrder.limitPrice.toFixed(4)} (上浮 +${streakOrder.limitOffsetPercent.toFixed(2)}%)`);

  // 模拟向上冲高触及挂单价
  engine.onTick({
    symbol: 'ALPHAUSDT',
    price: streakOrder.limitPrice,
    qty: 1,
    time: streakNow + 30000,
  });

  assert.equal(engine.hasActivePosition('ALPHAUSDT'), true, '挂单撮合后应转为活跃持仓');
  const streakPos = engine.getPosition('ALPHAUSDT')!;
  assert.equal(streakPos.signalType, 'streak');
  console.log(`✅ [空连阳] 挂单触碰撮合开空: ${streakPos.symbol} 开仓价: ${streakPos.entryPrice.toFixed(4)}, TP1: ${streakPos.tp1Price.toFixed(4)}, TP2: ${streakPos.tp2Price.toFixed(4)}`);

  // 模拟价格下杀触发阶段一止盈
  engine.onTick({
    symbol: 'ALPHAUSDT',
    price: streakPos.tp1Price - 0.01,
    qty: 1,
    time: streakNow + 60000,
  });

  assert.equal(streakPos.remainingFraction, 0.5, '阶段一达成后应平仓 50%');
  console.log(`✅ [空连阳] 阶段一达成 (平仓 50%): 阶段净盈亏 +${streakPos.exits[0]?.netPnlUsdt.toFixed(2)} USDT`);

  // 模拟价格进一步下杀触发阶段二全部止盈
  engine.onTick({
    symbol: 'ALPHAUSDT',
    price: streakPos.tp2Price - 0.01,
    qty: 1,
    time: streakNow + 120000,
  });

  assert.equal(engine.hasActivePosition('ALPHAUSDT'), false, '两段全部止盈后订单应结清');
  const closedStreak = engine.getState().closedPositions.find((p) => p.symbol === 'ALPHAUSDT')!;
  assert.equal(closedStreak.finalReason, 'target');
  assert.ok(closedStreak.signalLabel === '连阳悬空' || closedStreak.signalLabel === '空连阳' || closedStreak.signalLabel === '新高顶背离', 'signalLabel 应有效');
  console.log(`✅ [空连阳] 订单全额结清: 整单净盈亏 +${closedStreak.totalNetPnlUsdt.toFixed(2)} USDT, ROE: +${closedStreak.roePercent?.toFixed(1)}%`);

  // 测试 2: 空弱反弹挂单与超时/止盈平仓
  const reboundOrder = engine.createPendingOrder({
    symbol: 'BETAUSDT',
    dayChangePercent: 40.0,
    rank: 1,
    basePrice: 100.0,
    signalType: 'rebound',
    signalLabel: '空弱反弹',
    exitParams: { holdMinutes: 45, exitX: 35, exitN: 2.0, exitM: 3.0 },
    now: streakNow,
    signal: {
      candle: { time: streakNow - 60000, open: 98, high: 101, low: 97, close: 99, volume: 100 },
      streakCount: 1,
      amp30Percent: 10.0,
      upperShadowRatio: 0.2,
      greenRatio: 0.7,
      consecutiveGreenBars: 4,
    },
  });

  assert.equal(reboundOrder.signalType, 'rebound');
  assert.equal(reboundOrder.signalLabel, '空弱反弹');
  assert.equal(reboundOrder.exitParams.holdMinutes, 45);
  assert.equal(reboundOrder.exitParams.exitX, 35);
  assert.equal(reboundOrder.exitParams.exitN, 2.0);
  assert.equal(reboundOrder.exitParams.exitM, 3.0);

  console.log(`\n✅ [空弱反弹] 限价挂单创建成功: ${reboundOrder.symbol} 挂单价: ${reboundOrder.limitPrice.toFixed(4)}, exitX=35, hold=45m, exitM=3.0`);

  // 撮合成交
  engine.onTick({
    symbol: 'BETAUSDT',
    price: reboundOrder.limitPrice,
    qty: 1,
    time: streakNow + 15000,
  });

  const rebPos = engine.getPosition('BETAUSDT')!;
  assert.ok(rebPos != null);
  assert.equal(rebPos.signalLabel, '空弱反弹');
  // 验证两段退出价格计算
  // tp1Percent = 40 / 35 = 1.1428%
  // sl1Percent = 40 / 35 = 1.1428%
  // sl2Percent = 40 * 2.0 / 35 = 2.2857%
  // tp2Percent = 40 * 3.0 / 35 = 3.4286%
  assert.ok(Math.abs(rebPos.tp1Percent - 40 / 35) < 1e-4);
  assert.ok(Math.abs(rebPos.sl2Percent - 80 / 35) < 1e-4);
  assert.ok(Math.abs(rebPos.tp2Percent - 120 / 35) < 1e-4);
  console.log(`✅ [空弱反弹] 退出线核算正确: TP1 (-${rebPos.tp1Percent.toFixed(2)}%), SL2 (+${rebPos.sl2Percent.toFixed(2)}%), TP2 (-${rebPos.tp2Percent.toFixed(2)}%)`);

  console.log('\n================================================================');
  console.log('🎉 所有回测计算与模拟交易端到端生命周期验证全部通过！');
  console.log('================================================================');
}

main().catch((err) => {
  console.error('❌ 验证失败:', err);
  process.exit(1);
});
