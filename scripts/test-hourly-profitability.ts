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

export interface ProfitTestConfig {
  name: string;
  minDropFrom24h: number;
  requireMaOrder: boolean; // ma60 > ma10 > ma20
  requireCloseBelowMa: boolean; // close < ma60
  holdMinutes: number;
  tp1: number;
  tp2: number;
  sl: number;
  useDynamicExit?: boolean;
  exitX?: number;
  exitN?: number;
  exitM?: number;
  slOnCandleHigh?: boolean; // 结构止损: 挂在穿刺 K 线的高点 + 0.3%
}

export interface ProfitResult {
  name: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  pf: number;
  totalNet: number;
  avgNet: number;
  tp1Hits: number;
  tp2Hits: number;
  slHits: number;
  timeouts: number;
  avgDuration: number;
}

export function runProfitSim(
  minuteData: MinuteDataset,
  frames: any[],
  cfg: ProfitTestConfig
): ProfitResult {
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

      // Close below MA60
      if (cfg.requireCloseBelowMa && closedBar[4] >= ma60) continue;

      // MA hierarchy
      if (cfg.requireMaOrder) {
        const ma10 = calculateSma(closes, targetIdx, 10);
        const ma20 = calculateSma(closes, targetIdx, 20);
        if (ma10 == null || ma20 == null) continue;
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

      let tp1Price: number, tp2Price: number, slPrice: number;
      if (cfg.useDynamicExit) {
        const dc = row.dayChange;
        const x = cfg.exitX ?? 35;
        const n = cfg.exitN ?? 2.0;
        const m = cfg.exitM ?? 3.0;
        tp1Price = entryPrice * (1 - (dc / x) / 100);
        tp2Price = entryPrice * (1 - (dc * m / x) / 100);
        slPrice = entryPrice * (1 + (dc * n / x) / 100);
      } else {
        tp1Price = entryPrice * (1 - cfg.tp1 / 100);
        tp2Price = entryPrice * (1 - cfg.tp2 / 100);
        if (cfg.slOnCandleHigh) {
          // 结构止损: 挂在冲刺高点 + 0.3%，最小 1.5%，最大 cfg.sl
          const structSl = Math.min(cfg.sl, Math.max(1.5, ((closedBar[2] * 1.003 - entryPrice) / entryPrice) * 100));
          slPrice = entryPrice * (1 + structSl / 100);
        } else {
          slPrice = entryPrice * (1 + cfg.sl / 100);
        }
      }

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
    avgNet: trades > 0 ? totalNet / trades : 0,
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

  console.log('='.repeat(110));
  console.log('🔥【盈利能力攻坚专项回测】彻底扭转“只赚微利/净盈亏平平”：盈亏比重塑与波段空间释放');
  console.log('='.repeat(110));

  const tests: ProfitTestConfig[] = [
    // 0. 对照组：当前微利配置 (超短持仓 10m，吃 1.2%~1.5% 蝇头小利，输 2.5% 大止损)
    {
      name: '当前瓶颈: 10m超短持仓 (TP 1.5/3.0, SL 2.5) [盈亏比倒挂]',
      minDropFrom24h: 8,
      requireMaOrder: true,
      requireCloseBelowMa: false,
      holdMinutes: 10,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
    },
    {
      name: '当前瓶颈: 10m超短持仓 (TP 1.2/2.5, SL 2.5) [胜率高但净亏]',
      minDropFrom24h: 8,
      requireMaOrder: true,
      requireCloseBelowMa: false,
      holdMinutes: 10,
      tp1: 1.2,
      tp2: 2.5,
      sl: 2.5,
    },

    // 1. 突破思路一：小时线压制是大级别，必须给时间跌！放宽持仓 (30m ~ 60m)，放大止盈 (吃 4%~8% 主跌浪)
    {
      name: '波段释放A: 30m持仓 | TP 3.0 / 6.0, SL 3.5',
      minDropFrom24h: 8,
      requireMaOrder: true,
      requireCloseBelowMa: false,
      holdMinutes: 30,
      tp1: 3.0,
      tp2: 6.0,
      sl: 3.5,
    },
    {
      name: '波段释放B: 45m持仓 | TP 3.5 / 7.0, SL 4.0',
      minDropFrom24h: 8,
      requireMaOrder: true,
      requireCloseBelowMa: false,
      holdMinutes: 45,
      tp1: 3.5,
      tp2: 7.0,
      sl: 4.0,
    },
    {
      name: '波段释放C: 60m持仓 | TP 4.0 / 8.0, SL 4.5',
      minDropFrom24h: 8,
      requireMaOrder: true,
      requireCloseBelowMa: false,
      holdMinutes: 60,
      tp1: 4.0,
      tp2: 8.0,
      sl: 4.5,
    },
    {
      name: '波段释放D: 45m持仓 | TP 3.0 / 7.0, SL 3.0 (高盈亏比)',
      minDropFrom24h: 8,
      requireMaOrder: true,
      requireCloseBelowMa: false,
      holdMinutes: 45,
      tp1: 3.0,
      tp2: 7.0,
      sl: 3.0,
    },

    // 2. 突破思路二：结构性紧凑止损 (slOnCandleHigh) - 刺破 MA60 的那根针的高点就是硬止损！
    // 亏只亏 1.5%~1.8%，赚赚 3.0%~6.0%，盈亏比直接反转为 2:1 以上！
    {
      name: '结构紧止损: 20m持仓 | 针尖止损 (SL~1.8%) | TP 2.5 / 5.0',
      minDropFrom24h: 8,
      requireMaOrder: true,
      requireCloseBelowMa: false,
      holdMinutes: 20,
      tp1: 2.5,
      tp2: 5.0,
      sl: 3.0,
      slOnCandleHigh: true,
    },
    {
      name: '结构紧止损: 30m持仓 | 针尖止损 (SL~1.8%) | TP 3.0 / 6.0',
      minDropFrom24h: 8,
      requireMaOrder: true,
      requireCloseBelowMa: false,
      holdMinutes: 30,
      tp1: 3.0,
      tp2: 6.0,
      sl: 3.5,
      slOnCandleHigh: true,
    },
    {
      name: '结构紧止损: 45m持仓 | 针尖止损 (SL~1.8%) | TP 3.5 / 7.0',
      minDropFrom24h: 8,
      requireMaOrder: true,
      requireCloseBelowMa: false,
      holdMinutes: 45,
      tp1: 3.5,
      tp2: 7.0,
      sl: 4.0,
      slOnCandleHigh: true,
    },

    // 3. 突破思路三：深度见顶币种 (跌幅 >= 15% 或 >= 20%) + 小时压制波段
    {
      name: '深跌波段: 跌幅>=15% | 30m持仓 | TP 3.0 / 6.0, SL 3.5',
      minDropFrom24h: 15,
      requireMaOrder: true,
      requireCloseBelowMa: false,
      holdMinutes: 30,
      tp1: 3.0,
      tp2: 6.0,
      sl: 3.5,
    },
    {
      name: '深跌波段: 跌幅>=20% | 30m持仓 | TP 3.0 / 6.0, SL 4.0',
      minDropFrom24h: 20,
      requireMaOrder: true,
      requireCloseBelowMa: false,
      holdMinutes: 30,
      tp1: 3.0,
      tp2: 6.0,
      sl: 4.0,
    },
    {
      name: '深跌波段: 跌幅>=20% | 45m持仓 | TP 3.5 / 8.0, SL 4.5',
      minDropFrom24h: 20,
      requireMaOrder: true,
      requireCloseBelowMa: false,
      holdMinutes: 45,
      tp1: 3.5,
      tp2: 8.0,
      sl: 4.5,
    },

    // 4. 突破思路四：自适应动态大波动出场 (跟随 24h 涨幅动态缩放，X=35, N=2, M=3~4)
    {
      name: '动态波段: 30m持仓 | X=35, N=1.5, M=3.0 (高盈亏比)',
      minDropFrom24h: 8,
      requireMaOrder: true,
      requireCloseBelowMa: false,
      holdMinutes: 30,
      useDynamicExit: true,
      exitX: 35,
      exitN: 1.5,
      exitM: 3.0,
      tp1: 0,
      tp2: 0,
      sl: 0,
    },
    {
      name: '动态波段: 45m持仓 | X=35, N=1.5, M=3.5 (大肉模式)',
      minDropFrom24h: 8,
      requireMaOrder: true,
      requireCloseBelowMa: false,
      holdMinutes: 45,
      useDynamicExit: true,
      exitX: 35,
      exitN: 1.5,
      exitM: 3.5,
      tp1: 0,
      tp2: 0,
      sl: 0,
    },
    {
      name: '动态波段: 45m持仓 | 跌幅>=15% | X=35, N=1.5, M=3.5',
      minDropFrom24h: 15,
      requireMaOrder: true,
      requireCloseBelowMa: false,
      holdMinutes: 45,
      useDynamicExit: true,
      exitX: 35,
      exitN: 1.5,
      exitM: 3.5,
      tp1: 0,
      tp2: 0,
      sl: 0,
    },
  ];

  for (const c of tests) {
    const res = runProfitSim(minuteData, frames, c);
    const pnlSign = res.totalNet >= 0 ? '+' : '';
    console.log(
      `${res.name.padEnd(56)} | 交易: ${String(res.trades).padStart(3)}笔 | 胜率: ${res.winRate.toFixed(1).padStart(5)}% (${String(res.wins).padStart(2)}胜/${String(res.losses).padStart(2)}负) | PF: ${res.pf.toFixed(2)} | 净盈亏: ${(pnlSign + res.totalNet.toFixed(1) + '%').padStart(6)} | TP1: ${String(res.tp1Hits).padStart(2)} | TP2: ${String(res.tp2Hits).padStart(2)} | SL: ${String(res.slHits).padStart(2)} | 超时: ${String(res.timeouts).padStart(2)} | 均持: ${res.avgDuration.toFixed(1)}m`
    );
  }
}

main().catch(console.error);
