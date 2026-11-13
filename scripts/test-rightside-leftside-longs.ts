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

export function calcTradeReturn(
  side: 'LONG' | 'SHORT',
  entryPrice: number,
  exitPrice: number,
  costs = { takerFeeBps: 5, slippageBps: 2 }
) {
  const grossPercent =
    side === 'LONG'
      ? ((exitPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - exitPrice) / entryPrice) * 100;

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

  interface CandidateSig {
    symbol: string;
    type: 'right_pullback' | 'left_3w_div';
    time: number;
    entryTime: number;
    entryPrice: number;
    dayChange: number;
  }

  const pullbackEvents: CandidateSig[] = [];
  const divEvents: CandidateSig[] = [];

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
      if (!gRow || gRow.rank > 10 || gRow.dayChange < 20) continue;

      const start24h = Math.max(0, i - 1439);
      if (i === 40 || highs[i] > curMax24h) {
        let m = 0; for (let k = start24h; k <= i; k++) if (highs[k] > m) m = highs[k]; curMax24h = m;
      }
      if (curMax24h <= 0) continue;

      // 1. 【右侧回调反弹做多】 (Right-side Pullback Bounce Long)
      // 必须是 24h 涨幅 >= 25% 龙头，回踩 10%~20%，MA30 严格上倾托底，收阳企稳
      if (gRow.dayChange >= 25.0) {
        const drop = ((curMax24h - closes[i]) / curMax24h) * 100;
        if (drop >= 10.0 && drop <= 20.0) {
          const ma30 = calculateSma(closes, i, 30);
          const ma30Prev = calculateSma(closes, i - 3, 30);
          if (ma30 && ma30Prev && ma30 > ma30Prev) {
            if (lows[i] <= ma30 * 1.003 && closes[i] >= ma30 * 0.998) {
              if (dif[i] > 0) {
                const range = highs[i] - lows[i];
                const lowerWick = Math.min(opens[i], closes[i]) - lows[i];
                const isBull = closes[i] >= opens[i];
                if (isBull || (range > 0 && lowerWick / range >= 0.40)) {
                  pullbackEvents.push({
                    symbol: sym,
                    type: 'right_pullback',
                    time: t,
                    entryTime: bars[i + 1][0],
                    entryPrice: bars[i + 1][1],
                    dayChange: gRow.dayChange,
                  });
                }
              }
            }
          }
        }
      }

      // 2. 【左侧 3W 底背离弹射做多】 (Left-side 3W Bottom Divergence Catapult Long)
      // 在 10~40 根内构成 W 底 (或 3W 底) 且 MACD 强底背离，弹射收阳
      let high30 = 0;
      for (let k = Math.max(0, i - 30); k <= i; k++) if (highs[k] > high30) high30 = highs[k];
      const drop30 = high30 > 0 ? ((high30 - lows[i]) / high30) * 100 : 0;

      if (drop30 >= 4.0) {
        // 寻找前低 (8~25 根前)
        let prevMinIdx = -1, prevMinLow = Infinity;
        for (let k = Math.max(0, i - 25); k <= i - 8; k++) {
          if (lows[k] < prevMinLow) {
            prevMinLow = lows[k];
            prevMinIdx = k;
          }
        }

        if (prevMinIdx > 0 && Number.isFinite(prevMinLow)) {
          // 两底之间有波峰反弹构成 W 颈线
          let midPeak = 0;
          for (let k = prevMinIdx; k <= i; k++) if (highs[k] > midPeak) midPeak = highs[k];
          const midBounce = ((midPeak - prevMinLow) / prevMinLow) * 100;

          if (midBounce >= 1.5) {
            let midMin = Infinity;
            for (let k = prevMinIdx; k <= i; k++) if (lows[k] < midMin) midMin = lows[k];
            // 严格过滤底部不断降低：当前底与两底间最低点均不跌破前底 (0.2% 误差容忍)
            if (lows[i] <= prevMinLow * 1.005 && lows[i] >= prevMinLow * 0.998 && midMin >= prevMinLow * 0.998) {
              // MACD DIF 快线抬高且 Hist 红柱显著收窄
              if (dif[i] > dif[prevMinIdx] && hist[i] > hist[prevMinIdx]) {
                // 弹射阳线: 收盘突破前一根高点或收出实体阳线
                if (closes[i] > opens[i] && closes[i] > highs[i - 1] * 0.999) {
                  divEvents.push({
                    symbol: sym,
                    type: 'left_3w_div',
                    time: t,
                    entryTime: bars[i + 1][0],
                    entryPrice: bars[i + 1][1],
                    dayChange: gRow.dayChange,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  console.log(`收集信号: 右侧回调反弹 ${pullbackEvents.length} 笔, 左侧 3W 底背离 ${divEvents.length} 笔。\n`);

  for (const holdM of [30, 45, 60, 90]) {
    for (const [tp1, tp2, sl, sl2] of [[3.0, 8.0, 3.5, 7.0], [3.0, 8.0, 4.0, 8.0], [2.5, 6.0, 2.5, 5.0]]) {
      const evalStrat = (events: CandidateSig[], name: string) => {
        events.sort((a, b) => a.entryTime - b.entryTime);
        const occ = new Map<string, number>();
        const trades: number[] = [];

        for (const ev of events) {
          if ((occ.get(ev.symbol) ?? 0) > ev.entryTime) continue;
          const bars = minuteData.candles.get(ev.symbol);
          const idx = bars.findIndex((b: any) => b[0] === ev.entryTime);
          if (idx < 0) continue;

          const entry = ev.entryPrice;
          const tp1Price = entry * (1 + tp1 / 100);
          const tp2Price = entry * (1 + tp2 / 100);
          const slPrice = entry * (1 - sl / 100);
          let sl2Price = entry * (1 - sl2 / 100);
          let st1 = false, st2 = false;
          let net = 0;
          let exitT = ev.entryTime + holdM * MINUTE;

          for (let s = 0; s < holdM; s++) {
            const b = bars[idx + s];
            if (!b) break;
            const h = b[2], l = b[3], c = b[4];

            if (!st1) {
              if (l <= slPrice) {
                net += calcTradeReturn('LONG', entry, slPrice).netPercent * 0.5;
                st1 = true;
              } else if (h >= tp1Price) {
                net += calcTradeReturn('LONG', entry, tp1Price).netPercent * 0.5;
                st1 = true;
                sl2Price = entry;
              }
            }

            if (st1 && !st2) {
              if (l <= sl2Price) {
                net += calcTradeReturn('LONG', entry, sl2Price).netPercent * 0.5;
                st2 = true;
                exitT = b[0];
                break;
              } else if (h >= tp2Price) {
                net += calcTradeReturn('LONG', entry, tp2Price).netPercent * 0.5;
                st2 = true;
                exitT = b[0];
                break;
              }
            }

            if (s === holdM - 1) {
              const rem = !st1 ? 1.0 : !st2 ? 0.5 : 0;
              if (rem > 0) net += calcTradeReturn('LONG', entry, c).netPercent * rem;
              exitT = b[0];
            }
          }

          occ.set(ev.symbol, exitT + 20 * MINUTE);
          trades.push(net);
        }

        const total = trades.length;
        const wins = trades.filter(t => t > 0).length;
        const wr = total > 0 ? (wins / total) * 100 : 0;
        const netSum = trades.reduce((a, b) => a + b, 0);
        const gains = trades.filter(t => t > 0).reduce((a, b) => a + b, 0);
        const losses = Math.abs(trades.filter(t => t < 0).reduce((a, b) => a + b, 0));
        const pf = losses > 0 ? gains / losses : 999;

        if (wr >= 60) {
          console.log(
            `[${name}] hold=${holdM}m (TP:+${tp1}%/+${tp2}% SL:-${sl}%) -> 交易数: ${String(total).padStart(3)} | 胜率: ${wr.toFixed(1)}% (${wins}W/${total - wins}L) | 净收益: ${(netSum >= 0 ? '+' : '') + netSum.toFixed(2)}% | PF: ${pf.toFixed(2)}`
          );
        }
      };

      evalStrat(pullbackEvents, '右侧回调反弹');
      evalStrat(divEvents, '左侧3W底背离');
    }
  }
}

main().catch(console.error);
