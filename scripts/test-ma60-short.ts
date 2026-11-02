import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import type { MinuteDataset } from '../research/gainers-types.ts';
import { computeMacd, calculateSma } from '../src/macd.ts';
import type { Candle } from '../src/macd.ts';

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

interface TestConfig {
  name: string;
  nGreenBars: number;
  requireCloseBelowMa: boolean;
  requireBearish: boolean;
  requireSlopeDown: boolean;
  minDayChange: number;
  topN: number;
  holdMinutes: number;
  tp1Percent: number;
  tp2Percent: number;
  stopLossPercent: number;
  cooldownMinutes: number;
}

async function runTest(
  minuteData: MinuteDataset,
  frames: any[],
  cfg: TestConfig
) {
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
  const candleMap = new Map<string, Candle[]>();
  const timeIndices = new Map<string, Map<number, number>>();

  for (const sym of syms) {
    const rawBars = minuteData.candles.get(sym)!;
    const cList: Candle[] = [];
    const tMap = new Map<number, number>();
    for (let idx = 0; idx < rawBars.length; idx++) {
      const b = rawBars[idx];
      cList.push({ time: b[0], open: b[1], high: b[2], low: b[3], close: b[4], volume: b[5] });
      tMap.set(b[0], idx);
    }
    candleMap.set(sym, cList);
    timeIndices.set(sym, tMap);
    macdMap.set(sym, computeMacd(cList.map(c => c.close)));
  }

  interface SimPos {
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
    reason1?: string;
    reason2?: string;
  }

  const activePositions: SimPos[] = [];
  const closedTrades: any[] = [];
  const cooldownMap = new Map<string, number>();

  for (let tIdx = 0; tIdx < allTimesSorted.length; tIdx++) {
    const nowTime = allTimesSorted[tIdx];
    const bTime = Math.floor(nowTime / (60 * MINUTE)) * (60 * MINUTE);
    const board = gainerBoards.get(bTime);
    if (!board) continue;

    // Check active positions
    for (let pIdx = activePositions.length - 1; pIdx >= 0; pIdx--) {
      const pos = activePositions[pIdx];
      const sMap = candleMap.get(pos.symbol);
      const cIdx = timeIndices.get(pos.symbol)?.get(nowTime);
      if (sMap && cIdx !== undefined) {
        const curBar = sMap[cIdx];
        const h = curBar.high, l = curBar.low, c = curBar.close;

        // SHORT exits
        if (!pos.st1Done) {
          if (h >= pos.slPrice) {
            pos.netPnlPercent = calcTradeReturn('SHORT', pos.entryPrice, pos.slPrice).netPercent;
            pos.st1Done = true;
            pos.st2Done = true;
            pos.reason1 = 'stop';
            pos.reason2 = 'stop';
          } else if (l <= pos.tp1Price) {
            pos.netPnlPercent += calcTradeReturn('SHORT', pos.entryPrice, pos.tp1Price).netPercent * 0.5;
            pos.st1Done = true;
            pos.reason1 = 'target';
            pos.sl2Price = pos.entryPrice; // move to breakeven
            if (l <= pos.tp2Price) {
              pos.netPnlPercent += calcTradeReturn('SHORT', pos.entryPrice, pos.tp2Price).netPercent * 0.5;
              pos.st2Done = true;
              pos.reason2 = 'target';
            }
          }
        }

        if (pos.st1Done && !pos.st2Done) {
          if (h >= pos.sl2Price) {
            pos.netPnlPercent += calcTradeReturn('SHORT', pos.entryPrice, pos.sl2Price).netPercent * 0.5;
            pos.st2Done = true;
            pos.reason2 = 'stop';
          } else if (l <= pos.tp2Price) {
            pos.netPnlPercent += calcTradeReturn('SHORT', pos.entryPrice, pos.tp2Price).netPercent * 0.5;
            pos.st2Done = true;
            pos.reason2 = 'target';
          }
        }

        const isTimeout = nowTime >= pos.holdDeadline;
        if (pos.st2Done || isTimeout) {
          if (isTimeout && !pos.st2Done) {
            const rem = !pos.st1Done ? 1.0 : 0.5;
            pos.netPnlPercent += calcTradeReturn('SHORT', pos.entryPrice, c).netPercent * rem;
            if (!pos.reason1) pos.reason1 = 'timeout';
            pos.reason2 = 'timeout';
          }
          cooldownMap.set(pos.symbol, nowTime + cfg.cooldownMinutes * MINUTE);
          closedTrades.push({
            symbol: pos.symbol,
            entryTime: pos.entryTime,
            exitTime: nowTime,
            netPercent: pos.netPnlPercent,
            reasons: `${pos.reason1 ?? 'none'}/${pos.reason2 ?? 'none'}`,
          });
          activePositions.splice(pIdx, 1);
        }
      }
    }

    // Check entry
    for (const [sym, row] of board) {
      if (cfg.topN > 0 && row.rank > cfg.topN) continue;
      if (row.dayChange < cfg.minDayChange) continue;
      if (activePositions.some(p => p.symbol === sym)) continue;
      if ((cooldownMap.get(sym) ?? 0) > nowTime) continue;

      const fullBars = candleMap.get(sym);
      const tMap = timeIndices.get(sym);
      if (!fullBars || !tMap) continue;
      const curIdx = tMap.get(nowTime);
      if (curIdx === undefined || curIdx < 65 || curIdx >= fullBars.length - 1) continue;

      const targetIdx = curIdx - 1; // latest completed bar
      const closedBar = fullBars[targetIdx];
      const closes = fullBars.map(b => b.close);

      // MA60 at targetIdx
      const ma60 = calculateSma(closes, targetIdx, 60);
      if (ma60 == null) continue;

      // Condition: 最高价大于1mMA60 && 最低价小于1mMA60
      if (!(closedBar.high > ma60 && closedBar.low < ma60)) continue;

      // Optional: require close below ma60
      if (cfg.requireCloseBelowMa && closedBar.close >= ma60) continue;

      // Optional: require bearish candle (close < open)
      if (cfg.requireBearish && closedBar.close >= closedBar.open) continue;

      // Optional: require MA60 slope down
      if (cfg.requireSlopeDown) {
        const ma60Prev = calculateSma(closes, targetIdx - 3, 60);
        if (ma60Prev == null || ma60 > ma60Prev) continue;
      }

      // MACD: 近 N 根 macd 是绿柱 (hist > 0)
      const macd = macdMap.get(sym)!;
      let allGreen = true;
      for (let k = 0; k < cfg.nGreenBars; k++) {
        const barIdx = targetIdx - k;
        if (barIdx < 0 || macd.hist[barIdx] <= 0) {
          allGreen = false;
          break;
        }
      }
      if (!allGreen) continue;

      // Trigger short!
      const nextOpen = fullBars[curIdx].open;
      const entryPrice = nextOpen > 0 ? nextOpen : closedBar.close;
      const tp1 = cfg.tp1Percent;
      const tp2 = cfg.tp2Percent;
      const sl = cfg.stopLossPercent;

      activePositions.push({
        symbol: sym,
        entryTime: nowTime,
        entryPrice,
        tp1Price: entryPrice * (1 - tp1 / 100),
        tp2Price: entryPrice * (1 - tp2 / 100),
        slPrice: entryPrice * (1 + sl / 100),
        sl2Price: entryPrice * (1 + sl / 100),
        st1Done: false,
        st2Done: false,
        netPnlPercent: 0,
        holdDeadline: nowTime + cfg.holdMinutes * MINUTE,
      });
    }
  }

  const totalTrades = closedTrades.length;
  const wins = closedTrades.filter(t => t.netPercent > 0).length;
  const losses = closedTrades.filter(t => t.netPercent < 0).length;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const totalGain = closedTrades.filter(t => t.netPercent > 0).reduce((s, t) => s + t.netPercent, 0);
  const totalLoss = Math.abs(closedTrades.filter(t => t.netPercent < 0).reduce((s, t) => s + t.netPercent, 0));
  const pf = totalLoss > 0 ? totalGain / totalLoss : totalGain > 0 ? 99.9 : 0;
  const totalNet = closedTrades.reduce((s, t) => s + t.netPercent, 0);

  return {
    name: cfg.name,
    trades: totalTrades,
    wins,
    losses,
    winRate,
    pf,
    totalNet,
  };
}

