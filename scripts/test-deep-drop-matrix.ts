import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import type { MinuteDataset } from '../research/gainers-types.ts';
import { runDropSim, SimConfig } from './test-drop-from-24h-high.ts';

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

  console.log('='.repeat(105));
  console.log('🔬【深度跌幅挖掘】测试 24h 高点回撤 10% ~ 20% 下各种持仓时长与止盈止损矩阵');
  console.log('='.repeat(105));

  const deepTests: SimConfig[] = [
    // 跌幅 >= 8% (平衡样本量与质量)
    {
      name: '跌幅 >= 8% | 10m持仓 | TP 1.5/3.0, SL 2.5',
      holdMinutes: 10,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      minDropFrom24h: 8,
    },
    {
      name: '跌幅 >= 8% | 10m持仓 | TP 1.2/2.5, SL 2.5',
      holdMinutes: 10,
      tp1: 1.2,
      tp2: 2.5,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      minDropFrom24h: 8,
    },
    {
      name: '跌幅 >= 8% | 15m持仓 | TP 1.5/3.5, SL 2.5',
      holdMinutes: 15,
      tp1: 1.5,
      tp2: 3.5,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      minDropFrom24h: 8,
    },

    // 跌幅 >= 12%
    {
      name: '跌幅 >= 12% | 10m持仓 | TP 1.5/3.0, SL 2.5',
      holdMinutes: 10,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      minDropFrom24h: 12,
    },
    {
      name: '跌幅 >= 12% | 10m持仓 | TP 1.2/2.5, SL 2.5',
      holdMinutes: 10,
      tp1: 1.2,
      tp2: 2.5,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      minDropFrom24h: 12,
    },
    {
      name: '跌幅 >= 12% | 15m持仓 | TP 2.0/4.0, SL 3.0',
      holdMinutes: 15,
      tp1: 2.0,
      tp2: 4.0,
      sl: 3.0,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      minDropFrom24h: 12,
    },

    // 跌幅 >= 15%
    {
      name: '跌幅 >= 15% | 10m持仓 | TP 1.5/3.0, SL 2.5',
      holdMinutes: 10,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      minDropFrom24h: 15,
    },
    {
      name: '跌幅 >= 15% | 10m持仓 | TP 1.2/2.5, SL 2.5',
      holdMinutes: 10,
      tp1: 1.2,
      tp2: 2.5,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      minDropFrom24h: 15,
    },
    {
      name: '跌幅 >= 15% | 15m持仓 | TP 2.0/4.0, SL 2.5',
      holdMinutes: 15,
      tp1: 2.0,
      tp2: 4.0,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      minDropFrom24h: 15,
    },
    {
      name: '跌幅 >= 15% | 20m持仓 | TP 2.5/5.0, SL 3.5',
      holdMinutes: 20,
      tp1: 2.5,
      tp2: 5.0,
      sl: 3.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      minDropFrom24h: 15,
    },

    // 跌幅 >= 20% (高胜率正收益区间)
    {
      name: '跌幅 >= 20% | 10m持仓 | TP 1.5/3.0, SL 2.5',
      holdMinutes: 10,
      tp1: 1.5,
      tp2: 3.0,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      minDropFrom24h: 20,
    },
    {
      name: '跌幅 >= 20% | 10m持仓 | TP 1.2/2.5, SL 2.5',
      holdMinutes: 10,
      tp1: 1.2,
      tp2: 2.5,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      minDropFrom24h: 20,
    },
    {
      name: '跌幅 >= 20% | 15m持仓 | TP 2.0/4.5, SL 2.5',
      holdMinutes: 15,
      tp1: 2.0,
      tp2: 4.5,
      sl: 2.5,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      minDropFrom24h: 20,
    },
    {
      name: '跌幅 >= 20% | 20m持仓 | TP 2.5/5.0, SL 3.0',
      holdMinutes: 20,
      tp1: 2.5,
      tp2: 5.0,
      sl: 3.0,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      minDropFrom24h: 20,
    },
    {
      name: '跌幅 >= 20% | 30m持仓 | TP 3.0/6.0, SL 4.0',
      holdMinutes: 30,
      tp1: 3.0,
      tp2: 6.0,
      sl: 4.0,
      xMinutes: 5,
      ampDivisor: 10,
      nGreenBars: 3,
      minDropFrom24h: 20,
    },
  ];

  for (const tc of deepTests) {
    const res = runDropSim(minuteData, frames, tc);
    const pnlSign = res.totalNet >= 0 ? '+' : '';
    console.log(
      `${res.name.padEnd(46)} | 交易: ${String(res.trades).padStart(3)}笔 | 胜率: ${res.winRate.toFixed(1).padStart(5)}% (${String(res.wins).padStart(2)}胜/${String(res.losses).padStart(2)}负) | PF: ${res.pf.toFixed(2)} | 净盈亏: ${(pnlSign + res.totalNet.toFixed(1) + '%').padStart(6)} | TP1: ${String(res.tp1Hits).padStart(2)} | SL: ${String(res.slHits).padStart(2)} | 超时: ${String(res.timeouts).padStart(2)} | 均持: ${res.avgDuration.toFixed(1)}m`
    );
  }
}

main().catch(console.error);
