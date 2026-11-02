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

interface RunConfig {
  name: string;
  holdMinutes: number;
  useDynamicExit: boolean;
  exitX: number;
  exitN: number;
  exitM: number;
  tp1: number;
  tp2: number;
  sl: number;
  xMinutes: number;
  ampDivisor: number;
  nGreenBars: number;
}

interface TestResult {
  name: string;
  holdMinutes: number;
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

async function simulate(
  minuteData: MinuteDataset,
  frames: any[],
  cfg: RunConfig
): Promise<TestResult> {
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

      // 2. MA60 condition: high > ma60 && low < ma60
      const ma60 = calculateSma(closes, targetIdx, 60);
      if (ma60 == null) continue;
      if (!(closedBar[2] > ma60 && closedBar[3] < ma60)) continue;

      // 3. MACD: 近 N 根绿柱
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
      let tp1Price: number, tp2Price: number, slPrice: number;

      if (cfg.useDynamicExit) {
        const dc = row.dayChange;
        tp1Price = entryPrice * (1 - (dc / cfg.exitX) / 100);
        tp2Price = entryPrice * (1 - (dc * cfg.exitM / cfg.exitX) / 100);
        slPrice = entryPrice * (1 + (dc * cfg.exitN / cfg.exitX) / 100);
      } else {
        tp1Price = entryPrice * (1 - cfg.tp1 / 100);
        tp2Price = entryPrice * (1 - cfg.tp2 / 100);
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

  const totalTrades = closedTrades.length;
  const wins = closedTrades.filter(t => t.netPnlPercent > 0).length;
  const losses = closedTrades.filter(t => t.netPnlPercent <= 0).length;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const winGains = closedTrades.filter(t => t.netPnlPercent > 0).reduce((s, t) => s + t.netPnlPercent, 0);
  const lossLosses = Math.abs(closedTrades.filter(t => t.netPnlPercent <= 0).reduce((s, t) => s + t.netPnlPercent, 0));
  const pf = lossLosses > 0 ? winGains / lossLosses : winGains > 0 ? 99.9 : 0;
  const totalNet = closedTrades.reduce((s, t) => s + t.netPnlPercent, 0);
  const avgNet = totalTrades > 0 ? totalNet / totalTrades : 0;

  const tp1Hits = closedTrades.filter(t => t.reason1 === 'target').length;
  const tp2Hits = closedTrades.filter(t => t.reason2 === 'target').length;
  const slHits = closedTrades.filter(t => t.reason1 === 'stop' || t.reason2 === 'stop').length;
  const timeouts = closedTrades.filter(t => t.reason1 === 'timeout' || t.reason2 === 'timeout').length;
  const avgDuration = totalTrades > 0
    ? closedTrades.reduce((s, t) => s + ((t.exitTime ?? t.holdDeadline) - t.entryTime) / MINUTE, 0) / totalTrades
    : 0;

  return {
    name: cfg.name,
    holdMinutes: cfg.holdMinutes,
    trades: totalTrades,
    wins,
    losses,
    winRate,
    pf,
    totalNet,
    avgNet,
    tp1Hits,
    tp2Hits,
    slHits,
    timeouts,
    avgDuration,
  };
}

async function main() {
  console.log('================================================================================');
  console.log('🔬【全周期深度回测】小时线压制 + Base冲高 (5m>=24h/10) + 近3根MACD绿柱');
  console.log('   核心探索：不同持仓时长 (3m ~ 90m) 与退出机制全景对比');
  console.log('================================================================================\n');

  console.log('正在载入历史行情数据...');
  const hourly = await loadDataset(path.resolve('data/research/hourly-168h'));
  const frames = buildFrames(hourly, 10, 1);
  const minuteData = await loadAllMinutes();
  console.log(`行情数据载入完成！共 ${minuteData.candles.size} 个标的。\n`);

  // 1. 探索短时间持仓 (3m, 5m, 8m, 10m, 15m, 20m, 30m, 45m, 60m, 90m) - 动态退出模式 (X=35, N=2.0, M=2.0)
  console.log('────────────────────────────────────────────────────────────────────────────────');
  console.log('📊 实验组 1：动态退出模式 (X=35, N=2.0, M=2.0) - 持仓时间梯度扫描 (3m ~ 90m)');
  console.log('────────────────────────────────────────────────────────────────────────────────');
  const holdDurations = [3, 5, 8, 10, 12, 15, 20, 25, 30, 45, 60, 90];

  const dynResults: TestResult[] = [];
  for (const h of holdDurations) {
    const res = await simulate(minuteData, frames, {
      name: `持仓 ${String(h).padStart(2)}m`,
      holdMinutes: h,
      useDynamicExit: true,
      exitX: 35,
      exitN: 2.0,
      exitM: 2.0,
      tp1: 0,
      tp2: 0,
      sl: 0,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
    });
    dynResults.push(res);
    console.log(
      `${res.name} | 交易: ${String(res.trades).padStart(3)}笔 | 胜率: ${res.winRate.toFixed(1).padStart(5)}% (${String(res.wins).padStart(3)}胜/${String(res.losses).padStart(2)}负) | ` +
      `PF: ${res.pf.toFixed(2).padStart(4)} | 净盈亏: ${res.totalNet >= 0 ? '+' : ''}${res.totalNet.toFixed(1).padStart(5)}% | ` +
      `TP1达成: ${String(res.tp1Hits).padStart(3)} | TP2结清: ${String(res.tp2Hits).padStart(2)} | 止损: ${String(res.slHits).padStart(2)} | 超时: ${String(res.timeouts).padStart(2)} | 均持: ${res.avgDuration.toFixed(1)}m`
    );
  }

  // 2. 探索超短线闪击模式 (短周期 TP/SL 优化)
  console.log('\n────────────────────────────────────────────────────────────────────────────────');
  console.log('⚡ 实验组 2：短时间极速了结模式 (固定紧凑止盈止损 TP1=1.5%~2.5%, SL=2%~3.5%)');
  console.log('────────────────────────────────────────────────────────────────────────────────');

  const scalpConfigs = [
    { hold: 5,  tp1: 1.2, tp2: 2.5, sl: 2.0, label: '持仓 5m (TP1=1.2%, TP2=2.5%, SL=2.0%)' },
    { hold: 8,  tp1: 1.5, tp2: 3.0, sl: 2.5, label: '持仓 8m (TP1=1.5%, TP2=3.0%, SL=2.5%)' },
    { hold: 10, tp1: 1.5, tp2: 3.0, sl: 2.5, label: '持仓10m (TP1=1.5%, TP2=3.0%, SL=2.5%)' },
    { hold: 12, tp1: 1.8, tp2: 3.5, sl: 3.0, label: '持仓12m (TP1=1.8%, TP2=3.5%, SL=3.0%)' },
    { hold: 15, tp1: 2.0, tp2: 4.0, sl: 3.0, label: '持仓15m (TP1=2.0%, TP2=4.0%, SL=3.0%)' },
    { hold: 15, tp1: 2.5, tp2: 5.0, sl: 3.5, label: '持仓15m (TP1=2.5%, TP2=5.0%, SL=3.5%)' },
    { hold: 20, tp1: 2.5, tp2: 5.0, sl: 4.0, label: '持仓20m (TP1=2.5%, TP2=5.0%, SL=4.0%)' },
    { hold: 30, tp1: 2.5, tp2: 5.0, sl: 4.0, label: '持仓30m (TP1=2.5%, TP2=5.0%, SL=4.0%)' },
  ];

  for (const sc of scalpConfigs) {
    const res = await simulate(minuteData, frames, {
      name: sc.label,
      holdMinutes: sc.hold,
      useDynamicExit: false,
      exitX: 35,
      exitN: 2.0,
      exitM: 2.0,
      tp1: sc.tp1,
      tp2: sc.tp2,
      sl: sc.sl,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
    });
    console.log(
      `${res.name.padEnd(38)} | 交易: ${String(res.trades).padStart(3)}笔 | 胜率: ${res.winRate.toFixed(1).padStart(5)}% (${String(res.wins).padStart(3)}胜/${String(res.losses).padStart(2)}负) | ` +
      `PF: ${res.pf.toFixed(2).padStart(4)} | 净盈亏: ${res.totalNet >= 0 ? '+' : ''}${res.totalNet.toFixed(1).padStart(5)}% | ` +
      `TP1: ${String(res.tp1Hits).padStart(3)} | 止损: ${String(res.slHits).padStart(2)} | 超时: ${String(res.timeouts).padStart(2)} | 均持: ${res.avgDuration.toFixed(1)}m`
    );
  }

  // 3. 探索中长波段与标准波段模式 (TP1=3.5%, TP2=8%, SL=7% 及大止损 10%)
  console.log('\n────────────────────────────────────────────────────────────────────────────────');
  console.log('🎯 实验组 3：标准波段模式 (TP1=3.5%, TP2=8.0%, SL=7.0%) - 持仓时间对比');
  console.log('────────────────────────────────────────────────────────────────────────────────');
  const swingHolds = [10, 15, 20, 25, 30, 40, 45, 50, 60, 75, 90];
  for (const h of swingHolds) {
    const res = await simulate(minuteData, frames, {
      name: `持仓 ${String(h).padStart(2)}m (波段 TP 3.5/8, SL 7)`,
      holdMinutes: h,
      useDynamicExit: false,
      exitX: 35,
      exitN: 2.0,
      exitM: 3.0,
      tp1: 3.5,
      tp2: 8.0,
      sl: 7.0,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
    });
    console.log(
      `${res.name} | 交易: ${String(res.trades).padStart(3)}笔 | 胜率: ${res.winRate.toFixed(1).padStart(5)}% (${String(res.wins).padStart(3)}胜/${String(res.losses).padStart(2)}负) | ` +
      `PF: ${res.pf.toFixed(2).padStart(4)} | 净盈亏: ${res.totalNet >= 0 ? '+' : ''}${res.totalNet.toFixed(1).padStart(5)}% | ` +
      `TP1: ${String(res.tp1Hits).padStart(3)} | TP2: ${String(res.tp2Hits).padStart(2)} | 止损: ${String(res.slHits).padStart(2)} | 超时: ${String(res.timeouts).padStart(2)} | 均持: ${res.avgDuration.toFixed(1)}m`
    );
  }

  // 4. 探索加上 MA60 下倾 / 收盘受阻等过滤后在短持仓下的表现
  console.log('\n────────────────────────────────────────────────────────────────────────────────');
  console.log('💎 实验组 4：高胜率复合形态短持仓测试 (结合 3m 冲高 / MA60 下倾确认)');
  console.log('────────────────────────────────────────────────────────────────────────────────');
  const comboConfigs = [
    { hold: 10, xM: 3, div: 10, n: 2, tp1: 1.5, tp2: 3.5, sl: 2.5, label: '3m冲高 + 2绿柱 + 10m持仓 (TP 1.5/3.5, SL 2.5)' },
    { hold: 15, xM: 3, div: 10, n: 3, tp1: 2.0, tp2: 4.5, sl: 3.0, label: '3m冲高 + 3绿柱 + 15m持仓 (TP 2.0/4.5, SL 3.0)' },
    { hold: 15, xM: 5, div: 8,  n: 3, tp1: 2.5, tp2: 5.0, sl: 3.5, label: '5m强冲高(24h/8) + 15m持仓 (TP 2.5/5.0, SL 3.5)' },
    { hold: 20, xM: 5, div: 8,  n: 3, tp1: 3.0, tp2: 6.0, sl: 4.0, label: '5m强冲高(24h/8) + 20m持仓 (TP 3.0/6.0, SL 4.0)' },
    { hold: 30, xM: 5, div: 8,  n: 3, tp1: 3.5, tp2: 8.0, sl: 6.0, label: '5m强冲高(24h/8) + 30m持仓 (TP 3.5/8.0, SL 6.0)' },
  ];
  for (const cb of comboConfigs) {
    const res = await simulate(minuteData, frames, {
      name: cb.label,
      holdMinutes: cb.hold,
      useDynamicExit: false,
      exitX: 35,
      exitN: 2.0,
      exitM: 3.0,
      tp1: cb.tp1,
      tp2: cb.tp2,
      sl: cb.sl,
      xMinutes: cb.xM,
      ampDivisor: cb.div,
      nGreenBars: cb.n,
    });
    console.log(
      `${res.name.padEnd(46)} | 交易: ${String(res.trades).padStart(3)}笔 | 胜率: ${res.winRate.toFixed(1).padStart(5)}% (${String(res.wins).padStart(3)}胜/${String(res.losses).padStart(2)}负) | ` +
      `PF: ${res.pf.toFixed(2).padStart(4)} | 净盈亏: ${res.totalNet >= 0 ? '+' : ''}${res.totalNet.toFixed(1).padStart(5)}% | ` +
      `均持: ${res.avgDuration.toFixed(1)}m`
    );
  }
}

main().catch(console.error);
