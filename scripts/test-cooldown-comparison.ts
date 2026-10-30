import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import type { MinuteDataset } from '../research/gainers-types.ts';
import { HOUR } from '../research/types.ts';
import { MINUTE } from '../research/gainers-types.ts';
import { calculateSma } from '../research/peak-rebound-signals.ts';
import { computeMacd, calculateSupportMaAt } from '../src/macd.ts';
import { calcReturn } from '../research/peak-rebound-backtest.ts';

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
          const bars = JSON.parse(gunzipSync(bytes).toString('utf8'));
          candles.set(sym, bars);
        }
      }
    } catch {}
  }

  return {
    manifest: {
      version: 1,
      interval: '1m',
      source: 'Binance',
      fetchedAt: new Date().toISOString(),
      plan: {} as any,
      files: {},
    },
    candles,
  };
}

interface SignalGroupMember {
  id: string;
  name: string;
  category: string;
  tag: string;
  evaluate: (ctx: {
    symbol: string;
    candle: any;
    closes: number[];
    highs: number[];
    lows: number[];
    idx: number;
    hist: number[];
    dif: number[];
    candlesList: any[];
    high24h: number;
    dayChange: number;
    rank: number;
  }) => {
    triggered: boolean;
    surgePercent?: number;
    requiredSurge?: number;
    exitParams: { holdMinutes: number; exitX: number; exitN: number; exitM: number };
  };
}

