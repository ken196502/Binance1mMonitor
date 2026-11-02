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

export interface MaOrderConfig {
  name: string;
  minDropFrom24h: number;
  condition: 'none' | 'ma10_gt_ma20' | 'ma60_gt_ma10_gt_ma20';
  holdMinutes: number;
  tp1: number;
  tp2: number;
  sl: number;
}

export interface MaOrderResult {
  name: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  pf: number;
  totalNet: number;
  tp1Hits: number;
  tp2Hits: number;
  slHits: number;
  timeouts: number;
  avgDuration: number;
}

export function runMaOrderSim(
  minuteData: MinuteDataset,
  frames: any[],
  cfg: MaOrderConfig
): MaOrderResult {
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

      // Condition: MA hierarchy
      if (cfg.condition === 'ma10_gt_ma20') {
        const ma10 = calculateSma(closes, targetIdx, 10);
        const ma20 = calculateSma(closes, targetIdx, 20);
        if (ma10 == null || ma20 == null) continue;
        if (!(ma10 > ma20)) continue;
      } else if (cfg.condition === 'ma60_gt_ma10_gt_ma20') {
        const ma10 = calculateSma(closes, targetIdx, 10);
        const ma20 = calculateSma(closes, targetIdx, 20);
        if (ma10 == null || ma20 == null) continue;
        // ma60 > ma10 > ma20
        if (!(ma60 > ma10 && ma10 > ma20)) continue;
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
    tp2Hits,
    slHits,
    timeouts,
    avgDuration: trades > 0 ? totalDurationMinutes / trades : 0,
  };
}

async function main() {
  console.log('正在载入历史行情数据...');
  const hourly = await loadDataset(path.resolve('data/research/hourly-168h'));
  const frames = buildFrames(hourly, 10, 1);
  const minuteData = await loadAllMinutes();
  console.log(`行情数据载入完成！共 ${minuteData.candles.size} 个标的。\n`);

  console.log('='.repeat(105));
  console.log('🔬【核心验证】MA60 > MA10 > MA20 (大周期空头压制 + 次级反弹冲撞阻力) 深度回测');
  console.log('='.repeat(105));

  const suite: MaOrderConfig[] = [
    // 1. 方案 A (跌幅 >= 8%) 下的三重对比
    {
      name: '1. 方案A基线: 跌幅>=8% (无MA过滤)',
      minDropFrom24h: 8,
      condition: 'none',
      holdMinutes: 10,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
    },
    {
      name: '2. 方案A + MA10 > MA20',
      minDropFrom24h: 8,
      condition: 'ma10_gt_ma20',
      holdMinutes: 10,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
    },
    {
      name: '3. 方案A + MA60 > MA10 > MA20 (空头大势压制+金叉冲刺)',
      minDropFrom24h: 8,
      condition: 'ma60_gt_ma10_gt_ma20',
      holdMinutes: 10,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
    },

    // 2. TP 1.2% (轻松兑现) 下的三重对比
    {
      name: '4. 方案A(TP1.2) + 基线',
      minDropFrom24h: 8,
      condition: 'none',
      holdMinutes: 10,
      tp1: 1.2,
      tp2: 2.5,
      sl: 2.5,
    },
    {
      name: '5. 方案A(TP1.2) + MA10 > MA20',
      minDropFrom24h: 8,
      condition: 'ma10_gt_ma20',
      holdMinutes: 10,
      tp1: 1.2,
      tp2: 2.5,
      sl: 2.5,
    },
    {
      name: '6. 方案A(TP1.2) + MA60 > MA10 > MA20',
      minDropFrom24h: 8,
      condition: 'ma60_gt_ma10_gt_ma20',
      holdMinutes: 10,
      tp1: 1.2,
      tp2: 2.5,
      sl: 2.5,
    },

    // 3. 探索持仓时长放宽 (12m, 15m) 下 MA60 > MA10 > MA20 表现
    {
      name: '7. MA60>MA10>MA20: 12m持仓 (TP 1.5/3.0, SL 2.5)',
      minDropFrom24h: 8,
      condition: 'ma60_gt_ma10_gt_ma20',
      holdMinutes: 12,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
    },
    {
      name: '8. MA60>MA10>MA20: 15m持仓 (TP 1.5/3.5, SL 2.5)',
      minDropFrom24h: 8,
      condition: 'ma60_gt_ma10_gt_ma20',
      holdMinutes: 15,
      tp1: 1.5,
      tp2: 3.5,
      sl: 2.5,
    },

    // 4. 不同跌幅门槛叠加 MA60 > MA10 > MA20
    {
      name: '9. 无跌幅限制 + MA60 > MA10 > MA20',
      minDropFrom24h: 0,
      condition: 'ma60_gt_ma10_gt_ma20',
      holdMinutes: 10,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
    },
    {
      name: '10. 跌幅>=5% + MA60 > MA10 > MA20',
      minDropFrom24h: 5,
      condition: 'ma60_gt_ma10_gt_ma20',
      holdMinutes: 10,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
    },
    {
      name: '11. 跌幅>=10% + MA60 > MA10 > MA20',
      minDropFrom24h: 10,
      condition: 'ma60_gt_ma10_gt_ma20',
      holdMinutes: 10,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
    },
    {
      name: '12. 跌幅>=10% + MA60 > MA10 > MA20 (TP 1.2/2.5)',
      minDropFrom24h: 10,
      condition: 'ma60_gt_ma10_gt_ma20',
      holdMinutes: 10,
      tp1: 1.2,
      tp2: 2.5,
      sl: 2.5,
    },
    {
      name: '13. 跌幅>=15% + MA60 > MA10 > MA20',
      minDropFrom24h: 15,
      condition: 'ma60_gt_ma10_gt_ma20',
      holdMinutes: 10,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
    },
    {
      name: '14. 跌幅>=20% + MA60 > MA10 > MA20',
      minDropFrom24h: 20,
      condition: 'ma60_gt_ma10_gt_ma20',
      holdMinutes: 10,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
    },
  ];

  for (const c of suite) {
    const res = runMaOrderSim(minuteData, frames, c);
    const pnlSign = res.totalNet >= 0 ? '+' : '';
    console.log(
      `${res.name.padEnd(52)} | 交易: ${String(res.trades).padStart(3)}笔 | 胜率: ${res.winRate.toFixed(1).padStart(5)}% (${String(res.wins).padStart(2)}胜/${String(res.losses).padStart(2)}负) | PF: ${res.pf.toFixed(2)} | 净盈亏: ${(pnlSign + res.totalNet.toFixed(1) + '%').padStart(6)} | TP1: ${String(res.tp1Hits).padStart(2)} | SL: ${String(res.slHits).padStart(2)} | 超时: ${String(res.timeouts).padStart(2)} | 均持: ${res.avgDuration.toFixed(1)}m`
    );
  }
}

main().catch(console.error);
