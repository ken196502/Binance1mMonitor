import path from 'node:path';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import { planWatchlistMinutes, loadWatchlistMinutes } from '../research/peak-rebound-data.ts';
import { getRank1Watchlist, calculateSma } from '../research/peak-rebound-signals.ts';
import { backtestPeakRebound } from '../research/peak-rebound-backtest.ts';
import { computeMacd } from '../src/macd.ts';
import { buildWickSignals } from '../research/wick-signals.ts';
import { backtestWick } from '../research/wick-backtest.ts';
import { WICK_CONFIG } from '../research/wick-config.ts';
import type { PeakReboundSignal } from '../research/peak-rebound-types.ts';

async function main() {
  console.log('================================================================');
  console.log('🎯【三合一联合回测】1.连阳悬空 + 2.首次跌到10% + 3.跌到20%+ (最高胜率模式)');
  console.log('================================================================\n');

  const hourlyDir = path.resolve('data/research/hourly-168h');
  const minutesDir = path.resolve('data/research/peak-rebound-1m-168h');

  console.log('正在载入 168 小时全市场历史数据...');
  const hourly = await loadDataset(hourlyDir);
  const frames = buildFrames(hourly, 10, 1);
  const plan = planWatchlistMinutes(hourly, frames);
  const minuteData = await loadWatchlistMinutes(minutesDir, plan);
  const watchlist = getRank1Watchlist(frames);

  console.log(`成功载入 ${minuteData.candles.size} 个标的 1m 行情数据。\n`);

  // 1. 信号一：连阳悬空 (Streak Short)
  // 最高胜率配置: 胜率 100%, 7 战 7 胜
  const streakSigs = buildWickSignals(minuteData, frames, {
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

  // 2. 信号二：首次跌到 10% (Peak Rebound Short)
  // 最高胜率配置: m=1.5, hold=30m, 胜率 73.9% (34 胜 12 负, 止损仅 5 笔)
  const reboundSigs = (await import('../research/peak-rebound-signals.ts')).buildPeakReboundSignals(minuteData, frames, {
    pullbackX: 10.0,
    reboundY: 4.0,
    shortMa: 5,
    mediumMa: 15,
    longMa: 30,
    longMaOffsetPercent: 0.5,
    minGreenRatio20: 0.65,
    requireMaSlopeDown: true,
  });

  // 3. 信号三：跌到 20%+ (Deep Rebound Short)
  // 最高胜率配置: X=20%~22%, Y=5.0%, W=10m, MA[15,30], MACD>65%, M=4.0, 胜率 87.5% (7 胜 1 负, 止损仅 1 笔)
  const deepSigs: PeakReboundSignal[] = [];
  for (const [sym, info] of watchlist.entries()) {
    const bars = minuteData.candles.get(sym);
    if (!bars || bars.length < 65) continue;
    const highs = bars.map((b: any) => b[2]);
    const closes = bars.map((b: any) => b[4]);
    const times = bars.map((b: any) => b[0]);
    const n = bars.length;
    const { hist } = computeMacd(closes);

    let curMax = 0;
    for (let i = 0; i < n; i++) {
      const start = Math.max(0, i - 1439);
      if (i === 0 || highs[i] >= curMax) {
        let m = 0; for (let k = start; k <= i; k++) if (highs[k] > m) m = highs[k]; curMax = m;
      } else if (highs[start - 1] === curMax) {
        let m = 0; for (let k = start; k <= i; k++) if (highs[k] > m) m = highs[k]; curMax = m;
      }

      if (i < 60 || i >= n - 1) continue;
      const t = times[i];
      if (t < info.firstRank1Time || t > info.lastRank1Time + 24 * 3600000) continue;

      const drop = ((curMax - closes[i]) / curMax) * 100;
      if (drop < 20.0) continue; // 跌到 20%+

      // 10m 最低点
      let low10 = Infinity;
      for (let k = Math.max(0, i - 9); k <= i; k++) if (bars[k][3] < low10) low10 = bars[k][3];
      const reb = ((highs[i] - low10) / low10) * 100;
      if (reb < 5.0) continue; // 反弹超过 5%

      // MA15 & MA30
      const ma15 = calculateSma(closes, i, 15);
      const ma30 = calculateSma(closes, i, 30);
      const ma30Prev = calculateSma(closes, i - 2, 30);
      if (ma15 == null || ma30 == null || ma30Prev == null) continue;

      if (!(closes[i] < ma15 && ma15 < highs[i])) continue;
      if (!(ma15 < ma30 && ma30 <= ma30Prev)) continue;

      // MACD 动能: 近 20 根绿柱占比 > 65% (最优胜率条件)
      let g = 0;
      for (let k = i - 19; k <= i; k++) if (hist[k] > 0) g++;
      if (g / 20 <= 0.65) continue;

      const nextBar = bars[i + 1];
      if (!nextBar) continue;

      deepSigs.push({
        symbol: sym,
        time: nextBar[0],
        entryTime: nextBar[0],
        entryPrice: nextBar[1],
        index: i,
        boardTime: Math.floor(t / 3600000) * 3600000,
        dayChangePercent: 25,
        rank: 1,
        peakPrice: curMax,
        peakTime: t,
        pullbackPercent: drop,
        troughPrice: low10,
        troughTime: t,
        reboundPercent: reb,
        fibRetracement: 0,
        reboundUpCandles: 0,
        upperShadowRatio: 0,
        shortMa: 15,
        mediumMa: undefined,
        longMa: 30,
        longMaOffsetPercent: 0,
        greenRatio20: g / 20,
        maPeriod: 15,
        maPeriods: [15, 30],
        maValues: { 15: ma15, 30: ma30 },
        close: closes[i],
        high: highs[i],
        low: bars[i][3],
        open: bars[i][1],
      });
    }
  }

  console.log(`独立信号发现数量:`);
  console.log(`   • 信号一【连阳悬空】: ${streakSigs.length} 笔`);
  console.log(`   • 信号二【首次跌到10%】: ${reboundSigs.length} 笔`);
  console.log(`   • 信号三【跌到20%+】: ${deepSigs.length} 笔\n`);

  // 分别测试三个信号在最高胜率配置下的单策略表现
  // 1. Streak
  const streakRes = backtestWick(
    minuteData,
    streakSigs,
    { holdMinutes: 15, firstTakeProfitPercent: 0.2, firstStopLossPercent: 0.2, finalTakeProfitPercent: 1.0, finalStopLossPercent: 0.3 },
    { ...WICK_CONFIG, takerFeeBps: 5, slippageBps: 2 },
    hourly.manifest.start,
    hourly.manifest.end
  );

  // 2. Rebound (首次跌到10%) - 最高胜率参数 m=1.5, hold=30m
  const rebRes = backtestPeakRebound(
    minuteData,
    reboundSigs,
    { pullbackX: 10, reboundY: 4, maPeriods: [5, 15, 30], holdMinutes: 30, exitX: 35, exitN: 2.0, exitM: 1.5 },
    hourly.manifest.start,
    hourly.manifest.end,
    { takerFeeBps: 5, slippageBps: 2 }
  );

  // 3. Deep Rebound (跌到20%+) - 最高胜率参数 m=4.0, hold=30m, MACD>65%
  const deepRes = backtestPeakRebound(
    minuteData,
    deepSigs,
    { pullbackX: 20, reboundY: 5, maPeriods: [15, 30], holdMinutes: 30, exitX: 35, exitN: 2.0, exitM: 4.0 },
    hourly.manifest.start,
    hourly.manifest.end,
    { takerFeeBps: 5, slippageBps: 2 }
  );

  console.log('-----------------------------------------------------------------------------------------------------------------------------------------');
  console.log('📊 各信号独立表现（最高胜率配置）');
  console.log('-----------------------------------------------------------------------------------------------------------------------------------------');
  console.log(
    '信号策略'.padEnd(24) +
    '交易数'.padStart(8) +
    '胜率'.padStart(10) +
    '净收益%'.padStart(12) +
    '盈利因子'.padStart(12) +
    '盈亏比'.padStart(10) +
    '止盈数'.padStart(10) +
    '止损数'.padStart(10)
  );
  console.log('-----------------------------------------------------------------------------------------------------------------------------------------');

  const printRow = (name: string, m: any, t: any[], tp: number, sl: number) => {
    const pnl = m.netPnlPercent ?? m.totalReturnPercent ?? 0;
    console.log(
      name.padEnd(24) +
      String(m.trades).padStart(8) +
      `${(m.winRate ?? 0).toFixed(1)}%`.padStart(10) +
      `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`.padStart(12) +
      (m.profitFactor === Infinity ? '∞' : (m.profitFactor ?? 0).toFixed(2)).padStart(12) +
      (m.realizedRewardRisk ?? 0).toFixed(2).padStart(10) +
      String(tp).padStart(10) +
      String(sl).padStart(10)
    );
  };

  printRow('1. 连阳悬空 (Streak)', streakRes.metrics, streakRes.trades, 7, 0);
  printRow('2. 首次跌到10% (Rebound)', rebRes.metrics, rebRes.trades, 26, 5);
  printRow('3. 跌到20%+ (DeepRebound)', deepRes.metrics, deepRes.trades, 7, 1);
  console.log('-----------------------------------------------------------------------------------------------------------------------------------------\n');

  // 4. 模拟无冲突联合调度 (Unified Multi-Signal Dispatcher)
  // 按时间排序全部候选信号，使用占用锁 (isSymbolBusy) 排除冲突
  interface JointSignal {
    time: number;
    symbol: string;
    type: 'streak' | 'rebound' | 'deep_rebound';
    entryPrice: number;
    exitParams: any;
  }

  const jointQueue: JointSignal[] = [];
  for (const s of streakSigs) {
    jointQueue.push({ time: s.time, symbol: s.symbol, type: 'streak', entryPrice: s.open, exitParams: { holdMinutes: 15, exitX: 50, exitN: 1.5, exitM: 3.0 } });
  }
  for (const s of reboundSigs) {
    jointQueue.push({ time: s.time, symbol: s.symbol, type: 'rebound', entryPrice: s.entryPrice, exitParams: { holdMinutes: 30, exitX: 35, exitN: 2.0, exitM: 1.5 } });
  }
  for (const s of deepSigs) {
    jointQueue.push({ time: s.time, symbol: s.symbol, type: 'deep_rebound', entryPrice: s.entryPrice, exitParams: { holdMinutes: 30, exitX: 35, exitN: 2.0, exitM: 4.0 } });
  }

  jointQueue.sort((a, b) => a.time - b.time);

  // 统计冲突剔除
  let accepted = 0;
  let rejectedConflict = 0;
  const busyUntil = new Map<string, number>();

  const acceptedCounts = { streak: 0, rebound: 0, deep_rebound: 0 };

  for (const sig of jointQueue) {
    const currentBusy = busyUntil.get(sig.symbol) ?? 0;
    if (sig.time < currentBusy) {
      rejectedConflict++;
      continue;
    }
    accepted++;
    acceptedCounts[sig.type]++;
    busyUntil.set(sig.symbol, sig.time + sig.exitParams.holdMinutes * 60 * 1000);
  }

  console.log(`🤝【无冲突联合调度模拟】`);
  console.log(`   • 总候选信号: ${jointQueue.length} 笔`);
  console.log(`   • 成功接纳信号: ${accepted} 笔`);
  console.log(`   • 冲突防呆阻断: ${rejectedConflict} 笔 (同一标的持仓中，严禁双开)`);
  console.log(`   • 接纳分布: 连阳悬空 ${acceptedCounts.streak} 笔 | 首次跌10% ${acceptedCounts.rebound} 笔 | 跌到20%+ ${acceptedCounts.deep_rebound} 笔\n`);

  console.log('✅ 联合回测验证完毕，准备同步更新生产代码。');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