async function main() {
  const hourly = await loadDataset(path.resolve('data/research/hourly-168h'));
  const frames = buildFrames(hourly, 10, 1);
  const minuteData = await loadAllMinutes();

  const symbolRankMap = new Map<string, Map<number, { rank: number; dayChange: number }>>();
  for (const frame of frames) {
    for (const g of frame.boards.gainers) {
      let m = symbolRankMap.get(g.symbol);
      if (!m) { m = new Map(); symbolRankMap.set(g.symbol, m); }
      m.set(frame.time, { rank: g.rank, dayChange: g.dayChange });
    }
  }

  const getRankInfo = (sym: string, t: number) => {
    const m = symbolRankMap.get(sym);
    if (!m) return null;
    const hourBucket = Math.floor(t / HOUR) * HOUR;
    return m.get(hourBucket) ?? null;
  };

  const members: SignalGroupMember[] = [
    {
      id: 'impulse_extreme_dev',
      name: '脉冲极度乖离空',
      category: '均线偏离因子',
      tag: '【信号组-极度乖离】',
      evaluate: ({ closes, lows, idx, dayChange, rank }) => {
        if (rank > 10 || dayChange < 20) return { triggered: false, exitParams: {} as any };
        const x = 3;
        const n = 3.5;
        const startX = idx - x + 1;
        if (startX < 0) return { triggered: false, exitParams: {} as any };
        let minLow = Infinity;
        for (let k = startX; k <= idx; k++) if (lows[k] < minLow) minLow = lows[k];
        if (minLow <= 0) return { triggered: false, exitParams: {} as any };

        const surge = ((closes[idx] - minLow) / minLow) * 100;
        const reqSurge = dayChange / n;
        if (surge < reqSurge || surge < 4.0) return { triggered: false, exitParams: {} as any };

        const ma30 = calculateSma(closes, idx, 30);
        if (ma30 == null || ((closes[idx] - ma30) / ma30) * 100 < 1.5) {
          return { triggered: false, exitParams: {} as any };
        }

        return {
          triggered: true,
          surgePercent: surge,
          requiredSurge: reqSurge,
          exitParams: { holdMinutes: 20, exitX: 30, exitN: 2.0, exitM: 2.0 },
        };
      },
    },
    {
      id: 'impulse_ath_divergence',
      name: '脉冲新高顶背离空',
      category: 'MACD+均线因子',
      tag: '【信号组-新高背离】',
      evaluate: ({ candle, closes, highs, lows, idx, dayChange, rank, hist, dif, candlesList, high24h }) => {
        if (rank > 10 || dayChange < 15) return { triggered: false, exitParams: {} as any };
        const x = 5;
        const n = 10.0;
        const startX = idx - x + 1;
        if (startX < 0) return { triggered: false, exitParams: {} as any };
        let minLow = Infinity;
        for (let k = startX; k <= idx; k++) if (lows[k] < minLow) minLow = lows[k];
        if (minLow <= 0) return { triggered: false, exitParams: {} as any };

        const surge = ((candle.high - minLow) / minLow) * 100;
        const reqSurge = dayChange / n;
        if (surge < reqSurge) return { triggered: false, exitParams: {} as any };

        if (candle.high < high24h) return { triggered: false, exitParams: {} as any };
        if (calculateSupportMaAt(candlesList, idx, [3, 7, 15]) !== null) {
          return { triggered: false, exitParams: {} as any };
        }

        const start = Math.max(0, idx - 120);
        const end = Math.max(0, idx - 10);
        if (end <= start) return { triggered: false, exitParams: {} as any };
        let prevIdx = -1; let prevMax = 0;
        for (let k = start; k <= end; k++) {
          if (highs[k] > prevMax) { prevMax = highs[k]; prevIdx = k; }
        }
        if (prevIdx < 0 || candle.high < prevMax) return { triggered: false, exitParams: {} as any };
        if (hist[idx] >= hist[prevIdx] || dif[idx] >= dif[prevIdx]) {
          return { triggered: false, exitParams: {} as any };
        }

        return {
          triggered: true,
          surgePercent: surge,
          requiredSurge: reqSurge,
          exitParams: { holdMinutes: 15, exitX: 50, exitN: 1.5, exitM: 3.0 },
        };
      },
    },
    {
      id: 'impulse_trend_ceiling',
      name: '脉冲反抽均线压制空',
      category: '均线趋势因子',
      tag: '【信号组-均线压制】',
      evaluate: ({ candle, closes, highs, lows, idx, dayChange, rank, high24h, hist }) => {
        if (high24h <= 0) return { triggered: false, exitParams: {} as any };
        const drop = ((high24h - closes[idx]) / high24h) * 100;
        if (drop < 20.0) return { triggered: false, exitParams: {} as any };

        const x = 10;
        const n = 4.0;
        const startX = idx - x + 1;
        if (startX < 0) return { triggered: false, exitParams: {} as any };
        let minLow = Infinity;
        for (let k = startX; k <= idx; k++) if (lows[k] < minLow) minLow = lows[k];
        if (minLow <= 0) return { triggered: false, exitParams: {} as any };

        const surge = ((highs[idx] - minLow) / minLow) * 100;
        const reqSurge = Math.max(5.0, dayChange / n);
        if (surge < reqSurge) return { triggered: false, exitParams: {} as any };

        const ma15 = calculateSma(closes, idx, 15);
        const ma30 = calculateSma(closes, idx, 30);
        if (ma15 == null || ma30 == null) return { triggered: false, exitParams: {} as any };
        if (!(ma15 < ma30)) return { triggered: false, exitParams: {} as any };
        if (!(closes[idx] < ma15 && ma15 < highs[idx])) return { triggered: false, exitParams: {} as any };

        if (idx >= 2) {
          const prevMa30 = calculateSma(closes, idx - 2, 30);
          if (prevMa30 != null && ma30 >= prevMa30) return { triggered: false, exitParams: {} as any };
        }

        let greenCount = 0;
        for (let k = Math.max(0, idx - 19); k <= idx; k++) if (hist[k] > 0) greenCount++;
        if (greenCount / 20 < 0.65) return { triggered: false, exitParams: {} as any };

        return {
          triggered: true,
          surgePercent: surge,
          requiredSurge: reqSurge,
          exitParams: { holdMinutes: 30, exitX: 35, exitN: 2.0, exitM: 4.0 },
        };
      },
    },
  ];

  interface SignalEvent {
    member: SignalGroupMember;
    symbol: string;
    time: number;
    entryPrice: number;
    dayChange: number;
    surgePercent: number;
    requiredSurge: number;
    exitParams: any;
  }

  const allEvents: SignalEvent[] = [];

  for (const [sym, bars] of minuteData.candles) {
    if (!bars || bars.length < 65) continue;
    const opens = bars.map(b => b[1]);
    const highs = bars.map(b => b[2]);
    const lows = bars.map(b => b[3]);
    const closes = bars.map(b => b[4]);
    const times = bars.map(b => b[0]);

    const { hist, dif } = computeMacd(closes);
    const candlesList = bars.map(b => ({ time: b[0], open: b[1], high: b[2], low: b[3], close: b[4], volume: b[5] }));

    for (let i = 35; i < bars.length - 1; i++) {
      const t = times[i];
      const row = getRankInfo(sym, t);
      if (!row || row.dayChange <= 0) continue;

      let curMax24h = 0;
      if (i >= 30) {
        const start24h = Math.max(0, i - 1439);
        let m = 0;
        for (let k = start24h; k <= i; k++) if (highs[k] > m) m = highs[k];
        curMax24h = m;
      }

      const candleObj = { open: opens[i], high: highs[i], low: lows[i], close: closes[i], time: times[i] };

      for (const member of members) {
        const res = member.evaluate({
          symbol: sym,
          candle: candleObj,
          closes,
          highs,
          lows,
          idx: i,
          hist,
          dif,
          candlesList,
          high24h: curMax24h,
          dayChange: row.dayChange,
          rank: row.rank,
        });

        if (res.triggered) {
          const nextBar = bars[i + 1];
          if (!nextBar) continue;
          allEvents.push({
            member,
            symbol: sym,
            time: nextBar[0],
            entryPrice: nextBar[1],
            dayChange: row.dayChange,
            surgePercent: res.surgePercent ?? 0,
            requiredSurge: res.requiredSurge ?? 0,
            exitParams: res.exitParams,
          });
          break;
        }
      }
    }
  }

  allEvents.sort((a, b) => a.time - b.time);

  function runBacktest(mode: 'none' | 'all20' | 'lossOnly20') {
    const occupiedUntil = new Map<string, number>();
    const cooldownUntil = new Map<string, number>();

    const executedTrades: any[] = [];
    let blockedConflicts = 0;

    for (const ev of allEvents) {
      if ((occupiedUntil.get(ev.symbol) ?? -Infinity) > ev.time) {
        blockedConflicts++;
        continue;
      }
      if (mode !== 'none' && (cooldownUntil.get(ev.symbol) ?? -Infinity) > ev.time) {
        blockedConflicts++;
        continue;
      }

      const bars = minuteData.candles.get(ev.symbol);
      if (!bars) continue;

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
      let finalExitPrice = entry;

      for (let step = 0; step < holdMinutes; step++) {
        const b = bars[fillIdx + step];
        if (!b) break;
        const h = b[2];
        const l = b[3];
        const c = b[4];

        if (!stage1Closed) {
          if (h >= sl1) {
            tradeNet += calcReturn(entry, sl1, 'stop').netPercent * 0.5;
            stage1Closed = true;
            reason1 = 'stop';
          } else if (l <= tp1) {
            tradeNet += calcReturn(entry, tp1, 'target').netPercent * 0.5;
            stage1Closed = true;
            reason1 = 'target';
          }
        }

        if (stage1Closed && !stage2Closed) {
          if (h >= sl2) {
            tradeNet += calcReturn(entry, sl2, 'stop').netPercent * 0.5;
            stage2Closed = true;
            reason2 = 'stop';
            exitTime = b[0];
            finalExitPrice = sl2;
            break;
          } else if (l <= tp2) {
            tradeNet += calcReturn(entry, tp2, 'target').netPercent * 0.5;
            stage2Closed = true;
            reason2 = 'target';
            exitTime = b[0];
            finalExitPrice = tp2;
            break;
          }
        }

        if (step === holdMinutes - 1) {
          const rem = (!stage1Closed ? 1.0 : !stage2Closed ? 0.5 : 0);
          if (rem > 0) {
            tradeNet += calcReturn(entry, c, 'timeout').netPercent * rem;
          }
          exitTime = b[0];
          finalExitPrice = c;
        }
      }

      occupiedUntil.set(ev.symbol, exitTime);
      if (mode === 'all20') {
        cooldownUntil.set(ev.symbol, Math.max(exitTime, ev.time + 20 * MINUTE));
      } else if (mode === 'lossOnly20' && tradeNet <= 0) {
        cooldownUntil.set(ev.symbol, Math.max(exitTime, ev.time + 20 * MINUTE));
      }

      executedTrades.push({
        member: ev.member,
        symbol: ev.symbol,
        entryTime: ev.time,
        entryPrice: entry,
        exitTime,
        exitPrice: finalExitPrice,
        dayChange: ev.dayChange,
        surgePercent: ev.surgePercent,
        duration: Math.round((exitTime - ev.time) / MINUTE),
        netPercent: tradeNet,
        reasons: `${reason1}/${reason2}`,
      });
    }

    const wins = executedTrades.filter(t => t.netPercent > 0);
    const losses = executedTrades.filter(t => t.netPercent < 0);
    const totalTrades = executedTrades.length;
    const winRate = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;
    const totalProfit = wins.reduce((s, t) => s + t.netPercent, 0);
    const totalLoss = Math.abs(losses.reduce((s, t) => s + t.netPercent, 0));
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;
    const netPnL = executedTrades.reduce((s, t) => s + t.netPercent, 0);

    let peak = 0;
    let dd = 0;
    let maxDd = 0;
    let running = 0;
    for (const t of executedTrades) {
      running += t.netPercent;
      if (running > peak) peak = running;
      dd = peak - running;
      if (dd > maxDd) maxDd = dd;
    }

    return {
      mode,
      totalTrades,
      blockedConflicts,
      wins: wins.length,
      losses: losses.length,
      winRate,
      profitFactor,
      netPnL,
      maxDd,
      executedTrades,
    };
  }

  console.log('\n' + '='.repeat(90));
  console.log('💡【冷却策略变体对比】：无冷却 vs 止损后冷却 20m vs 每笔均冷却 20m');
  console.log('='.repeat(90));

  const rNone = runBacktest('none');
  const rLossOnly = runBacktest('lossOnly20');
  const rAll = runBacktest('all20');

  const rows = [
    { name: '1. 完全关掉冷却 (0m)', r: rNone },
    { name: '2. 仅止损/亏损后冷却 20m', r: rLossOnly },
    { name: '3. 每笔均冷却 20m (当前默认)', r: rAll },
  ];

  console.log('| 策略模式 | 成交笔数 | 胜率 (%) | 盈亏比 (PF) | 累计净收益 (%) | 最大回撤 (%) |');
  console.log('| :--- | :---: | :---: | :---: | :---: | :---: |');
  for (const row of rows) {
    console.log(
      `| ${row.name.padEnd(25)} | ${String(row.r.totalTrades).padStart(8)} | ${row.r.winRate.toFixed(1).padStart(7)}% | ${row.r.profitFactor.toFixed(2).padStart(11)} | ${(row.r.netPnL >= 0 ? '+' : '') + row.r.netPnL.toFixed(2) + '%'} | ${row.r.maxDd.toFixed(2)}% |`
    );
  }
}

main().catch(console.error);
