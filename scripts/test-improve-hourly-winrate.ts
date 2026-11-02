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

export interface FilterConfig {
  name: string;
  holdMinutes: number;
  tp1: number;
  tp2: number;
  sl: number;
  xMinutes: number;
  ampDivisor: number;
  nGreenBars: number;
  topN: number;
  minDayChange: number;
  // Feature filters:
  requireCloseBelowMa?: boolean; // 收盘价在 MA60 之下
  requireBearish?: boolean; // 当根 K 线收阴
  requireMaSlopeDown?: boolean; // MA60 倾斜向下 (ma60 < ma60[t-3])
  minUpperShadowRatio?: number; // 上影线 / 实体 >= X
  requireHistShrinking?: boolean; // 当前绿柱短于前一根绿柱 (动能开始衰竭)
  useHighBasedSl?: boolean; // 以当根最高价 + 0.3% 作为止损，而非固定 2.5%
}

export interface TestResult {
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

export function runSimulation(
  minuteData: MinuteDataset,
  frames: any[],
  cfg: FilterConfig
): TestResult {
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
      if (row.rank > cfg.topN || row.dayChange < cfg.minDayChange) continue;
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

      // 2. MA60 condition: high > ma60 && low < ma60
      const ma60 = calculateSma(closes, targetIdx, 60);
      if (ma60 == null) continue;
      if (!(closedBar[2] > ma60 && closedBar[3] < ma60)) continue;

      // Feature Filter: 收盘价在 MA60 之下 (收盘被阻力压回)
      if (cfg.requireCloseBelowMa && closedBar[4] >= ma60) continue;

      // Feature Filter: K线收阴确认
      if (cfg.requireBearish && closedBar[4] >= closedBar[1]) continue;

      // Feature Filter: MA60 均线下倾
      if (cfg.requireMaSlopeDown) {
        const ma60Prev = calculateSma(closes, targetIdx - 3, 60);
        if (ma60Prev == null || ma60 >= ma60Prev) continue;
      }

      // Feature Filter: 上影线比例
      if (cfg.minUpperShadowRatio !== undefined && cfg.minUpperShadowRatio > 0) {
        const o = closedBar[1], h = closedBar[2], l = closedBar[3], c = closedBar[4];
        const body = Math.abs(c - o);
        const upper = h - Math.max(o, c);
        const ratio = body > 0 ? upper / body : 1.0;
        if (ratio < cfg.minUpperShadowRatio) continue;
      }

      // 3. MACD: 近 N 根绿柱
      const macd = macdMap.get(sym)!;
      let allGreen = true;
      for (let k = 0; k < cfg.nGreenBars; k++) {
        const idx = targetIdx - k;
        if (idx < 0 || macd.hist[idx] <= 0) { allGreen = false; break; }
      }
      if (!allGreen) continue;

      // Feature Filter: 绿柱衰减 (hist[t] < hist[t-1])
      if (cfg.requireHistShrinking) {
        if (macd.hist[targetIdx] >= macd.hist[targetIdx - 1]) continue;
      }

      // Trigger
      const nextOpen = rawBars[curIdx][1];
      const entryPrice = nextOpen > 0 ? nextOpen : closedBar[4];
      const tp1Price = entryPrice * (1 - cfg.tp1 / 100);
      const tp2Price = entryPrice * (1 - cfg.tp2 / 100);

      let slPrice: number;
      if (cfg.useHighBasedSl) {
        // 最高价之上 0.3% 作为动态止损，但不超过 cfg.sl，也不小于 1.0%
        const dynSl = Math.min(cfg.sl, Math.max(1.0, ((closedBar[2] * 1.003 - entryPrice) / entryPrice) * 100));
        slPrice = entryPrice * (1 + dynSl / 100);
      } else {
        slPrice = entryPrice * (1 + cfg.sl / 100);
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

  const baseConfig: Omit<FilterConfig, 'name'> = {
    holdMinutes: 10,
    tp1: 1.5,
    tp2: 3.0,
    sl: 2.5,
    xMinutes: 5,
    ampDivisor: 10,
    nGreenBars: 3,
    topN: 10,
    minDayChange: 10,
  };

  const testCases: FilterConfig[] = [
    // 0. Baseline (基线: TP 1.5/3.0, SL 2.5, 10m)
    {
      ...baseConfig,
      name: '0. 基准 (Baseline: 10m, TP 1.5/3.0, SL 2.5)',
    },

    // 维度 1: K线微观形态过滤 (受阻与假突破确认)
    {
      ...baseConfig,
      requireCloseBelowMa: true,
      name: '1. 形态: 收盘被压在 MA60 之下 (close < ma60)',
    },
    {
      ...baseConfig,
      requireBearish: true,
      name: '2. 形态: 触碰当根收阴线 (close < open)',
    },
    {
      ...baseConfig,
      minUpperShadowRatio: 0.8,
      name: '3. 形态: 显著上影线压制 (上影/实体 >= 0.8)',
    },
    {
      ...baseConfig,
      requireCloseBelowMa: true,
      requireBearish: true,
      name: '4. 形态组合: 收盘在MA60下 + 收阴线',
    },

    // 维度 2: 均线趋势与下倾确认
    {
      ...baseConfig,
      requireMaSlopeDown: true,
      name: '5. 趋势: MA60 倾斜向下 (ma60 < ma60[t-3])',
    },
    {
      ...baseConfig,
      requireCloseBelowMa: true,
      requireMaSlopeDown: true,
      name: '6. 趋势+形态: 收盘在MA60下 + MA60倾斜向下',
    },

    // 维度 3: 动能拐点与衰竭 (MACD)
    {
      ...baseConfig,
      requireHistShrinking: true,
      name: '7. 动能: MACD绿柱见顶衰减 (hist[t] < hist[t-1])',
    },
    {
      ...baseConfig,
      nGreenBars: 4,
      name: '8. 动能: 连续 4 根绿柱冲顶',
    },
    {
      ...baseConfig,
      nGreenBars: 2,
      name: '9. 动能: 连续 2 根绿柱快速反应',
    },
    {
      ...baseConfig,
      requireCloseBelowMa: true,
      requireHistShrinking: true,
      name: '10. 形态+动能: 收在MA60下 + MACD绿柱衰减',
    },

    // 维度 4: 榜单与动能冲高阈值
    {
      ...baseConfig,
      topN: 5,
      name: '11. 榜单: 聚焦 Top 5 领涨标的',
    },
    {
      ...baseConfig,
      minDayChange: 15,
      name: '12. 涨幅: 24h 涨幅 >= 15% (更强波动)',
    },
    {
      ...baseConfig,
      ampDivisor: 8,
      name: '13. 冲高: 更强冲高强度 (5m 冲高 >= 24h / 8)',
    },
    {
      ...baseConfig,
      xMinutes: 3,
      name: '14. 冲高: 3m 急冲触碰 MA60',
    },

    // 维度 5: 止盈止损参数微调 (针对 10m 持仓)
    {
      ...baseConfig,
      tp1: 1.2,
      tp2: 2.5,
      sl: 2.0,
      name: '15. 参数: 紧凑目标 (TP 1.2/2.5, SL 2.0)',
    },
    {
      ...baseConfig,
      tp1: 1.2,
      tp2: 2.5,
      sl: 2.5,
      name: '16. 参数: 轻松兑现 (TP 1.2/2.5, SL 2.5)',
    },
    {
      ...baseConfig,
      tp1: 1.0,
      tp2: 2.0,
      sl: 2.0,
      name: '17. 参数: 超快兑现 (TP 1.0/2.0, SL 2.0)',
    },
    {
      ...baseConfig,
      tp1: 1.5,
      tp2: 3.0,
      sl: 3.0,
      name: '18. 参数: 宽容止损 (TP 1.5/3.0, SL 3.0)',
    },
    {
      ...baseConfig,
      holdMinutes: 12,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
      name: '19. 参数: 持仓轻度放宽至 12m',
    },
    {
      ...baseConfig,
      holdMinutes: 15,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
      name: '20. 参数: 持仓轻度放宽至 15m',
    },

    // 维度 6: 终极组合测试 (高胜率黄金组合)
    {
      ...baseConfig,
      requireCloseBelowMa: true,
      requireHistShrinking: true,
      tp1: 1.2,
      tp2: 2.5,
      sl: 2.5,
      name: '21. 终极组合A: 收在MA60下 + 绿柱衰退 + TP 1.2/2.5',
    },
    {
      ...baseConfig,
      requireCloseBelowMa: true,
      requireBearish: true,
      tp1: 1.2,
      tp2: 2.5,
      sl: 2.5,
      name: '22. 终极组合B: 收在MA60下 + 收阴 + TP 1.2/2.5',
    },
    {
      ...baseConfig,
      requireCloseBelowMa: true,
      requireHistShrinking: true,
      holdMinutes: 12,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
      name: '23. 终极组合C: 收在MA60下 + 绿柱衰退 + 12m持仓',
    },
    {
      ...baseConfig,
      requireCloseBelowMa: true,
      requireMaSlopeDown: true,
      tp1: 1.2,
      tp2: 2.5,
      sl: 2.5,
      name: '24. 终极组合D: 收在MA60下 + MA下倾 + TP 1.2/2.5',
    },
    {
      ...baseConfig,
      requireCloseBelowMa: true,
      minUpperShadowRatio: 0.8,
      tp1: 1.2,
      tp2: 2.5,
      sl: 2.5,
      name: '25. 终极组合E: 收在MA60下 + 上影线 >= 0.8 + TP 1.2/2.5',
    },
  ];

  console.log('='.repeat(95));
  console.log('🔬【胜率攻坚回测】针对 10m 短持仓 (基准 56.9%) 多维度提胜率全量测试');
  console.log('='.repeat(95));

  for (const tc of testCases) {
    const res = runSimulation(minuteData, frames, tc);
    const pnlSign = res.totalNet >= 0 ? '+' : '';
    console.log(
      `${res.name.padEnd(52)} | 交易: ${String(res.trades).padStart(3)}笔 | 胜率: ${res.winRate.toFixed(1).padStart(5)}% (${String(res.wins).padStart(2)}胜/${String(res.losses).padStart(2)}负) | PF: ${res.pf.toFixed(2)} | 净盈亏: ${(pnlSign + res.totalNet.toFixed(1) + '%').padStart(6)} | TP1: ${String(res.tp1Hits).padStart(2)} | SL: ${String(res.slHits).padStart(2)} | 超时: ${String(res.timeouts).padStart(2)} | 均持: ${res.avgDuration.toFixed(1)}m`
    );
  }
}

main().catch(console.error);
