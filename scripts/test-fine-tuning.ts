import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import type { MinuteDataset } from '../research/gainers-types.ts';
import { computeMacd, calculateSma } from '../src/macd.ts';
import { runSimulation, FilterConfig } from './test-improve-hourly-winrate.ts';

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
  const hourly = await loadDataset(path.resolve('data/research/hourly-168h'));
  const frames = buildFrames(hourly, 10, 1);
  const minuteData = await loadAllMinutes();

  const fineTuningCases: FilterConfig[] = [
    // 1. 基准
    {
      name: '基准: 10m, TP 1.5/3.0, SL 2.5',
      holdMinutes: 10,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      topN: 10,
      minDayChange: 10,
    },
    // 2. 纯调整 TP1 阶梯 (10m 持仓)
    {
      name: 'TP1 梯队: TP 1.3 / 2.8, SL 2.5',
      holdMinutes: 10,
      tp1: 1.3,
      tp2: 2.8,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      topN: 10,
      minDayChange: 10,
    },
    {
      name: 'TP1 梯队: TP 1.2 / 2.5, SL 2.5',
      holdMinutes: 10,
      tp1: 1.2,
      tp2: 2.5,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      topN: 10,
      minDayChange: 10,
    },
    {
      name: 'TP1 梯队: TP 1.1 / 2.5, SL 2.5',
      holdMinutes: 10,
      tp1: 1.1,
      tp2: 2.5,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      topN: 10,
      minDayChange: 10,
    },

    // 3. 收在 MA60 下 + MA 下倾 + TP 梯度
    {
      name: 'MA压制+下倾: TP 1.5 / 3.0, SL 2.5',
      holdMinutes: 10,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      topN: 10,
      minDayChange: 10,
      requireCloseBelowMa: true,
      requireMaSlopeDown: true,
    },
    {
      name: 'MA压制+下倾: TP 1.3 / 2.8, SL 2.5',
      holdMinutes: 10,
      tp1: 1.3,
      tp2: 2.8,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      topN: 10,
      minDayChange: 10,
      requireCloseBelowMa: true,
      requireMaSlopeDown: true,
    },
    {
      name: 'MA压制+下倾: TP 1.2 / 2.5, SL 2.5',
      holdMinutes: 10,
      tp1: 1.2,
      tp2: 2.5,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      topN: 10,
      minDayChange: 10,
      requireCloseBelowMa: true,
      requireMaSlopeDown: true,
    },
    {
      name: 'MA压制+下倾: TP 1.0 / 2.2, SL 2.5',
      holdMinutes: 10,
      tp1: 1.0,
      tp2: 2.2,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      topN: 10,
      minDayChange: 10,
      requireCloseBelowMa: true,
      requireMaSlopeDown: true,
    },

    // 4. MA压制+下倾 + Top 5 榜单
    {
      name: 'MA压制+下倾 + Top 5: TP 1.2 / 2.5, SL 2.5',
      holdMinutes: 10,
      tp1: 1.2,
      tp2: 2.5,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      topN: 5,
      minDayChange: 10,
      requireCloseBelowMa: true,
      requireMaSlopeDown: true,
    },
    {
      name: 'MA压制+下倾 + Top 5: TP 1.5 / 3.0, SL 2.5',
      holdMinutes: 10,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      topN: 5,
      minDayChange: 10,
      requireCloseBelowMa: true,
      requireMaSlopeDown: true,
    },

    // 5. 3m 急冲 + MA 压制 + 下倾
    {
      name: '3m急冲 + MA压制+下倾: TP 1.2 / 2.5, SL 2.5',
      holdMinutes: 10,
      tp1: 1.2,
      tp2: 2.5,
      sl: 2.5,
      xMinutes: 3,
      ampDivisor: 10,
      nGreenBars: 3,
      topN: 10,
      minDayChange: 10,
      requireCloseBelowMa: true,
      requireMaSlopeDown: true,
    },
    {
      name: '3m急冲 + MA压制+下倾: TP 1.3 / 2.8, SL 2.5',
      holdMinutes: 10,
      tp1: 1.3,
      tp2: 2.8,
      sl: 2.5,
      xMinutes: 3,
      ampDivisor: 10,
      nGreenBars: 3,
      topN: 10,
      minDayChange: 10,
      requireCloseBelowMa: true,
      requireMaSlopeDown: true,
    },

    // 6. 12m 持仓微调对比
    {
      name: 'MA压制+下倾 + 12m持仓: TP 1.3 / 2.8, SL 2.5',
      holdMinutes: 12,
      tp1: 1.3,
      tp2: 2.8,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      topN: 10,
      minDayChange: 10,
      requireCloseBelowMa: true,
      requireMaSlopeDown: true,
    },
    {
      name: 'MA压制+下倾 + 12m持仓: TP 1.5 / 3.0, SL 2.5',
      holdMinutes: 12,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      topN: 10,
      minDayChange: 10,
      requireCloseBelowMa: true,
      requireMaSlopeDown: true,
    },
  ];

  console.log('='.repeat(95));
  console.log('🎯 精细调优验证');
  console.log('='.repeat(95));

  for (const tc of fineTuningCases) {
    const res = runSimulation(minuteData, frames, tc);
    const pnlSign = res.totalNet >= 0 ? '+' : '';
    console.log(
      `${res.name.padEnd(48)} | 交易: ${String(res.trades).padStart(3)}笔 | 胜率: ${res.winRate.toFixed(1).padStart(5)}% (${String(res.wins).padStart(2)}胜/${String(res.losses).padStart(2)}负) | PF: ${res.pf.toFixed(2)} | 净盈亏: ${(pnlSign + res.totalNet.toFixed(1) + '%').padStart(6)} | TP1: ${String(res.tp1Hits).padStart(2)} | SL: ${String(res.slHits).padStart(2)} | 超时: ${String(res.timeouts).padStart(2)} | 均持: ${res.avgDuration.toFixed(1)}m`
    );
  }
}

main().catch(console.error);
