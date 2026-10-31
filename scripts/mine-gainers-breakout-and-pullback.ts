import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import type { MinuteDataset } from '../research/gainers-types.ts';
import { HOUR } from '../research/types.ts';
import { MINUTE } from '../research/gainers-types.ts';
import { calculateSma } from '../research/peak-rebound-signals.ts';
import { computeMacd, calculateSupportMaAt } from '../src/macd.ts';

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
          candles.set(sym, JSON.parse(gunzipSync(bytes).toString('utf8')));
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
  const hourly = await loadDataset(path.resolve('data/research/hourly-168h'));
  const frames = buildFrames(hourly, 10, 1);
  const minuteData = await loadAllMinutes();

  const gainerBoards = new Map<number, Map<string, any>>();
  for (const frame of frames) {
    const gMap = new Map<string, any>();
    for (const obs of frame.boards.gainers) gMap.set(obs.symbol, { rank: obs.rank, dayChange: obs.dayChange });
    gainerBoards.set(frame.time, gMap);
  }

  console.log('=== 测试 1: 新高动能加速真突破做多 (ATH Momentum Breakout) ===\n');

  for (const surgeDiv of [8, 10, 12]) {
    for (const holdM of [15, 20, 30]) {
      for (const tp of [2.5, 3.0, 4.0]) {
        for (const sl of [2.5, 3.0, 4.0]) {
          const events: any[] = [];
          for (const [sym, bars] of minuteData.candles) {
            if (!bars || bars.length < 65) continue;
            const opens = bars.map(b => b[1]);
            const highs = bars.map(b => b[2]);
            const lows = bars.map(b => b[3]);
            const closes = bars.map(b => b[4]);
            const times = bars.map(b => b[0]);
            const { hist, dif } = computeMacd(closes);

            let curMax24h = 0;

            for (let i = 35; i < bars.length - 1; i++) {
              const t = times[i];
              const bTime = Math.floor(t / HOUR) * HOUR;
              const gRow = gainerBoards.get(bTime)?.get(sym);
              if (!gRow || gRow.rank > 10 || gRow.dayChange < 20) continue;

              const start24h = Math.max(0, i - 1439);
              if (i === 35 || highs[i] > curMax24h) {
                let m = 0; for (let k = start24h; k <= i; k++) if (highs[k] > m) m = highs[k]; curMax24h = m;
              }
              if (curMax24h <= 0) continue;

              // 创 24h 新高
              if (highs[i] < curMax24h) continue;

              // 5m 脉冲
              const start5m = Math.max(0, i - 4);
              let minL5m = Infinity;
              for (let k = start5m; k <= i; k++) if (lows[k] < minL5m) minL5m = lows[k];
              const surge = ((highs[i] - minL5m) / minL5m) * 100;
              if (surge < gRow.dayChange / surgeDiv) continue;

              // 均线支撑: MA[3, 7, 15] 紧随托底
              const candlesList = bars.slice(i - 20, i + 1).map(b => ({ open: b[1], high: b[2], low: b[3], close: b[4], time: b[0] }));
              const supported = calculateSupportMaAt(candlesList, candlesList.length - 1, [3, 7, 15]);
              if (supported === null) continue; // 必须有均线托底，拒绝悬空

              // MACD 动能确认: 寻找 10~60 根前高
              let prevIdx = -1, prevMax = 0;
              for (let k = Math.max(0, i - 60); k <= Math.max(0, i - 10); k++) {
                if (highs[k] > prevMax) { prevMax = highs[k]; prevIdx = k; }
              }
              if (prevIdx < 0 || highs[i] < prevMax) continue;

              // 关键: 真突破动能必须放大 (非背离)
              if (hist[i] <= hist[prevIdx] || dif[i] <= dif[prevIdx]) continue;

              // 收阳线
              if (closes[i] <= opens[i]) continue;

              events.push({ sym, time: bars[i + 1][0], entry: bars[i + 1][1] });
            }
          }

          events.sort((a, b) => a.time - b.time);
          const occ = new Map<string, number>();
          const trades: number[] = [];

          for (const ev of events) {
            if ((occ.get(ev.sym) ?? 0) > ev.time) continue;
            const bars = minuteData.candles.get(ev.sym);
            const idx = bars.findIndex((b: any) => b[0] === ev.time);
            if (idx < 0) continue;

            const entry = ev.entry;
            const tpPrice = entry * (1 + tp / 100);
            const slPrice = entry * (1 - sl / 100);
            let net = 0;
            let exitT = ev.time + holdM * MINUTE;

            for (let s = 0; s < holdM; s++) {
              const b = bars[idx + s];
              if (!b) break;
              if (b[3] <= slPrice) {
                net = calcLongReturn(entry, slPrice).netPercent;
                exitT = b[0];
                break;
              } else if (b[2] >= tpPrice) {
                net = calcLongReturn(entry, tpPrice).netPercent;
                exitT = b[0];
                break;
              }
              if (s === holdM - 1) {
                net = calcLongReturn(entry, b[4]).netPercent;
                exitT = b[0];
              }
            }

            occ.set(ev.sym, exitT + 15 * MINUTE);
            trades.push(net);
          }

          const wins = trades.filter(t => t > 0).length;
          const total = trades.length;
          if (total >= 10) {
            const wr = (wins / total) * 100;
            const netSum = trades.reduce((a, b) => a + b, 0);
            const gains = trades.filter(t => t > 0).reduce((a, b) => a + b, 0);
            const losses = Math.abs(trades.filter(t => t < 0).reduce((a, b) => a + b, 0));
            const pf = losses > 0 ? gains / losses : 999;
            if (wr >= 60 && netSum > 0) {
              console.log(`[新高真突破闪击] div=${surgeDiv} hold=${holdM}m tp=${tp}% sl=${sl}% -> 交易数:${total} 胜率:${wr.toFixed(1)}% (${wins}W/${total - wins}L) 净收益:+${netSum.toFixed(2)}% PF:${pf.toFixed(2)}`);
            }
          }
        }
      }
    }
  }
}

main().catch(console.error);
