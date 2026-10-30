import path from 'node:path';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import { planWatchlistMinutes, loadWatchlistMinutes } from '../research/peak-rebound-data.ts';
import { calculateSupportMaAt, computeMacd } from '../src/macd.ts';
import { calcReturn } from '../research/peak-rebound-backtest.ts';
import { HOUR } from '../research/types.ts';
import { MINUTE } from '../research/gainers-types.ts';

interface SignalEvent {
  symbol: string;
  time: number;
  entryPrice: number;
  dayChange: number;
  surgePercent: number;
  exitParams: { holdMinutes: number; exitX: number; exitN: number; exitM: number };
  signalBarHigh: number;
  divergence: { prevMax: number; curHist: number; prevHist: number };
}

async function main() {
  console.log('================================================================');
  console.log('🎯【专项审查】新高空 (脉冲新高顶背离) 极端最高点止损表现');
  console.log('================================================================\n');

  const hourlyDir = path.resolve('data/research/hourly-168h');
  const minutesDir = path.resolve('data/research/peak-rebound-1m-168h');

  const hourly = await loadDataset(hourlyDir);
  const frames = buildFrames(hourly, 10, 1);
  const plan = planWatchlistMinutes(hourly, frames);
  const minuteData = await loadWatchlistMinutes(minutesDir, plan);

  const boards = new Map<number, Map<string, { rank: number; dayChange: number }>>();
  for (const f of frames) {
    const m = new Map<string, { rank: number; dayChange: number }>();
    for (const b of f.boards.gainers) m.set(b.symbol, { rank: b.rank, dayChange: b.dayChange });
    boards.set(f.time, m);
  }

  // 1. 扫描全部【新高顶背离】信号
  // 核心规则：
  // - 处于涨幅榜 Top 10, 24h 涨幅 >= 15%
  // - 5m 脉冲涨幅 >= 24h / 10
  // - 创 24h 新高 (high >= past 1440m max)
  // - 短均线 MA [3, 7, 15] 悬空无支撑
  // - MACD Hist 与 DIF 双重顶背离 (回溯 10m ~ 120m)
  const events: SignalEvent[] = [];

  for (const [sym, bars] of minuteData.candles) {
    if (!bars || bars.length < 65) continue;
    const opens = bars.map(b => b[1]);
    const highs = bars.map(b => b[2]);
    const lows = bars.map(b => b[3]);
    const closes = bars.map(b => b[4]);
    const times = bars.map(b => b[0]);
    const { hist, dif } = computeMacd(closes);
    const candlesList = bars.map(b => ({ time: b[0], open: b[1], high: b[2], low: b[3], close: b[4] }));

    let curMax24h = 0;

    for (let i = 35; i < bars.length - 1; i++) {
      const t = times[i];
      const bTime = Math.floor(t / HOUR) * HOUR;
      const row = boards.get(bTime)?.get(sym);
      if (!row) continue;

      const start24h = Math.max(0, i - 1439);
      if (i === 35 || highs[i] > curMax24h) {
        let m = 0;
        for (let k = start24h; k <= i; k++) if (highs[k] > m) m = highs[k];
        curMax24h = m;
      }

      if (row.rank > 10 || row.dayChange < 15) continue;

      // 5m 涨幅 >= 24h / 10
      const startX = Math.max(0, i - 4);
      let minLow = Infinity;
      for (let k = startX; k <= i; k++) if (lows[k] < minLow) minLow = lows[k];
      if (minLow <= 0) continue;
      const surge = ((highs[i] - minLow) / minLow) * 100;
      const reqSurge = row.dayChange / 10.0;
      if (surge < reqSurge) continue;

      // 创 24h 新高
      if (highs[i] < curMax24h) continue;

      // MA [3, 7, 15] 悬空无支撑
      if (calculateSupportMaAt(candlesList, i, [3, 7, 15]) !== null) continue;

      // MACD 双重顶背离 (10m ~ 120m)
      const lookStart = Math.max(0, i - 120);
      const lookEnd = Math.max(0, i - 10);
      if (lookEnd <= lookStart) continue;

      let prevIdx = -1;
      let prevMax = 0;
      for (let k = lookStart; k <= lookEnd; k++) {
        if (highs[k] > prevMax) {
          prevMax = highs[k];
          prevIdx = k;
        }
      }
      if (prevIdx < 0 || highs[i] < prevMax) continue;
      if (hist[i] >= hist[prevIdx] || dif[i] >= dif[prevIdx]) continue;

      const nextBar = bars[i + 1];
      if (!nextBar) continue;

      events.push({
        symbol: sym,
        time: nextBar[0],
        entryPrice: nextBar[1],
        dayChange: row.dayChange,
        surgePercent: surge,
        signalBarHigh: highs[i],
        exitParams: { holdMinutes: 15, exitX: 50, exitN: 1.5, exitM: 3.0 },
        divergence: { prevMax, curHist: hist[i], prevHist: hist[prevIdx] },
      });
    }
  }

  events.sort((a, b) => a.time - b.time);
  console.log(`📡 扫描到原始【新高空】候选信号: ${events.length} 笔\n`);

  // 运行回测函数
  function runSimulation(stopAtHigh: boolean) {
    const occupiedUntil = new Map<string, number>();
    const trades: any[] = [];

    for (const ev of events) {
      if ((occupiedUntil.get(ev.symbol) ?? 0) > ev.time) continue;

      const bars = minuteData.candles.get(ev.symbol)!;
      const fillIdx = bars.findIndex(b => b[0] === ev.time);
      if (fillIdx < 0) continue;

      const { holdMinutes, exitX, exitN, exitM } = ev.exitParams;
      const dayChange = Math.max(10, ev.dayChange);
      const entry = ev.entryPrice;

      const tp1 = entry * (1 - (dayChange / exitX) / 100);
      const sl1 = entry * (1 + (dayChange / exitX) / 100);
      const tp2 = entry * (1 - (dayChange * exitM / exitX) / 100);
      const sl2 = entry * (1 + (dayChange * exitN / exitX) / 100);

      let stage1Closed = false;
      let stage2Closed = false;
      let tradeNet = 0;
      let exitTime = ev.time + holdMinutes * MINUTE;
      let reason1 = 'timeout';
      let reason2 = 'timeout';
      let exits: any[] = [];

      for (let step = 0; step < holdMinutes; step++) {
        const b = bars[fillIdx + step];
        if (!b) break;
        const o = b[1];
        const h = b[2];
        const l = b[3];
        const c = b[4];

        if (!stage1Closed) {
          if (h >= sl1) {
            const exitP = stopAtHigh ? h : (o >= sl1 ? o : sl1);
            const ret = calcReturn(entry, exitP, 'stop', { takerFeeBps: 5, slippageBps: 2 });
            tradeNet += ret.netPercent * 0.5;
            stage1Closed = true;
            reason1 = 'stop';
            exits.push({ stage: 1, reason: 'stop', exitPrice: exitP, netPercent: ret.netPercent * 0.5 });
          } else if (l <= tp1) {
            const exitP = o <= tp1 ? o : tp1;
            const ret = calcReturn(entry, exitP, 'target', { takerFeeBps: 5, slippageBps: 2 });
            tradeNet += ret.netPercent * 0.5;
            stage1Closed = true;
            reason1 = 'target';
            exits.push({ stage: 1, reason: 'target', exitPrice: exitP, netPercent: ret.netPercent * 0.5 });
          }
        }

        if (stage1Closed && !stage2Closed) {
          if (h >= sl2) {
            const exitP = stopAtHigh ? h : (o >= sl2 ? o : sl2);
            const ret = calcReturn(entry, exitP, 'stop', { takerFeeBps: 5, slippageBps: 2 });
            tradeNet += ret.netPercent * 0.5;
            stage2Closed = true;
            reason2 = 'stop';
            exitTime = b[0];
            exits.push({ stage: 2, reason: 'stop', exitPrice: exitP, netPercent: ret.netPercent * 0.5 });
            break;
          } else if (l <= tp2) {
            const exitP = o <= tp2 ? o : tp2;
            const ret = calcReturn(entry, exitP, 'target', { takerFeeBps: 5, slippageBps: 2 });
            tradeNet += ret.netPercent * 0.5;
            stage2Closed = true;
            reason2 = 'target';
            exitTime = b[0];
            exits.push({ stage: 2, reason: 'target', exitPrice: exitP, netPercent: ret.netPercent * 0.5 });
            break;
          }
        }

        if (step === holdMinutes - 1) {
          const rem = (!stage1Closed ? 1.0 : !stage2Closed ? 0.5 : 0);
          if (rem > 0) {
            const ret = calcReturn(entry, c, 'timeout', { takerFeeBps: 5, slippageBps: 2 });
            tradeNet += ret.netPercent * rem;
            exits.push({ stage: stage1Closed ? 2 : 1, reason: 'timeout', exitPrice: c, netPercent: ret.netPercent * rem });
          }
          exitTime = b[0];
        }
      }

      occupiedUntil.set(ev.symbol, exitTime + 20 * MINUTE); // 20m 冷却
      trades.push({
        event: ev,
        entryPrice: entry,
        entryTime: ev.time,
        exitTime,
        netPercent: tradeNet,
        reasons: `${reason1}/${reason2}`,
        exits,
      });
    }

    const wins = trades.filter(t => t.netPercent > 0);
    const losses = trades.filter(t => t.netPercent < 0);
    const grossWins = wins.reduce((s, t) => s + t.netPercent, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPercent, 0));
    const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
    const profitFactor = grossLoss > 0 ? grossWins / grossLoss : Infinity;
    const meanWin = wins.length ? grossWins / wins.length : 0;
    const meanLoss = losses.length ? grossLoss / losses.length : 0;
    const rr = meanLoss > 0 ? meanWin / meanLoss : Infinity;
    const totalNet = trades.reduce((s, t) => s + t.netPercent, 0);

    return { trades, wins: wins.length, losses: losses.length, winRate, profitFactor, rr, totalNet, meanWin, meanLoss };
  }

  const std = runSimulation(false);
  const ext = runSimulation(true);

  console.log('================================================================');
  console.log('📊【新高空 (脉冲新高顶背离)】标准止损 vs 极端1m最高点止损 对比');
  console.log('================================================================');
  console.log(`指标                     | 【标准止损模式】         | 【极端1m最高点(High)模式】`);
  console.log('----------------------------------------------------------------');
  console.log(`交易笔数                 | ${String(std.trades.length).padEnd(24)} | ${String(ext.trades.length).padEnd(24)}`);
  console.log(`胜率 (Win Rate)          | ${(std.winRate.toFixed(2) + '%').padEnd(24)} | ${(ext.winRate.toFixed(2) + '%').padEnd(24)}`);
  console.log(`战绩 (胜 / 负)           | ${(std.wins + ' 胜 / ' + std.losses + ' 负').padEnd(24)} | ${(ext.wins + ' 胜 / ' + ext.losses + ' 负').padEnd(24)}`);
  console.log(`累计净收益率 (Net PnL)   | ${(std.totalNet >= 0 ? '+' : '') + std.totalNet.toFixed(2) + '%'}`.padEnd(26) + `| ${(ext.totalNet >= 0 ? '+' : '') + ext.totalNet.toFixed(2) + '%'}`);
  console.log(`盈利因子 (Profit Factor) | ${String(std.profitFactor.toFixed(2)).padEnd(24)} | ${String(ext.profitFactor.toFixed(2)).padEnd(24)}`);
  console.log(`盈亏比 (Reward/Risk)     | ${String(std.rr.toFixed(2)).padEnd(24)} | ${String(ext.rr.toFixed(2)).padEnd(24)}`);
  console.log(`平均盈利幅度             | ${('+' + std.meanWin.toFixed(2) + '%').padEnd(24)} | ${('+' + ext.meanWin.toFixed(2) + '%').padEnd(24)}`);
  console.log(`平均亏损幅度             | ${('-' + std.meanLoss.toFixed(2) + '%').padEnd(24)} | ${('-' + ext.meanLoss.toFixed(2) + '%').padEnd(24)}`);
  console.log('----------------------------------------------------------------\n');

  console.log('📋【逐笔明细审查】(对比标准止损 vs 极端最高点止损):');
  for (let i = 0; i < std.trades.length; i++) {
    const t1 = std.trades[i];
    const t2 = ext.trades[i];
    const sym = t1.event.symbol;
    const timeStr = new Date(t1.entryTime).toISOString().slice(5, 16);
    const dayChg = t1.event.dayChange.toFixed(1);
    const net1 = (t1.netPercent >= 0 ? '+' : '') + t1.netPercent.toFixed(2) + '%';
    const net2 = (t2.netPercent >= 0 ? '+' : '') + t2.netPercent.toFixed(2) + '%';
    const diff = (t2.netPercent - t1.netPercent).toFixed(2) + '%';
    const flag = t2.netPercent < 0 && t1.netPercent > 0 ? '⚠️ 胜转负' : (t2.netPercent < 0 ? '❌ 亏损' : '✅ 盈利');

    console.log(
      `#${i + 1} [${sym.padEnd(8)}] ${timeStr} | 24h: +${dayChg}% | 入场: ${t1.entryPrice.toFixed(4)} | ` +
      `标准: ${net1.padEnd(7)} (${t1.reasons}) → 极端: ${net2.padEnd(7)} (${t2.reasons}) | 差额: ${diff} | ${flag}`
    );
  }
}

main().catch(console.error);
