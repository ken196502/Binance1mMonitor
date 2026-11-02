import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import type { MinuteDataset } from '../research/gainers-types.ts';
import { computeMacd, calculateSma } from '../src/macd.ts';

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

export interface MaSimConfig {
  name: string;
  holdMinutes: number;
  tp1: number;
  tp2: number;
  sl: number;
  xMinutes: number;
  ampDivisor: number;
  nGreenBars: number;
  minDropFrom24h?: number; // 距离 24h 最高价至少跌了 x%
  requireMa10LessMa20?: boolean; // 新条件：1m MA10 < 1m MA20
  requireMa10SlopeDown?: boolean; // 可选附加：MA10 自身向下倾斜
}

export interface MaSimResult {
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

export function runMaSim(
  minuteData: MinuteDataset,
  frames: any[],
  cfg: MaSimConfig
): MaSimResult {
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

    // Check open positions
    for (let pIdx = activePositions.length - 1; pIdx >= 0; pIdx--) {
      const pos = activePositions[pIdx];
      const sBars = candleMap.get(pos.symbol);
      const cIdx = timeIndices.get(pos.symbol)?.get(nowTime);
      if (sBars && cIdx !== undefined) {
        const curBar = sBars[cIdx];
        const h = curBar[2], l = curBar[3], c = curBar[4];

        // Stage 1
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
            pos.sl2Price = pos.entryPrice; // move stop to breakeven
            if (l <= pos.tp2Price) {
              pos.netPnlPercent += calcTradeReturn('SHORT', pos.entryPrice, pos.tp2Price).netPercent * 0.5;
              pos.st2Done = true;
              pos.reason2 = 'target';
              pos.exitTime = nowTime;
            }
          }
        }

        // Stage 2
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

        // Timeout
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

    // Check entry
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

      // 1. Base surge: xMinutes 内冲高涨幅 >= 24h 涨幅 / ampDivisor
      const xStart = Math.max(0, targetIdx - cfg.xMinutes + 1);
      let xMinLow = Infinity;
      for (let k = xStart; k <= targetIdx; k++) {
        if (rawBars[k][3] < xMinLow) xMinLow = rawBars[k][3];
      }
      if (xMinLow <= 0) continue;
      const xRisePercent = ((closedBar[2] - xMinLow) / xMinLow) * 100;
      if (xRisePercent < row.dayChange / cfg.ampDivisor) continue;

      // 2. 离 24h 最高价跌幅过滤 (minDropFrom24h)
      if (cfg.minDropFrom24h !== undefined && cfg.minDropFrom24h > 0) {
        const start24h = Math.max(0, targetIdx - 1439);
        let high24h = 0;
        for (let k = start24h; k <= targetIdx; k++) {
          if (rawBars[k][2] > high24h) high24h = rawBars[k][2];
        }
        if (high24h <= 0) continue;
        const dropFrom24h = ((high24h - closedBar[4]) / high24h) * 100;
        if (dropFrom24h < cfg.minDropFrom24h) continue;
      }

      // 3. MA60 condition: high > ma60 && low < ma60
      const ma60 = calculateSma(closes, targetIdx, 60);
      if (ma60 == null) continue;
      if (!(closedBar[2] > ma60 && closedBar[3] < ma60)) continue;

      // 4. 新测试条件：MA10 < MA20 (1m 级别的 10 周期均线 < 20 周期均线)
      if (cfg.requireMa10LessMa20) {
        const ma10 = calculateSma(closes, targetIdx, 10);
        const ma20 = calculateSma(closes, targetIdx, 20);
        if (ma10 == null || ma20 == null) continue;
        if (ma10 >= ma20) continue;

        if (cfg.requireMa10SlopeDown) {
          const ma10Prev = calculateSma(closes, targetIdx - 2, 10);
          if (ma10Prev == null || ma10 >= ma10Prev) continue;
        }
      }

      // 5. MACD: 近 N 根绿柱
      const macd = macdMap.get(sym)!;
      let allGreen = true;
      for (let k = 0; k < cfg.nGreenBars; k++) {
        const idx = targetIdx - k;
        if (idx < 0 || macd.hist[idx] <= 0) { allGreen = false; break; }
      }
      if (!allGreen) continue;

      // Trigger
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

  console.log('='.repeat(105));
  console.log('🔬【核心验证】方案 A (跌幅 >= 8%) 叠加 1m MA10 < MA20 死叉/空头排列回测');
  console.log('='.repeat(105));

  const tests: MaSimConfig[] = [
    // 1. 基准对照：方案 A (跌幅 >= 8%) 不加 ma10 < ma20
    {
      name: '方案A基准: 跌幅>=8% | 10m持仓 (TP 1.5/3.0, SL 2.5)',
      holdMinutes: 10,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      minDropFrom24h: 8,
    },
    // 2. 方案 A 叠加 MA10 < MA20
    {
      name: '方案A + MA10 < MA20: 跌幅>=8% | 10m持仓 (TP 1.5/3.0, SL 2.5)',
      holdMinutes: 10,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      minDropFrom24h: 8,
      requireMa10LessMa20: true,
    },
    // 3. 方案 A + MA10 < MA20 + MA10 下倾
    {
      name: '方案A + MA10 < MA20 + MA10下倾 | 10m持仓 (TP 1.5/3.0, SL 2.5)',
      holdMinutes: 10,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      minDropFrom24h: 8,
      requireMa10LessMa20: true,
      requireMa10SlopeDown: true,
    },

    // 4. 方案 A + MA10 < MA20 下的 TP/SL 微调
    {
      name: '方案A + MA10 < MA20: 10m持仓 (TP 1.2/2.5, SL 2.5)',
      holdMinutes: 10,
      tp1: 1.2,
      tp2: 2.5,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      minDropFrom24h: 8,
      requireMa10LessMa20: true,
    },
    {
      name: '方案A + MA10 < MA20: 10m持仓 (TP 1.3/2.8, SL 2.5)',
      holdMinutes: 10,
      tp1: 1.3,
      tp2: 2.8,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      minDropFrom24h: 8,
      requireMa10LessMa20: true,
    },
    {
      name: '方案A + MA10 < MA20: 12m持仓 (TP 1.5/3.0, SL 2.5)',
      holdMinutes: 12,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      minDropFrom24h: 8,
      requireMa10LessMa20: true,
    },
    {
      name: '方案A + MA10 < MA20: 15m持仓 (TP 1.5/3.5, SL 2.5)',
      holdMinutes: 15,
      tp1: 1.5,
      tp2: 3.5,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      minDropFrom24h: 8,
      requireMa10LessMa20: true,
    },

    // 5. 对比不同跌幅门槛叠加 MA10 < MA20
    {
      name: '无跌幅限制 + MA10 < MA20 (TP 1.5/3.0, SL 2.5)',
      holdMinutes: 10,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      requireMa10LessMa20: true,
    },
    {
      name: '跌幅>=5% + MA10 < MA20 (TP 1.5/3.0, SL 2.5)',
      holdMinutes: 10,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      minDropFrom24h: 5,
      requireMa10LessMa20: true,
    },
    {
      name: '跌幅>=10% + MA10 < MA20 (TP 1.5/3.0, SL 2.5)',
      holdMinutes: 10,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      minDropFrom24h: 10,
      requireMa10LessMa20: true,
    },
    {
      name: '跌幅>=10% + MA10 < MA20 (TP 1.2/2.5, SL 2.5)',
      holdMinutes: 10,
      tp1: 1.2,
      tp2: 2.5,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      minDropFrom24h: 10,
      requireMa10LessMa20: true,
    },
    {
      name: '跌幅>=15% + MA10 < MA20 (TP 1.5/3.0, SL 2.5)',
      holdMinutes: 10,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      minDropFrom24h: 15,
      requireMa10LessMa20: true,
    },
    {
      name: '跌幅>=20% + MA10 < MA20 (TP 1.5/3.0, SL 2.5)',
      holdMinutes: 10,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      minDropFrom24h: 20,
      requireMa10LessMa20: true,
    },
  ];

  for (const tc of tests) {
    const res = runMaSim(minuteData, frames, tc);
    const pnlSign = res.totalNet >= 0 ? '+' : '';
    console.log(
      `${res.name.padEnd(54)} | 交易: ${String(res.trades).padStart(3)}笔 | 胜率: ${res.winRate.toFixed(1).padStart(5)}% (${String(res.wins).padStart(2)}胜/${String(res.losses).padStart(2)}负) | PF: ${res.pf.toFixed(2)} | 净盈亏: ${(pnlSign + res.totalNet.toFixed(1) + '%').padStart(6)} | TP1: ${String(res.tp1Hits).padStart(2)} | SL: ${String(res.slHits).padStart(2)} | 超时: ${String(res.timeouts).padStart(2)} | 均持: ${res.avgDuration.toFixed(1)}m`
    );
  }
}

main().catch(console.error);
