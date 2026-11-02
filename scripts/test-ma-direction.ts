import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import type { MinuteDataset } from '../research/gainers-types.ts';
import { computeMacd, calculateSma } from '../src/macd.ts';
import { calcTradeReturn } from './test-ma10-ma20-stack.ts';

const MINUTE = 60000;

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

interface TestMaConfig {
  name: string;
  minDropFrom24h: number;
  maRelation: 'none' | 'less' | 'greater'; // ma10 vs ma20
  tp1: number;
  tp2: number;
  sl: number;
  holdMinutes: number;
}

function runSim(minuteData: MinuteDataset, frames: any[], cfg: TestMaConfig) {
  const gainerBoards = new Map<number, Map<string, any>>();
  for (const frame of frames) {
    const gMap = new Map<string, any>();
    for (const obs of frame.boards.gainers) gMap.set(obs.symbol, { rank: obs.rank, dayChange: obs.dayChange });
    gainerBoards.set(frame.time, gMap);
  }

  const allTimeSet = new Set<number>();
  for (const [, bars] of minuteData.candles) {
    for (const b of bars) allTimeSet.add(b[0]);
  }
  const allTimesSorted = Array.from(allTimeSet).sort((a, b) => a - b);

  const syms = Array.from(minuteData.candles.keys());
  const macdMap = new Map<string, { dif: number[]; dea: number[]; hist: number[] }>();
  const candleMap = new Map<string, any[]>();
  const timeIndices = new Map<string, Map<number, number>>();

  for (const sym of syms) {
    const rawBars = minuteData.candles.get(sym)!;
    const tMap = new Map<number, number>();
    for (let idx = 0; idx < rawBars.length; idx++) {
      tMap.set(rawBars[idx][0], idx);
    }
    candleMap.set(sym, rawBars);
    timeIndices.set(sym, tMap);
    macdMap.set(sym, computeMacd(rawBars.map((b: any) => b[4])));
  }

  interface Pos {
    symbol: string;
    entryTime: number;
    entryPrice: number;
    tp1Price: number;
    tp2Price: number;
    slPrice: number;
    sl2Price: number;
    st1Done: boolean;
    st2Done: boolean;
    netPnlPercent: number;
    holdDeadline: number;
    reason1?: 'target' | 'stop' | 'timeout';
    reason2?: 'target' | 'stop' | 'timeout';
    exitTime?: number;
  }

  const activePositions: Pos[] = [];
  const closedTrades: Pos[] = [];
  const cooldownMap = new Map<string, number>();

  for (let tIdx = 0; tIdx < allTimesSorted.length; tIdx++) {
    const nowTime = allTimesSorted[tIdx];
    const bTime = Math.floor(nowTime / (60 * MINUTE)) * (60 * MINUTE);
    const board = gainerBoards.get(bTime);
    if (!board) continue;

    for (let pIdx = activePositions.length - 1; pIdx >= 0; pIdx--) {
      const pos = activePositions[pIdx];
      const sBars = candleMap.get(pos.symbol);
      const cIdx = timeIndices.get(pos.symbol)?.get(nowTime);
      if (sBars && cIdx !== undefined) {
        const curBar = sBars[cIdx];
        const h = curBar[2], l = curBar[3], c = curBar[4];

        if (!pos.st1Done) {
          if (h >= pos.slPrice) {
            pos.netPnlPercent = calcTradeReturn('SHORT', pos.entryPrice, pos.slPrice).netPercent;
            pos.st1Done = true;
            pos.st2Done = true;
            pos.reason1 = 'stop';
            pos.reason2 = 'stop';
            pos.exitTime = nowTime;
          } else if (l <= pos.tp1Price) {
            pos.netPnlPercent += calcTradeReturn('SHORT', pos.entryPrice, pos.tp1Price).netPercent * 0.5;
            pos.st1Done = true;
            pos.reason1 = 'target';
            pos.sl2Price = pos.entryPrice;
            if (l <= pos.tp2Price) {
              pos.netPnlPercent += calcTradeReturn('SHORT', pos.entryPrice, pos.tp2Price).netPercent * 0.5;
              pos.st2Done = true;
              pos.reason2 = 'target';
              pos.exitTime = nowTime;
            }
          }
        }

        if (pos.st1Done && !pos.st2Done) {
          if (h >= pos.sl2Price) {
            pos.netPnlPercent += calcTradeReturn('SHORT', pos.entryPrice, pos.sl2Price).netPercent * 0.5;
            pos.st2Done = true;
            pos.reason2 = 'stop';
            pos.exitTime = nowTime;
          } else if (l <= pos.tp2Price) {
            pos.netPnlPercent += calcTradeReturn('SHORT', pos.entryPrice, pos.tp2Price).netPercent * 0.5;
            pos.st2Done = true;
            pos.reason2 = 'target';
            pos.exitTime = nowTime;
          }
        }

        const isTimeout = nowTime >= pos.holdDeadline;
        if (pos.st2Done || isTimeout) {
          if (isTimeout && !pos.st2Done) {
            const rem = !pos.st1Done ? 1.0 : 0.5;
            pos.netPnlPercent += calcTradeReturn('SHORT', pos.entryPrice, c).netPercent * rem;
            if (!pos.reason1) pos.reason1 = 'timeout';
            pos.reason2 = 'timeout';
            pos.exitTime = nowTime;
          }
          cooldownMap.set(pos.symbol, nowTime + 20 * MINUTE);
          closedTrades.push(pos);
          activePositions.splice(pIdx, 1);
        }
      }
    }

    for (const [sym, row] of board) {
      if (row.rank > 10 || row.dayChange < 10) continue;
      if (activePositions.some(p => p.symbol === sym)) continue;
      if ((cooldownMap.get(sym) ?? 0) > nowTime) continue;

      const rawBars = candleMap.get(sym);
      const tMap = timeIndices.get(sym);
      if (!rawBars || !tMap) continue;
      const curIdx = tMap.get(nowTime);
      if (curIdx === undefined || curIdx < 65 || curIdx >= rawBars.length - 1) continue;

      const targetIdx = curIdx - 1;
      const closedBar = rawBars[targetIdx];
      const closes = rawBars.map((b: any) => b[4]);

      // Base surge: 5m
      const xStart = Math.max(0, targetIdx - 5 + 1);
      let xMinLow = Infinity;
      for (let k = xStart; k <= targetIdx; k++) {
        if (rawBars[k][3] < xMinLow) xMinLow = rawBars[k][3];
      }
      if (xMinLow <= 0) continue;
      const xRisePercent = ((closedBar[2] - xMinLow) / xMinLow) * 100;
      if (xRisePercent < row.dayChange / 10) continue;

      // 24h drop
      if (cfg.minDropFrom24h > 0) {
        const start24h = Math.max(0, targetIdx - 1439);
        let high24h = 0;
        for (let k = start24h; k <= targetIdx; k++) {
          if (rawBars[k][2] > high24h) high24h = rawBars[k][2];
        }
        if (high24h <= 0) continue;
        const dropFrom24h = ((high24h - closedBar[4]) / high24h) * 100;
        if (dropFrom24h < cfg.minDropFrom24h) continue;
      }

      // MA60 touch
      const ma60 = calculateSma(closes, targetIdx, 60);
      if (ma60 == null) continue;
      if (!(closedBar[2] > ma60 && closedBar[3] < ma60)) continue;

      // MA10 vs MA20
      if (cfg.maRelation !== 'none') {
        const ma10 = calculateSma(closes, targetIdx, 10);
        const ma20 = calculateSma(closes, targetIdx, 20);
        if (ma10 == null || ma20 == null) continue;
        if (cfg.maRelation === 'less' && !(ma10 < ma20)) continue;
        if (cfg.maRelation === 'greater' && !(ma10 > ma20)) continue;
      }

      // MACD: 3 green bars
      const macd = macdMap.get(sym)!;
      let allGreen = true;
      for (let k = 0; k < 3; k++) {
        const idx = targetIdx - k;
        if (idx < 0 || macd.hist[idx] <= 0) { allGreen = false; break; }
      }
      if (!allGreen) continue;

      const nextOpen = rawBars[curIdx][1];
      const entryPrice = nextOpen > 0 ? nextOpen : closedBar[4];
      const tp1Price = entryPrice * (1 - cfg.tp1 / 100);
      const tp2Price = entryPrice * (1 - cfg.tp2 / 100);
      const slPrice = entryPrice * (1 + cfg.sl / 100);

      activePositions.push({
        symbol: sym,
        entryTime: nowTime,
        entryPrice,
        tp1Price,
        tp2Price,
        slPrice,
        sl2Price: slPrice,
        st1Done: false,
        st2Done: false,
        netPnlPercent: 0,
        holdDeadline: nowTime + cfg.holdMinutes * MINUTE,
      });
    }
  }

  let totalWin = 0;
  let totalLoss = 0;
  let tp1Hits = 0;
  let tp2Hits = 0;
  let slHits = 0;
  let timeouts = 0;
  let totalNet = 0;
  let totalDurationMinutes = 0;

  for (const t of closedTrades) {
    if (t.netPnlPercent > 0) totalWin += t.netPnlPercent;
    else totalLoss += Math.abs(t.netPnlPercent);

    if (t.reason1 === 'target') tp1Hits++;
    if (t.reason2 === 'target') tp2Hits++;
    if (t.reason1 === 'stop' || t.reason2 === 'stop') slHits++;
    if (t.reason1 === 'timeout' || t.reason2 === 'timeout') timeouts++;

    totalNet += t.netPnlPercent;
    const dur = ((t.exitTime ?? (t.entryTime + cfg.holdMinutes * MINUTE)) - t.entryTime) / MINUTE;
    totalDurationMinutes += dur;
  }

  const wins = closedTrades.filter(t => t.netPnlPercent > 0).length;
  const losses = closedTrades.filter(t => t.netPnlPercent <= 0).length;
  const trades = closedTrades.length;
  const winRate = trades > 0 ? (wins / trades) * 100 : 0;
  const pf = totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? 99 : 0;

  return {
    name: cfg.name,
    trades,
    wins,
    losses,
    winRate,
    pf,
    totalNet,
    tp1Hits,
    slHits,
    timeouts,
    avgDuration: trades > 0 ? totalDurationMinutes / trades : 0,
  };
}

