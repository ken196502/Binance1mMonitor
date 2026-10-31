import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import { calculateSma } from '../research/peak-rebound-signals.ts';
import { computeMacd } from '../src/macd.ts';
import { calcLongReturn } from './test-optimal-long-ensemble.ts';

async function main() {
  const dir1 = path.resolve('data/research/staged-1m-20261020-20261023');
  const dir2 = path.resolve('data/research/peak-rebound-1m-168h');
  const minuteData = new Map();
  for (const dir of [dir1, dir2]) {
    try {
      const files = await readdir(dir);
      for (const f of files) {
        if (f.endsWith('.json.gz')) {
          const sym = f.replace('.json.gz', '');
          const bytes = await readFile(path.join(dir, f));
          minuteData.set(sym, JSON.parse(gunzipSync(bytes).toString('utf8')));
        }
      }
    } catch {}
  }

  const hourly = await loadDataset(path.resolve('data/research/hourly-168h'));
  const frames = buildFrames(hourly, 10, 1);
  const gainerBoards = new Map();
  for (const frame of frames) {
    const gMap = new Map();
    for (const obs of frame.boards.gainers) gMap.set(obs.symbol, { rank: obs.rank, dayChange: obs.dayChange });
    gainerBoards.set(frame.time, gMap);
  }

  console.log('测试【突破回踩确认】与【冲高首踩MA15顺势】...\n');

  // Candidate 1: 突破前高后回踩确认 (Breakout & Retest)
  const eventsBreakout = [];
  for (const [sym, bars] of minuteData) {
    const closes = bars.map(b => b[4]);
    const highs = bars.map(b => b[2]);
    const lows = bars.map(b => b[3]);
    const opens = bars.map(b => b[1]);
    const times = bars.map(b => b[0]);
    const { dif, hist } = computeMacd(closes);

    for (let i = 60; i < bars.length - 1; i++) {
      const t = times[i];
      const bTime = Math.floor(t / 3600000) * 3600000;
      const gRow = gainerBoards.get(bTime)?.get(sym);
      if (!gRow || gRow.rank > 10 || gRow.dayChange < 20) continue;

      // 过去 30 根 K 线的阻力位 (高点)
      let prevHigh = 0;
      for (let k = Math.max(0, i - 40); k <= i - 10; k++) if (highs[k] > prevHigh) prevHigh = highs[k];
      if (prevHigh <= 0) continue;

      // 必须在最近 1~5 根内向上真突破过 prevHigh
      let brokeAbove = false;
      for (let k = i - 5; k < i; k++) if (highs[k] > prevHigh * 1.01) brokeAbove = true;
      if (!brokeAbove) continue;

      // 当前回踩不破 prevHigh (Low 接近 prevHigh，Close 在 prevHigh 之上)
      if (lows[i] <= prevHigh * 1.005 && closes[i] >= prevHigh * 0.998) {
        if (closes[i] >= opens[i] && dif[i] > 0) {
          eventsBreakout.push({ sym, time: bars[i + 1][0], entry: bars[i + 1][1] });
        }
      }
    }
  }

  // 模拟 Candidate 1
  eventsBreakout.sort((a, b) => a.time - b.time);
  const occ1 = new Map();
  const tr1 = [];
  for (const ev of eventsBreakout) {
    if ((occ1.get(ev.sym) ?? 0) > ev.time) continue;
    const bars = minuteData.get(ev.sym);
    const idx = bars.findIndex(b => b[0] === ev.time);
    if (idx < 0) continue;
    const entry = ev.entry;
    const tp1 = entry * 1.03, tp2 = entry * 1.06, sl = entry * 0.95;
    let sl2 = sl;
    let st1 = false, st2 = false, net = 0, exitT = ev.time + 30 * 60000;
    for (let s = 0; s < 30; s++) {
      const b = bars[idx + s];
      if (!b) break;
      if (!st1) {
        if (b[3] <= sl) { net += calcLongReturn(entry, sl).netPercent * 0.5; st1 = true; }
        else if (b[2] >= tp1) { net += calcLongReturn(entry, tp1).netPercent * 0.5; st1 = true; sl2 = entry; }
      }
      if (st1 && !st2) {
        if (b[3] <= sl2) { net += calcLongReturn(entry, sl2).netPercent * 0.5; st2 = true; exitT = b[0]; break; }
        else if (b[2] >= tp2) { net += calcLongReturn(entry, tp2).netPercent * 0.5; st2 = true; exitT = b[0]; break; }
      }
      if (s === 29) {
        const rem = !st1 ? 1.0 : !st2 ? 0.5 : 0;
        if (rem > 0) net += calcLongReturn(entry, b[4]).netPercent * rem;
        exitT = b[0];
      }
    }
    occ1.set(ev.sym, exitT + 15 * 60000);
    tr1.push(net);
  }

  const w1 = tr1.filter(t => t > 0).length;
  const n1 = tr1.length;
  console.log(`【突破回踩确认做多】交易数: ${n1} 胜率: ${(w1/n1*100).toFixed(1)}% (${w1}W/${n1-w1}L) 净收益: ${(tr1.reduce((a,b)=>a+b,0)>=0?'+':'')+tr1.reduce((a,b)=>a+b,0).toFixed(2)}%`);
}

main().catch(console.error);
