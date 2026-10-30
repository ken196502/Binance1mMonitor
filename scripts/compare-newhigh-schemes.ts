import path from 'node:path';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import { planWatchlistMinutes, loadWatchlistMinutes } from '../research/peak-rebound-data.ts';
import { calculateSupportMaAt, computeMacd } from '../src/macd.ts';
import { calcReturn } from '../research/peak-rebound-backtest.ts';
import { HOUR } from '../research/types.ts';
import { MINUTE } from '../research/gainers-types.ts';

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

  interface Scheme {
    id: string;
    name: string;
    desc: string;
    requireBearish: boolean;
    lookbackMax: number;
    maxLowerShadowPct: number;
    exitX: number;
    exitN: number;
    exitM: number;
    holdMinutes: number;
  }

  const schemes: Scheme[] = [
    {
      id: 'baseline',
      name: '原版策略 (Baseline)',
      desc: '无K线阴阳过滤，回溯 120 根',
      requireBearish: false,
      lookbackMax: 120,
      maxLowerShadowPct: 999,
      exitX: 50,
      exitN: 1.5,
      exitM: 3.0,
      holdMinutes: 15,
    },
    {
      id: 'optimized',
      name: '改进策略 A (推荐方案: 收阴假突破 + 紧邻背离)',
      desc: '要求信号K收阴确认假突破，限制背离窗口在 20 根K线内',
      requireBearish: true,
      lookbackMax: 20,
      maxLowerShadowPct: 999,
      exitX: 50,
      exitN: 1.5,
      exitM: 3.0,
      holdMinutes: 15,
    },
    {
      id: 'conservative',
      name: '改进策略 B (极度保守方案: 收阴 + 紧邻 + 无长下影)',
      desc: '收阴 + 背离<=20 + 下影线<1.5% (杜绝抄底买盘强硬托底)',
      requireBearish: true,
      lookbackMax: 20,
      maxLowerShadowPct: 1.5,
      exitX: 50,
      exitN: 1.5,
      exitM: 3.0,
      holdMinutes: 15,
    },
  ];

  function evaluateScheme(scheme: Scheme, stopAtHigh: boolean) {
    const events: any[] = [];

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

        // 下影线过滤
        const lowerShadow = Math.min(closes[i], opens[i]) - lows[i];
        const lowerShadowPct = (lowerShadow / opens[i]) * 100;
        if (lowerShadowPct > scheme.maxLowerShadowPct) continue;

        // 阴线过滤
        if (scheme.requireBearish && closes[i] >= opens[i]) continue;

        // MACD 双重顶背离
        const lookStart = Math.max(0, i - scheme.lookbackMax);
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
          exitParams: { holdMinutes: scheme.holdMinutes, exitX: scheme.exitX, exitN: scheme.exitN, exitM: scheme.exitM },
        });
      }
    }

    events.sort((a, b) => a.time - b.time);

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
          } else if (l <= tp1) {
            const exitP = o <= tp1 ? o : tp1;
            const ret = calcReturn(entry, exitP, 'target', { takerFeeBps: 5, slippageBps: 2 });
            tradeNet += ret.netPercent * 0.5;
            stage1Closed = true;
            reason1 = 'target';
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
            break;
          } else if (l <= tp2) {
            const exitP = o <= tp2 ? o : tp2;
            const ret = calcReturn(entry, exitP, 'target', { takerFeeBps: 5, slippageBps: 2 });
            tradeNet += ret.netPercent * 0.5;
            stage2Closed = true;
            reason2 = 'target';
            exitTime = b[0];
            break;
          }
        }

        if (step === holdMinutes - 1) {
          const rem = (!stage1Closed ? 1.0 : !stage2Closed ? 0.5 : 0);
          if (rem > 0) {
            const ret = calcReturn(entry, c, 'timeout', { takerFeeBps: 5, slippageBps: 2 });
            tradeNet += ret.netPercent * rem;
          }
          exitTime = b[0];
        }
      }

      occupiedUntil.set(ev.symbol, exitTime + 20 * MINUTE);
      trades.push({
        symbol: ev.symbol,
        time: new Date(ev.time).toISOString().slice(5, 16),
        netPercent: tradeNet,
        reasons: `${reason1}/${reason2}`,
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

  console.log('========================================================================================');
  console.log('🏆【新高空 (新高顶背离)】全方案回测对比总结表 (168h 全市场实测)');
  console.log('========================================================================================');
  console.log('方案名称                     | 止损模式     | 交易数 | 战绩(胜/负) | 胜率    | 累计净收益 | 盈利因子(PF) | 盈亏比(RR)');
  console.log('----------------------------------------------------------------------------------------');

  for (const s of schemes) {
    const std = evaluateScheme(s, false);
    const ext = evaluateScheme(s, true);

    const padS = (str: string, len: number) => str.padEnd(len);
    const padN = (num: number, len: number) => num.toString().padStart(len);

    console.log(
      `${padS(s.name, 28)} | 标准止损     | ${padN(std.trades.length, 6)} | ${(std.wins + '胜' + std.losses + '负').padStart(11)} | ${(std.winRate.toFixed(1) + '%').padStart(7)} | ${(std.totalNet >= 0 ? '+' : '') + std.totalNet.toFixed(2) + '%'}`.padEnd(72) +
      `| ${std.profitFactor.toFixed(2).padStart(12)} | ${std.rr.toFixed(2).padStart(10)}`
    );
    console.log(
      `${padS('  ↳ ' + s.desc, 28)} | 极端最高点   | ${padN(ext.trades.length, 6)} | ${(ext.wins + '胜' + ext.losses + '负').padStart(11)} | ${(ext.winRate.toFixed(1) + '%').padStart(7)} | ${(ext.totalNet >= 0 ? '+' : '') + ext.totalNet.toFixed(2) + '%'}`.padEnd(72) +
      `| ${(ext.profitFactor === Infinity ? '∞' : ext.profitFactor.toFixed(2)).padStart(12)} | ${(ext.rr === Infinity ? '∞' : ext.rr.toFixed(2)).padStart(10)}`
    );
    console.log('----------------------------------------------------------------------------------------');
  }
}

main().catch(console.error);