async function main() {
  const hourly = await loadDataset(path.resolve('data/research/hourly-168h'));
  const frames = buildFrames(hourly, 10, 1);
  const minuteData = await loadAllMinutes();

  console.log('='.repeat(105));
  console.log('🔬【对比实验】方案 A 叠加 MA10 < MA20 vs MA10 > MA20 vs 不限制');
  console.log('='.repeat(105));

  const configs: TestMaConfig[] = [
    // 跌幅 >= 8% 对比
    {
      name: '方案A基线: 跌幅>=8% (不限制 MA10/MA20)',
      minDropFrom24h: 8,
      maRelation: 'none',
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
      holdMinutes: 10,
    },
    {
      name: '方案A + MA10 < MA20 (均线死叉压制)',
      minDropFrom24h: 8,
      maRelation: 'less',
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
      holdMinutes: 10,
    },
    {
      name: '方案A + MA10 > MA20 (均线金叉冲撞MA60)',
      minDropFrom24h: 8,
      maRelation: 'greater',
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
      holdMinutes: 10,
    },

    // 跌幅 >= 8% + TP 1.2/2.5 对比
    {
      name: '方案A(TP1.2): 跌幅>=8% (不限制)',
      minDropFrom24h: 8,
      maRelation: 'none',
      tp1: 1.2,
      tp2: 2.5,
      sl: 2.5,
      holdMinutes: 10,
    },
    {
      name: '方案A(TP1.2) + MA10 < MA20',
      minDropFrom24h: 8,
      maRelation: 'less',
      tp1: 1.2,
      tp2: 2.5,
      sl: 2.5,
      holdMinutes: 10,
    },
    {
      name: '方案A(TP1.2) + MA10 > MA20',
      minDropFrom24h: 8,
      maRelation: 'greater',
      tp1: 1.2,
      tp2: 2.5,
      sl: 2.5,
      holdMinutes: 10,
    },

    // 跌幅 >= 5% 对比
    {
      name: '跌幅>=5% (不限制 MA10/MA20)',
      minDropFrom24h: 5,
      maRelation: 'none',
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
      holdMinutes: 10,
    },
    {
      name: '跌幅>=5% + MA10 < MA20',
      minDropFrom24h: 5,
      maRelation: 'less',
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
      holdMinutes: 10,
    },
    {
      name: '跌幅>=5% + MA10 > MA20',
      minDropFrom24h: 5,
      maRelation: 'greater',
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
      holdMinutes: 10,
    },
  ];

  for (const c of configs) {
    const res = runSim(minuteData, frames, c);
    const pnlSign = res.totalNet >= 0 ? '+' : '';
    console.log(
      `${res.name.padEnd(46)} | 交易: ${String(res.trades).padStart(3)}笔 | 胜率: ${res.winRate.toFixed(1).padStart(5)}% (${String(res.wins).padStart(2)}胜/${String(res.losses).padStart(2)}负) | PF: ${res.pf.toFixed(2)} | 净盈亏: ${(pnlSign + res.totalNet.toFixed(1) + '%').padStart(6)} | TP1: ${String(res.tp1Hits).padStart(2)} | SL: ${String(res.slHits).padStart(2)} | 超时: ${String(res.timeouts).padStart(2)} | 均持: ${res.avgDuration.toFixed(1)}m`
    );
  }
}

main().catch(console.error);
