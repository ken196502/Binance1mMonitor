import path from 'node:path';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import { planWatchlistMinutes, loadWatchlistMinutes } from '../research/peak-rebound-data.ts';
import { buildPeakReboundSignals } from '../research/peak-rebound-signals.ts';
import { backtestPeakRebound } from '../research/peak-rebound-backtest.ts';

async function main() {
  console.log('================================================================');
  console.log('🧪【空弱反弹】1mClose < ma10 << ma60 + ma10 < 1mhigh 回测实验');
  console.log('================================================================\n');

  const hourlyDir = path.resolve('data/research/hourly-168h');
  const minutesDir = path.resolve('data/research/peak-rebound-1m-168h');

  console.log('正在载入 168 小时全市场历史数据...');
  const hourly = await loadDataset(hourlyDir);
  const frames = buildFrames(hourly, 10, 1);
  const plan = planWatchlistMinutes(hourly, frames);
  const minuteData = await loadWatchlistMinutes(minutesDir, plan);
  console.log(`成功载入 ${minuteData.candles.size} 个榜首标的 1m 高精度行情数据。\n`);

  // 定义多组回测对照试验
  const experiments = [
    {
      group: '基准组',
      name: '基准: MA 5/15/30 (MA30压制>=0.5%, 下倾, m=3.0, 45m)',
      signalOptions: {
        pullbackX: 10.0,
        reboundY: 4.0,
        shortMa: 5,
        mediumMa: 15,
        longMa: 30,
        longMaOffsetPercent: 0.5,
        minGreenRatio20: 0.65,
        requireMaSlopeDown: true,
      },
      exitParams: { pullbackX: 10.0, reboundY: 4.0, maPeriods: [5, 15, 30], holdMinutes: 45, exitX: 35, exitN: 2.0, exitM: 3.0 },
    },
    // 用户方案: 1mClose < ma10 << ma60 + ma10 < 1mhigh
    // 解释 1: ma60 >= high * 1.005 (标准天花板 offset=0.5%)
    {
      group: '用户方案 (MA 10/60)',
      name: '方案 1: MA 10/60 (MA60高出高点>=0.5%), 下倾, m=3.0, 45m',
      signalOptions: {
        pullbackX: 10.0,
        reboundY: 4.0,
        shortMa: 10,
        mediumMa: undefined,
        longMa: 60,
        longMaOffsetPercent: 0.5,
        minGreenRatio20: 0.65,
        requireMaSlopeDown: true,
      },
      exitParams: { pullbackX: 10.0, reboundY: 4.0, maPeriods: [10, 60], holdMinutes: 45, exitX: 35, exitN: 2.0, exitM: 3.0 },
    },
    // 解释 2: ma60 >= high * 1.01 (更显著的高于, offset=1.0%, 对应 <<)
    {
      group: '用户方案 (MA 10/60)',
      name: '方案 2: MA 10/60 (MA60高出高点>=1.0% [<<显著压制]), 下倾, m=3.0, 45m',
      signalOptions: {
        pullbackX: 10.0,
        reboundY: 4.0,
        shortMa: 10,
        mediumMa: undefined,
        longMa: 60,
        longMaOffsetPercent: 1.0,
        minGreenRatio20: 0.65,
        requireMaSlopeDown: true,
      },
      exitParams: { pullbackX: 10.0, reboundY: 4.0, maPeriods: [10, 60], holdMinutes: 45, exitX: 35, exitN: 2.0, exitM: 3.0 },
    },
    // 解释 3: ma60 >= high * 1.02 (非常显著的高于, offset=2.0%, 对应 <<)
    {
      group: '用户方案 (MA 10/60)',
      name: '方案 3: MA 10/60 (MA60高出高点>=2.0% [<<极度压制]), 下倾, m=3.0, 45m',
      signalOptions: {
        pullbackX: 10.0,
        reboundY: 4.0,
        shortMa: 10,
        mediumMa: undefined,
        longMa: 60,
        longMaOffsetPercent: 2.0,
        minGreenRatio20: 0.65,
        requireMaSlopeDown: true,
      },
      exitParams: { pullbackX: 10.0, reboundY: 4.0, maPeriods: [10, 60], holdMinutes: 45, exitX: 35, exitN: 2.0, exitM: 3.0 },
    },
    // 解释 4: offset=0 (只要 ma60 > ma10 即可)
    {
      group: '用户方案 (MA 10/60)',
      name: '方案 4: MA 10/60 (offset=0 只要 MA60>MA10), 下倾, m=3.0, 45m',
      signalOptions: {
        pullbackX: 10.0,
        reboundY: 4.0,
        shortMa: 10,
        mediumMa: undefined,
        longMa: 60,
        longMaOffsetPercent: 0,
        minGreenRatio20: 0.65,
        requireMaSlopeDown: true,
      },
      exitParams: { pullbackX: 10.0, reboundY: 4.0, maPeriods: [10, 60], holdMinutes: 45, exitX: 35, exitN: 2.0, exitM: 3.0 },
    },
    // 解释 5: 持仓 60m (匹配 MA60 周期)
    {
      group: '用户方案 (MA 10/60)',
      name: '方案 5: MA 10/60 (offset=0.5%), 下倾, m=3.0, 最长持仓60m',
      signalOptions: {
        pullbackX: 10.0,
        reboundY: 4.0,
        shortMa: 10,
        mediumMa: undefined,
        longMa: 60,
        longMaOffsetPercent: 0.5,
        minGreenRatio20: 0.65,
        requireMaSlopeDown: true,
      },
      exitParams: { pullbackX: 10.0, reboundY: 4.0, maPeriods: [10, 60], holdMinutes: 60, exitX: 35, exitN: 2.0, exitM: 3.0 },
    },
    // 解释 6: 纯形态无下倾过滤
    {
      group: '用户方案 (MA 10/60)',
      name: '方案 6: MA 10/60 (offset=0.5%), 纯形态无下倾, m=3.0, 45m',
      signalOptions: {
        pullbackX: 10.0,
        reboundY: 4.0,
        shortMa: 10,
        mediumMa: undefined,
        longMa: 60,
        longMaOffsetPercent: 0.5,
        minGreenRatio20: 0.65,
        requireMaSlopeDown: false,
      },
      exitParams: { pullbackX: 10.0, reboundY: 4.0, maPeriods: [10, 60], holdMinutes: 45, exitX: 35, exitN: 2.0, exitM: 3.0 },
    },
    // 对比延伸 1: 如果把 shortMa 改为 5: MA 5 << MA 60
    {
      group: '延伸方案 (MA 5/60 对比)',
      name: '延伸 1: MA 5/60 (MA5阻击, MA60天花板>=0.5%), 下倾, m=3.0, 45m',
      signalOptions: {
        pullbackX: 10.0,
        reboundY: 4.0,
        shortMa: 5,
        mediumMa: undefined,
        longMa: 60,
        longMaOffsetPercent: 0.5,
        minGreenRatio20: 0.65,
        requireMaSlopeDown: true,
      },
      exitParams: { pullbackX: 10.0, reboundY: 4.0, maPeriods: [5, 60], holdMinutes: 45, exitX: 35, exitN: 2.0, exitM: 3.0 },
    },
    // 对比延伸 2: 三均线 MA 5/10/60
    {
      group: '延伸方案 (三均线 MA 5/10/60)',
      name: '延伸 2: 三均线 MA 5/10/60 (MA5阻击, MA60>10>5), 下倾, m=3.0, 45m',
      signalOptions: {
        pullbackX: 10.0,
        reboundY: 4.0,
        shortMa: 5,
        mediumMa: 10,
        longMa: 60,
        longMaOffsetPercent: 0.5,
        minGreenRatio20: 0.65,
        requireMaSlopeDown: true,
      },
      exitParams: { pullbackX: 10.0, reboundY: 4.0, maPeriods: [5, 10, 60], holdMinutes: 45, exitX: 35, exitN: 2.0, exitM: 3.0 },
    },
  ];

  const results: any[] = [];

  for (const exp of experiments) {
    const signals = buildPeakReboundSignals(minuteData, frames, exp.signalOptions);
    const { metrics, trades } = backtestPeakRebound(
      minuteData,
      signals,
      exp.exitParams,
      hourly.manifest.start,
      hourly.manifest.end,
      { takerFeeBps: 5, slippageBps: 2 }
    );

    const s2Target = trades.filter((t) => t.exits[1]?.reason === 'target').length;
    const s2Timeout = trades.filter((t) => t.exits[1]?.reason === 'timeout').length;
    const s2Stop = trades.filter((t) => t.exits[1]?.reason === 'stop').length;

    results.push({
      name: exp.name,
      signals: signals.length,
      trades: metrics.trades,
      wins: metrics.wins,
      losses: metrics.losses,
      breakevens: metrics.breakevens,
      winRate: metrics.winRate ?? 0,
      netPnl: metrics.netPnlPercent,
      profitFactor: metrics.profitFactor ?? 0,
      rewardRisk: metrics.realizedRewardRisk ?? 0,
      s2Target,
      s2Timeout,
      s2Stop,
      tradesList: trades,
    });
  }

  console.log('-----------------------------------------------------------------------------------------------------------------------------------------');
  console.log('📊 1mClose < ma10 << ma60 + ma10 < 1mhigh 回测详细对比');
  console.log('-----------------------------------------------------------------------------------------------------------------------------------------');
  console.log(
    '方案名称'.padEnd(56) +
    '信号'.padStart(6) +
    '交易'.padStart(6) +
    '胜率'.padStart(8) +
    '净收益%'.padStart(10) +
    '盈利因子'.padStart(10) +
    '盈亏比'.padStart(8) +
    '段2止盈'.padStart(9) +
    '段2超时'.padStart(9) +
    '段2止损'.padStart(9)
  );
  console.log('-----------------------------------------------------------------------------------------------------------------------------------------');

  for (const r of results) {
    console.log(
      r.name.padEnd(56) +
      String(r.signals).padStart(6) +
      String(r.trades).padStart(6) +
      `${r.winRate.toFixed(1)}%`.padStart(8) +
      `${r.netPnl >= 0 ? '+' : ''}${r.netPnl.toFixed(2)}%`.padStart(10) +
      r.profitFactor.toFixed(2).padStart(10) +
      r.rewardRisk.toFixed(2).padStart(8) +
      String(r.s2Target).padStart(9) +
      String(r.s2Timeout).padStart(9) +
      String(r.s2Stop).padStart(9)
    );
  }
  console.log('-----------------------------------------------------------------------------------------------------------------------------------------\n');

  // 标的分布
  const p1Trades = results[1].tradesList;
  const baseTrades = results[0].tradesList;

  const symP1: Record<string, { pnl: number; count: number; stopCount: number }> = {};
  for (const t of p1Trades) {
    const sym = t.signal.symbol;
    if (!symP1[sym]) symP1[sym] = { pnl: 0, count: 0, stopCount: 0 };
    symP1[sym].pnl += t.netPercent;
    symP1[sym].count++;
    if (t.exits[1]?.reason === 'stop') symP1[sym].stopCount++;
  }

  const baseSymPnL: Record<string, { pnl: number; count: number; stopCount: number }> = {};
  for (const t of baseTrades) {
    const sym = t.signal.symbol;
    if (!baseSymPnL[sym]) baseSymPnL[sym] = { pnl: 0, count: 0, stopCount: 0 };
    baseSymPnL[sym].pnl += t.netPercent;
    baseSymPnL[sym].count++;
    if (t.exits[1]?.reason === 'stop') baseSymPnL[sym].stopCount++;
  }

  console.log('🔍 标的分币种盈亏对比 (基准 MA 5/15/30 vs 方案 1 MA 10/60 offset>=0.5%):');
  console.log('-----------------------------------------------------------------------------------------');
  console.log('币种'.padEnd(12) + '基准PnL%'.padStart(12) + '基准交易数'.padStart(12) + 'MA 10/60 PnL%'.padStart(16) + 'MA 10/60交易数'.padStart(14) + 'MA止损数'.padStart(10));
  console.log('-----------------------------------------------------------------------------------------');
  const allSyms = Array.from(new Set([...Object.keys(symP1), ...Object.keys(baseSymPnL)])).sort();
  for (const sym of allSyms) {
    const b = baseSymPnL[sym] || { pnl: 0, count: 0, stopCount: 0 };
    const m = symP1[sym] || { pnl: 0, count: 0, stopCount: 0 };
    console.log(
      sym.padEnd(12) +
      `${b.pnl >= 0 ? '+' : ''}${b.pnl.toFixed(2)}%`.padStart(12) +
      String(b.count).padStart(12) +
      `${m.pnl >= 0 ? '+' : ''}${m.pnl.toFixed(2)}%`.padStart(16) +
      String(m.count).padStart(14) +
      String(m.stopCount).padStart(10)
    );
  }
  console.log('-----------------------------------------------------------------------------------------');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
