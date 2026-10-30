import path from 'node:path';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import { planWatchlistMinutes, loadWatchlistMinutes } from '../research/peak-rebound-data.ts';
import { buildPeakReboundSignals, getRank1Watchlist } from '../research/peak-rebound-signals.ts';
import { backtestPeakRebound } from '../research/peak-rebound-backtest.ts';
import { buildWickSignals } from '../research/wick-signals.ts';
import { backtestWick } from '../research/wick-backtest.ts';
import { WICK_CONFIG } from '../research/wick-config.ts';

async function main() {
  console.log('================================================================');
  console.log('⚡ 极端行情止损测试：标准止损价 vs 1分钟最高点(High)极端止损');
  console.log('================================================================\n');

  const hourlyDir = path.resolve('data/research/hourly-168h');
  const minutesDir = path.resolve('data/research/peak-rebound-1m-168h');

  const hourly = await loadDataset(hourlyDir);
  const frames = buildFrames(hourly, 10, 1);
  const plan = planWatchlistMinutes(hourly, frames);
  const minuteData = await loadWatchlistMinutes(minutesDir, plan);

  // -------------------------------------------------------------
  // 策略一：空弱反弹策略 (Peak Rebound Short)
  // -------------------------------------------------------------
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

  const reboundBacktestParams = {
    pullbackX: 10.0,
    reboundY: 4.0,
    shortMa: 5,
    mediumMa: 15,
    longMa: 30,
    longMaOffsetPercent: 0.5,
    minGreenRatio20: 0.65,
    maPeriods: [5, 15, 30],
    holdMinutes: 30,
    exitX: 35,
    exitN: 2.0,
    exitM: 1.5,
  };

  const rebStd = backtestPeakRebound(
    minuteData,
    reboundSignals,
    reboundBacktestParams,
    hourly.manifest.start,
    hourly.manifest.end,
    { takerFeeBps: 5, slippageBps: 2, stopAtHigh: false }
  );

  const rebExt = backtestPeakRebound(
    minuteData,
    reboundSignals,
    reboundBacktestParams,
    hourly.manifest.start,
    hourly.manifest.end,
    { takerFeeBps: 5, slippageBps: 2, stopAtHigh: true }
  );

  // -------------------------------------------------------------
  // 策略二：空连阳策略 (Streak Short)
  // -------------------------------------------------------------
  const streakSignals = buildWickSignals(minuteData, frames, {
    topN: 10,
    indicatorWindow: 199,
    minStreakCount: 2,
    gainMode: 'day-fraction',
    dayGainFraction: 0.05,
    minStreakGainPercent: 1,
    minDayChangePercent: 0,
    minGreenRatio: 0.7,
    minConsecutiveGreenBars: 7,
    maxUpperShadowRatio: 0.3,
    supportMaPeriods: [3, 7, 15],
    takerFeeBps: 5,
    slippageBps: 2,
    holdMinutes: [15],
    exitX: 50,
    exitN: 1.5,
    exitM: 3.0,
  } as any);

  const streakStd = backtestWick(
    minuteData,
    streakSignals,
    { holdMinutes: 15, firstTakeProfitPercent: 0.2, firstStopLossPercent: 0.2, finalTakeProfitPercent: 1.0, finalStopLossPercent: 0.3 },
    { ...WICK_CONFIG, takerFeeBps: 5, slippageBps: 2, stopAtHigh: false },
    hourly.manifest.start,
    hourly.manifest.end
  );

  const streakExt = backtestWick(
    minuteData,
    streakSignals,
    { holdMinutes: 15, firstTakeProfitPercent: 0.2, firstStopLossPercent: 0.2, finalTakeProfitPercent: 1.0, finalStopLossPercent: 0.3 },
    { ...WICK_CONFIG, takerFeeBps: 5, slippageBps: 2, stopAtHigh: true },
    hourly.manifest.start,
    hourly.manifest.end
  );

  console.log('================================================================');
  console.log('📊 策略一【空弱反弹 Peak Rebound Short】回测指标对比:');
  console.log('================================================================');
  console.log(`指标                     | 【标准止损价平仓】      | 【极端1m最高点(High)平仓】`);
  console.log('----------------------------------------------------------------');
  console.log(`交易笔数 (Trades)        | ${String(rebStd.metrics.trades).padEnd(23)} | ${String(rebExt.metrics.trades).padEnd(23)}`);
  console.log(`胜率 (Win Rate)          | ${(rebStd.metrics.winRate?.toFixed(2) + '%').padEnd(23)} | ${(rebExt.metrics.winRate?.toFixed(2) + '%').padEnd(23)}`);
  console.log(`盈利 / 亏损 笔数         | ${(rebStd.metrics.wins + ' 胜 / ' + rebStd.metrics.losses + ' 负').padEnd(23)} | ${(rebExt.metrics.wins + ' 胜 / ' + rebExt.metrics.losses + ' 负').padEnd(23)}`);
  console.log(`净收益率 (Net PnL)       | ${(rebStd.metrics.netPnlPercent >= 0 ? '+' : '') + rebStd.metrics.netPnlPercent.toFixed(2) + '%'}`.padEnd(25) + `| ${(rebExt.metrics.netPnlPercent >= 0 ? '+' : '') + rebExt.metrics.netPnlPercent.toFixed(2) + '%'}`);
  console.log(`盈利因子 (Profit Factor) | ${String(rebStd.metrics.profitFactor?.toFixed(2) ?? 'N/A').padEnd(23)} | ${String(rebExt.metrics.profitFactor?.toFixed(2) ?? 'N/A').padEnd(23)}`);
  console.log(`盈亏比 (Reward/Risk)     | ${String(rebStd.metrics.realizedRewardRisk?.toFixed(2) ?? 'N/A').padEnd(23)} | ${String(rebExt.metrics.realizedRewardRisk?.toFixed(2) ?? 'N/A').padEnd(23)}`);
  console.log(`平均每笔收益             | ${((rebStd.metrics.meanTradePercent ?? 0) >= 0 ? '+' : '') + (rebStd.metrics.meanTradePercent?.toFixed(2) ?? '0') + '%'}`.padEnd(25) + `| ${((rebExt.metrics.meanTradePercent ?? 0) >= 0 ? '+' : '') + (rebExt.metrics.meanTradePercent?.toFixed(2) ?? '0') + '%'}`);
  console.log(`平均亏损幅度             | ${'-' + (rebStd.metrics.meanLossPercent?.toFixed(2) ?? '0') + '%'}`.padEnd(25) + `| ${'-' + (rebExt.metrics.meanLossPercent?.toFixed(2) ?? '0') + '%'}`);

  console.log('\n================================================================');
  console.log('📊 策略二【空连阳 Streak Short】回测指标对比:');
  console.log('================================================================');
  console.log(`指标                     | 【标准止损价平仓】      | 【极端1m最高点(High)平仓】`);
  console.log('----------------------------------------------------------------');
  console.log(`交易笔数 (Trades)        | ${String(streakStd.metrics.submitted).padEnd(23)} | ${String(streakExt.metrics.submitted).padEnd(23)}`);
  console.log(`胜率 (Win Rate)          | ${(streakStd.metrics.winRate?.toFixed(2) + '%').padEnd(23)} | ${(streakExt.metrics.winRate?.toFixed(2) + '%').padEnd(23)}`);
  console.log(`盈利 / 亏损 笔数         | ${(streakStd.metrics.wins + ' 胜 / ' + streakStd.metrics.losses + ' 负').padEnd(23)} | ${(streakExt.metrics.wins + ' 胜 / ' + streakExt.metrics.losses + ' 负').padEnd(23)}`);
  console.log(`净收益率 (Net PnL)       | ${(streakStd.metrics.sumNetPercent >= 0 ? '+' : '') + streakStd.metrics.sumNetPercent.toFixed(2) + '%'}`.padEnd(25) + `| ${(streakExt.metrics.sumNetPercent >= 0 ? '+' : '') + streakExt.metrics.sumNetPercent.toFixed(2) + '%'}`);
  console.log(`盈利因子 (Profit Factor) | ${String(streakStd.metrics.profitFactor?.toFixed(2) ?? 'N/A').padEnd(23)} | ${String(streakExt.metrics.profitFactor?.toFixed(2) ?? 'N/A').padEnd(23)}`);

  console.log('\n================================================================');
  console.log('🔍 极端最高点止损样本分析 (当发生止损时，最高点与止损线偏差情况):');
  console.log('================================================================');
  let diffCount = 0;
  for (let i = 0; i < rebStd.trades.length; i++) {
    const stdT = rebStd.trades[i];
    const extT = rebExt.trades[i];
    if (stdT.exits.some(e => e.reason === 'stop')) {
      diffCount++;
      const stdLoss = stdT.netPercent;
      const extLoss = extT.netPercent;
      console.log(`[止损 #${diffCount}] ${stdT.signal.symbol} | 入场: ${stdT.entryPrice.toFixed(4)} | 标准净亏: ${stdLoss.toFixed(2)}% → 极端最高点净亏: ${extLoss.toFixed(2)}% (额外亏损: ${(extLoss - stdLoss).toFixed(2)}%)`);
    }
  }
}

main().catch(console.error);
