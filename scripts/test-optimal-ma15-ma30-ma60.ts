import path from 'node:path';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import { planWatchlistMinutes, loadWatchlistMinutes } from '../research/peak-rebound-data.ts';
import { getRank1Watchlist } from '../research/peak-rebound-signals.ts';
import { backtestPeakRebound } from '../research/peak-rebound-backtest.ts';
import type { PeakReboundSignal } from '../research/peak-rebound-types.ts';

async function main() {
  console.log('================================================================');
  console.log('🧪【最优解验证】在最优参数空间测试 MA15 < MA30 < MA60 三均线');
  console.log('================================================================\n');

  const hourlyDir = path.resolve('data/research/hourly-168h');
  const minutesDir = path.resolve('data/research/peak-rebound-1m-168h');

  const hourly = await loadDataset(hourlyDir);
  const frames = buildFrames(hourly, 10, 1);
  const plan = planWatchlistMinutes(hourly, frames);
  const minuteData = await loadWatchlistMinutes(minutesDir, plan);
  const watchlist = getRank1Watchlist(frames);

  const maPeriodsToPrecompute = [15, 30, 60];
  const lowWindowsToPrecompute = [8, 10, 15];

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

    // MAs: 15, 30, 60
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

  // 定义多组回测对照试验
  interface TestConfig {
    group: string;
    name: string;
    x: number;
    y: number;
    w: number;
    useMa60: boolean; // 是否要求 ma30 < ma60
    slopeDown: boolean;
    hold: number;
    exitM: number;
  }

  const experiments: TestConfig[] = [
    // 1. 最优解 A (双均线 MA15 < MA30)
    {
      group: '最优解 A 对比组 (双均线 MA15 < MA30)',
      name: '最优解 A 基准: 双均线 MA[15,30] (X=22%, Y=5%, W=10m, 45m, M=4)',
      x: 22,
      y: 5.0,
      w: 10,
      useMa60: false,
      slopeDown: true,
      hold: 45,
      exitM: 4.0,
    },
    // 2. 最优解 A 加 MA60 (三均线 MA15 < MA30 < MA60)
    {
      group: '最优解 A 升级组 (三均线 MA15 < MA30 < MA60)',
      name: '方案 A1: 三均线 MA[15,30,60] (X=22%, Y=5%, W=10m, 45m, M=4)',
      x: 22,
      y: 5.0,
      w: 10,
      useMa60: true,
      slopeDown: true,
      hold: 45,
      exitM: 4.0,
    },
    {
      group: '最优解 A 升级组 (三均线 MA15 < MA30 < MA60)',
      name: '方案 A2: 三均线 MA[15,30,60] (X=22%, Y=5%, W=10m, 30m, M=4)',
      x: 22,
      y: 5.0,
      w: 10,
      useMa60: true,
      slopeDown: true,
      hold: 30,
      exitM: 4.0,
    },
    {
      group: '最优解 A 升级组 (三均线 MA15 < MA30 < MA60)',
      name: '方案 A3: 三均线 MA[15,30,60] (X=22%, Y=5%, W=10m, 30m, M=3)',
      x: 22,
      y: 5.0,
      w: 10,
      useMa60: true,
      slopeDown: true,
      hold: 30,
      exitM: 3.0,
    },

    // 3. 最优解 B (双均线 MA15 < MA30)
    {
      group: '最优解 B 对比组 (双均线 MA15 < MA30)',
      name: '最优解 B 基准: 双均线 MA[15,30] (X=25%, Y=5%, W=10m, 30m, M=4)',
      x: 25,
      y: 5.0,
      w: 10,
      useMa60: false,
      slopeDown: true,
      hold: 30,
      exitM: 4.0,
    },
    // 4. 最优解 B 加 MA60 (三均线 MA15 < MA30 < MA60)
    {
      group: '最优解 B 升级组 (三均线 MA15 < MA30 < MA60)',
      name: '方案 B1: 三均线 MA[15,30,60] (X=25%, Y=5%, W=10m, 30m, M=4)',
      x: 25,
      y: 5.0,
      w: 10,
      useMa60: true,
      slopeDown: true,
      hold: 30,
      exitM: 4.0,
    },
    {
      group: '最优解 B 升级组 (三均线 MA15 < MA30 < MA60)',
      name: '方案 B2: 三均线 MA[15,30,60] (X=25%, Y=5%, W=10m, 45m, M=4)',
      x: 25,
      y: 5.0,
      w: 10,
      useMa60: true,
      slopeDown: true,
      hold: 45,
      exitM: 4.0,
    },

    // 5. 最优解 C (高频组 X=20%, Y=5%)
    {
      group: '高频解 C 对比组 (X=20%, Y=5%)',
      name: '方案 C-双均线: 双均线 MA[15,30] (X=20%, Y=5%, W=10m, 45m, M=4)',
      x: 20,
      y: 5.0,
      w: 10,
      useMa60: false,
      slopeDown: true,
      hold: 45,
      exitM: 4.0,
    },
    {
      group: '高频解 C 升级组 (X=20%, Y=5%)',
      name: '方案 C-三均线: 三均线 MA[15,30,60] (X=20%, Y=5%, W=10m, 45m, M=4)',
      x: 20,
      y: 5.0,
      w: 10,
      useMa60: true,
      slopeDown: true,
      hold: 45,
      exitM: 4.0,
    },

    // 6. 敏捷组 (X=25%, Y=3%, W=8m)
    {
      group: '敏捷解 D 对比组 (X=25%, Y=3%)',
      name: '方案 D-双均线: 双均线 MA[15,30] (X=25%, Y=3%, W=8m, 20m, M=4)',
      x: 25,
      y: 3.0,
      w: 8,
      useMa60: false,
      slopeDown: true,
      hold: 20,
      exitM: 4.0,
    },
    {
      group: '敏捷解 D 升级组 (X=25%, Y=3%)',
      name: '方案 D-三均线: 三均线 MA[15,30,60] (X=25%, Y=3%, W=8m, 20m, M=4)',
      x: 25,
      y: 3.0,
      w: 8,
      useMa60: true,
      slopeDown: true,
      hold: 20,
      exitM: 4.0,
    },
  ];

  console.log('-----------------------------------------------------------------------------------------------------------------------------------------');
  console.log('📊 最优解加入 MA60 (MA15 < MA30 < MA60) 详细对比');
  console.log('-----------------------------------------------------------------------------------------------------------------------------------------');
  console.log(
    '方案名称'.padEnd(58) +
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

  for (const exp of experiments) {
    const signals: PeakReboundSignal[] = [];

    for (const item of precomputed) {
      const { bars, highs, closes, times, high24h, lowsWindow, mas, watchStart, watchEnd } = item;
      const lowArr = lowsWindow[exp.w];
      const ma15Arr = mas[15];
      const ma30Arr = mas[30];
      const ma60Arr = mas[60];
      if (!lowArr || !ma15Arr || !ma30Arr || !ma60Arr) continue;

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
        if (drop < exp.x) continue;

        // 2. 距离窗口低点反弹超过 Y%
        const low = lowArr[i];
        if (low <= 0) continue;
        const rebound = ((high - low) / low) * 100;
        if (rebound < exp.y) continue;

        // 3. 均线形态: 1mClose < ma15 < 1mHigh
        const ma15 = ma15Arr[i];
        const ma30 = ma30Arr[i];
        const ma60 = ma60Arr[i];
        if (ma15 == null || ma30 == null || ma60 == null) continue;

        if (!(close < ma15 && ma15 < high)) continue;

        // 排列条件:
        // 双均线: ma15 < ma30
        // 三均线: ma15 < ma30 && ma30 < ma60
        if (exp.useMa60) {
          if (!(ma15 < ma30 && ma30 < ma60)) continue;
        } else {
          if (!(ma15 < ma30)) continue;
        }

        // 下倾确认 (ma30)
        if (exp.slopeDown && i >= 2) {
          const ma30Prev = ma30Arr[i - 2];
          if (ma30Prev != null && ma30 > ma30Prev) continue;
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
          shortMa: 15,
          mediumMa: 30,
          longMa: exp.useMa60 ? 60 : 30,
          longMaOffsetPercent: 0,
          greenRatio20: 0,
          maPeriod: 15,
          maPeriods: exp.useMa60 ? [15, 30, 60] : [15, 30],
          maValues: { 15: ma15, 30: ma30, 60: ma60 },
          close,
          high,
          low,
          open: bars[i][1],
        });

        cooldownUntil = time + 30 * 60 * 1000;
      }
    }

    const { metrics, trades } = backtestPeakRebound(
      minuteData,
      signals,
      { pullbackX: exp.x, reboundY: exp.y, maPeriods: exp.useMa60 ? [15, 30, 60] : [15, 30], holdMinutes: exp.hold, exitX: 35, exitN: 2.0, exitM: exp.exitM },
      hourly.manifest.start,
      hourly.manifest.end,
      { takerFeeBps: 5, slippageBps: 2 }
    );

    const s2Target = trades.filter((t) => t.exits[1]?.reason === 'target').length;
    const s2Timeout = trades.filter((t) => t.exits[1]?.reason === 'timeout').length;
    const s2Stop = trades.filter((t) => t.exits[1]?.reason === 'stop').length;

    console.log(
      exp.name.padEnd(58) +
      String(signals.length).padStart(6) +
      String(metrics.trades).padStart(6) +
      `${(metrics.winRate ?? 0).toFixed(1)}%`.padStart(8) +
      `${metrics.netPnlPercent >= 0 ? '+' : ''}${metrics.netPnlPercent.toFixed(2)}%`.padStart(10) +
      (metrics.profitFactor ?? 0).toFixed(2).padStart(10) +
      (metrics.realizedRewardRisk ?? 0).toFixed(2).padStart(8) +
      String(s2Target).padStart(9) +
      String(s2Timeout).padStart(9) +
      String(s2Stop).padStart(9)
    );
  }

  console.log('-----------------------------------------------------------------------------------------------------------------------------------------\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
