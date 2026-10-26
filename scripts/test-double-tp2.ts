import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import { planWatchlistMinutes, loadWatchlistMinutes } from '../research/peak-rebound-data.ts';
import { buildPeakReboundSignals } from '../research/peak-rebound-signals.ts';
import { backtestPeakRebound } from '../research/peak-rebound-backtest.ts';
import { loadGainersMinutes } from '../research/gainers-data.ts';
import { buildWickSignals } from '../research/wick-signals.ts';
import { backtestWick } from '../research/wick-backtest.ts';
import { WICK_CONFIG } from '../research/wick-config.ts';

async function runComparison() {
  console.log('================================================================');
  console.log('🔬【第二阶段止盈放大一倍】回测对比实验');
  console.log('================================================================\n');

  // ===========================================================================
  // 一、空弱反弹 (Peak Rebound Short)
  // ===========================================================================
  console.log('----------------------------------------------------------------');
  console.log('【实验一：空弱反弹 (Peak Rebound Short)】');
  console.log('----------------------------------------------------------------');

  const hourly168Dir = path.resolve('data/research/hourly-168h');
  const minutes168Dir = path.resolve('data/research/peak-rebound-1m-168h');

  const hourly168 = await loadDataset(hourly168Dir);
  const frames168 = buildFrames(hourly168, 10, 1);
  const plan168 = planWatchlistMinutes(hourly168, frames168);
  const minuteData168 = await loadWatchlistMinutes(minutes168Dir, plan168);

  // 1. 生成空弱反弹信号 (标准过滤: MA5/15/30 空头排列, MA30高于高点>=0.5%, MA5阻击, 回撤10%, 反弹4%, MACD绿柱>65%, MA下倾)
  const reboundSignals = buildPeakReboundSignals(minuteData168, frames168, {
    pullbackX: 10.0,
    reboundY: 4.0,
    shortMa: 5,
    mediumMa: 15,
    longMa: 30,
    longMaOffsetPercent: 0.5,
    minGreenRatio20: 0.65,
    requireMaSlopeDown: true,
  });

  console.log(`有效空弱反弹信号: ${reboundSignals.length} 个 (涵盖 168 小时内 18 个强势榜首币)`);

  const reboundCases = [
    {
      name: '基准方案 A: m = 1.5, 最长持仓 30m',
      params: { pullbackX: 10.0, reboundY: 4.0, maPeriods: [5, 15, 30], holdMinutes: 30, exitX: 35, exitN: 2.0, exitM: 1.5 },
    },
    {
      name: '放大方案 B: m = 3.0 (止盈翻倍), 持仓 30m',
      params: { pullbackX: 10.0, reboundY: 4.0, maPeriods: [5, 15, 30], holdMinutes: 30, exitX: 35, exitN: 2.0, exitM: 3.0 },
    },
    {
      name: '放大方案 C: m = 3.0 (止盈翻倍), 放宽持仓 45m',
      params: { pullbackX: 10.0, reboundY: 4.0, maPeriods: [5, 15, 30], holdMinutes: 45, exitX: 35, exitN: 2.0, exitM: 3.0 },
    },
    {
      name: '放大方案 D: m = 3.0 (止盈翻倍), 充裕持仓 60m',
      params: { pullbackX: 10.0, reboundY: 4.0, maPeriods: [5, 15, 30], holdMinutes: 60, exitX: 35, exitN: 2.0, exitM: 3.0 },
    },
  ];

  const reboundResults = [];

  for (const tc of reboundCases) {
    const { metrics, trades } = backtestPeakRebound(
      minuteData168,
      reboundSignals,
      tc.params,
      hourly168.manifest.start,
      hourly168.manifest.end,
      { takerFeeBps: 5, slippageBps: 2 }
    );

    const s2Target = trades.filter((t) => t.exits[1]?.reason === 'target').length;
    const s2Stop = trades.filter((t) => t.exits[1]?.reason === 'stop').length;
    const s2Timeout = trades.filter((t) => t.exits[1]?.reason === 'timeout').length;

    reboundResults.push({
      name: tc.name,
      trades: metrics.trades,
      wins: metrics.wins,
      losses: metrics.losses,
      winRate: metrics.winRate ?? 0,
      netPnl: metrics.netPnlPercent,
      profitFactor: metrics.profitFactor ?? 0,
      rewardRisk: metrics.realizedRewardRisk ?? 0,
      meanWin: metrics.meanWinPercent ?? 0,
      meanLoss: metrics.meanLossPercent ?? 0,
      s2Target,
      s2Timeout,
      s2Stop,
      rawTrades: trades,
    });
  }

  console.log('\n📊 空弱反弹各方案回测对比:');
  console.log('--------------------------------------------------------------------------------------------------------------------');
  console.log(
    '方案名称'.padEnd(38) +
    '交易数'.padStart(7) +
    '胜率'.padStart(8) +
    '净收益%'.padStart(10) +
    '盈利因子'.padStart(10) +
    '盈亏比'.padStart(8) +
    '段2止盈'.padStart(9) +
    '段2超时'.padStart(9) +
    '段2止损'.padStart(9)
  );
  console.log('--------------------------------------------------------------------------------------------------------------------');

  for (const r of reboundResults) {
    console.log(
      r.name.padEnd(38) +
      String(r.trades).padStart(7) +
      `${r.winRate.toFixed(1)}%`.padStart(8) +
      `${r.netPnl >= 0 ? '+' : ''}${r.netPnl.toFixed(2)}%`.padStart(10) +
      r.profitFactor.toFixed(2).padStart(10) +
      r.rewardRisk.toFixed(2).padStart(8) +
      String(r.s2Target).padStart(9) +
      String(r.s2Timeout).padStart(9) +
      String(r.s2Stop).padStart(9)
    );
  }
  console.log('--------------------------------------------------------------------------------------------------------------------\n');

  // ===========================================================================
  // 二、空连阳 (Streak Short)
  // ===========================================================================
  console.log('----------------------------------------------------------------');
  console.log('【实验二：空连阳 (Streak Short)】');
  console.log('----------------------------------------------------------------');

  const hourly72Dir = path.resolve('data/research/hourly-20261020-20261023');
  const minutes72Dir = path.resolve('data/research/staged-1m-20261020-20261023');

  const hourly72 = await loadDataset(hourly72Dir);
  const frames72 = buildFrames(hourly72, 10, 1);
  const manifest72 = JSON.parse(await readFile(path.join(minutes72Dir, 'manifest.json'), 'utf8'));
  const minuteData72 = await loadGainersMinutes(minutes72Dir, manifest72.plan);

  const streakConfig = {
    ...WICK_CONFIG,
    topN: 10,
    minStreakCount: 2,
    supportMaPeriods: [3, 7, 15] as readonly number[],
    minGreenRatio: 0.70,
    minConsecutiveGreenBars: 7,
    maxUpperShadowRatio: 0.30,
    minUpperShadowRatio: 0.005,
    holdMinutes: 15,
    exitX: 50,
    exitN: 1.5,
    exitM: 3.0,
    takerFeeBps: 5,
    slippageBps: 2,
  };

  const streakSignals = buildWickSignals(minuteData72, frames72, streakConfig);
  console.log(`有效空连阳信号: ${streakSignals.length} 个 (涵盖 72 小时内 Top 10 入榜标的池)`);

  const streakCases = [
    {
      name: '基准方案 A: M = 3.0, 最长持仓 15m',
      params: { holdMinutes: 15, exitX: 50, exitN: 1.5, exitM: 3.0, minGreenRatio: 0.70, minConsecutiveGreenBars: 7, maxUpperShadowRatio: 0.30 },
    },
    {
      name: '放大方案 B: M = 6.0 (止盈翻倍), 持仓 15m',
      params: { holdMinutes: 15, exitX: 50, exitN: 1.5, exitM: 6.0, minGreenRatio: 0.70, minConsecutiveGreenBars: 7, maxUpperShadowRatio: 0.30 },
    },
    {
      name: '放大方案 C: M = 6.0 (止盈翻倍), 放宽持仓 30m',
      params: { holdMinutes: 30, exitX: 50, exitN: 1.5, exitM: 6.0, minGreenRatio: 0.70, minConsecutiveGreenBars: 7, maxUpperShadowRatio: 0.30 },
    },
    {
      name: '放大方案 D: M = 4.5 (适度放大 1.5倍), 持仓 15m',
      params: { holdMinutes: 15, exitX: 50, exitN: 1.5, exitM: 4.5, minGreenRatio: 0.70, minConsecutiveGreenBars: 7, maxUpperShadowRatio: 0.30 },
    },
  ];

  const streakResults = [];

  for (const sc of streakCases) {
    const { metrics: summary, trades } = backtestWick(
      minuteData72,
      streakSignals,
      sc.params as any,
      streakConfig,
      hourly72.manifest.start,
      hourly72.manifest.end
    );

    const s2Target = trades.filter((t) => t.exits[1]?.reason === 'target').length;
    const s2Timeout = trades.filter((t) => t.exits[1]?.reason === 'timeout').length;
    const s2Stop = trades.filter((t) => t.exits[1]?.reason === 'stop').length;

    streakResults.push({
      name: sc.name,
      trades: summary.trades,
      wins: summary.wins,
      losses: summary.losses,
      winRate: summary.winRate ?? 0,
      netPnl: summary.sumNetPercent,
      profitFactor: summary.profitFactor,
      rewardRisk: summary.realizedRewardRisk ?? 0,
      meanWin: summary.meanWinPercent ?? 0,
      meanLoss: summary.meanLossPercent ?? 0,
      exitsTarget: s2Target,
      exitsTimeout: s2Timeout,
      exitsStop: s2Stop,
      rawTrades: trades,
    });
  }

  console.log('\n📊 空连阳各方案回测对比:');
  console.log('--------------------------------------------------------------------------------------------------------------------');
  console.log(
    '方案名称'.padEnd(38) +
    '交易数'.padStart(7) +
    '胜率'.padStart(8) +
    '净收益%'.padStart(10) +
    '盈利因子'.padStart(10) +
    '盈亏比'.padStart(8) +
    '终局止盈'.padStart(9) +
    '终局超时'.padStart(9) +
    '终局止损'.padStart(9)
  );
  console.log('--------------------------------------------------------------------------------------------------------------------');

  for (const r of streakResults) {
    console.log(
      r.name.padEnd(38) +
      String(r.trades).padStart(7) +
      `${r.winRate.toFixed(1)}%`.padStart(8) +
      `${r.netPnl >= 0 ? '+' : ''}${r.netPnl.toFixed(2)}%`.padStart(10) +
      (r.profitFactor == null ? 'N/A' : r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(2)).padStart(10) +
      r.rewardRisk.toFixed(2).padStart(8) +
      String(r.exitsTarget).padStart(9) +
      String(r.exitsTimeout).padStart(9) +
      String(r.exitsStop).padStart(9)
    );
  }
  console.log('--------------------------------------------------------------------------------------------------------------------\n');
}

runComparison().catch((e) => {
  console.error(e);
  process.exit(1);
});
