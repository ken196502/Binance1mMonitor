import path from 'node:path';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import { planWatchlistMinutes, loadWatchlistMinutes } from '../research/peak-rebound-data.ts';
import { getRank1Watchlist } from '../research/peak-rebound-signals.ts';
import { backtestPeakRebound } from '../research/peak-rebound-backtest.ts';
import { computeMacd } from '../src/macd.ts';
import type { PeakReboundSignal } from '../research/peak-rebound-types.ts';

async function main() {
  console.log('================================================================');
  console.log('🧪【MACD 维度精细化探索】新方案 (MA15/30) 结合 MACD 动能饱和');
  console.log('================================================================\n');

  const hourlyDir = path.resolve('data/research/hourly-168h');
  const minutesDir = path.resolve('data/research/peak-rebound-1m-168h');

  const hourly = await loadDataset(hourlyDir);
  const frames = buildFrames(hourly, 10, 1);
  const plan = planWatchlistMinutes(hourly, frames);
  const minuteData = await loadWatchlistMinutes(minutesDir, plan);
  const watchlist = getRank1Watchlist(frames);

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

    // Rolling lows (10m)
    const lowsWindow10 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const start = Math.max(0, i - 10 + 1);
      let m = Infinity;
      for (let k = start; k <= i; k++) if (lows[k] < m) m = lows[k];
      lowsWindow10[i] = m;
    }

    // MAs: 15, 30
    const mas: Record<number, (number | null)[]> = {};
    for (const p of [15, 30]) {
      const arr: (number | null)[] = new Array(n).fill(null);
      let sum = 0;
      for (let i = 0; i < n; i++) {
        sum += closes[i];
        if (i >= p) sum -= closes[i - p];
        if (i >= p - 1) arr[i] = sum / p;
      }
      mas[p] = arr;
    }

    // MACD hist
    const { hist } = computeMacd(closes);

    precomputed.push({
      symbol,
      bars,
      highs,
      lows,
      closes,
      times,
      high24h: Array.from(high24h),
      lowsWindow10: Array.from(lowsWindow10),
      mas,
      hist,
      watchStart: info.firstRank1Time,
      watchEnd: info.lastRank1Time + 24 * 3600000,
    });
  }

  // 测试不同 MACD 过滤配置
  interface MacdExp {
    name: string;
    macdWindow?: number;
    minGreenRatio?: number;
    consecutiveGreen?: number;
  }

  const experiments: MacdExp[] = [
    { name: '1. 基准 (无 MACD 过滤)' },
    { name: '2. 旧方案原生 (近20根 绿柱>65%)', macdWindow: 20, minGreenRatio: 0.65 },
    { name: '3. 适度适配 (近15根 绿柱>60%)', macdWindow: 15, minGreenRatio: 0.60 },
    { name: '4. 适度适配 (近15根 绿柱>50%)', macdWindow: 15, minGreenRatio: 0.50 },
    { name: '5. 窗口同步 (近10根 绿柱>70%)', macdWindow: 10, minGreenRatio: 0.70 },
    { name: '6. 窗口同步 (近10根 绿柱>60%)', macdWindow: 10, minGreenRatio: 0.60 },
    { name: '7. 窗口同步 (近10根 绿柱>50%)', macdWindow: 10, minGreenRatio: 0.50 },
    { name: '8. 末尾连续绿柱 >= 4根 (动能饱和)', consecutiveGreen: 4 },
    { name: '9. 末尾连续绿柱 >= 5根 (动能饱和)', consecutiveGreen: 5 },
    { name: '10. 末尾连续绿柱 >= 6根 (动能饱和)', consecutiveGreen: 6 },
    { name: '11. 双重确认 (近10根>60% 且 连续>=4根)', macdWindow: 10, minGreenRatio: 0.60, consecutiveGreen: 4 },
    { name: '12. 双重确认 (近15根>50% 且 连续>=4根)', macdWindow: 15, minGreenRatio: 0.50, consecutiveGreen: 4 },
  ];

  console.log('-----------------------------------------------------------------------------------------------------------------------------------------');
  console.log('📊 最优解 (X=22%, Y=5%, W=10m, MA[15,30], M=4.0, 45m) 叠加 MACD 动能参数对照');
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

  for (const exp of experiments) {
    const signals: PeakReboundSignal[] = [];

    for (const item of precomputed) {
      const { bars, highs, closes, times, high24h, lowsWindow10, mas, hist, watchStart, watchEnd } = item;
      const ma15Arr = mas[15];
      const ma30Arr = mas[30];
      if (!ma15Arr || !ma30Arr) continue;

      let cooldownUntil = 0;

      for (let i = 60; i < bars.length - 1; i++) {
        const time = times[i];
        if (time < watchStart || time > watchEnd) continue;
        if (time < cooldownUntil) continue;

        const h24 = high24h[i];
        const close = closes[i];
        const high = highs[i];

        // 1. 距离 24h 高点跌超过 22%
        const drop = ((h24 - close) / h24) * 100;
        if (drop < 22) continue;

        // 2. 距离 10m 最低点反弹超过 5%
        const low = lowsWindow10[i];
        if (low <= 0) continue;
        const rebound = ((high - low) / low) * 100;
        if (rebound < 5.0) continue;

        // 3. 均线形态: 1mClose < ma15 < 1mHigh 且 ma15 < ma30
        const ma15 = ma15Arr[i];
        const ma30 = ma30Arr[i];
        if (ma15 == null || ma30 == null) continue;

        if (!(close < ma15 && ma15 < high)) continue;
        if (!(ma15 < ma30)) continue;

        // 下倾确认 (ma30)
        if (i >= 2) {
          const ma30Prev = ma30Arr[i - 2];
          if (ma30Prev != null && ma30 > ma30Prev) continue;
        }

        // 4. MACD 过滤
        if (exp.macdWindow && exp.minGreenRatio) {
          let greenCount = 0;
          for (let k = i - exp.macdWindow + 1; k <= i; k++) {
            if (hist[k] > 0) greenCount++;
          }
          if (greenCount / exp.macdWindow <= exp.minGreenRatio) continue;
        }

        if (exp.consecutiveGreen) {
          let consecutive = 0;
          for (let k = i; k >= 0; k--) {
            if (hist[k] > 0) consecutive++;
            else break;
          }
          if (consecutive < exp.consecutiveGreen) continue;
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
          mediumMa: undefined,
          longMa: 30,
          longMaOffsetPercent: 0,
          greenRatio20: 0,
          maPeriod: 15,
          maPeriods: [15, 30],
          maValues: { 15: ma15, 30: ma30 },
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
      { pullbackX: 22, reboundY: 5.0, maPeriods: [15, 30], holdMinutes: 45, exitX: 35, exitN: 2.0, exitM: 4.0 },
      hourly.manifest.start,
      hourly.manifest.end,
      { takerFeeBps: 5, slippageBps: 2 }
    );

    const s2Target = trades.filter((t) => t.exits[1]?.reason === 'target').length;
    const s2Timeout = trades.filter((t) => t.exits[1]?.reason === 'timeout').length;
    const s2Stop = trades.filter((t) => t.exits[1]?.reason === 'stop').length;

    console.log(
      exp.name.padEnd(52) +
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
