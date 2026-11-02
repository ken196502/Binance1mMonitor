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

async function main() {
  console.log('正在载入历史行情数据...');
  const hourly = await loadDataset(path.resolve('data/research/hourly-168h'));
  const frames = buildFrames(hourly, 10, 1);
  const minuteData = await loadAllMinutes();
  console.log(`行情数据载入完成！共 ${minuteData.candles.size} 个标的。\n`);

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

  // 1. 模拟运行单个策略
  function simulateStrategy(type: 'peak_rebound' | 'deep_rebound' | 'hourly_suppression') {
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

    // Rank 1 history for peak_rebound
    const rank1History = new Map<string, { peakPrice: number; lastRank1Time: number }>();

    for (let tIdx = 0; tIdx < allTimesSorted.length; tIdx++) {
      const nowTime = allTimesSorted[tIdx];
      const bTime = Math.floor(nowTime / (60 * MINUTE)) * (60 * MINUTE);
      const board = gainerBoards.get(bTime);
      if (!board) continue;

      // Update rank1 history
      for (const [sym, row] of board) {
        if (row.rank === 1) {
          const rawBars = candleMap.get(sym);
          const tMap = timeIndices.get(sym);
          const curIdx = tMap?.get(nowTime);
          if (rawBars && curIdx !== undefined) {
            const h = rawBars[curIdx][2];
            const existing = rank1History.get(sym);
            if (!existing) {
              rank1History.set(sym, { peakPrice: h, lastRank1Time: nowTime });
            } else {
              existing.lastRank1Time = nowTime;
              if (h > existing.peakPrice) existing.peakPrice = h;
            }
          }
        }
      }

      // Manage active positions
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

      // Check entry
      for (const [sym, row] of board) {
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
        const macd = macdMap.get(sym)!;

        let triggered = false;
        let holdMinutes = 30;
        let tp1 = 3.5, tp2 = 7.0, sl = 4.0;

        if (type === 'peak_rebound') {
          // 子策略一：首次跌10% (榜首弱反弹, MA30>MA15>MA5, High>MA5 && Close<MA5)
          const r1 = rank1History.get(sym);
          if (!r1) continue;
          if (nowTime - r1.lastRank1Time > 48 * 60 * MINUTE) continue;
          if (closedBar[2] > r1.peakPrice) r1.peakPrice = closedBar[2];

          // 跌幅 >= 10%
          const dropFromPeak = ((r1.peakPrice - closedBar[4]) / r1.peakPrice) * 100;
          if (dropFromPeak < 10) continue;

          // 阶段反弹 y >= 4% (从过去 30m 最低点)
          const low30Start = Math.max(0, targetIdx - 30);
          let low30 = Infinity;
          for (let k = low30Start; k <= targetIdx; k++) {
            if (rawBars[k][3] < low30) low30 = rawBars[k][3];
          }
          if (low30 <= 0) continue;
          const reboundPct = ((closedBar[2] - low30) / low30) * 100;
          if (reboundPct < 4.0) continue;

          // MA30 > MA15 > MA5
          const ma5 = calculateSma(closes, targetIdx, 5);
          const ma15 = calculateSma(closes, targetIdx, 15);
          const ma30 = calculateSma(closes, targetIdx, 30);
          if (ma5 == null || ma15 == null || ma30 == null) continue;
          if (!(ma30 > ma15 && ma15 > ma5)) continue;
          if (ma30 < closedBar[2] * 1.005) continue; // MA30 压制高于反弹高点 0.5%
          if (!(closedBar[2] > ma5 && closedBar[4] < ma5)) continue; // MA5 刺破收回

          // 近 20 根绿柱占比 > 65%
          let green20 = 0;
          for (let k = 0; k < 20; k++) {
            const idx = targetIdx - k;
            if (idx >= 0 && macd.hist[idx] > 0) green20++;
          }
          if (green20 / 20 < 0.65) continue;

          triggered = true;
          holdMinutes = 30;
          // 首次跌10%的黄金参数: TP1=3.5%, TP2=7.0%, SL=4.0%
          tp1 = 3.5; tp2 = 7.0; sl = 4.0;
        } else if (type === 'deep_rebound') {
          // 子策略二：跌到20%+ (距24h高点跌>=20%, 反弹>=5%, MA15<MA30, Close<MA15<High)
          const start24h = Math.max(0, targetIdx - 1439);
          let high24h = 0;
          for (let k = start24h; k <= targetIdx; k++) {
            if (rawBars[k][2] > high24h) high24h = rawBars[k][2];
          }
          if (high24h <= 0) continue;
          const dropFrom24h = ((high24h - closedBar[4]) / high24h) * 100;
          if (dropFrom24h < 20.0) continue;

          // 10m 最低点反弹 >= 5%
          const low10Start = Math.max(0, targetIdx - 10);
          let low10 = Infinity;
          for (let k = low10Start; k <= targetIdx; k++) {
            if (rawBars[k][3] < low10) low10 = rawBars[k][3];
          }
          if (low10 <= 0) continue;
          const rebound10 = ((closedBar[2] - low10) / low10) * 100;
          if (rebound10 < 5.0) continue;

          // MA15 < MA30
          const ma15 = calculateSma(closes, targetIdx, 15);
          const ma30 = calculateSma(closes, targetIdx, 30);
          if (ma15 == null || ma30 == null) continue;
          if (!(ma15 < ma30)) continue;
          const ma30Prev = calculateSma(closes, targetIdx - 3, 30);
          if (ma30Prev == null || ma30 >= ma30Prev) continue; // MA30 下倾

          // Close < MA15 < High
          if (!(closedBar[4] < ma15 && closedBar[2] > ma15)) continue;

          // 近 20 根绿柱占比 > 55%
          let green20 = 0;
          for (let k = 0; k < 20; k++) {
            const idx = targetIdx - k;
            if (idx >= 0 && macd.hist[idx] > 0) green20++;
          }
          if (green20 / 20 < 0.55) continue;

          triggered = true;
          holdMinutes = 30;
          tp1 = 4.0; tp2 = 8.0; sl = 5.0;
        } else if (type === 'hourly_suppression') {
          // 子策略三：小时线压制做空 (深跌狂暴狙击版: 跌幅>=20%, 5m冲高>=24h/10, 碰MA60, MA60>MA10>MA20, 近3绿柱)
          if (row.rank > 10 || row.dayChange < 10) continue;

          const start24h = Math.max(0, targetIdx - 1439);
          let high24h = 0;
          for (let k = start24h; k <= targetIdx; k++) {
            if (rawBars[k][2] > high24h) high24h = rawBars[k][2];
          }
          if (high24h <= 0) continue;
          const dropFrom24h = ((high24h - closedBar[4]) / high24h) * 100;
          if (dropFrom24h < 20.0) continue;

          // 5m 冲高 >= 24h / 10
          const xStart = Math.max(0, targetIdx - 5 + 1);
          let xMinLow = Infinity;
          for (let k = xStart; k <= targetIdx; k++) {
            if (rawBars[k][3] < xMinLow) xMinLow = rawBars[k][3];
          }
          if (xMinLow <= 0) continue;
          const xRisePercent = ((closedBar[2] - xMinLow) / xMinLow) * 100;
          if (xRisePercent < row.dayChange / 10) continue;

          // MA60 碰触
          const ma60 = calculateSma(closes, targetIdx, 60);
          if (ma60 == null) continue;
          if (!(closedBar[2] > ma60 && closedBar[3] < ma60)) continue;

          // MA60 > MA10 > MA20
          const ma10 = calculateSma(closes, targetIdx, 10);
          const ma20 = calculateSma(closes, targetIdx, 20);
          if (ma10 == null || ma20 == null) continue;
          if (!(ma60 > ma10 && ma10 > ma20)) continue;

          // 近 3 根绿柱
          let allGreen = true;
          for (let k = 0; k < 3; k++) {
            const idx = targetIdx - k;
            if (idx < 0 || macd.hist[idx] <= 0) { allGreen = false; break; }
          }
          if (!allGreen) continue;

          triggered = true;
          holdMinutes = 30;
          tp1 = 3.0; tp2 = 6.0; sl = 4.0;
        }

        if (triggered) {
          const nextOpen = rawBars[curIdx][1];
          const entryPrice = nextOpen > 0 ? nextOpen : closedBar[4];
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
            holdDeadline: nowTime + holdMinutes * MINUTE,
          });
        }
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
      const dur = ((t.exitTime ?? (t.entryTime + 30 * MINUTE)) - t.entryTime) / MINUTE;
      totalDurationMinutes += dur;
    }

    const wins = closedTrades.filter(t => t.netPnlPercent > 0).length;
    const losses = closedTrades.filter(t => t.netPnlPercent <= 0).length;
    const trades = closedTrades.length;
    const winRate = trades > 0 ? (wins / trades) * 100 : 0;
    const pf = totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? 99 : 0;

    return {
      type,
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
      tradesList: closedTrades,
    };
  }

  console.log('='.repeat(105));
  console.log('📊【三大右侧下跌做空子策略】同源 168h 历史行情精准横向对比');
  console.log('='.repeat(105));

  const res1 = simulateStrategy('peak_rebound');
  const res2 = simulateStrategy('deep_rebound');
  const res3 = simulateStrategy('hourly_suppression');

  const printRow = (title: string, r: any) => {
    const pnlSign = r.totalNet >= 0 ? '+' : '';
    console.log(
      `${title.padEnd(42)} | 交易: ${String(r.trades).padStart(3)}笔 | 胜率: ${r.winRate.toFixed(1).padStart(5)}% (${String(r.wins).padStart(2)}胜/${String(r.losses).padStart(2)}负) | PF: ${r.pf.toFixed(2)} | 净盈亏: ${(pnlSign + r.totalNet.toFixed(1) + '%').padStart(6)} | TP1: ${String(r.tp1Hits).padStart(2)} | TP2: ${String(r.tp2Hits).padStart(2)} | SL: ${String(r.slHits).padStart(2)} | 超时: ${String(r.timeouts).padStart(2)} | 均持: ${r.avgDuration.toFixed(1)}m`
    );
  };

  printRow('1. 首次跌10% (龙头初次见顶回撤弱反弹)', res1);
  printRow('2. 跌到20%+ (二次超跌反弹 MA15 阻击)', res2);
  printRow('3. 小时线压制 (深跌狂暴狙击 MA60 阻击)', res3);

  // Check signal collision / overlap
  console.log('\n' + '-'.repeat(105));
  console.log('🔍【信号重合度检测】检查三大策略是否存在冲突抢单，还是在时间/价格上完美错位互补？');
  console.log('-'.repeat(105));

  const times1 = new Set(res1.tradesList.map(t => `${t.symbol}-${Math.floor(t.entryTime / (60 * MINUTE))}`));
  const times2 = new Set(res2.tradesList.map(t => `${t.symbol}-${Math.floor(t.entryTime / (60 * MINUTE))}`));
  const times3 = new Set(res3.tradesList.map(t => `${t.symbol}-${Math.floor(t.entryTime / (60 * MINUTE))}`));

  let overlap12 = 0, overlap13 = 0, overlap23 = 0;
  for (const k of times3) {
    if (times1.has(k)) overlap13++;
    if (times2.has(k)) overlap23++;
  }
  for (const k of times1) {
    if (times2.has(k)) overlap12++;
  }

  console.log(`[首次跌10%] 与 [跌到20%+] 同分钟同币种重合数: ${overlap12} 笔`);
  console.log(`[首次跌10%] 与 [小时线压制] 同分钟同币种重合数: ${overlap13} 笔`);
  console.log(`[跌到20%+] 与 [小时线压制] 同分钟同币种重合数: ${overlap23} 笔`);
}

main().catch(console.error);
