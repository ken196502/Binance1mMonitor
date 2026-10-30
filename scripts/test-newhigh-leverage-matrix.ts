import path from 'node:path';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import { planWatchlistMinutes, loadWatchlistMinutes } from '../research/peak-rebound-data.ts';
import { calculateSupportMaAt, computeMacd } from '../src/macd.ts';
import { calcReturn } from '../research/peak-rebound-backtest.ts';
import { HOUR } from '../research/types.ts';

async function main() {
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

  // 测试两种不同规则的新高背离:
  // 1. 标准生产版 (Baseline)
  // 2. 优胜版 (收阴确认方案: requireBearish = true)
  const schemes = [
    { name: '1. 当前生产规则 (Standard Blitz)', requireBearish: false },
    { name: '2. 胜率强化版 (带收阴确认 Blitz)', requireBearish: true },
  ];

  for (const sch of schemes) {
    console.log(`\n========================================================================================`);
    console.log(`🎯 测试方案: ${sch.name}`);
    console.log(`========================================================================================`);

    const signals: any[] = [];
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
        if (!row || row.rank > 10 || row.dayChange < 15) continue;

        const start24h = Math.max(0, i - 1439);
        if (i === 35 || highs[i] > curMax24h) {
          let m = 0;
          for (let k = start24h; k <= i; k++) if (highs[k] > m) m = highs[k];
          curMax24h = m;
        }

        const startX = Math.max(0, i - 4);
        let minLow = Infinity;
        for (let k = startX; k <= i; k++) if (lows[k] < minLow) minLow = lows[k];
        if (minLow <= 0) continue;
        const surge = ((highs[i] - minLow) / minLow) * 100;
        if (surge < row.dayChange / 10.0) continue;

        if (highs[i] < curMax24h) continue;
        if (calculateSupportMaAt(candlesList, i, [3, 7, 15]) !== null) continue;

        const lookStart = Math.max(0, i - 120);
        const lookEnd = Math.max(0, i - 10);
        if (lookEnd <= lookStart) continue;

        let prevIdx = -1;
        let prevMax = 0;
        for (let k = lookStart; k <= lookEnd; k++) {
          if (highs[k] > prevMax) { prevMax = highs[k]; prevIdx = k; }
        }
        if (prevIdx < 0 || prevMax >= highs[i]) continue;
        if (hist[i] >= hist[prevIdx] || dif[i] >= dif[prevIdx] || hist[prevIdx] <= 0) continue;

        if (sch.requireBearish && closes[i] >= opens[i]) continue;

        const entryBar = bars[i + 1];
        signals.push({
          symbol: sym,
          time: t,
          entryTime: entryBar[0],
          entryPrice: entryBar[1],
          dayChange: row.dayChange,
          exitParams: { holdMinutes: 15, exitX: 50, exitN: 1.5, exitM: 3.0 },
        });
      }
    }

    signals.sort((a, b) => a.entryTime - b.entryTime);

    // 过滤防重
    const filtered: any[] = [];
    const occ = new Map<string, number>();
    for (const s of signals) {
      if ((occ.get(s.symbol) ?? -Infinity) <= s.entryTime) {
        filtered.push(s);
        occ.set(s.symbol, s.entryTime + s.exitParams.holdMinutes * 60 * 1000);
      }
    }

    // 运行各杠杆
    const levList = [1, 2, 3, 5, 8, 10, 15];
    const levRows: any[] = [];

    for (const lev of levList) {
      let grossGain = 0;
      let grossLoss = 0;
      let wins = 0;
      let losses = 0;
      let worstLossRoe = 0;
      let bestWinRoe = 0;
      const roes: number[] = [];

      for (const sig of filtered) {
        const bars = minuteData.candles.get(sig.symbol);
        if (!bars) continue;
        const fillIdx = bars.findIndex(b => b[0] === sig.entryTime);
        if (fillIdx < 0) continue;

        const entry = sig.entryPrice;
        const dayChange = sig.dayChange;
        const exitX = sig.exitParams.exitX;
        const exitN = sig.exitParams.exitN;
        const exitM = sig.exitParams.exitM;
        const holdMinutes = sig.exitParams.holdMinutes;

        const tp1 = entry * (1 - (dayChange / exitX) / 100);
        const sl1 = entry * (1 + (dayChange / exitX) / 100);
        const tp2 = entry * (1 - (dayChange * exitM / exitX) / 100);
        const sl2 = entry * (1 + (dayChange * exitN / exitX) / 100);

        let stage1Closed = false;
        let stage2Closed = false;
        let tradeNet = 0;

        for (let step = 0; step < holdMinutes; step++) {
          const b = bars[fillIdx + step];
          if (!b) break;
          const o = b[1];
          const h = b[2];
          const l = b[3];
          const c = b[4];

          if (!stage1Closed) {
            if (h >= sl1) {
              const ret = calcReturn(entry, h, 'stop', { takerFeeBps: 5, slippageBps: 2 });
              tradeNet += ret.netPercent * 0.5;
              stage1Closed = true;
            } else if (l <= tp1) {
              const exitP = o <= tp1 ? o : tp1;
              const ret = calcReturn(entry, exitP, 'target', { takerFeeBps: 5, slippageBps: 2 });
              tradeNet += ret.netPercent * 0.5;
              stage1Closed = true;
            }
          }

          if (stage1Closed && !stage2Closed) {
            if (h >= sl2) {
              const ret = calcReturn(entry, h, 'stop', { takerFeeBps: 5, slippageBps: 2 });
              tradeNet += ret.netPercent * 0.5;
              stage2Closed = true;
              break;
            } else if (l <= tp2) {
              const exitP = o <= tp2 ? o : tp2;
              const ret = calcReturn(entry, exitP, 'target', { takerFeeBps: 5, slippageBps: 2 });
              tradeNet += ret.netPercent * 0.5;
              stage2Closed = true;
              break;
            }
          }

          if (step === holdMinutes - 1) {
            const rem = (!stage1Closed ? 1.0 : !stage2Closed ? 0.5 : 0);
            if (rem > 0) {
              const ret = calcReturn(entry, c, 'timeout', { takerFeeBps: 5, slippageBps: 2 });
              tradeNet += ret.netPercent * rem;
            }
          }
        }

        const unleveragedPct = tradeNet;
        const roe = unleveragedPct * lev;
        roes.push(roe);

        if (roe > 0) {
          wins++;
          grossGain += roe;
          if (roe > bestWinRoe) bestWinRoe = roe;
        } else {
          losses++;
          grossLoss += Math.abs(roe);
          if (roe < worstLossRoe) worstLossRoe = roe;
        }
      }

      const totalPnl = roes.reduce((a, b) => a + b, 0);
      const winRate = filtered.length > 0 ? (wins / filtered.length) * 100 : 0;
      const pf = grossLoss > 0 ? grossGain / grossLoss : Infinity;

      // 模拟 100U 初始资金, 单笔 20U 保证金
      let equity = 100;
      let peak = 100;
      let maxDd = 0;
      for (const roe of roes) {
        equity += 20 * (roe / 100);
        if (equity > peak) peak = equity;
        const dd = ((peak - equity) / peak) * 100;
        if (dd > maxDd) maxDd = dd;
      }

      levRows.push({
        杠杆: `${lev}x`,
        交易数: filtered.length,
        胜率: `${winRate.toFixed(1)}%`,
        盈亏比: pf.toFixed(2),
        总收益率: `${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(1)}%`,
        '账户净收益 (100U本金)': `${equity >= 100 ? '+' : ''}${(equity - 100).toFixed(2)}U`,
        最大回撤: `${maxDd.toFixed(1)}%`,
        平均单笔ROE: `${(totalPnl / filtered.length).toFixed(2)}%`,
        最大单笔赢: `+${bestWinRoe.toFixed(1)}%`,
        最大单笔亏: `${worstLossRoe.toFixed(1)}%`,
      });
    }

    console.table(levRows);
  }
}

main().catch(console.error);
