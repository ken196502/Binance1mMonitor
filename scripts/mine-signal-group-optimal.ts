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

interface TestVariant {
  category: string;
  name: string;
  x: number;
  n: number;
  minDayChange: number;
  minSurge: number;
  check: (ctx: {
    candle: any;
    closes: number[];
    highs: number[];
    lows: number[];
    idx: number;
    hist: number[];
    dif: number[];
    candlesList: any[];
    high24h: number;
  }) => boolean;
  holdMinutes: number;
  exitX: number;
  exitN: number;
  exitM: number;
}

async function main() {
  const hourly = await loadDataset(path.resolve('data/research/hourly-168h'));
  const frames = buildFrames(hourly, 10, 1);
  const minuteData = await loadAllMinutes();

  const boards = new Map<number, Map<string, { rank: number; dayChange: number }>>();
  for (const frame of frames) {
    const symbolMap = new Map<string, { rank: number; dayChange: number }>();
    for (const obs of frame.boards.gainers) {
      symbolMap.set(obs.symbol, { rank: obs.rank, dayChange: obs.dayChange });
    }
    boards.set(frame.time, symbolMap);
  }

  const variants: TestVariant[] = [
    // 类别 A: 冲高 + 均线乖离族 (MA Extension)
    {
      category: '均线乖离',
      name: 'A1: 3m≥24h/3.5 + MA30乖离≥1.5%',
      x: 3, n: 3.5, minDayChange: 20, minSurge: 4.0,
      check: ({ closes, idx }) => {
        const ma30 = calculateSma(closes, idx, 30);
        return ma30 != null && ((closes[idx] - ma30) / ma30) * 100 >= 1.5;
      },
      holdMinutes: 20, exitX: 30, exitN: 2.0, exitM: 2.0,
    },
    {
      category: '均线乖离',
      name: 'A2: 5m≥24h/3.0 + MA30乖离≥1.5%',
      x: 5, n: 3.0, minDayChange: 20, minSurge: 4.0,
      check: ({ closes, idx }) => {
        const ma30 = calculateSma(closes, idx, 30);
        return ma30 != null && ((closes[idx] - ma30) / ma30) * 100 >= 1.5;
      },
      holdMinutes: 20, exitX: 30, exitN: 2.0, exitM: 2.0,
    },
    {
      category: '均线乖离',
      name: 'A3: 10m≥24h/3.0 + MA30乖离≥1.5%',
      x: 10, n: 3.0, minDayChange: 20, minSurge: 4.0,
      check: ({ closes, idx }) => {
        const ma30 = calculateSma(closes, idx, 30);
        return ma30 != null && ((closes[idx] - ma30) / ma30) * 100 >= 1.5;
      },
      holdMinutes: 25, exitX: 30, exitN: 2.0, exitM: 2.0,
    },

    // 类别 B: 冲高 + 均线悬空 + 动能背离 (MA Suspension + MACD Divergence)
    {
      category: '顶背离',
      name: 'B1: 5m≥24h/6.0 + 创24h新高 + MACD顶背离 + MA悬空',
      x: 5, n: 6.0, minDayChange: 15, minSurge: 3.5,
      check: ({ candle, highs, idx, hist, dif, candlesList, high24h }) => {
        if (candle.high < high24h) return false;
        if (calculateSupportMaAt(candlesList, idx, [3, 7, 15]) !== null) return false;
        const start = Math.max(0, idx - 120);
        const end = Math.max(0, idx - 10);
        if (end <= start) return false;
        let prevIdx = -1; let prevMax = 0;
        for (let k = start; k <= end; k++) {
          if (highs[k] > prevMax) { prevMax = highs[k]; prevIdx = k; }
        }
        if (prevIdx < 0 || candle.high < prevMax) return false;
        return hist[idx] < hist[prevIdx] && dif[idx] < dif[prevIdx];
      },
      holdMinutes: 15, exitX: 50, exitN: 1.5, exitM: 3.0,
    },
    {
      category: '顶背离',
      name: 'B2: 5m≥24h/8.0 + 创局部新高(30m) + MACD顶背离',
      x: 5, n: 8.0, minDayChange: 15, minSurge: 3.0,
      check: ({ candle, highs, idx, hist, dif }) => {
        const start = Math.max(0, idx - 60);
        const end = Math.max(0, idx - 8);
        if (end <= start) return false;
        let prevIdx = -1; let prevMax = 0;
        for (let k = start; k <= end; k++) {
          if (highs[k] > prevMax) { prevMax = highs[k]; prevIdx = k; }
        }
        if (prevIdx < 0 || candle.high < prevMax) return false;
        return hist[idx] < hist[prevIdx] && dif[idx] < dif[prevIdx];
      },
      holdMinutes: 15, exitX: 35, exitN: 2.0, exitM: 2.0,
    },

    // 类别 C: 冲高 + MACD 动能拐头衰竭 (MACD Histogram Rollover)
    {
      category: '动能拐头',
      name: 'C1: 5m≥24h/4.0 + MACD柱拐头下倾 (Hist[i]<Hist[i-1])',
      x: 5, n: 4.0, minDayChange: 15, minSurge: 3.5,
      check: ({ idx, hist }) => {
        if (idx < 2) return false;
        return hist[idx] < hist[idx - 1] && hist[idx - 1] > hist[idx - 2] && hist[idx - 1] > 0;
      },
      holdMinutes: 20, exitX: 35, exitN: 2.0, exitM: 2.0,
    },
    {
      category: '动能拐头',
      name: 'C2: 5m≥24h/4.0 + MACD柱拐头 + 刺破MA5收回 (Close<MA5<High)',
      x: 5, n: 4.0, minDayChange: 15, minSurge: 3.5,
      check: ({ candle, closes, highs, idx, hist }) => {
        if (idx < 2) return false;
        if (!(hist[idx] < hist[idx - 1] && hist[idx - 1] > 0)) return false;
        const ma5 = calculateSma(closes, idx, 5);
        return ma5 != null && candle.close < ma5 && highs[idx] > ma5;
      },
      holdMinutes: 20, exitX: 35, exitN: 2.0, exitM: 2.0,
    },
    {
      category: '动能拐头',
      name: 'C3: 3m≥24h/3.5 + MACD柱拐头 + 收阴确认 (Close<Open)',
      x: 3, n: 3.5, minDayChange: 20, minSurge: 4.0,
      check: ({ candle, idx, hist }) => {
        if (idx < 2) return false;
        if (!(hist[idx] < hist[idx - 1] && hist[idx - 1] > 0)) return false;
        return candle.close < candle.open;
      },
      holdMinutes: 20, exitX: 30, exitN: 2.0, exitM: 2.0,
    },

    // 类别 D: 冲高 + 均线压制阻击 (MA Resistance & Rejection)
    {
      category: '均线压制',
      name: 'D1: 5m≥24h/4.0 + MA15天花板压制 (Close<MA15<High)',
      x: 5, n: 4.0, minDayChange: 15, minSurge: 3.5,
      check: ({ candle, closes, highs, idx }) => {
        const ma15 = calculateSma(closes, idx, 15);
        return ma15 != null && candle.close < ma15 && highs[idx] > ma15;
      },
      holdMinutes: 20, exitX: 35, exitN: 2.0, exitM: 2.0,
    },
    {
      category: '均线压制',
      name: 'D2: 10m≥24h/4.0 + MA30天花板压制 (Close<MA30<High)',
      x: 10, n: 4.0, minDayChange: 15, minSurge: 3.5,
      check: ({ candle, closes, highs, idx }) => {
        const ma30 = calculateSma(closes, idx, 30);
        return ma30 != null && candle.close < ma30 && highs[idx] > ma30;
      },
      holdMinutes: 30, exitX: 35, exitN: 2.0, exitM: 3.0,
    },
    {
      category: '均线压制',
      name: 'D3: 5m≥24h/4.0 + MA15<MA30空头排列 + MA15压制',
      x: 5, n: 4.0, minDayChange: 15, minSurge: 3.5,
      check: ({ candle, closes, highs, idx }) => {
        const ma15 = calculateSma(closes, idx, 15);
        const ma30 = calculateSma(closes, idx, 30);
        if (ma15 == null || ma30 == null) return false;
        return ma15 < ma30 && candle.close < ma15 && highs[idx] > ma15;
      },
      holdMinutes: 25, exitX: 35, exitN: 2.0, exitM: 2.5,
    },
  ];

  interface Res {
    category: string;
    name: string;
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
    pf: number | null;
    netPnl: number;
    maxDd: number;
  }

  const results: Res[] = [];

  for (const cand of variants) {
    const occupied = new Map<string, number>();
    let tradeCount = 0;
    let wins = 0;
    let losses = 0;
    let grossWins = 0;
    let grossLoss = 0;
    let totalNet = 0;
    let cumPnl = 0;
    let peakEquity = 0;
    let maxDd = 0;

    for (const [sym, bars] of minuteData.candles) {
      if (!bars || bars.length < 65) continue;
      const opens = bars.map(b => b[1]);
      const highs = bars.map(b => b[2]);
      const lows = bars.map(b => b[3]);
      const closes = bars.map(b => b[4]);
      const times = bars.map(b => b[0]);
      const { hist, dif } = computeMacd(closes);
      const candlesList = bars.map(b => ({ time: b[0], open: b[1], high: b[2], low: b[3], close: b[4] }));

      let cooldown = 0;
      let curMax24h = 0;

      for (let i = 35; i < bars.length - 1; i++) {
        const t = times[i];
        if (t < cooldown) continue;

        const bTime = Math.floor(t / HOUR) * HOUR;
        const row = boards.get(bTime)?.get(sym);
        if (!row || row.rank > 10 || row.dayChange < cand.minDayChange) continue;

        const start24h = Math.max(0, i - 1439);
        if (i === 35 || highs[i] > curMax24h) {
          let m = 0;
          for (let k = start24h; k <= i; k++) if (highs[k] > m) m = highs[k];
          curMax24h = m;
        }

        const startX = i - cand.x + 1;
        if (startX < 0) continue;
        let minLow = Infinity;
        for (let k = startX; k <= i; k++) if (lows[k] < minLow) minLow = lows[k];
        if (minLow <= 0) continue;

        const surge = ((closes[i] - minLow) / minLow) * 100;
        const reqSurge = row.dayChange / cand.n;
        if (surge < reqSurge || surge < cand.minSurge) continue;

        const candleObj = { open: opens[i], high: highs[i], low: lows[i], close: closes[i], time: times[i] };
        const pass = cand.check({
          candle: candleObj,
          closes,
          highs,
          lows,
          idx: i,
          hist,
          dif,
          candlesList,
          high24h: curMax24h,
        });
        if (!pass) continue;

        const nextBar = bars[i + 1];
        if (!nextBar) continue;
        const entryPrice = nextBar[1];
        const entryTime = nextBar[0];

        if ((occupied.get(sym) ?? -Infinity) > entryTime) continue;

        tradeCount++;
        const dayChange = Math.max(10, row.dayChange);
        const tp1 = entryPrice * (1 - (dayChange / cand.exitX) / 100);
        const sl1 = entryPrice * (1 + (dayChange / cand.exitX) / 100);
        const tp2 = entryPrice * (1 - (dayChange * cand.exitM / cand.exitX) / 100);
        const sl2 = entryPrice * (1 + (dayChange * cand.exitN / cand.exitX) / 100);

        let stage1Closed = false;
        let stage2Closed = false;
        let tradeNet = 0;
        let exitTime = entryTime + cand.holdMinutes * MINUTE;

        for (let step = 0; step < cand.holdMinutes; step++) {
          const bar = bars[i + 1 + step];
          if (!bar) break;
          const h = bar[2];
          const l = bar[3];
          const c = bar[4];

          if (!stage1Closed) {
            if (h >= sl1) {
              tradeNet += calcReturn(entryPrice, sl1, 'stop').netPercent * 0.5;
              stage1Closed = true;
            } else if (l <= tp1) {
              tradeNet += calcReturn(entryPrice, tp1, 'target').netPercent * 0.5;
              stage1Closed = true;
            }
          }

          if (stage1Closed && !stage2Closed) {
            if (h >= sl2) {
              tradeNet += calcReturn(entryPrice, sl2, 'stop').netPercent * 0.5;
              stage2Closed = true;
              exitTime = bar[0];
              break;
            } else if (l <= tp2) {
              tradeNet += calcReturn(entryPrice, tp2, 'target').netPercent * 0.5;
              stage2Closed = true;
              exitTime = bar[0];
              break;
            }
          }

          if (step === cand.holdMinutes - 1) {
            const rem = (!stage1Closed ? 1.0 : !stage2Closed ? 0.5 : 0);
            if (rem > 0) {
              tradeNet += calcReturn(entryPrice, c, 'timeout').netPercent * rem;
            }
            exitTime = bar[0];
          }
        }

        occupied.set(sym, exitTime);
        cooldown = t + 20 * MINUTE;

        if (tradeNet > 0) {
          wins++;
          grossWins += tradeNet;
        } else {
          losses++;
          grossLoss += Math.abs(tradeNet);
        }
        totalNet += tradeNet;
        cumPnl += tradeNet;
        if (cumPnl > peakEquity) peakEquity = cumPnl;
        const dd = peakEquity - cumPnl;
        if (dd > maxDd) maxDd = dd;
      }
    }

    const winRate = tradeCount ? (wins / tradeCount) * 100 : 0;
    const pf = grossLoss > 0 ? grossWins / grossLoss : Infinity;
    results.push({
      category: cand.category,
      name: cand.name,
      trades: tradeCount,
      wins,
      losses,
      winRate,
      pf,
      netPnl: totalNet,
      maxDd,
    });
  }

  results.sort((a, b) => b.winRate - a.winRate || (b.pf ?? 0) - (a.pf ?? 0));

  console.log('| 因子类别 | 子策略名称与因子组合 | 交易笔数 | 战绩(胜/负) | 胜率(%) | 盈亏比(PF) | 累计净收益(%) | 最大回撤(%) |');
  console.log('| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |');
  for (const r of results) {
    console.log(
      `| ${r.category.padEnd(8)} | ${r.name.padEnd(46)} | ${r.trades.toString().padStart(8)} | ${(r.wins + '胜' + r.losses + '负').padStart(9)} | ${r.winRate.toFixed(1)}% | ${r.pf ? r.pf.toFixed(2) : '∞'} | +${r.netPnl.toFixed(2)}% | ${r.maxDd.toFixed(2)}% |`,
    );
  }
}

main().catch(console.error);
