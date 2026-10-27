import path from 'node:path';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import { planWatchlistMinutes, loadWatchlistMinutes } from '../research/peak-rebound-data.ts';
import { buildPeakReboundSignals } from '../research/peak-rebound-signals.ts';
import { backtestPeakRebound } from '../research/peak-rebound-backtest.ts';

async function main() {
  console.log('================================================================');
  console.log('🧪【空弱反弹】MA10 & MA20 双均线组合回测对比实验');
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
      group: '对照组 (现行三均线 MA 5/15/30)',
      name: '基准: MA 5/15/30, MA30压制>=0.5%, 下倾, m=3.0, 45m',
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
    {
      group: '对照组 (现行三均线 MA 5/15/30)',
      name: '基准: MA 5/15/30, MA30压制>=0.5%, 下倾, m=1.5, 30m',
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
      exitParams: { pullbackX: 10.0, reboundY: 4.0, maPeriods: [5, 15, 30], holdMinutes: 30, exitX: 35, exitN: 2.0, exitM: 1.5 },
    },
    // 用户提议方案：只看 MA10 和 MA20，MA20 > MA10，上影线 > MA10，收盘价 < MA10
    {
      group: '用户方案 (只看 MA 10/20)',
      name: '方案 1: MA 10/20 (无长均偏移限制), 开启下倾, m=3.0, 45m',
      signalOptions: {
        pullbackX: 10.0,
        reboundY: 4.0,
        shortMa: 10,
        mediumMa: undefined,
        longMa: 20,
        longMaOffsetPercent: 0, // 无偏移限制
        minGreenRatio20: 0.65,
        requireMaSlopeDown: true,
      },
      exitParams: { pullbackX: 10.0, reboundY: 4.0, maPeriods: [10, 20], holdMinutes: 45, exitX: 35, exitN: 2.0, exitM: 3.0 },
    },
    {
      group: '用户方案 (只看 MA 10/20)',
      name: '方案 2: MA 10/20 (无长均偏移限制), 开启下倾, m=1.5, 30m',
      signalOptions: {
        pullbackX: 10.0,
        reboundY: 4.0,
        shortMa: 10,
        mediumMa: undefined,
        longMa: 20,
        longMaOffsetPercent: 0,
        minGreenRatio20: 0.65,
        requireMaSlopeDown: true,
      },
      exitParams: { pullbackX: 10.0, reboundY: 4.0, maPeriods: [10, 20], holdMinutes: 30, exitX: 35, exitN: 2.0, exitM: 1.5 },
    },
    {
      group: '用户方案 (只看 MA 10/20)',
      name: '方案 3: MA 10/20 (MA20高出高点>=0.5%), 开启下倾, m=3.0, 45m',
      signalOptions: {
        pullbackX: 10.0,
        reboundY: 4.0,
        shortMa: 10,
        mediumMa: undefined,
        longMa: 20,
        longMaOffsetPercent: 0.5,
        minGreenRatio20: 0.65,
        requireMaSlopeDown: true,
      },
      exitParams: { pullbackX: 10.0, reboundY: 4.0, maPeriods: [10, 20], holdMinutes: 45, exitX: 35, exitN: 2.0, exitM: 3.0 },
    },
    {
      group: '用户方案 (只看 MA 10/20)',
      name: '方案 4: MA 10/20 (纯形态无下倾确认), m=3.0, 45m',
      signalOptions: {
        pullbackX: 10.0,
        reboundY: 4.0,
        shortMa: 10,
        mediumMa: undefined,
        longMa: 20,
        longMaOffsetPercent: 0,
        minGreenRatio20: 0.65,
        requireMaSlopeDown: false,
      },
      exitParams: { pullbackX: 10.0, reboundY: 4.0, maPeriods: [10, 20], holdMinutes: 45, exitX: 35, exitN: 2.0, exitM: 3.0 },
    },
    {
      group: '延伸方案 (三均线 MA 5/10/20)',
      name: '延伸 1: MA 5/10/20 (三均线 MA20>MA10>MA5), m=3.0, 45m',
      signalOptions: {
        pullbackX: 10.0,
        reboundY: 4.0,
        shortMa: 5,
        mediumMa: 10,
        longMa: 20,
        longMaOffsetPercent: 0.5,
        minGreenRatio20: 0.65,
        requireMaSlopeDown: true,
      },
      exitParams: { pullbackX: 10.0, reboundY: 4.0, maPeriods: [5, 10, 20], holdMinutes: 45, exitX: 35, exitN: 2.0, exitM: 3.0 },
    },
    {
      group: '延伸方案 (双均线 MA 5/20)',
      name: '延伸 2: MA 5/20 (短周期MA5阻击, MA20天花板>=0.5%), m=3.0, 45m',
      signalOptions: {
        pullbackX: 10.0,
        reboundY: 4.0,
        shortMa: 5,
        mediumMa: undefined,
        longMa: 20,
        longMaOffsetPercent: 0.5,
        minGreenRatio20: 0.65,
        requireMaSlopeDown: true,
      },
      exitParams: { pullbackX: 10.0, reboundY: 4.0, maPeriods: [5, 20], holdMinutes: 45, exitX: 35, exitN: 2.0, exitM: 3.0 },
    },
    {
      group: '延伸方案 (双均线 MA 10/30)',
      name: '延伸 3: MA 10/30 (MA10阻击, MA30天花板>=0.5%), m=3.0, 45m',
      signalOptions: {
        pullbackX: 10.0,
        reboundY: 4.0,
        shortMa: 10,
        mediumMa: undefined,
        longMa: 30,
        longMaOffsetPercent: 0.5,
        minGreenRatio20: 0.65,
        requireMaSlopeDown: true,
      },
      exitParams: { pullbackX: 10.0, reboundY: 4.0, maPeriods: [10, 30], holdMinutes: 45, exitX: 35, exitN: 2.0, exitM: 3.0 },
    },
  ];

  const results = [];

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
      meanTrade: metrics.meanTradePercent ?? 0,
      meanWin: metrics.meanWinPercent ?? 0,
      meanLoss: metrics.meanLossPercent ?? 0,
      s2Target,
      s2Timeout,
      s2Stop,
      tradesList: trades,
    });
  }

  console.log('-----------------------------------------------------------------------------------------------------------------------------------------');
  console.log('📊 MA10/MA20 双均线组合回测详细对比');
  console.log('-----------------------------------------------------------------------------------------------------------------------------------------');
  console.log(
    '方案名称'.padEnd(52) +
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
      r.name.padEnd(52) +
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

  // 分析 MA 10/20 信号特征
  const ma10Trades = results[2].tradesList;
  const baseTrades = results[0].tradesList;

  const symPnL: Record<string, { pnl: number; count: number; stopCount: number }> = {};
  for (const t of ma10Trades) {
    const sym = t.signal.symbol;
    if (!symPnL[sym]) symPnL[sym] = { pnl: 0, count: 0, stopCount: 0 };
    symPnL[sym].pnl += t.netPercent;
    symPnL[sym].count++;
    if (t.exits[1]?.reason === 'stop') symPnL[sym].stopCount++;
  }

  const baseSymPnL: Record<string, { pnl: number; count: number; stopCount: number }> = {};
  for (const t of baseTrades) {
    const sym = t.signal.symbol;
    if (!baseSymPnL[sym]) baseSymPnL[sym] = { pnl: 0, count: 0, stopCount: 0 };
    baseSymPnL[sym].pnl += t.netPercent;
    baseSymPnL[sym].count++;
    if (t.exits[1]?.reason === 'stop') baseSymPnL[sym].stopCount++;
  }

  console.log('🔍 标的分币种盈亏对比 (基准 MA 5/15/30 vs 方案 1 MA 10/20):');
  console.log('-----------------------------------------------------------------------------------------');
  console.log('币种'.padEnd(12) + '基准PnL%'.padStart(12) + '基准交易数'.padStart(12) + 'MA10/20 PnL%'.padStart(16) + 'MA10/20交易数'.padStart(14) + 'MA止损数'.padStart(10));
  console.log('-----------------------------------------------------------------------------------------');
  const allSyms = Array.from(new Set([...Object.keys(symPnL), ...Object.keys(baseSymPnL)])).sort();
  for (const sym of allSyms) {
    const b = baseSymPnL[sym] || { pnl: 0, count: 0, stopCount: 0 };
    const m = symPnL[sym] || { pnl: 0, count: 0, stopCount: 0 };
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
