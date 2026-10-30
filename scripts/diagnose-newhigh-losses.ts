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

  const symbolsToDiagnose = [
    { symbol: 'ARIAUSDT', timeStr: '2026-10-18T14:54' },
    { symbol: 'QUSDT', timeStr: '2026-10-19T04:30' },
    { symbol: 'BRUSDT', timeStr: '2026-10-19T19:53' },
  ];

  for (const item of symbolsToDiagnose) {
    const bars = minuteData.candles.get(item.symbol)!;
    const targetIdx = bars.findIndex(b => new Date(b[0]).toISOString().startsWith(item.timeStr));
    if (targetIdx < 0) continue;

    const sigIdx = targetIdx - 1; // 信号K线
    const sigBar = bars[sigIdx];
    const fillBar = bars[targetIdx];

    const closes = bars.slice(0, sigIdx + 1).map(b => b[4]);
    const highs = bars.slice(0, sigIdx + 1).map(b => b[2]);
    const lows = bars.slice(0, sigIdx + 1).map(b => b[3]);
    const { hist, dif } = computeMacd(closes);

    console.log(`\n================================================================`);
    console.log(`🔍 诊断亏损交易: ${item.symbol} @ ${item.timeStr}`);
    console.log(`================================================================`);
    console.log(`入场K线时间: ${new Date(fillBar[0]).toISOString()}, 开盘入场价: ${fillBar[1]}`);
    console.log(`信号K线: Open=${sigBar[1]}, High=${sigBar[2]}, Low=${sigBar[3]}, Close=${sigBar[4]}`);
    console.log(`信号K线形态: 阳线/阴线: ${sigBar[4] >= sigBar[1] ? '🟢 阳线' : '🔴 阴线'}, 上影线: ${(sigBar[2] - Math.max(sigBar[1], sigBar[4])).toFixed(4)}`);
    console.log(`当前 MACD Hist: ${hist[sigIdx].toFixed(6)}, DIF: ${dif[sigIdx].toFixed(6)}`);

    // 观察信号后 15 根 K 线的价格走势
    console.log(`\n后续 15 分钟走势:`);
    for (let k = 0; k < 15; k++) {
      const b = bars[targetIdx + k];
      if (!b) break;
      const chg = ((b[4] - fillBar[1]) / fillBar[1] * 100).toFixed(2);
      const highChg = ((b[2] - fillBar[1]) / fillBar[1] * 100).toFixed(2);
      console.log(`  +${k + 1}m: High=+${highChg}%, Close=${chg}% (O=${b[1]}, H=${b[2]}, L=${b[3]}, C=${b[4]})`);
    }
  }
}

main().catch(console.error);
