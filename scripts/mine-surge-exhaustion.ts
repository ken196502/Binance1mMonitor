import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import { calculateSma } from '../research/peak-rebound-signals.ts';
import { computeMacd } from '../src/macd.ts';
import { HOUR } from '../research/types.ts';
import { MINUTE } from '../research/gainers-types.ts';
import { calcReturn, wilsonInterval } from '../research/peak-rebound-backtest.ts';

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

// 简易 RSI 计算
function calculateRsi(closes: number[], index: number, period = 14): number | null {
  if (index < period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = index - period + 1; i <= index; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

interface SignalItem {
  symbol: string;
  time: number;
  entryPrice: number;
  dayChange: number;
  surge: number;
  requiredSurge: number;
  x: number;
  n: number;
  upperShadow: number;
  rsi: number;
  maDev: number; // close / ma30 - 1
  isRed: boolean;
  volRatio: number;
}

async function main() {
  console.log('================================================================');
  console.log('⚡【深度寻优】极端脉冲衰竭做空 (x 分钟涨幅 >= 24h / N) + 动能/乖离过滤');
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

  // 测试网格:
  // x: 3, 5, 10, 15, 30
  // N: 1.5, 2.0, 2.5, 3.0, 3.5, 4.0
  const xGrid = [3, 5, 10, 15, 30];
  const nGrid = [1.5, 2.0, 2.5, 3.0, 3.5, 4.0];

  interface TestResult {
    name: string;
    x: number;
    n: number;
    filterDesc: string;
    trades: number;
    winRate: number;
    pf: number | null;
    netPnl: number;
    maxDd: number;
  }

  const results: TestResult[] = [];

  for (const x of xGrid) {
    for (const n of nGrid) {
      // 收集信号
      const signals: SignalItem[] = [];

      for (const [symbol, bars] of candles) {
        if (!bars || bars.length < 65) continue;

        const opens = bars.map(b => b[1]);
        const highs = bars.map(b => b[2]);
        const lows = bars.map(b => b[3]);
        const closes = bars.map(b => b[4]);
        const volumes = bars.map(b => b[5]);
        const times = bars.map(b => b[0]);

        let cooldown = 0;

        for (let i = Math.max(x, 35); i < bars.length - 1; i++) {
          const t = times[i];
          if (t < cooldown) continue;

          const boardTime = Math.floor(t / HOUR) * HOUR;
          const row = boards.get(boardTime)?.get(symbol);
          if (!row || row.rank > 10 || row.dayChange < 10) continue;

          // x 分钟内最低价
          let minLow = Infinity;
          let maxHigh = -Infinity;
          for (let k = i - x + 1; k <= i; k++) {
            if (lows[k] < minLow) minLow = lows[k];
            if (highs[k] > maxHigh) maxHigh = highs[k];
          }

          const curClose = closes[i];
          const curOpen = opens[i];
          const curHigh = highs[i];
          const curLow = lows[i];

          const surge = minLow > 0 ? ((curClose - minLow) / minLow) * 100 : 0;
          const requiredSurge = row.dayChange / n;

          if (surge < requiredSurge) continue;

          // 特征计算
          const totalRange = curHigh - curLow;
          const upperShadow = totalRange > 0 ? (curHigh - Math.max(curOpen, curClose)) / totalRange : 0;
          const isRed = curClose < curOpen;
          const rsi = calculateRsi(closes, i, 14) ?? 50;
          const ma30 = calculateSma(closes, i, 30) ?? curClose;
          const maDev = (curClose - ma30) / ma30 * 100;

          // 20根均量
          let sumVol = 0;
          for (let k = i - 19; k <= i; k++) sumVol += volumes[k];
          const avgVol = sumVol / 20;
          const volRatio = avgVol > 0 ? volumes[i] / avgVol : 1;

          const nextBar = bars[i + 1];
          signals.push({
            symbol,
            time: nextBar[0],
            entryPrice: nextBar[1],
            dayChange: row.dayChange,
            surge,
            requiredSurge,
            x,
            n,
            upperShadow,
            rsi,
            maDev,
            isRed,
            volRatio,
          });

          cooldown = t + 20 * MINUTE;
        }
      }

      // 测试不同过滤条件下的回测
      const filterVariations = [
        { name: '纯冲高无过滤', filter: (s: SignalItem) => true },
        { name: '见顶长上影(影线≥20%)', filter: (s: SignalItem) => s.upperShadow >= 0.2 },
        { name: '极度乖离(高出MA30≥2%)', filter: (s: SignalItem) => s.maDev >= 2.0 },
        { name: '放量滞涨(量比≥1.5+影线≥15%)', filter: (s: SignalItem) => s.volRatio >= 1.5 && s.upperShadow >= 0.15 },
        { name: 'RSI极度超买(RSI≥75)', filter: (s: SignalItem) => s.rsi >= 75 },
        { name: '综合衰竭(乖离≥1.5%+影线≥15%)', filter: (s: SignalItem) => s.maDev >= 1.5 && s.upperShadow >= 0.15 },
      ];

      for (const f of filterVariations) {
        const filteredSignals = signals.filter(f.filter);
        if (filteredSignals.length < 5) continue;

        // 回测 (测试动态 2 段式退出: X=35, N=2.0, M=2.0, 30m)
        let wins = 0;
        let totalNet = 0;
        let grossWins = 0;
        let grossLoss = 0;
        let cumPnl = 0;
        let peakEquity = 0;
        let maxDd = 0;
        let tradeCount = 0;

        const occupied = new Map<string, number>();

        for (const sig of filteredSignals) {
          if ((occupied.get(sig.symbol) ?? -Infinity) > sig.time) continue;

          const bars = candles.get(sig.symbol);
          if (!bars) continue;

          // 寻找 entryBar
          const idx = bars.findIndex(b => b[0] === sig.time);
          if (idx < 0) continue;

          tradeCount++;
          const entry = sig.entryPrice;
          const dayChange = Math.max(10, sig.dayChange);

          const tp1 = entry * (1 - (dayChange / 35) / 100);
          const sl1 = entry * (1 + (dayChange / 35) / 100);
          const tp2 = entry * (1 - (dayChange * 2.0 / 35) / 100);
          const sl2 = entry * (1 + (dayChange * 2.0 / 35) / 100);

          let stage1Closed = false;
          let stage2Closed = false;
          let tradeNet = 0;
          let exitTime = sig.time + 30 * MINUTE;

          for (let step = 0; step < 30; step++) {
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
              } else if (low <= tp1) {
                const ret = calcReturn(entry, tp1, 'target');
                tradeNet += ret.netPercent * 0.5;
                stage1Closed = true;
              }
            }

            if (stage1Closed && !stage2Closed) {
              if (high >= sl2) {
                const ret = calcReturn(entry, sl2, 'stop');
                tradeNet += ret.netPercent * 0.5;
                stage2Closed = true;
                exitTime = bar[0];
                break;
              } else if (low <= tp2) {
                const ret = calcReturn(entry, tp2, 'target');
                tradeNet += ret.netPercent * 0.5;
                stage2Closed = true;
                exitTime = bar[0];
                break;
              }
            }

            if (step === 29) {
              // timeout
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

        if (tradeCount >= 5) {
          const winRate = (wins / tradeCount) * 100;
          const pf = grossLoss > 0 ? grossWins / grossLoss : Infinity;
          results.push({
            name: `${x}m内涨>=24h/${n}`,
            x,
            n,
            filterDesc: f.name,
            trades: tradeCount,
            winRate,
            pf,
            netPnl: totalNet,
            maxDd,
          });
        }
      }
    }
  }

  // 排序输出
  results.sort((a, b) => b.winRate - a.winRate || (b.pf ?? 0) - (a.pf ?? 0));

  console.log('| 核心条件 (x 分钟 / N) | 过滤器 | 交易笔数 | 胜率(%) | 盈亏比(PF) | 累计净收益(%) | 最大回撤(%) |');
  console.log('| :--- | :--- | :---: | :---: | :---: | :---: | :---: |');
  for (const r of results.slice(0, 30)) {
    console.log(
      `| ${r.name.padEnd(20)} | ${r.filterDesc.padEnd(25)} | ${r.trades.toString().padStart(8)} | ${r.winRate.toFixed(1)}% | ${r.pf ? r.pf.toFixed(2) : '∞'} | ${r.netPnl.toFixed(2)}% | ${r.maxDd.toFixed(2)}% |`,
    );
  }
}

main().catch(console.error);
