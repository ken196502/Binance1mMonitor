import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import { calculateSma } from '../research/peak-rebound-signals.ts';
import { HOUR } from '../research/types.ts';
import { MINUTE } from '../research/gainers-types.ts';
import { calcReturn } from '../research/peak-rebound-backtest.ts';

async function loadAllMinutes() {
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
  return candles;
}

interface CandleBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface SignalCandidate {
  symbol: string;
  time: number;
  entryPrice: number;
  dayChange: number;
  surge: number;
  requiredSurge: number;
  upperShadow: number;
  maDev: number;
}

async function main() {
  console.log('================================================================');
  console.log('🎯【退出优化】针对 3m~5m 内涨幅 >= 24h / 3~3.5 做空的最优退出参数寻优');
  console.log('================================================================\n');

  const hourly = await loadDataset(path.resolve('data/research/hourly-168h'));
  const frames = buildFrames(hourly, 10, 1);
  const candles = await loadAllMinutes();

  const boards = new Map<number, Map<string, { rank: number; dayChange: number }>>();
  for (const frame of frames) {
    const symbolMap = new Map<string, { rank: number; dayChange: number }>();
    for (const obs of frame.boards.gainers) {
      symbolMap.set(obs.symbol, { rank: obs.rank, dayChange: obs.dayChange });
    }
    boards.set(frame.time, symbolMap);
  }

  // 待测的 3 个黄金信号核心配置:
  // 配置 A: x=3m, N=3.5, 综合衰竭 (乖离>=1.5% + 影线>=15%)
  // 配置 B: x=3m, N=3.5, 极度乖离 (乖离>=2.0%)
  // 配置 C: x=5m, N=3.0, 综合衰竭 (乖离>=1.5% + 影线>=15%)
  const signalConfigs = [
    { id: 'SigA_3m_N3.5_Exhaust', x: 3, n: 3.5, minDev: 1.5, minShadow: 0.15 },
    { id: 'SigB_3m_N3.5_Dev2.0', x: 3, n: 3.5, minDev: 2.0, minShadow: 0 },
    { id: 'SigC_5m_N3.0_Exhaust', x: 5, n: 3.0, minDev: 1.5, minShadow: 0.15 },
  ];

  for (const sc of signalConfigs) {
    console.log(`\n================== 信号配置: ${sc.id} (x=${sc.x}m, N=${sc.n}, MA乖离≥${sc.minDev}%, 影线≥${sc.minShadow * 100}%) ==================`);

    const signals: SignalCandidate[] = [];
    for (const [symbol, bars] of candles) {
      if (!bars || bars.length < 65) continue;
      const opens = bars.map(b => b[1]);
      const highs = bars.map(b => b[2]);
      const lows = bars.map(b => b[3]);
      const closes = bars.map(b => b[4]);
      const times = bars.map(b => b[0]);

      let cooldown = 0;
      for (let i = Math.max(sc.x, 35); i < bars.length - 1; i++) {
        const t = times[i];
        if (t < cooldown) continue;

        const boardTime = Math.floor(t / HOUR) * HOUR;
        const row = boards.get(boardTime)?.get(symbol);
        if (!row || row.rank > 10 || row.dayChange < 10) continue;

        let minLow = Infinity;
        for (let k = i - sc.x + 1; k <= i; k++) {
          if (lows[k] < minLow) minLow = lows[k];
        }

        const curClose = closes[i];
        const curOpen = opens[i];
        const curHigh = highs[i];
        const curLow = lows[i];

        const surge = minLow > 0 ? ((curClose - minLow) / minLow) * 100 : 0;
        const requiredSurge = row.dayChange / sc.n;
        if (surge < requiredSurge) continue;

        const totalRange = curHigh - curLow;
        const upperShadow = totalRange > 0 ? (curHigh - Math.max(curOpen, curClose)) / totalRange : 0;
        if (sc.minShadow > 0 && upperShadow < sc.minShadow) continue;

        const ma30 = calculateSma(closes, i, 30) ?? curClose;
        const maDev = ((curClose - ma30) / ma30) * 100;
        if (sc.minDev > 0 && maDev < sc.minDev) continue;

        const nextBar = bars[i + 1];
        signals.push({
          symbol,
          time: nextBar[0],
          entryPrice: nextBar[1],
          dayChange: row.dayChange,
          surge,
          requiredSurge,
          upperShadow,
          maDev,
        });

        cooldown = t + 20 * MINUTE;
      }
    }

    console.log(`生成有效开仓信号: ${signals.length} 个`);

    // 各种退出策略组合
    const exitTests = [
      // 15 分钟持仓测试
      { hold: 15, x: 25, n: 1.5, m: 1.5, label: '15m持有, X=25, N=1.5, M=1.5 (宽止盈止损)' },
      { hold: 15, x: 35, n: 1.5, m: 1.5, label: '15m持有, X=35, N=1.5, M=1.5' },
      { hold: 15, x: 35, n: 2.0, m: 2.0, label: '15m持有, X=35, N=2.0, M=2.0' },
      { hold: 15, x: 50, n: 1.5, m: 3.0, label: '15m持有, X=50, N=1.5, M=3.0 (连阳悬空同款定制)' },
      // 30 分钟持仓测试
      { hold: 30, x: 35, n: 1.5, m: 1.5, label: '30m持有, X=35, N=1.5, M=1.5 (首次跌10%同款定制)' },
      { hold: 30, x: 35, n: 2.0, m: 2.0, label: '30m持有, X=35, N=2.0, M=2.0' },
      { hold: 30, x: 35, n: 2.0, m: 3.0, label: '30m持有, X=35, N=2.0, M=3.0' },
      { hold: 30, x: 35, n: 2.0, m: 4.0, label: '30m持有, X=35, N=2.0, M=4.0 (跌到20%同款定制)' },
      { hold: 30, x: 50, n: 1.5, m: 3.0, label: '30m持有, X=50, N=1.5, M=3.0' },
      // 45 分钟持仓测试
      { hold: 45, x: 35, n: 2.0, m: 2.0, label: '45m持有, X=35, N=2.0, M=2.0' },
    ];

    console.log('| 退出方案描述 | 交易笔数 | 胜率(%) | 盈亏比(PF) | 累计净收益(%) | 最大回撤(%) | 阶段一盈/损 | 阶段二盈/损 |');
    console.log('| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |');

    for (const et of exitTests) {
      let wins = 0;
      let totalNet = 0;
      let grossWins = 0;
      let grossLoss = 0;
      let cumPnl = 0;
      let peakEquity = 0;
      let maxDd = 0;
      let tradeCount = 0;

      let st1Tp = 0, st1Sl = 0;
      let st2Tp = 0, st2Sl = 0;

      const occupied = new Map<string, number>();

      for (const sig of signals) {
        if ((occupied.get(sig.symbol) ?? -Infinity) > sig.time) continue;

        const bars = candles.get(sig.symbol);
        if (!bars) continue;

        const idx = bars.findIndex(b => b[0] === sig.time);
        if (idx < 0) continue;

        tradeCount++;
        const entry = sig.entryPrice;
        const dayChange = Math.max(10, sig.dayChange);

        const tp1 = entry * (1 - (dayChange / et.x) / 100);
        const sl1 = entry * (1 + (dayChange / et.x) / 100);
        const tp2 = entry * (1 - (dayChange * et.m / et.x) / 100);
        const sl2 = entry * (1 + (dayChange * et.n / et.x) / 100);

        let stage1Closed = false;
        let stage2Closed = false;
        let tradeNet = 0;
        let exitTime = sig.time + et.hold * MINUTE;

        for (let step = 0; step < et.hold; step++) {
          const bar = bars[idx + step];
          if (!bar) break;

          const high = bar[2];
          const low = bar[3];
          const close = bar[4];

          if (!stage1Closed) {
            if (high >= sl1) {
              const ret = calcReturn(entry, sl1, 'stop');
              tradeNet += ret.netPercent * 0.5;
              stage1Closed = true;
              st1Sl++;
            } else if (low <= tp1) {
              const ret = calcReturn(entry, tp1, 'target');
              tradeNet += ret.netPercent * 0.5;
              stage1Closed = true;
              st1Tp++;
            }
          }

          if (stage1Closed && !stage2Closed) {
            if (high >= sl2) {
              const ret = calcReturn(entry, sl2, 'stop');
              tradeNet += ret.netPercent * 0.5;
              stage2Closed = true;
              st2Sl++;
              exitTime = bar[0];
              break;
            } else if (low <= tp2) {
              const ret = calcReturn(entry, tp2, 'target');
              tradeNet += ret.netPercent * 0.5;
              stage2Closed = true;
              st2Tp++;
              exitTime = bar[0];
              break;
            }
          }

          if (step === et.hold - 1) {
            const rem = (!stage1Closed ? 1.0 : !stage2Closed ? 0.5 : 0);
            if (rem > 0) {
              const ret = calcReturn(entry, close, 'timeout');
              tradeNet += ret.netPercent * rem;
            }
            exitTime = bar[0];
          }
        }

        occupied.set(sig.symbol, exitTime);

        if (tradeNet > 0) {
          wins++;
          grossWins += tradeNet;
        } else {
          grossLoss += Math.abs(tradeNet);
        }
        totalNet += tradeNet;

        cumPnl += tradeNet;
        if (cumPnl > peakEquity) peakEquity = cumPnl;
        const dd = peakEquity - cumPnl;
        if (dd > maxDd) maxDd = dd;
      }

      const winRate = tradeCount ? (wins / tradeCount) * 100 : 0;
      const pf = grossLoss > 0 ? grossWins / grossLoss : Infinity;

      console.log(
        `| ${et.label.padEnd(35)} | ${tradeCount.toString().padStart(8)} | ${winRate.toFixed(1)}% | ${pf ? pf.toFixed(2) : '∞'} | ${totalNet.toFixed(2)}% | ${maxDd.toFixed(2)}% | ${(st1Tp + '/' + st1Sl).padStart(11)} | ${(st2Tp + '/' + st2Sl).padStart(11)} |`,
      );
    }
  }
}

main().catch(console.error);
