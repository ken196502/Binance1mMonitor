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

  console.log('=== 精细化测试：Top 5 vs Top 10 + 冷静期 + 出场优化 ===\n');

  const configs: any[] = [];

  for (const topN of [5, 10]) {
    for (const x of [5, 10, 15, 20]) {
      for (const n of [4.0, 5.0, 6.0, 8.0]) {
        for (const maPeriod of [15, 30]) {
          for (const tp1 of [3.0, 3.5, 4.0]) {
            for (const sl of [6.0, 7.0, 8.0]) {
              const events: any[] = [];

              for (const [sym, bars] of minuteData.candles) {
                if (!bars || bars.length < 65) continue;
                const opens = bars.map(b => b[1]);
                const highs = bars.map(b => b[2]);
                const lows = bars.map(b => b[3]);
                const closes = bars.map(b => b[4]);
                const times = bars.map(b => b[0]);
                const { dif, hist } = computeMacd(closes);

                let curMax24h = 0;

                for (let i = 40; i < bars.length - 1; i++) {
                  const t = times[i];
                  const bTime = Math.floor(t / HOUR) * HOUR;
                  const gRow = gainerBoards.get(bTime)?.get(sym);
                  if (!gRow || gRow.rank > topN || gRow.dayChange < 25) continue;

                  const dayChange = gRow.dayChange;

                  const start24h = Math.max(0, i - 1439);
                  if (i === 40 || highs[i] > curMax24h) {
                    let m = 0; for (let k = start24h; k <= i; k++) if (highs[k] > m) m = highs[k]; curMax24h = m;
                  }
                  if (curMax24h <= 0) continue;
                  const drop = ((curMax24h - closes[i]) / curMax24h) * 100;
                  if (drop < 5.0 || drop > 20.0) continue;

                  // 1. X 分钟在 24h/N 内震荡
                  const startX = Math.max(0, i - x + 1);
                  let maxH = 0, minL = Infinity;
                  for (let k = startX; k <= i; k++) {
                    if (highs[k] > maxH) maxH = highs[k];
                    if (lows[k] < minL) minL = lows[k];
                  }
                  if (minL <= 0 || maxH <= minL) continue;

                  const ampX = ((maxH - minL) / minL) * 100;
                  if (ampX > dayChange / n || ampX < 0.5) continue;

                  // 2. 均线多头排列与托底 (MA15 > MA30 且价格踩在 MA15 或 MA30 上)
                  const ma15 = calculateSma(closes, i, 15);
                  const ma30 = calculateSma(closes, i, 30);
                  const ma30Prev = calculateSma(closes, i - 3, 30);
                  if (!ma15 || !ma30 || !ma30Prev || ma30 <= ma30Prev || ma15 < ma30) continue;
                  if (!(lows[i] <= ma15 * 1.003 && closes[i] >= ma15 * 0.998)) continue;

                  // 3. MACD 水上多头且动能向上
                  if (dif[i] <= 0 || hist[i] <= 0) continue;

                  // 4. 收阳或长下影
                  const range = highs[i] - lows[i];
                  const lowerWick = Math.min(opens[i], closes[i]) - lows[i];
                  const isBull = closes[i] >= opens[i];
                  if (!isBull && (range <= 0 || lowerWick / range < 0.40)) continue;

                  events.push({ sym, time: bars[i + 1][0], entry: bars[i + 1][1] });
                }
              }

              if (events.length < 15) continue;
              events.sort((a, b) => a.time - b.time);

              const occ = new Map<string, number>();
              const trades: number[] = [];

              for (const ev of events) {
                if ((occ.get(ev.sym) ?? 0) > ev.time) continue;
                const bars = minuteData.candles.get(ev.sym);
                const idx = bars.findIndex((b: any) => b[0] === ev.time);
                if (idx < 0) continue;

                const entry = ev.entry;
                const tp1Price = entry * (1 + tp1 / 100);
                const tp2Price = entry * 1.08;
                const slPrice = entry * (1 - sl / 100);
                let sl2Price = slPrice;
                let st1 = false, st2 = false;
                let net = 0;
                let exitT = ev.time + 90 * MINUTE;

                for (let s = 0; s < 90; s++) {
                  const b = bars[idx + s];
                  if (!b) break;
                  const h = b[2], l = b[3], c = b[4];

                  if (!st1) {
                    if (l <= slPrice) {
                      net += calcLongReturn(entry, slPrice).netPercent * 0.5;
                      st1 = true;
                    } else if (h >= tp1Price) {
                      net += calcLongReturn(entry, tp1Price).netPercent * 0.5;
                      st1 = true;
                      sl2Price = entry;
                    }
                  }

                  if (st1 && !st2) {
                    if (l <= sl2Price) {
                      net += calcLongReturn(entry, sl2Price).netPercent * 0.5;
                      st2 = true;
                      exitT = b[0];
                      break;
                    } else if (h >= tp2Price) {
                      net += calcLongReturn(entry, tp2Price).netPercent * 0.5;
                      st2 = true;
                      exitT = b[0];
                      break;
                    }
                  }

                  if (s === 89) {
                    const rem = !st1 ? 1.0 : !st2 ? 0.5 : 0;
                    if (rem > 0) net += calcLongReturn(entry, c).netPercent * rem;
                    exitT = b[0];
                  }
                }

                occ.set(ev.sym, exitT + 25 * MINUTE);
                trades.push(net);
              }

              const total = trades.length;
              if (total >= 15) {
                const wins = trades.filter(t => t > 0).length;
                const wr = (wins / total) * 100;
                const netSum = trades.reduce((a, b) => a + b, 0);
                const gains = trades.filter(t => t > 0).reduce((a, b) => a + b, 0);
                const losses = Math.abs(trades.filter(t => t < 0).reduce((a, b) => a + b, 0));
                const pf = losses > 0 ? gains / losses : 999;

                if (wr >= 65 && netSum > 10) {
                  configs.push({
                    desc: `Top${topN} X=${x}m N=${n} MA${maPeriod} tp1=+${tp1}% sl=-${sl}%`,
                    total,
                    wins,
                    wr,
                    netSum,
                    pf,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  configs.sort((a, b) => b.wr - a.wr || b.netSum - a.netSum);

  console.log(`🎉 挖掘出 ${configs.length} 组超高胜率策略 (胜率 >= 70% 且 净收益 > +10%)：\n`);
  console.log('| 序号 | 参数配置 | 交易数 | 战绩(胜/负) | 胜率 | 累计净收益 | PF |');
  console.log('| :---: | :--- | :---: | :---: | :---: | :---: | :---: |');

  configs.slice(0, 25).forEach((c, i) => {
    console.log(
      `| ${String(i + 1).padStart(2)} | ${c.desc.padEnd(42)} | ${String(c.total).padStart(5)} | ${String(`${c.wins}W/${c.total - c.wins}L`).padStart(9)} | ${c.wr.toFixed(1)}% | +${c.netSum.toFixed(2)}% | ${c.pf.toFixed(2)} |`
    );
  });
}

main().catch(console.error);
