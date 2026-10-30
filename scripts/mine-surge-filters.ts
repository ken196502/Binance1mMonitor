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

async function main() {
  console.log('================================================================');
  console.log('🔥【假突破过滤与真高潮识别】24h涨幅底线 + 最小绝对冲高幅度网格');
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

  // 参数网格:
  // x: 3, 5, 10
  // N: 2.5, 3.0, 3.5, 4.0
  // minDayChange: 15, 20, 25
  // minAbsoluteSurge: 4, 5, 6
  // Exit: 15m, X=25~35, N=1.5~2.0, M=1.5~2.5

  interface CandidateResult {
    x: number;
    n: number;
    minDayChange: number;
    minSurge: number;
    trades: number;
    winRate: number;
    pf: number | null;
    netPnl: number;
    maxDd: number;
    wins: number;
    losses: number;
  }

  const results: CandidateResult[] = [];

  for (const x of [3, 5, 8, 10]) {
    for (const n of [2.5, 3.0, 3.5, 4.0]) {
      for (const minDayChange of [15, 20, 25]) {
        for (const minSurge of [4.0, 5.0, 6.0]) {
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

          for (const [symbol, bars] of candles) {
            if (!bars || bars.length < 65) continue;
            const opens = bars.map(b => b[1]);
            const highs = bars.map(b => b[2]);
            const lows = bars.map(b => b[3]);
            const closes = bars.map(b => b[4]);
            const times = bars.map(b => b[0]);

            let cooldown = 0;
            for (let i = 35; i < bars.length - 1; i++) {
              const t = times[i];
              if (t < cooldown) continue;

              const boardTime = Math.floor(t / HOUR) * HOUR;
              const row = boards.get(boardTime)?.get(symbol);
              if (!row || row.rank > 10 || row.dayChange < minDayChange) continue;

              let minLow = Infinity;
              for (let k = i - x + 1; k <= i; k++) {
                if (lows[k] < minLow) minLow = lows[k];
              }

              const curClose = closes[i];
              const curOpen = opens[i];
              const curHigh = highs[i];
              const curLow = lows[i];

              const surge = minLow > 0 ? ((curClose - minLow) / minLow) * 100 : 0;
              const requiredSurge = row.dayChange / n;

              // 核心条件 + 绝对冲高下限
              if (surge < requiredSurge || surge < minSurge) continue;

              // 均线乖离过滤 (冲高必须脱离 MA30 均线，确认极端爆发)
              const ma30 = calculateSma(closes, i, 30) ?? curClose;
              const maDev = ((curClose - ma30) / ma30) * 100;
              if (maDev < 1.5) continue;

              // 触发
              const nextBar = bars[i + 1];
              const entryTime = nextBar[0];
              const entryPrice = nextBar[1];

              if ((occupied.get(symbol) ?? -Infinity) > entryTime) continue;

              tradeCount++;
              const dayChange = Math.max(10, row.dayChange);
              // 两段式退出: X=30, N=2.0, M=2.0, hold=20m
              const exitX = 30;
              const exitN = 2.0;
              const exitM = 2.0;
              const hold = 20;

              const tp1 = entryPrice * (1 - (dayChange / exitX) / 100);
              const sl1 = entryPrice * (1 + (dayChange / exitX) / 100);
              const tp2 = entryPrice * (1 - (dayChange * exitM / exitX) / 100);
              const sl2 = entryPrice * (1 + (dayChange * exitN / exitX) / 100);

              let stage1Closed = false;
              let stage2Closed = false;
              let tradeNet = 0;
              let exitTime = entryTime + hold * MINUTE;

              for (let step = 0; step < hold; step++) {
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

                if (step === hold - 1) {
                  const rem = (!stage1Closed ? 1.0 : !stage2Closed ? 0.5 : 0);
                  if (rem > 0) {
                    tradeNet += calcReturn(entryPrice, c, 'timeout').netPercent * rem;
                  }
                  exitTime = bar[0];
                }
              }

              occupied.set(symbol, exitTime);
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

          if (tradeCount >= 5) {
            const winRate = (wins / tradeCount) * 100;
            const pf = grossLoss > 0 ? grossWins / grossLoss : Infinity;
            results.push({
              x,
              n,
              minDayChange,
              minSurge,
              trades: tradeCount,
              winRate,
              pf,
              netPnl: totalNet,
              maxDd,
              wins,
              losses,
            });
          }
        }
      }
    }
  }

  // 排序: 胜率优先 (同时胜率相同时按 PF 排序)
  results.sort((a, b) => b.winRate - a.winRate || (b.pf ?? 0) - (a.pf ?? 0));

  console.log('| x(分) | N(倍) | 24h门槛 | 冲高门槛 | 战绩(胜/负) | 胜率(%) | 盈亏比(PF) | 累计净收益(%) | 最大回撤(%) |');
  console.log('| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |');
  for (const r of results.slice(0, 30)) {
    console.log(
      `| ${r.x.toString().padStart(4)} | ${r.n.toFixed(1).padStart(4)} | ≥${r.minDayChange}% | ≥${r.minSurge}% | ${(r.wins + '胜' + r.losses + '负').padStart(11)} | ${r.winRate.toFixed(1)}% | ${r.pf ? r.pf.toFixed(2) : '∞'} | ${r.netPnl.toFixed(2)}% | ${r.maxDd.toFixed(2)}% |`,
    );
  }
}

main().catch(console.error);
