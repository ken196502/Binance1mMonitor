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

  console.log('=== 测试：涨幅榜首（Rank 1）首次回踩状态机做多 ===\n');

  interface Rank1Watch {
    symbol: string;
    peakPrice: number;
    troughPrice: number;
    state: 'watching_peak' | 'pulled_back' | 'triggered' | 'done';
    cooldownUntil: number;
  }

  const watchlist = new Map<string, Rank1Watch>();
  const events: any[] = [];

  for (const [sym, bars] of minuteData.candles) {
    if (!bars || bars.length < 65) continue;
    const closes = bars.map(b => b[4]);
    const highs = bars.map(b => b[2]);
    const lows = bars.map(b => b[3]);
    const opens = bars.map(b => b[1]);
    const times = bars.map(b => b[0]);
    const { dif, hist } = computeMacd(closes);

    let item: Rank1Watch = {
      symbol: sym,
      peakPrice: 0,
      troughPrice: Infinity,
      state: 'watching_peak',
      cooldownUntil: 0,
    };

    for (let i = 35; i < bars.length - 1; i++) {
      const t = times[i];
      const bTime = Math.floor(t / HOUR) * HOUR;
      const gRow = gainerBoards.get(bTime)?.get(sym);

      // 必须是榜一标的
      if (gRow && gRow.rank === 1 && gRow.dayChange >= 25) {
        if (item.peakPrice === 0 || highs[i] > item.peakPrice) {
          item.peakPrice = highs[i];
          item.troughPrice = lows[i];
          item.state = 'watching_peak';
        }
      }

      if (item.peakPrice === 0) continue;
      if (t < item.cooldownUntil) continue;

      if (item.state === 'watching_peak') {
        if (highs[i] >= item.peakPrice) {
          item.peakPrice = highs[i];
          item.troughPrice = lows[i];
        } else {
          const drop = ((item.peakPrice - lows[i]) / item.peakPrice) * 100;
          if (drop >= 10.0 && drop <= 18.0) {
            item.state = 'pulled_back';
            item.troughPrice = lows[i];
          }
        }
        continue;
      }

      if (item.state === 'pulled_back') {
        if (highs[i] > item.peakPrice) {
          item.peakPrice = highs[i];
          item.state = 'watching_peak';
          continue;
        }

        // 企稳阳线反包确认
        const isBullish = closes[i] > opens[i];
        const body = closes[i] - opens[i];
        const range = highs[i] - lows[i];
        const hasGoodBody = range > 0 && body / range >= 0.45;
        const bouncePercent = ((closes[i] - item.troughPrice) / item.troughPrice) * 100;

        if (isBullish && hasGoodBody && bouncePercent >= 2.0 && dif[i] > 0) {
          events.push({ sym, time: bars[i + 1][0], entry: bars[i + 1][1], drop: ((item.peakPrice - closes[i]) / item.peakPrice) * 100 });
          item.state = 'done';
          item.cooldownUntil = t + 120 * MINUTE; // 触发后长冷静期，单次主升浪仅做一次
        }
      }
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
    const tp1 = entry * 1.035;
    const tp2 = entry * 1.08;
    const sl1 = entry * 0.94; // 6% 紧止损
    let sl2 = sl1;

    let stage1 = false, stage2 = false;
    let net = 0;
    let exitT = ev.time + 45 * MINUTE;

    for (let s = 0; s < 45; s++) {
      const b = bars[idx + s];
      if (!b) break;
      if (!stage1) {
        if (b[3] <= sl1) { net += calcLongReturn(entry, sl1).netPercent * 0.5; stage1 = true; }
        else if (b[2] >= tp1) { net += calcLongReturn(entry, tp1).netPercent * 0.5; stage1 = true; sl2 = entry; }
      }
      if (stage1 && !stage2) {
        if (b[3] <= sl2) { net += calcLongReturn(entry, sl2).netPercent * 0.5; stage2 = true; exitT = b[0]; break; }
        else if (b[2] >= tp2) { net += calcLongReturn(entry, tp2).netPercent * 0.5; stage2 = true; exitT = b[0]; break; }
      }
      if (s === 44) {
        const rem = !stage1 ? 1.0 : !stage2 ? 0.5 : 0;
        if (rem > 0) net += calcLongReturn(entry, b[4]).netPercent * rem;
        exitT = b[0];
      }
    }

    occ.set(ev.sym, exitT);
    trades.push(net);
  }

  const wins = trades.filter(t => t > 0).length;
  const total = trades.length;
  const wr = total > 0 ? (wins / total) * 100 : 0;
  const netSum = trades.reduce((a, b) => a + b, 0);
  const gains = trades.filter(t => t > 0).reduce((a, b) => a + b, 0);
  const losses = Math.abs(trades.filter(t => t < 0).reduce((a, b) => a + b, 0));
  const pf = losses > 0 ? gains / losses : 999;

  console.log(`【榜一首次见顶回踩状态机做多】交易数: ${total} | 胜率: ${wr.toFixed(1)}% (${wins}W/${total - wins}L) | 净收益: ${(netSum >= 0 ? '+' : '') + netSum.toFixed(2)}% | PF: ${pf.toFixed(2)}`);
}

main().catch(console.error);
