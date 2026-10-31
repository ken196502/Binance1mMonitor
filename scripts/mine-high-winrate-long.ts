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

interface TestSetup {
  name: string;
  detector: (ctx: {
    candle: any;
    closes: number[];
    highs: number[];
    lows: number[];
    opens: number[];
    idx: number;
    hist: number[];
    dif: number[];
    high24h: number;
    low24h: number;
    dayChange: number;
    rank: number;
  }) => boolean;
  tp1: number;
  tp2: number;
  sl: number;
  holdM: number;
}

async function runTest(setup: TestSetup, minuteData: MinuteDataset, gainerBoards: Map<number, Map<string, any>>) {
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
    let curMin24h = Infinity;

    for (let i = 35; i < bars.length - 1; i++) {
      const t = times[i];
      const bTime = Math.floor(t / HOUR) * HOUR;
      const gRow = gainerBoards.get(bTime)?.get(sym);
      if (!gRow) continue;

      const start24h = Math.max(0, i - 1439);
      if (i === 35 || highs[i] > curMax24h) {
        let m = 0;
        for (let k = start24h; k <= i; k++) if (highs[k] > m) m = highs[k];
        curMax24h = m;
      }
      if (i === 35 || lows[i] < curMin24h) {
        let mi = Infinity;
        for (let k = start24h; k <= i; k++) if (lows[k] < mi) mi = lows[k];
        curMin24h = mi;
      }

      const candleObj = { open: opens[i], high: highs[i], low: lows[i], close: closes[i], time: times[i] };
      const matched = setup.detector({
        candle: candleObj,
        closes,
        highs,
        lows,
        opens,
        idx: i,
        hist,
        dif,
        high24h: curMax24h,
        low24h: curMin24h,
        dayChange: gRow.dayChange,
        rank: gRow.rank,
      });

      if (matched) {
        events.push({ sym, time: bars[i + 1][0], entry: bars[i + 1][1] });
      }
    }
  }

  events.sort((a, b) => a.time - b.time);
  const occupied = new Map<string, number>();
  const trades: number[] = [];

  for (const ev of events) {
    if ((occupied.get(ev.sym) ?? 0) > ev.time) continue;
    const bars = minuteData.candles.get(ev.sym);
    const idx = bars.findIndex((b: any) => b[0] === ev.time);
    if (idx < 0) continue;

    const entry = ev.entry;
    const tp1Price = entry * (1 + setup.tp1 / 100);
    const tp2Price = entry * (1 + setup.tp2 / 100);
    const sl1Price = entry * (1 - setup.sl / 100);
    let sl2Price = entry * (1 - setup.sl / 100);

    let stage1Closed = false;
    let stage2Closed = false;
    let tradeNet = 0;
    let exitT = ev.time + setup.holdM * MINUTE;

    for (let s = 0; s < setup.holdM; s++) {
      const b = bars[idx + s];
      if (!b) break;

      if (!stage1Closed) {
        if (b[3] <= sl1Price) {
          tradeNet += calcLongReturn(entry, sl1Price).netPercent * 0.5;
          stage1Closed = true;
        } else if (b[2] >= tp1Price) {
          tradeNet += calcLongReturn(entry, tp1Price).netPercent * 0.5;
          stage1Closed = true;
          sl2Price = entry; // Move to breakeven
        }
      }

      if (stage1Closed && !stage2Closed) {
        if (b[3] <= sl2Price) {
          tradeNet += calcLongReturn(entry, sl2Price).netPercent * 0.5;
          stage2Closed = true;
          exitT = b[0];
          break;
        } else if (b[2] >= tp2Price) {
          tradeNet += calcLongReturn(entry, tp2Price).netPercent * 0.5;
          stage2Closed = true;
          exitT = b[0];
          break;
        }
      }

      if (s === setup.holdM - 1) {
        const rem = !stage1Closed ? 1.0 : !stage2Closed ? 0.5 : 0;
        if (rem > 0) tradeNet += calcLongReturn(entry, b[4]).netPercent * rem;
        exitT = b[0];
      }
    }

    occupied.set(ev.sym, exitT + 15 * MINUTE);
    trades.push(tradeNet);
  }

  const total = trades.length;
  const wins = trades.filter(t => t > 0).length;
  const wr = total > 0 ? (wins / total) * 100 : 0;
  const netSum = trades.reduce((a, b) => a + b, 0);
  const gains = trades.filter(t => t > 0).reduce((a, b) => a + b, 0);
  const lossSum = Math.abs(trades.filter(t => t < 0).reduce((a, b) => a + b, 0));
  const pf = lossSum > 0 ? gains / lossSum : gains > 0 ? 999 : 0;

  if (total >= 10 && wr >= 55) {
    console.log(`[${setup.name.padEnd(35)}] N=${String(total).padStart(3)} | 胜率: ${(wr.toFixed(1) + '%').padStart(6)} (${wins}W/${total - wins}L) | 净收益: ${(netSum >= 0 ? '+' : '') + netSum.toFixed(2) + '%'} | PF: ${pf.toFixed(2)}`);
  }
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

  console.log('=== 多头高胜率策略寻优扫描 ===\n');

  // 模型 1：龙头生命线回踩 (支持不同周期均线 MA15, MA30, MA60)
  for (const maPeriod of [15, 30, 45, 60]) {
    for (const dropMin of [8.0, 10.0, 12.0, 15.0]) {
      for (const tp1 of [3.0, 4.0, 5.0]) {
        for (const tp2 of [6.0, 8.0, 10.0]) {
          for (const sl of [5.0, 6.0, 8.0]) {
            for (const holdM of [45, 60, 90]) {
              await runTest({
                name: `MA${maPeriod}回踩(drop>=${dropMin}%,tp=${tp1}/${tp2},sl=${sl},h=${holdM}m)`,
                tp1, tp2, sl, holdM,
                detector: ({ candle, closes, high24h, idx, dayChange, rank, dif, hist }) => {
                  if (rank > 10 || dayChange < 25) return false;
                  if (high24h <= 0) return false;

                  const drop = ((high24h - candle.close) / high24h) * 100;
                  if (drop < dropMin || drop > 22.0) return false;

                  const ma = calculateSma(closes, idx, maPeriod);
                  const maPrev = calculateSma(closes, idx - 3, maPeriod);
                  if (ma == null || maPrev == null) return false;
                  if (ma <= maPrev) return false; // 均线上倾

                  // 触碰均线支撑
                  if (!(candle.low <= ma * 1.003 && candle.close >= ma * 0.998)) return false;

                  // MACD 大势为多
                  if (dif[idx] <= 0) return false;

                  // K线必须出现企稳买盘 (收阳或下影线占比 >= 40%)
                  const range = candle.high - candle.low;
                  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
                  const isBull = candle.close >= candle.open;
                  if (!isBull && (range <= 0 || lowerWick / range < 0.4)) return false;

                  return true;
                }
              }, minuteData, gainerBoards);
            }
          }
        }
      }
    }
  }
}

main().catch(console.error);
