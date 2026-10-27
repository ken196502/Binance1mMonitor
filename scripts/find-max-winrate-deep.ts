import path from 'node:path';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import { planWatchlistMinutes, loadWatchlistMinutes } from '../research/peak-rebound-data.ts';
import { getRank1Watchlist } from '../research/peak-rebound-signals.ts';
import { backtestPeakRebound } from '../research/peak-rebound-backtest.ts';
import { computeMacd } from '../src/macd.ts';

async function findMaxWinRate() {
  const hourly = await loadDataset(path.resolve('data/research/hourly-168h'));
  const frames = buildFrames(hourly, 10, 1);
  const plan = planWatchlistMinutes(hourly, frames);
  const minuteData = await loadWatchlistMinutes(path.resolve('data/research/peak-rebound-1m-168h'), plan);
  const watchlist = getRank1Watchlist(frames);

  const precomputed: any[] = [];
  for (const [sym, info] of watchlist.entries()) {
    const bars = minuteData.candles.get(sym);
    if (!bars || bars.length < 65) continue;
    const highs = bars.map((b: any) => b[2]);
    const closes = bars.map((b: any) => b[4]);
    const times = bars.map((b: any) => b[0]);
    const n = bars.length;
    const { hist } = computeMacd(closes);

    const high24h = new Float64Array(n);
    let curMax = 0;
    for (let i = 0; i < n; i++) {
      const start = Math.max(0, i - 1439);
      if (i === 0 || highs[i] >= curMax) {
        let m = 0; for (let k = start; k <= i; k++) if (highs[k] > m) m = highs[k]; curMax = m;
      } else if (highs[start - 1] === curMax) {
        let m = 0; for (let k = start; k <= i; k++) if (highs[k] > m) m = highs[k]; curMax = m;
      }
      high24h[i] = curMax;
    }

    const lows10 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let m = Infinity; for (let k = Math.max(0, i - 9); k <= i; k++) if (bars[k][3] < m) m = bars[k][3]; lows10[i] = m;
    }

    const mas: Record<number, (number | null)[]> = {};
    for (const p of [15, 30]) {
      const arr = new Array(n).fill(null);
      let s = 0;
      for (let i = 0; i < n; i++) {
        s += closes[i];
        if (i >= p) s -= closes[i - p];
        if (i >= p - 1) arr[i] = s / p;
      }
      mas[p] = arr;
    }

    precomputed.push({ sym, bars, highs, closes, times, high24h, lows10, mas, hist, info });
  }

  // Scan across X, Y, MACD, M, hold to find maximum win rate configs
  const results: any[] = [];
  for (const x of [18, 20, 22, 25]) {
    for (const y of [3.0, 4.0, 5.0]) {
      for (const macdThreshold of [undefined, 0.50, 0.65]) {
        const signals: any[] = [];
        for (const item of precomputed) {
          let cooldownUntil = 0;
          for (let i = 60; i < item.bars.length - 1; i++) {
            const t = item.times[i];
            if (t < item.info.firstRank1Time || t > item.info.lastRank1Time + 24 * 3600000) continue;
            if (t < cooldownUntil) continue;

            const drop = ((item.high24h[i] - item.closes[i]) / item.high24h[i]) * 100;
            if (drop < x) continue;

            const low = item.lows10[i];
            const reb = ((item.highs[i] - low) / low) * 100;
            if (reb < y) continue;

            const ma15 = item.mas[15][i];
            const ma30 = item.mas[30][i];
            const ma30Prev = item.mas[30][i - 2];
            if (ma15 == null || ma30 == null || ma30Prev == null) continue;

            if (!(item.closes[i] < ma15 && ma15 < item.highs[i])) continue;
            if (!(ma15 < ma30 && ma30 <= ma30Prev)) continue;

            if (macdThreshold !== undefined) {
              let g = 0;
              for (let k = i - 19; k <= i; k++) if (item.hist[k] > 0) g++;
              if (g / 20 <= macdThreshold) continue;
            }

            signals.push({
              symbol: item.sym,
              time: item.times[i + 1],
              entryTime: item.times[i + 1],
              entryPrice: item.bars[i + 1][1],
              index: i,
              dayChangePercent: 25,
              rank: 1,
              peakPrice: item.high24h[i],
              troughPrice: low,
              pullbackPercent: drop,
              reboundPercent: reb,
              shortMa: 15,
              longMa: 30,
              maPeriod: 15,
              maPeriods: [15, 30],
              close: item.closes[i],
              high: item.highs[i],
              low: item.bars[i][3],
              open: item.bars[i][1],
            });
            cooldownUntil = t + 30 * 60 * 1000;
          }
        }

        if (signals.length < 5) continue;

        for (const m of [1.5, 2.0, 3.0, 4.0]) {
          for (const hold of [15, 30, 45]) {
            const { metrics, trades } = backtestPeakRebound(
              minuteData,
              signals,
              { pullbackX: x, reboundY: y, maPeriods: [15, 30], holdMinutes: hold, exitX: 35, exitN: 2.0, exitM: m },
              hourly.manifest.start,
              hourly.manifest.end,
              { takerFeeBps: 5, slippageBps: 2 }
            );
            if (metrics.trades >= 5 && metrics.netPnlPercent > 0) {
              const s2Stop = trades.filter((t: any) => t.exits[1]?.reason === 'stop').length;
              const s2Target = trades.filter((t: any) => t.exits[1]?.reason === 'target').length;
              results.push({
                x, y, macdThreshold, m, hold,
                trades: metrics.trades,
                winRate: metrics.winRate || 0,
                netPnl: metrics.netPnlPercent,
                pf: metrics.profitFactor || 0,
                s2Target, s2Stop,
              });
            }
          }
        }
      }
    }
  }

  // Sort by winRate descending
  results.sort((a, b) => b.winRate - a.winRate);
  console.log('Top 20 Highest Win Rate configurations for Deep Rebound:');
  for (const r of results.slice(0, 20)) {
    console.log(
      `胜率: ${r.winRate.toFixed(1)}% | 净利: +${r.netPnl.toFixed(2)}% | PF: ${r.pf.toFixed(2)} | 交易: ${r.trades} (止盈: ${r.s2Target}, 止损: ${r.s2Stop}) | X=${r.x}%, Y=${r.y}%, MACD=${r.macdThreshold ?? 'None'}, Hold=${r.hold}m, M=${r.m}`
    );
  }
}

findMaxWinRate().catch(console.error);
