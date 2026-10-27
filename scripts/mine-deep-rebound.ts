import path from 'node:path';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import { planWatchlistMinutes, loadWatchlistMinutes } from '../research/peak-rebound-data.ts';
import { getRank1Watchlist } from '../research/peak-rebound-signals.ts';
import { backtestPeakRebound } from '../research/peak-rebound-backtest.ts';
import type { PeakReboundSignal } from '../research/peak-rebound-types.ts';

async function main() {
  console.log('================================================================');
  console.log('⛏️【精准深度挖掘】聚焦 X=[18%~30%], Y=[2.5%~5%], 双均线精细化探索');
  console.log('================================================================\n');

  const hourlyDir = path.resolve('data/research/hourly-168h');
  const minutesDir = path.resolve('data/research/peak-rebound-1m-168h');

  const hourly = await loadDataset(hourlyDir);
  const frames = buildFrames(hourly, 10, 1);
  const plan = planWatchlistMinutes(hourly, frames);
  const minuteData = await loadWatchlistMinutes(minutesDir, plan);
  const watchlist = getRank1Watchlist(frames);

  const maPeriodsToPrecompute = [5, 8, 10, 12, 14, 15, 16, 20, 25, 30, 35, 40, 45];
  const lowWindowsToPrecompute = [8, 10, 12, 15, 18, 20];

  const precomputed: any[] = [];

  for (const [symbol, info] of watchlist.entries()) {
    const bars = minuteData.candles.get(symbol);
    if (!bars || bars.length < 65) continue;

    const highs = bars.map((b: any) => b[2]);
    const lows = bars.map((b: any) => b[3]);
    const closes = bars.map((b: any) => b[4]);
    const times = bars.map((b: any) => b[0]);
    const n = bars.length;

    // 24h rolling high
    const high24h = new Float64Array(n);
    let curMax = 0;
    for (let i = 0; i < n; i++) {
      const start = Math.max(0, i - 1439);
      if (i === 0 || highs[i] >= curMax) {
        let m = 0;
        for (let k = start; k <= i; k++) if (highs[k] > m) m = highs[k];
        curMax = m;
      } else if (highs[start - 1] === curMax) {
        let m = 0;
        for (let k = start; k <= i; k++) if (highs[k] > m) m = highs[k];
        curMax = m;
      }
      high24h[i] = curMax;
    }

    // Rolling lows
    const lowsWindow: Record<number, number[]> = {};
    for (const w of lowWindowsToPrecompute) {
      const arr = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const start = Math.max(0, i - w + 1);
        let m = Infinity;
        for (let k = start; k <= i; k++) if (lows[k] < m) m = lows[k];
        arr[i] = m;
      }
      lowsWindow[w] = Array.from(arr);
    }

    // MAs
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

  // 重点扫描 X in [18, 20, 22, 25, 28, 30], Y in [2.5, 3.0, 3.5, 4.0, 4.5, 5.0]
  const xValues = [18, 20, 22, 25, 28, 30];
  const yValues = [2.5, 3.0, 3.5, 4.0, 4.5, 5.0];
  const lowWindows = [8, 10, 12, 15];

  const maPairs = [
    { short: 10, long: 30 },
    { short: 12, long: 25 },
    { short: 12, long: 30 },
    { short: 14, long: 30 },
    { short: 15, long: 25 },
    { short: 15, long: 30 },
    { short: 15, long: 35 },
    { short: 15, long: 40 },
    { short: 16, long: 30 },
    { short: 20, long: 40 },
  ];

  const candidates: any[] = [];

  for (const x of xValues) {
    for (const y of yValues) {
      for (const w of lowWindows) {
        for (const pair of maPairs) {
          for (const slope of [true, false]) {
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

                const drop = ((h24 - close) / h24) * 100;
                if (drop < x) continue;

                const low = lowArr[i];
                if (low <= 0) continue;
                const rebound = ((high - low) / low) * 100;
                if (rebound < y) continue;

                const maShort = maShortArr[i];
                const maLong = maLongArr[i];
                if (maShort == null || maLong == null) continue;

                if (!(close < maShort && maShort < high)) continue;
                if (!(maShort < maLong)) continue;

                if (slope && i >= 2) {
                  const maLongPrev = maLongArr[i - 2];
                  if (maLongPrev != null && maLong > maLongPrev) continue;
                }

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
                  longMaOffsetPercent: 0,
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

            if (signals.length < 10) continue;

            for (const hold of [20, 30, 45]) {
              for (const exitM of [1.5, 2.0, 3.0, 4.0]) {
                const { metrics, trades } = backtestPeakRebound(
                  minuteData,
                  signals,
                  { pullbackX: x, reboundY: y, maPeriods: [pair.short, pair.long], holdMinutes: hold, exitX: 35, exitN: 2.0, exitM },
                  hourly.manifest.start,
                  hourly.manifest.end,
                  { takerFeeBps: 5, slippageBps: 2 }
                );

                if (metrics.trades >= 15 && metrics.netPnlPercent > 0) {
                  const s2Target = trades.filter((t) => t.exits[1]?.reason === 'target').length;
                  const s2Stop = trades.filter((t) => t.exits[1]?.reason === 'stop').length;

                  candidates.push({
                    x,
                    y,
                    window: w,
                    shortMa: pair.short,
                    longMa: pair.long,
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

  candidates.sort((a, b) => b.netPnl - a.netPnl);

  console.log(`挖掘完成！共发现 ${candidates.length} 个盈利方案（交易次数 >= 15）。\n`);

  console.log('-----------------------------------------------------------------------------------------------------------------------------------------');
  console.log('🏆【TOP 20 深度优化最优解】(按净收益排序)');
  console.log('-----------------------------------------------------------------------------------------------------------------------------------------');
  console.log(
    '配置详情 (X, Y, 窗口, 双均线, 倾斜, 持仓, M)'.padEnd(50) +
    '交易'.padStart(6) +
    '胜率'.padStart(8) +
    '净收益%'.padStart(10) +
    '盈利因子'.padStart(10) +
    '盈亏比'.padStart(8) +
    '段2止盈'.padStart(9) +
    '段2止损'.padStart(9)
  );
  console.log('-----------------------------------------------------------------------------------------------------------------------------------------');

  for (const c of candidates.slice(0, 20)) {
    const desc = `X=${c.x}%, Y=${c.y}%, W=${c.window}m, MA[${c.shortMa},${c.longMa}], slp=${c.slopeDown ? 'Y' : 'N'}, ${c.hold}m, M=${c.exitM}`;
    console.log(
      desc.padEnd(50) +
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
