import path from 'node:path';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import { planWatchlistMinutes, loadWatchlistMinutes } from '../research/peak-rebound-data.ts';
import { calculateSupportMaAt, computeMacd } from '../src/macd.ts';
import { HOUR } from '../research/types.ts';

async function main() {
  const hourlyDir = path.resolve('data/research/hourly-168h');
  const minutesDir = path.resolve('data/research/peak-rebound-1m-168h');

  const hourly = await loadDataset(hourlyDir);
  const frames = buildFrames(hourly, 10, 1);
  const plan = planWatchlistMinutes(hourly, frames);
  const minuteData = await loadWatchlistMinutes(minutesDir, plan);

  const boards = new Map<number, Map<string, { rank: number; dayChange: number }>>();
  for (const f of frames) {
    const m = new Map<string, { rank: number; dayChange: number }>();
    for (const b of f.boards.gainers) m.set(b.symbol, { rank: b.rank, dayChange: b.dayChange });
    boards.set(f.time, m);
  }

  // 检查所有 10 笔交易的信号特征
  for (const [sym, bars] of minuteData.candles) {
    if (!bars || bars.length < 65) continue;
    const opens = bars.map(b => b[1]);
    const highs = bars.map(b => b[2]);
    const lows = bars.map(b => b[3]);
    const closes = bars.map(b => b[4]);
    const times = bars.map(b => b[0]);
    const { hist, dif } = computeMacd(closes);
    const candlesList = bars.map(b => ({ time: b[0], open: b[1], high: b[2], low: b[3], close: b[4] }));

    let curMax24h = 0;

    for (let i = 35; i < bars.length - 1; i++) {
      const t = times[i];
      const bTime = Math.floor(t / HOUR) * HOUR;
      const row = boards.get(bTime)?.get(sym);
      if (!row) continue;

      const start24h = Math.max(0, i - 1439);
      if (i === 35 || highs[i] > curMax24h) {
        let m = 0;
        for (let k = start24h; k <= i; k++) if (highs[k] > m) m = highs[k];
        curMax24h = m;
      }

      if (row.rank > 10 || row.dayChange < 15) continue;

      const startX = Math.max(0, i - 4);
      let minLow = Infinity;
      for (let k = startX; k <= i; k++) if (lows[k] < minLow) minLow = lows[k];
      if (minLow <= 0) continue;
      const surge = ((highs[i] - minLow) / minLow) * 100;
      const reqSurge = row.dayChange / 10.0;
      if (surge < reqSurge) continue;

      if (highs[i] < curMax24h) continue;

      if (calculateSupportMaAt(candlesList, i, [3, 7, 15]) !== null) continue;

      const lookStart = Math.max(0, i - 120);
      const lookEnd = Math.max(0, i - 10);
      if (lookEnd <= lookStart) continue;

      let prevIdx = -1;
      let prevMax = 0;
      for (let k = lookStart; k <= lookEnd; k++) {
        if (highs[k] > prevMax) {
          prevMax = highs[k];
          prevIdx = k;
        }
      }
      if (prevIdx < 0 || highs[i] < prevMax) continue;
      if (hist[i] >= hist[prevIdx] || dif[i] >= dif[prevIdx]) continue;

      // 统计更多信号特征
      const candle = candlesList[i];
      const body = Math.abs(candle.close - candle.open);
      const upperShadow = candle.high - Math.max(candle.close, candle.open);
      const lowerShadow = Math.min(candle.close, candle.open) - candle.low;
      const upperShadowRatio = body > 0 ? upperShadow / body : 0;
      const isBearish = candle.close < candle.open;
      const histDiffRatio = (hist[prevIdx] - hist[i]) / Math.abs(hist[prevIdx]);

      // 距离前高柱数
      const barsFromPeak = i - prevIdx;

      console.log(
        `[${sym.padEnd(8)}] @ ${new Date(times[i + 1]).toISOString().slice(5, 16)} | 24h: +${row.dayChange.toFixed(1)}% | 5m冲高: +${surge.toFixed(1)}% | ` +
        `阴线: ${isBearish ? '是' : '否'} | 上影/实体比: ${upperShadowRatio.toFixed(2)} | 下影: ${((lowerShadow / candle.open) * 100).toFixed(2)}% | ` +
        `距前高: ${barsFromPeak}根 | Hist背离衰减: ${(histDiffRatio * 100).toFixed(0)}%`
      );
    }
  }
}

main().catch(console.error);
