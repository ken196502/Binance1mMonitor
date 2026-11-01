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

  console.log('=== 精确触发模型测试：震荡箱体突破 vs 震荡回踩托底 vs 震荡MACD爆发 ===\n');

  interface TriggerModel {
    id: string;
    name: string;
    x: number;
    n: number;
    check: (ctx: {
      i: number;
      opens: number[];
      highs: number[];
      lows: number[];
      closes: number[];
      vols: number[];
      dif: number[];
      dea: number[];
      hist: number[];
      dayChange: number;
      rank: number;
      high24h: number;
      dropFromHigh: number;
    }) => boolean;
  }

  const triggers: TriggerModel[] = [];

  // Model A: 箱体突破 (过去 X 分钟在 24h/N 内震荡，当前 K 线收盘价突破箱体前高)
  for (const x of [10, 15, 20, 30]) {
    for (const n of [4.0, 5.0, 6.0, 8.0]) {
      triggers.push({
        id: `breakout_x${x}_n${n}`,
        name: `【箱体突破】X=${x}m N=${n}`,
        x,
        n,
        check: (ctx) => {
          const { i, opens, highs, lows, closes, dif, dayChange, dropFromHigh } = ctx;
          if (dropFromHigh > 15) return false;

          // 过去 X 根 K 线（不含当前根）的高低点
          let boxHigh = 0, boxLow = Infinity;
          for (let k = i - x; k < i; k++) {
            if (highs[k] > boxHigh) boxHigh = highs[k];
            if (lows[k] < boxLow) boxLow = lows[k];
          }
          if (boxLow <= 0 || boxHigh <= boxLow) return false;

          const boxAmp = ((boxHigh - boxLow) / boxLow) * 100;
          if (boxAmp > dayChange / n || boxAmp < 0.5) return false;

          // 当前根收盘真突破箱体上沿
          if (closes[i] <= boxHigh * 1.001) return false;
          // 当前根必须是实体阳线
          if (closes[i] <= opens[i]) return false;

          // 均线多头支撑确认
          const ma15 = calculateSma(closes, i, 15);
          const ma30 = calculateSma(closes, i, 30);
          if (!ma15 || !ma30 || closes[i] < ma15 || ma15 < ma30) return false;

          // MACD 水上
          if (dif[i] <= 0) return false;

          return true;
        },
      });
    }
  }

  // Model B: 震荡下探托底企稳 (过去 X 分钟在 24h/N 内震荡，当前根踩到 MA30 或箱体下沿长下影收阳)
  for (const x of [10, 15, 20, 30]) {
    for (const n of [4.0, 5.0, 6.0, 8.0]) {
      triggers.push({
        id: `support_x${x}_n${n}`,
        name: `【均线托底】X=${x}m N=${n}`,
        x,
        n,
        check: (ctx) => {
          const { i, opens, highs, lows, closes, dif, dayChange, dropFromHigh } = ctx;
          if (dropFromHigh > 20) return false;

          let boxHigh = 0, boxLow = Infinity;
          for (let k = i - x + 1; k <= i; k++) {
            if (highs[k] > boxHigh) boxHigh = highs[k];
            if (lows[k] < boxLow) boxLow = lows[k];
          }
          if (boxLow <= 0 || boxHigh <= boxLow) return false;

          const boxAmp = ((boxHigh - boxLow) / boxLow) * 100;
          if (boxAmp > dayChange / n || boxAmp < 0.5) return false;

          // MA30 支撑检验
          const ma30 = calculateSma(closes, i, 30);
          const ma30Prev = calculateSma(closes, i - 3, 30);
          if (!ma30 || !ma30Prev || ma30 <= ma30Prev) return false;

          // 踩到 MA30 且收盘守住
          if (!(lows[i] <= ma30 * 1.002 && closes[i] >= ma30 * 0.998)) return false;

          // 实体阳线或下影线 >= 40%
          const range = highs[i] - lows[i];
          const lowerWick = Math.min(opens[i], closes[i]) - lows[i];
          const isBull = closes[i] >= opens[i];
          if (!isBull && (range <= 0 || lowerWick / range < 0.40)) return false;

          if (dif[i] <= 0) return false;

          return true;
        },
      });
    }
  }

  // Model C: 震荡水上金叉突破 (过去 X 分钟在 24h/N 内震荡，MACD 零轴上方初次金叉放量)
  for (const x of [10, 15, 20]) {
    for (const n of [4.0, 5.0, 6.0]) {
      triggers.push({
        id: `cross_x${x}_n${n}`,
        name: `【金叉放量】X=${x}m N=${n}`,
        x,
        n,
        check: (ctx) => {
          const { i, opens, highs, lows, closes, dif, dea, hist, dayChange, dropFromHigh } = ctx;
          if (dropFromHigh > 15) return false;

          let boxHigh = 0, boxLow = Infinity;
          for (let k = i - x + 1; k <= i; k++) {
            if (highs[k] > boxHigh) boxHigh = highs[k];
            if (lows[k] < boxLow) boxLow = lows[k];
          }
          if (boxLow <= 0 || boxHigh <= boxLow) return false;

          const boxAmp = ((boxHigh - boxLow) / boxLow) * 100;
          if (boxAmp > dayChange / n || boxAmp < 0.5) return false;

          // MACD 刚金叉 (上根 <= 0，这根 > 0，且 DIF > 0)
          if (!(hist[i - 1] <= 0 && hist[i] > 0 && dif[i] > 0)) return false;

          // 收阳
          if (closes[i] <= opens[i]) return false;

          const ma15 = calculateSma(closes, i, 15);
          if (!ma15 || closes[i] < ma15) return false;

          return true;
        },
      });
    }
  }

  const exitProfiles = [
    { hold: 30, tp1: 3.0, tp2: 6.0, sl: 4.0 },
    { hold: 45, tp1: 3.5, tp2: 7.0, sl: 5.0 },
    { hold: 60, tp1: 4.0, tp2: 8.0, sl: 6.0 },
    { hold: 90, tp1: 4.0, tp2: 8.0, sl: 7.0 },
  ];

  interface Stat {
    name: string;
    hold: number;
    tp1: number;
    tp2: number;
    sl: number;
    total: number;
    wins: number;
    wr: number;
    net: number;
    pf: number;
  }
  const allStats: Stat[] = [];

  for (const t of triggers) {
    const events: any[] = [];

    for (const [sym, bars] of minuteData.candles) {
      if (!bars || bars.length < 65) continue;
      const opens = bars.map(b => b[1]);
      const highs = bars.map(b => b[2]);
      const lows = bars.map(b => b[3]);
      const closes = bars.map(b => b[4]);
      const vols = bars.map(b => b[5]);
      const times = bars.map(b => b[0]);
      const { dif, dea, hist } = computeMacd(closes);

      let curMax24h = 0;

      for (let i = 40; i < bars.length - 1; i++) {
        const tm = times[i];
        const bTime = Math.floor(tm / HOUR) * HOUR;
        const gRow = gainerBoards.get(bTime)?.get(sym);
        if (!gRow || gRow.rank > 10 || gRow.dayChange < 20) continue;

        const start24h = Math.max(0, i - 1439);
        if (i === 40 || highs[i] > curMax24h) {
          let m = 0; for (let k = start24h; k <= i; k++) if (highs[k] > m) m = highs[k]; curMax24h = m;
        }
        if (curMax24h <= 0) continue;
        const dropFromHigh = ((curMax24h - closes[i]) / curMax24h) * 100;

        if (t.check({
          i, opens, highs, lows, closes, vols, dif, dea, hist,
          dayChange: gRow.dayChange, rank: gRow.rank, high24h: curMax24h, dropFromHigh
        })) {
          events.push({ sym, time: bars[i + 1][0], entry: bars[i + 1][1] });
        }
      }
    }

    if (events.length < 10) continue;
    events.sort((a, b) => a.time - b.time);

    for (const ep of exitProfiles) {
      const occ = new Map<string, number>();
      const trades: number[] = [];

      for (const ev of events) {
        if ((occ.get(ev.sym) ?? 0) > ev.time) continue;
        const bars = minuteData.candles.get(ev.sym);
        const idx = bars.findIndex((b: any) => b[0] === ev.time);
        if (idx < 0) continue;

        const entry = ev.entry;
        const tp1 = entry * (1 + ep.tp1 / 100);
        const tp2 = entry * (1 + ep.tp2 / 100);
        const sl = entry * (1 - ep.sl / 100);
        let sl2 = sl;
        let st1 = false, st2 = false;
        let net = 0;
        let exitT = ev.time + ep.hold * MINUTE;

        for (let s = 0; s < ep.hold; s++) {
          const b = bars[idx + s];
          if (!b) break;
          const h = b[2], l = b[3], c = b[4];

          if (!st1) {
            if (l <= sl) {
              net += calcLongReturn(entry, sl).netPercent * 0.5;
              st1 = true;
            } else if (h >= tp1) {
              net += calcLongReturn(entry, tp1).netPercent * 0.5;
              st1 = true;
              sl2 = entry;
            }
          }

          if (st1 && !st2) {
            if (l <= sl2) {
              net += calcLongReturn(entry, sl2).netPercent * 0.5;
              st2 = true;
              exitT = b[0];
              break;
            } else if (h >= tp2) {
              net += calcLongReturn(entry, tp2).netPercent * 0.5;
              st2 = true;
              exitT = b[0];
              break;
            }
          }

          if (s === ep.hold - 1) {
            const rem = !st1 ? 1.0 : !st2 ? 0.5 : 0;
            if (rem > 0) net += calcLongReturn(entry, c).netPercent * rem;
            exitT = b[0];
          }
        }

        occ.set(ev.sym, exitT + 20 * MINUTE);
        trades.push(net);
      }

      const total = trades.length;
      if (total >= 10) {
        const wins = trades.filter(t => t > 0).length;
        const wr = (wins / total) * 100;
        const netSum = trades.reduce((a, b) => a + b, 0);
        const gains = trades.filter(t => t > 0).reduce((a, b) => a + b, 0);
        const losses = Math.abs(trades.filter(t => t < 0).reduce((a, b) => a + b, 0));
        const pf = losses > 0 ? gains / losses : 999;

        allStats.push({
          name: t.name,
          hold: ep.hold,
          tp1: ep.tp1,
          tp2: ep.tp2,
          sl: ep.sl,
          total,
          wins,
          wr,
          net: netSum,
          pf,
        });
      }
    }
  }

  allStats.sort((a, b) => b.wr - a.wr || b.net - a.net);

  console.log(`\n🎉 排名前 25 名优质结果：\n`);
  console.log('| 序号 | 触发模型 | 止盈止损持仓 | 交易数 | 胜率 | 累计净收益 | PF |');
  console.log('| :---: | :--- | :---: | :---: | :---: | :---: | :---: |');

  allStats.slice(0, 25).forEach((s, i) => {
    console.log(
      `| ${String(i + 1).padStart(2)} | ${s.name.padEnd(28)} | +${s.tp1}%/+${s.tp2}%/-${s.sl}% (${s.hold}m) | ${String(s.total).padStart(5)} | ${s.wr.toFixed(1)}% (${s.wins}W/${s.total - s.wins}L) | ${(s.net >= 0 ? '+' : '') + s.net.toFixed(2)}% | ${s.pf.toFixed(2)} |`
    );
  });
}

main().catch(console.error);