async function main() {
  console.log('正在载入历史行情数据...');
  const hourly = await loadDataset(path.resolve('data/research/hourly-168h'));
  const frames = buildFrames(hourly, 10, 1);
  const minuteData = await loadAllMinutes();
  console.log(`行情数据载入完成！标的数: ${minuteData.candles.size}`);

  const nList = [1, 2, 3, 4, 5, 6, 8, 10];
  console.log('\n--- 实验 1: 扫描近 N 根 MACD 是绿柱 (严格 high > MA60 && low < MA60, 30m持仓, TP1=3.5%, TP2=8%, SL=7%) ---');
  
  for (const n of nList) {
    const res = await runTest(minuteData, frames, {
      name: `近 ${n} 根绿柱`,
      nGreenBars: n,
      requireCloseBelowMa: false,
      requireBearish: false,
      requireSlopeDown: false,
      minDayChange: 10,
      topN: 10,
      holdMinutes: 30,
      tp1Percent: 3.5,
      tp2Percent: 8.0,
      stopLossPercent: 7.0,
      cooldownMinutes: 20,
    });
    console.log(`${res.name.padEnd(14)}: 交易 ${String(res.trades).padStart(3)} 笔 | 胜率 ${res.winRate.toFixed(1)}% (${res.wins}胜 ${res.losses}负) | PF: ${res.pf.toFixed(2)} | 累计净收益: ${res.totalNet >= 0 ? '+' : ''}${res.totalNet.toFixed(1)}%`);
  }

  console.log('\n--- 实验 2: 加入收盘价受压制确认 (close < ma60) 对比 ---');
  for (const n of [1, 2, 3, 4, 5]) {
    const res = await runTest(minuteData, frames, {
      name: `近 ${n} 根绿柱 + close<ma60`,
      nGreenBars: n,
      requireCloseBelowMa: true,
      requireBearish: false,
      requireSlopeDown: false,
      minDayChange: 10,
      topN: 10,
      holdMinutes: 30,
      tp1Percent: 3.5,
      tp2Percent: 8.0,
      stopLossPercent: 7.0,
      cooldownMinutes: 20,
    });
    console.log(`${res.name.padEnd(26)}: 交易 ${String(res.trades).padStart(3)} 笔 | 胜率 ${res.winRate.toFixed(1)}% (${res.wins}胜 ${res.losses}负) | PF: ${res.pf.toFixed(2)} | 累计净收益: ${res.totalNet >= 0 ? '+' : ''}${res.totalNet.toFixed(1)}%`);
  }

  console.log('\n--- 实验 3: 加入阴线收盘确认 (bearish: close < open) 对比 ---');
  for (const n of [1, 2, 3, 4, 5]) {
    const res = await runTest(minuteData, frames, {
      name: `近 ${n} 根绿柱 + 收阴`,
      nGreenBars: n,
      requireCloseBelowMa: false,
      requireBearish: true,
      requireSlopeDown: false,
      minDayChange: 10,
      topN: 10,
      holdMinutes: 30,
      tp1Percent: 3.5,
      tp2Percent: 8.0,
      stopLossPercent: 7.0,
      cooldownMinutes: 20,
    });
    console.log(`${res.name.padEnd(20)}: 交易 ${String(res.trades).padStart(3)} 笔 | 胜率 ${res.winRate.toFixed(1)}% (${res.wins}胜 ${res.losses}负) | PF: ${res.pf.toFixed(2)} | 累计净收益: ${res.totalNet >= 0 ? '+' : ''}${res.totalNet.toFixed(1)}%`);
  }

  console.log('\n--- 实验 4: 持仓周期与退出对比 (N=3, 4, 5, 持仓 15m vs 30m vs 45m vs 60m) ---');
  for (const hold of [15, 30, 45, 60]) {
    for (const n of [3, 4, 5]) {
      const res = await runTest(minuteData, frames, {
        name: `N=${n}, 持仓${hold}m`,
        nGreenBars: n,
        requireCloseBelowMa: false,
        requireBearish: false,
        requireSlopeDown: false,
        minDayChange: 10,
        topN: 10,
        holdMinutes: hold,
        tp1Percent: 3.5,
        tp2Percent: 8.0,
        stopLossPercent: 7.0,
        cooldownMinutes: 20,
      });
      console.log(`${res.name.padEnd(18)}: 交易 ${String(res.trades).padStart(3)} 笔 | 胜率 ${res.winRate.toFixed(1)}% (${res.wins}胜 ${res.losses}负) | PF: ${res.pf.toFixed(2)} | 累计净收益: ${res.totalNet >= 0 ? '+' : ''}${res.totalNet.toFixed(1)}%`);
    }
  }

  console.log('\n--- 实验 5: 动态退出与盈亏比参数扫描 (N=3, 30m, 比较不同 TP1/TP2/SL) ---');
  const tpConfigs = [
    { tp1: 2.5, tp2: 6.0, sl: 5.0, label: '紧凑型 TP1=2.5%, TP2=6.0%, SL=5.0%' },
    { tp1: 3.0, tp2: 6.0, sl: 6.0, label: '均衡型 TP1=3.0%, TP2=6.0%, SL=6.0%' },
    { tp1: 3.5, tp2: 8.0, sl: 7.0, label: '标准型 TP1=3.5%, TP2=8.0%, SL=7.0%' },
    { tp1: 4.0, tp2: 8.0, sl: 10.0, label: '波段型 TP1=4.0%, TP2=8.0%, SL=10.0%' },
  ];
  for (const tpc of tpConfigs) {
    const res = await runTest(minuteData, frames, {
      name: tpc.label,
      nGreenBars: 3,
      requireCloseBelowMa: false,
      requireBearish: false,
      requireSlopeDown: false,
      minDayChange: 10,
      topN: 10,
      holdMinutes: 30,
      tp1Percent: tpc.tp1,
      tp2Percent: tpc.tp2,
      stopLossPercent: tpc.sl,
      cooldownMinutes: 20,
    });
    console.log(`${res.name.padEnd(38)}: 交易 ${String(res.trades).padStart(3)} 笔 | 胜率 ${res.winRate.toFixed(1)}% (${res.wins}胜 ${res.losses}负) | PF: ${res.pf.toFixed(2)} | 累计净收益: ${res.totalNet >= 0 ? '+' : ''}${res.totalNet.toFixed(1)}%`);
  }
}

main().catch(console.error);
