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

  // 诊断 SigB: x=3m, N=3.5, 乖离 >= 2%
  const x = 3;
  const n = 3.5;
  const hold = 15;
  const exitX = 25;
  const exitN = 1.5;
  const exitM = 1.5;

  const trades: any[] = [];
  const occupied = new Map<string, number>();

  for (const [symbol, bars] of candles) {
    if (!bars || bars.length < 65) continue;
    const opens = bars.map(b => b[1]);
    const highs = bars.map(b => b[2]);
    const lows = bars.map(b => b[3]);
    const closes = bars.map(b => b[4]);
    const volumes = bars.map(b => b[5]);
    const times = bars.map(b => b[0]);

    let cooldown = 0;
    for (let i = 35; i < bars.length - 1; i++) {
      const t = times[i];
      if (t < cooldown) continue;

      const boardTime = Math.floor(t / HOUR) * HOUR;
      const row = boards.get(boardTime)?.get(symbol);
      if (!row || row.rank > 10 || row.dayChange < 10) continue;

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
      if (surge < requiredSurge) continue;

      const ma30 = calculateSma(closes, i, 30) ?? curClose;
      const maDev = ((curClose - ma30) / ma30) * 100;
      if (maDev < 2.0) continue;

      const totalRange = curHigh - curLow;
      const upperShadow = totalRange > 0 ? (curHigh - Math.max(curOpen, curClose)) / totalRange : 0;

      // 检查均线排列
      const ma5 = calculateSma(closes, i, 5) ?? curClose;
      const ma15 = calculateSma(closes, i, 15) ?? curClose;

      // 触发
      const nextBar = bars[i + 1];
      const entryTime = nextBar[0];
      const entryPrice = nextBar[1];

      if ((occupied.get(symbol) ?? -Infinity) > entryTime) continue;

      const dayChange = Math.max(10, row.dayChange);
      const tp1 = entryPrice * (1 - (dayChange / exitX) / 100);
      const sl1 = entryPrice * (1 + (dayChange / exitX) / 100);
      const tp2 = entryPrice * (1 - (dayChange * exitM / exitX) / 100);
      const sl2 = entryPrice * (1 + (dayChange * exitN / exitX) / 100);

      let stage1Closed = false;
      let stage2Closed = false;
      let tradeNet = 0;
      let exitTime = entryTime + hold * MINUTE;
      let reason1 = 'timeout';
      let reason2 = 'timeout';

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
            reason1 = 'stop';
          } else if (l <= tp1) {
            tradeNet += calcReturn(entryPrice, tp1, 'target').netPercent * 0.5;
            stage1Closed = true;
            reason1 = 'target';
          }
        }

        if (stage1Closed && !stage2Closed) {
          if (h >= sl2) {
            tradeNet += calcReturn(entryPrice, sl2, 'stop').netPercent * 0.5;
            stage2Closed = true;
            reason2 = 'stop';
            exitTime = bar[0];
            break;
          } else if (l <= tp2) {
            tradeNet += calcReturn(entryPrice, tp2, 'target').netPercent * 0.5;
            stage2Closed = true;
            reason2 = 'target';
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

      trades.push({
        symbol,
        time: new Date(entryTime).toISOString(),
        rank: row.rank,
        dayChange: row.dayChange.toFixed(1),
        surge: surge.toFixed(2),
        requiredSurge: requiredSurge.toFixed(2),
        maDev: maDev.toFixed(2),
        upperShadow: (upperShadow * 100).toFixed(1),
        ma5_gt_ma15: ma5 > ma15,
        netPercent: tradeNet.toFixed(2),
        isWin: tradeNet > 0,
        reasons: `${reason1}/${reason2}`,
      });
    }
  }

  console.log('全部 29 笔交易诊断明细:');
  console.log('| 币种 | 入场时间 | 榜位 | 24h% | 3m涨幅% | 门槛% | 偏离MA30% | 影线% | 盈亏% | 结果 | 退出原因 |');
  console.log('| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |');
  for (const t of trades) {
    const res = t.isWin ? '✅ 盈利' : '❌ 亏损';
    console.log(
      `| ${t.symbol.padEnd(8)} | ${t.time.slice(5, 16)} | ${t.rank} | ${t.dayChange}% | ${t.surge}% | ${t.requiredSurge}% | ${t.maDev}% | ${t.upperShadow}% | ${t.netPercent.padStart(6)}% | ${res} | ${t.reasons} |`,
    );
  }

  const wins = trades.filter(t => t.isWin);
  const losses = trades.filter(t => !t.isWin);
  console.log(`\n总结: 总交易 ${trades.length} 笔, 盈利 ${wins.length} 笔 (${(wins.length / trades.length * 100).toFixed(1)}%), 亏损 ${losses.length} 笔`);

  // 对比赢家和输家的特征差异
  const avgLossShadow = losses.reduce((s, l) => s + parseFloat(l.upperShadow), 0) / (losses.length || 1);
  const avgWinShadow = wins.reduce((s, w) => s + parseFloat(w.upperShadow), 0) / (wins.length || 1);
  console.log(`平均上影线比例: 赢家 = ${avgWinShadow.toFixed(1)}%, 输家 = ${avgLossShadow.toFixed(1)}%`);

  const avgLossSurge = losses.reduce((s, l) => s + parseFloat(l.surge), 0) / (losses.length || 1);
  const avgWinSurge = wins.reduce((s, w) => s + parseFloat(w.surge), 0) / (wins.length || 1);
  console.log(`平均 3m 冲高幅度: 赢家 = ${avgWinSurge.toFixed(2)}%, 输家 = ${avgLossSurge.toFixed(2)}%`);
}

main().catch(console.error);
