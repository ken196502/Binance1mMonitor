import path from 'node:path';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import { planWatchlistMinutes, loadWatchlistMinutes } from '../research/peak-rebound-data.ts';
import { getRank1Watchlist, calculateSma } from '../research/peak-rebound-signals.ts';
import { backtestPeakRebound } from '../research/peak-rebound-backtest.ts';
import type { PeakReboundSignal } from '../research/peak-rebound-types.ts';

interface PrecomputedData {
  symbol: string;
  bars: any[];
  highs: number[];
  lows: number[];
  closes: number[];
  times: number[];
  high24h: number[];
  lowsWindow: Record<number, number[]>; // window -> low array
  mas: Record<number, (number | null)[]>; // period -> ma array
  watchStart: number;
  watchEnd: number;
}

async function main() {
  console.log('================================================================');
  console.log('⛏️【参数挖掘】24h跌幅X% + 窗口低点反弹Y% + 双均线压制组合全空间寻优');
  console.log('================================================================\n');

  const hourlyDir = path.resolve('data/research/hourly-168h');
  const minutesDir = path.resolve('data/research/peak-rebound-1m-168h');

  console.log('正在载入 168 小时全市场历史数据...');
  const hourly = await loadDataset(hourlyDir);
  const frames = buildFrames(hourly, 10, 1);
  const plan = planWatchlistMinutes(hourly, frames);
  const minuteData = await loadWatchlistMinutes(minutesDir, plan);
  const watchlist = getRank1Watchlist(frames);

  console.log(`成功载入 ${minuteData.candles.size} 个标的行情。预计算技术指标与极值缓存中...`);

  const maPeriodsToPrecompute = [3, 5, 7, 10, 12, 15, 20, 30, 45, 60];
  const lowWindowsToPrecompute = [10, 15, 20, 30];

  const precomputed: PrecomputedData[] = [];

  for (const [symbol, info] of watchlist.entries()) {
    const bars = minuteData.candles.get(symbol);
    if (!bars || bars.length < 65) continue;

    const highs = bars.map((b: any) => b[2]);
    const lows = bars.map((b: any) => b[3]);
    const closes = bars.map((b: any) => b[4]);
    const times = bars.map((b: any) => b[0]);
    const n = bars.length;

    // 1. 24h rolling high (过去至多 1440 根)
    const high24h = new Float64Array(n);
    let curMax = 0;
    for (let i = 0; i < n; i++) {
      const start = Math.max(0, i - 1439);
      if (i === 0 || highs[i] >= curMax) {
        let m = 0;
        for (let k = start; k <= i; k++) if (highs[k] > m) m = highs[k];
        curMax = m;
      } else {
        // if old max fell out of window
        if (highs[start - 1] === curMax) {
          let m = 0;
          for (let k = start; k <= i; k++) if (highs[k] > m) m = highs[k];
          curMax = m;
        }
      }
      high24h[i] = curMax;
    }

    // 2. Rolling lows for windows
    const lowsWindow: Record<number, number[]> = {};
    for (const w of lowWindowsToPrecompute) {
      const arr = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const start = Math.max(0, i - w + 1);
        let m = Infinity;
        for (let k = start; k <= i; k++) {
          if (lows[k] < m) m = lows[k];
        }
        arr[i] = m;
      }
      lowsWindow[w] = Array.from(arr);
    }

    // 3. Precompute MAs
    const mas: Record<number, (number | null)[]> = {};
    for (const p of maPeriodsToPrecompute) {
      const arr: (number | null)[] = new Array(n).fill(null);
      let sum = 0;
      for (let i = 0; i < n; i++) {
        sum += closes[i];
        if (i >= p) sum -= closes[i - p];
        if (i >= p - 1) arr[i] = sum / p;
      }
      mas[p] = arr;
    }

    precomputed.push({
      symbol,
      bars,
      highs,
      lows,
      closes,
      times,
      high24h: Array.from(high24h),
      lowsWindow,
      mas,
      watchStart: info.firstRank1Time,
      watchEnd: info.lastRank1Time + 24 * 3600000,
    });
  }

  console.log(`预计算完成！标的数: ${precomputed.length}。开始全空间超参数网格扫描...\n`);

  // 定义超参数搜索空间
  const xValues = [8, 10, 12, 15, 18, 20];
  const yValues = [1.5, 2.0, 2.5, 3.0, 4.0];
  const lowWindows = [10, 15, 20];
  
  // 双均线对测试
  const maPairs = [
    { short: 3, long: 15 },
    { short: 3, long: 30 },
    { short: 5, long: 15 },
    { short: 5, long: 20 },
    { short: 5, long: 30 },
    { short: 5, long: 45 },
    { short: 5, long: 60 },
    { short: 7, long: 20 },
    { short: 7, long: 30 },
    { short: 10, long: 20 },
    { short: 10, long: 30 },
    { short: 10, long: 60 },
    { short: 15, long: 30 },
    { short: 15, long: 60 },
  ];

  const ceilingOffsets = [0, 0.5];
  const slopeDownOptions = [true, false];
  const holdTimes = [30, 45];
  const exitMValues = [1.5, 3.0];

  interface MineCandidate {
    x: number;
    y: number;
    window: number;
    shortMa: number;
    longMa: number;
    offset: number;
    slopeDown: boolean;
    hold: number;
    exitM: number;
    signals: number;
    trades: number;
    winRate: number;
    netPnl: number;
    profitFactor: number;
    rewardRisk: number;
    s2Target: number;
    s2Stop: number;
  }

  const allCandidates: MineCandidate[] = [];

  let count = 0;
  const startTime = Date.now();

  for (const x of xValues) {
    for (const y of yValues) {
      for (const w of lowWindows) {
        for (const pair of maPairs) {
          for (const offset of ceilingOffsets) {
            for (const slope of slopeDownOptions) {
              // 构建信号
              const signals: PeakReboundSignal[] = [];

              for (const item of precomputed) {
                const { bars, highs, closes, times, high24h, lowsWindow, mas, watchStart, watchEnd } = item;
                const lowArr = lowsWindow[w];
                const maShortArr = mas[pair.short];
                const maLongArr = mas[pair.long];
                if (!lowArr || !maShortArr || !maLongArr) continue;

                let cooldownUntil = 0;

                for (let i = 60; i < bars.length - 1; i++) {
                  const time = times[i];
                  if (time < watchStart || time > watchEnd) continue;
                  if (time < cooldownUntil) continue;

                  const h24 = high24h[i];
                  const close = closes[i];
                  const high = highs[i];

                  // 1. 距离 24h 高点跌超过 X%
                  const drop = ((h24 - close) / h24) * 100;
                  if (drop < x) continue;

                  // 2. 距离窗口低点反弹超过 Y%
                  const low = lowArr[i];
                  if (low <= 0) continue;
                  const rebound = ((high - low) / low) * 100;
                  if (rebound < y) continue;

                  // 3. 双均线形态: 1mClose < maShort < 1mHigh
                  const maShort = maShortArr[i];
                  const maLong = maLongArr[i];
                  if (maShort == null || maLong == null) continue;

                  if (!(close < maShort && maShort < high)) continue;

                  // maShort < maLong 排列
                  if (!(maShort < maLong)) continue;

                  // 天花板 offset
                  if (offset > 0 && maLong < high * (1 + offset / 100)) continue;

                  // 下倾确认
                  if (slope && i >= 2) {
                    const maLongPrev = maLongArr[i - 2];
                    if (maLongPrev != null && maLong > maLongPrev) continue;
                  }

                  // 产生信号
                  const nextBar = bars[i + 1];
                  if (!nextBar) continue;

                  signals.push({
                    symbol: item.symbol,
                    time: nextBar[0],
                    entryTime: nextBar[0],
                    entryPrice: nextBar[1],
                    index: i,
                    boardTime: Math.floor(time / 3600000) * 3600000,
                    dayChangePercent: 25,
                    rank: 1,
                    peakPrice: h24,
                    peakTime: time,
                    pullbackPercent: drop,
                    troughPrice: low,
                    troughTime: time,
                    reboundPercent: rebound,
                    fibRetracement: 0,
                    reboundUpCandles: 0,
                    upperShadowRatio: 0,
                    shortMa: pair.short,
                    mediumMa: undefined,
                    longMa: pair.long,
                    longMaOffsetPercent: offset,
                    greenRatio20: 0,
                    maPeriod: pair.short,
                    maPeriods: [pair.short, pair.long],
                    maValues: { [pair.short]: maShort, [pair.long]: maLong },
                    close,
                    high,
                    low,
                    open: bars[i][1],
                  });

                  cooldownUntil = time + 30 * 60 * 1000;
                }
              }

              // 若信号太少，直接跳过回测
              if (signals.length < 10) continue;

              // 测试持仓与止盈参数
              for (const hold of holdTimes) {
                for (const exitM of exitMValues) {
                  count++;
                  const { metrics, trades } = backtestPeakRebound(
                    minuteData,
                    signals,
                    { pullbackX: x, reboundY: y, maPeriods: [pair.short, pair.long], holdMinutes: hold, exitX: 35, exitN: 2.0, exitM },
                    hourly.manifest.start,
                    hourly.manifest.end,
                    { takerFeeBps: 5, slippageBps: 2 }
                  );

                  if (metrics.trades >= 10) {
                    const s2Target = trades.filter((t) => t.exits[1]?.reason === 'target').length;
                    const s2Stop = trades.filter((t) => t.exits[1]?.reason === 'stop').length;

                    allCandidates.push({
                      x,
                      y,
                      window: w,
                      shortMa: pair.short,
                      longMa: pair.long,
                      offset,
                      slopeDown: slope,
                      hold,
                      exitM,
                      signals: signals.length,
                      trades: metrics.trades,
                      winRate: metrics.winRate ?? 0,
                      netPnl: metrics.netPnlPercent,
                      profitFactor: metrics.profitFactor ?? 0,
                      rewardRisk: metrics.realizedRewardRisk ?? 0,
                      s2Target,
                      s2Stop,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`搜索完毕！在 ${elapsed}s 内共评估了 ${count} 个有效参数组合。`);
  console.log(`有效交易次数 >= 10 的方案总数: ${allCandidates.length} 个。\n`);

  // 按净收益降序排序
  allCandidates.sort((a, b) => b.netPnl - a.netPnl);

  const profitable = allCandidates.filter((c) => c.netPnl > 0);
  console.log(`🏆 盈利方案总数: ${profitable.length} 个！`);

  console.log('\n-----------------------------------------------------------------------------------------------------------------------------------------');
  console.log('🌟【TOP 15 最佳综合表现方案】(按净收益排序)');
  console.log('-----------------------------------------------------------------------------------------------------------------------------------------');
  console.log(
    '配置详情 (X, Y, 窗口, 双均线, 偏移, 倾斜, 持仓, M)'.padEnd(54) +
    '交易'.padStart(6) +
    '胜率'.padStart(8) +
    '净收益%'.padStart(10) +
    '盈利因子'.padStart(10) +
    '盈亏比'.padStart(8) +
    '段2止盈'.padStart(9) +
    '段2止损'.padStart(9)
  );
  console.log('-----------------------------------------------------------------------------------------------------------------------------------------');

  for (const c of allCandidates.slice(0, 15)) {
    const desc = `X=${c.x}%, Y=${c.y}%, W=${c.window}m, MA[${c.shortMa},${c.longMa}], off=${c.offset}%, slp=${c.slopeDown ? 'Y' : 'N'}, ${c.hold}m, M=${c.exitM}`;
    console.log(
      desc.padEnd(54) +
      String(c.trades).padStart(6) +
      `${c.winRate.toFixed(1)}%`.padStart(8) +
      `${c.netPnl >= 0 ? '+' : ''}${c.netPnl.toFixed(2)}%`.padStart(10) +
      c.profitFactor.toFixed(2).padStart(10) +
      c.rewardRisk.toFixed(2).padStart(8) +
      String(c.s2Target).padStart(9) +
      String(c.s2Stop).padStart(9)
    );
  }
  console.log('-----------------------------------------------------------------------------------------------------------------------------------------\n');

  // 按胜率排序 (交易 >= 20)
  const highWinRate = allCandidates.filter((c) => c.trades >= 20 && c.netPnl > 0);
  highWinRate.sort((a, b) => b.winRate - a.winRate);

  if (highWinRate.length > 0) {
    console.log('-----------------------------------------------------------------------------------------------------------------------------------------');
    console.log('🎯【TOP 10 高胜率稳健方案】(交易>=20, 盈利, 按胜率排序)');
    console.log('-----------------------------------------------------------------------------------------------------------------------------------------');
    console.log(
      '配置详情 (X, Y, 窗口, 双均线, 偏移, 倾斜, 持仓, M)'.padEnd(54) +
      '交易'.padStart(6) +
      '胜率'.padStart(8) +
      '净收益%'.padStart(10) +
      '盈利因子'.padStart(10) +
      '盈亏比'.padStart(8) +
      '段2止盈'.padStart(9) +
      '段2止损'.padStart(9)
    );
    console.log('-----------------------------------------------------------------------------------------------------------------------------------------');
    for (const c of highWinRate.slice(0, 10)) {
      const desc = `X=${c.x}%, Y=${c.y}%, W=${c.window}m, MA[${c.shortMa},${c.longMa}], off=${c.offset}%, slp=${c.slopeDown ? 'Y' : 'N'}, ${c.hold}m, M=${c.exitM}`;
      console.log(
        desc.padEnd(54) +
        String(c.trades).padStart(6) +
        `${c.winRate.toFixed(1)}%`.padStart(8) +
        `${c.netPnl >= 0 ? '+' : ''}${c.netPnl.toFixed(2)}%`.padStart(10) +
        c.profitFactor.toFixed(2).padStart(10) +
        c.rewardRisk.toFixed(2).padStart(8) +
        String(c.s2Target).padStart(9) +
        String(c.s2Stop).padStart(9)
      );
    }
    console.log('-----------------------------------------------------------------------------------------------------------------------------------------\n');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
