import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import type { MinuteDataset } from '../research/gainers-types.ts';
import { HOUR } from '../research/types.ts';
import { MINUTE } from '../research/gainers-types.ts';
import { calculateSma } from '../research/peak-rebound-signals.ts';
import { computeMacd } from '../src/macd.ts';

async function loadAllMinutes(): Promise<MinuteDataset> {
  const dir1 = path.resolve('data/research/staged-1m-20261020-20261023');
  const dir2 = path.resolve('data/research/peak-rebound-1m-168h');
  const candles = new Map<string, any[]>();

  for (const dir of [dir1, dir2]) {
    try {
      const files = await readdir(dir);
      for (const f of files) {
        if (f.endsWith('.json.gz')) {
          const sym = f.replace('.json.gz', '');
          const bytes = await readFile(path.join(dir, f));
          const bars = JSON.parse(gunzipSync(bytes).toString('utf8'));
          candles.set(sym, bars);
        }
      }
    } catch {}
  }
  return {
    manifest: { version: 1, interval: '1m', source: 'Binance', fetchedAt: '', plan: {} as any, files: {} },
    candles,
  };
}

export function calcLongReturn(
  entryPrice: number,
  exitPrice: number,
  costs = { takerFeeBps: 5, slippageBps: 2 }
) {
  const grossPercent = ((exitPrice - entryPrice) / entryPrice) * 100;
  const entryFeePercent = costs.takerFeeBps / 100;
  const exitFeePercent = (costs.takerFeeBps / 100) * (exitPrice / entryPrice);
  const slippagePercent = (costs.slippageBps / 100) * (1 + exitPrice / entryPrice);
  const netPercent = grossPercent - entryFeePercent - exitFeePercent - slippagePercent;
  return { grossPercent, netPercent };
}

async function main() {
  const minuteData = await loadAllMinutes();
  console.log(`载入 ${minuteData.candles.size} 个币种进行多策略精细参数扫描...\n`);

  // 1. 扫描【闪崩极度负乖离做多】 (Extreme Negative MA Deviation Long)
  console.log('=== 扫描 1: 闪崩极度负乖离做多 (全币种急跌均值回归) ===');
  for (const xMinutes of [2, 3, 5]) {
    for (const minDrop of [3.0, 4.0, 5.0]) {
      for (const minNegDev of [1.5, 2.0, 2.5]) {
        for (const holdM of [15, 20, 30]) {
          const events: any[] = [];
          for (const [sym, bars] of minuteData.candles) {
            if (!bars || bars.length < 65) continue;
            const closes = bars.map(b => b[4]);
            const highs = bars.map(b => b[2]);
            const lows = bars.map(b => b[3]);
            const opens = bars.map(b => b[1]);

            for (let i = 35; i < bars.length - 1; i++) {
              const startX = i - xMinutes + 1;
              if (startX < 0) continue;
              let maxHigh = -Infinity;
              for (let k = startX; k <= i; k++) if (highs[k] > maxHigh) maxHigh = highs[k];
              if (maxHigh <= 0) continue;

              const drop = ((maxHigh - closes[i]) / maxHigh) * 100;
              if (drop < minDrop) continue;

              const ma30 = calculateSma(closes, i, 30);
              if (ma30 == null) continue;
              const negDev = ((ma30 - closes[i]) / ma30) * 100;
              if (negDev < minNegDev) continue;

              // 探针反抽: 下影线
              const c = closes[i], o = opens[i], l = lows[i], h = highs[i];
              const range = h - l;
              const lowerWick = Math.min(o, c) - l;
              if (range > 0 && lowerWick / range < 0.25) continue;

              events.push({ sym, time: bars[i + 1][0], entry: bars[i + 1][1] });
            }
          }

          events.sort((a, b) => a.time - b.time);
          const occupied = new Map<string, number>();
          const trades: any[] = [];

          for (const ev of events) {
            if ((occupied.get(ev.sym) ?? 0) > ev.time) continue;
            const bars = minuteData.candles.get(ev.sym);
            const idx = bars.findIndex((b: any) => b[0] === ev.time);
            if (idx < 0) continue;

            const entry = ev.entry;
            const tp = entry * 1.025; // 2.5% TP
            const sl = entry * 0.975; // 2.5% SL
            let net = 0;
            let exitT = ev.time + holdM * MINUTE;

            for (let s = 0; s < holdM; s++) {
              const b = bars[idx + s];
              if (!b) break;
              if (b[3] <= sl) {
                net = calcLongReturn(entry, sl).netPercent;
                exitT = b[0];
                break;
              } else if (b[2] >= tp) {
                net = calcLongReturn(entry, tp).netPercent;
                exitT = b[0];
                break;
              }
              if (s === holdM - 1) {
                net = calcLongReturn(entry, b[4]).netPercent;
                exitT = b[0];
              }
            }

            occupied.set(ev.sym, exitT + 15 * MINUTE);
            trades.push(net);
          }

          const wins = trades.filter(t => t > 0).length;
          const total = trades.length;
          if (total >= 15) {
            const wr = (wins / total) * 100;
            const netSum = trades.reduce((a, b) => a + b, 0);
            const gains = trades.filter(t => t > 0).reduce((a, b) => a + b, 0);
            const losses = Math.abs(trades.filter(t => t < 0).reduce((a, b) => a + b, 0));
            const pf = losses > 0 ? gains / losses : 999;
            if (wr >= 60 && netSum > 0) {
              console.log(`[极度负乖离] x=${xMinutes}m drop>=${minDrop}% dev>=${minNegDev}% hold=${holdM}m -> 交易数:${total} 胜率:${wr.toFixed(1)}% (${wins}W/${total - wins}L) 净收益:+${netSum.toFixed(2)}% PF:${pf.toFixed(2)}`);
            }
          }
        }
      }
    }
  }
}

main().catch(console.error);
