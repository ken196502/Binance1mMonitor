import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import type { MinuteDataset } from '../research/gainers-types.ts';
import { HOUR } from '../research/types.ts';
import { computeMacd, calculateSupportMaAt } from '../src/macd.ts';
import { calcReturn } from '../research/peak-rebound-backtest.ts';

// 1. 数据装载器：合并全部 1m K 线数据
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
          if (!candles.has(sym) || bars.length > candles.get(sym).length) {
            candles.set(sym, bars);
          }
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

export interface BlitzSignal {
  symbol: string;
  time: number;
  entryTime: number;
  entryPrice: number;
  dayChangePercent: number;
  rank: number;
  exitX: number;
  exitN: number;
  exitM: number;
  holdMinutes: number;
}

// 2. 提取【新高顶背离闪击】信号
async function extractNewHighSignals(
  minuteData: MinuteDataset,
  frames: any[],
  hourly: any
): Promise<BlitzSignal[]> {
  const boards = new Map<number, Map<string, { rank: number; dayChange: number }>>();
  for (const frame of frames) {
    const symbolMap = new Map<string, { rank: number; dayChange: number }>();
    for (const b of frame.boards.gainers) {
      symbolMap.set(b.symbol, { rank: b.rank, dayChange: b.dayChange });
    }
    boards.set(frame.time, symbolMap);
  }

  const signals: BlitzSignal[] = [];

  for (const [sym, bars] of minuteData.candles) {
    if (!bars || bars.length < 65) continue;
    const closes = bars.map(b => b[4]);
    const highs = bars.map(b => b[2]);
    const lows = bars.map(b => b[3]);
    const times = bars.map(b => b[0]);
    const candlesList = bars.map(b => ({ time: b[0], open: b[1], high: b[2], low: b[3], close: b[4] }));
    const { hist } = computeMacd(closes);

    let curMax24h = 0;

    for (let i = 35; i < bars.length - 2; i++) {
      const t = times[i];
      const bTime = Math.floor(t / HOUR) * HOUR;
      const row = boards.get(bTime)?.get(sym);
      if (!row || row.rank > 10 || row.dayChange < 15) continue;

      const start24h = Math.max(0, i - 1439);
      if (i === 35 || highs[i] > curMax24h) {
        let m = 0;
        for (let k = start24h; k <= i; k++) {
          if (highs[k] > m) m = highs[k];
        }
        curMax24h = m;
      }

      // 5m 脉冲 >= 24h / 10
      const start5m = Math.max(0, i - 4);
      let minLow5m = Infinity;
      for (let k = start5m; k <= i; k++) {
        if (lows[k] < minLow5m) minLow5m = lows[k];
      }
      if (minLow5m <= 0) continue;
      const surge = ((highs[i] - minLow5m) / minLow5m) * 100;
      if (surge < row.dayChange / 10.0) continue;

      // 创 24h 新高
      if (highs[i] < curMax24h) continue;

      // 短均线 MA [3, 7, 15] 悬空无支撑
      if (calculateSupportMaAt(candlesList, i, [3, 7, 15]) !== null) continue;

      // MACD 顶背离 (10m ~ 120m)
      const lookStart = Math.max(0, i - 120);
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

      if (prevIdx < 0 || prevMax >= highs[i]) continue;
      const curHist = hist[i];
      const prevHist = hist[prevIdx];
      if (curHist >= prevHist || prevHist <= 0) continue;

      // 收阴确认或上影线过滤 (生产对齐规则)
      const curBar = candlesList[i];
      const body = Math.abs(curBar.close - curBar.open);
      const upperShadow = curBar.high - Math.max(curBar.open, curBar.close);
      if (body > 0 && upperShadow / body > 0.30 && curBar.close >= curBar.open) continue;

      // 信号成立，下根开盘入场
      const entryBar = bars[i + 1];
      signals.push({
        symbol: sym,
        time: t,
        entryTime: entryBar[0],
        entryPrice: entryBar[1],
        dayChangePercent: row.dayChange,
        rank: row.rank,
        exitX: 50,
        exitN: 1.5,
        exitM: 3.0,
        holdMinutes: 15,
      });
    }
  }

  // 按时间排序并去重
  signals.sort((a, b) => a.entryTime - b.entryTime);
  return signals;
}

// 3. 模拟两阶段交易
interface TradeResult {
  symbol: string;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  netPnlPct: number;
  leveragedNetPnlPct: number;
  roePercent: number;
  isWin: boolean;
  isLiquidated: boolean;
  exitReason: string;
  durationMinutes: number;
  maxAdversePct: number;
}

function simulateBlitzTrade(
  sig: BlitzSignal,
  bars: any[],
  leverage: number,
  takerFeeBps = 5,
  slippageBps = 2,
  stopAtHigh = true
): TradeResult | null {
  const fillIdx = bars.findIndex(b => b[0] === sig.entryTime);
  if (fillIdx < 0) return null;

  const entry = sig.entryPrice;
  const dayChange = Math.max(10, sig.dayChangePercent);

  // 两段动态退出参数
  const tp1Pct = dayChange / sig.exitX;               // ~0.5% - 0.8%
  const sl1Pct = dayChange / sig.exitX;               // ~0.5% - 0.8%
  const sl2Pct = (dayChange * sig.exitN) / sig.exitX; // ~0.75% - 1.2%
  const tp2Pct = (dayChange * sig.exitM) / sig.exitX; // ~1.5% - 2.4%

  const tp1Price = entry * (1 - tp1Pct / 100);
  const sl1Price = entry * (1 + sl1Pct / 100);
  const sl2Price = entry * (1 + sl2Pct / 100);
  const tp2Price = entry * (1 - tp2Pct / 100);

  // 强平线 (95% 维持保证金线)
  const liqPct = (100.0 / leverage) * 0.95;
  const liqPrice = entry * (1 + liqPct / 100);

  const feeRate = (takerFeeBps * 2 + slippageBps * 2) / 10000; // 双边手续费+滑点

  let remainingFraction = 1.0;
  let stage1Done = false;
  let stage1Return = 0;
  let stage2Return = 0;
  let exitReason = 'timeout';
  let exitTime = sig.entryTime + sig.holdMinutes * 60 * 1000;
  let maxAdverse = 0;
  let isLiquidated = false;

  const maxSteps = Math.min(sig.holdMinutes, bars.length - fillIdx);

  for (let step = 0; step < maxSteps; step++) {
    const b = bars[fillIdx + step];
    const bTime = b[0];
    const high = b[2];
    const low = b[3];
    const close = b[4];

    const curAdverse = ((high - entry) / entry) * 100;
    if (curAdverse > maxAdverse) maxAdverse = curAdverse;

    // 检查强平
    if (high >= liqPrice) {
      isLiquidated = true;
      exitReason = 'liquidated';
      exitTime = bTime;
      const lossPct = -100.0; // 保证金全损
      return {
        symbol: sig.symbol,
        entryTime: sig.entryTime,
        entryPrice: entry,
        exitTime,
        netPnlPct: -(100 / leverage),
        leveragedNetPnlPct: lossPct,
        roePercent: lossPct,
        isWin: false,
        isLiquidated: true,
        exitReason,
        durationMinutes: step + 1,
        maxAdversePct: maxAdverse,
      };
    }

    // 阶段一处理
    if (!stage1Done) {
      if (low <= tp1Price) {
        // 阶段一止盈
        stage1Done = true;
        remainingFraction = 0.5;
        const gross = tp1Pct;
        stage1Return = (gross / 100 - feeRate) * 0.5;
      } else if (high >= sl1Price) {
        // 阶段一止损
        stage1Done = true;
        remainingFraction = 0.5;
        const execHigh = stopAtHigh ? high : sl1Price;
        const gross = -((execHigh - entry) / entry);
        stage1Return = (gross - feeRate) * 0.5;
      }
    }

    // 阶段二处理
    if (stage1Done) {
      if (low <= tp2Price) {
        // 阶段二止盈
        const gross = tp2Pct;
        stage2Return = (gross / 100 - feeRate) * 0.5;
        remainingFraction = 0;
        exitReason = 'target';
        exitTime = bTime;
        break;
      } else if (high >= sl2Price) {
        // 阶段二止损
        const execHigh = stopAtHigh ? high : sl2Price;
        const gross = -((execHigh - entry) / entry);
        stage2Return = (gross - feeRate) * 0.5;
        remainingFraction = 0;
        exitReason = 'stop';
        exitTime = bTime;
        break;
      }
    }

    // 超时退出
    if (step === maxSteps - 1) {
      exitReason = 'timeout';
      exitTime = bTime;
      const closeReturn = ((entry - close) / entry) - feeRate;
      if (!stage1Done) {
        stage1Return = closeReturn * 0.5;
      }
      if (remainingFraction > 0) {
        stage2Return = closeReturn * remainingFraction;
      }
    }
  }

  const netPnlPct = (stage1Return + stage2Return) * 100;
  const leveragedNetPnlPct = netPnlPct * leverage;
  const roePercent = leveragedNetPnlPct;

  return {
    symbol: sig.symbol,
    entryTime: sig.entryTime,
    entryPrice: entry,
    exitTime,
    netPnlPct,
    leveragedNetPnlPct,
    roePercent,
    isWin: netPnlPct > 0.001,
    isLiquidated: false,
    exitReason,
    durationMinutes: Math.round((exitTime - sig.entryTime) / 60000),
    maxAdversePct: maxAdverse,
  };
}

async function main() {
  console.log('========================================================================================');
  console.log('⚡【新高顶背离闪击战专项】杠杆敏感度全量回测 (1x ~ 20x)');
  console.log('========================================================================================\n');

  console.log('1. 正在载入全量 119,655 根 1m K 线数据与 168h 历史行情...');
  const minuteData = await loadAllMinutes();
  const hourlyDir = path.resolve('data/research/hourly-168h');
  const hourly = await loadDataset(hourlyDir);
  const frames = buildFrames(hourly, 10, 1);

  console.log('2. 提取【新高顶背离】全量信号 (15m 闪击战规则)...');
  const allSignals = await extractNewHighSignals(minuteData, frames, hourly);
  console.log(`✅ 共检测到 ${allSignals.length} 笔新高顶背离候选信号`);

  // 模拟实盘冷却防重过滤 (cooldown 15m)
  const filteredSignals: BlitzSignal[] = [];
  const occupiedUntil = new Map<string, number>();

  for (const s of allSignals) {
    const occ = occupiedUntil.get(s.symbol) ?? -Infinity;
    if (s.entryTime >= occ) {
      filteredSignals.push(s);
      occupiedUntil.set(s.symbol, s.entryTime + s.holdMinutes * 60 * 1000);
    }
  }

  console.log(`✅ 经防重冷却后，有效独立交易笔数: ${filteredSignals.length} 笔\n`);

  // 4. 杠杆梯度测试
  const leverages = [1, 2, 3, 5, 7, 10, 12, 15, 20];
  const summaryRows: any[] = [];

  for (const lev of leverages) {
    const trades: TradeResult[] = [];
    let grossGain = 0;
    let grossLoss = 0;
    let liqCount = 0;

    for (const sig of filteredSignals) {
      const bars = minuteData.candles.get(sig.symbol);
      if (!bars) continue;
      const res = simulateBlitzTrade(sig, bars, lev, 5, 2, true);
      if (res) {
        trades.push(res);
        if (res.leveragedNetPnlPct > 0) {
          grossGain += res.leveragedNetPnlPct;
        } else {
          grossLoss += Math.abs(res.leveragedNetPnlPct);
        }
        if (res.isLiquidated) liqCount++;
      }
    }

    const wins = trades.filter(t => t.isWin).length;
    const losses = trades.filter(t => !t.isWin).length;
    const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
    const pf = grossLoss > 0 ? grossGain / grossLoss : (grossGain > 0 ? Infinity : 1.0);
    const totalPnl = trades.reduce((acc, t) => acc + t.leveragedNetPnlPct, 0);

    // 计算资金曲线与最大回撤
    let equity = 100.0;
    let peak = 100.0;
    let maxDd = 0;

    for (const t of trades) {
      // 假设单笔投入 20% 保证金
      const pnlOnAccount = equity * 0.20 * (t.leveragedNetPnlPct / 100);
      equity += pnlOnAccount;
      if (equity > peak) peak = equity;
      const dd = ((peak - equity) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
    }

    const calmar = maxDd > 0 ? (equity - 100) / maxDd : 0;

    const winTrades = trades.filter(t => t.isWin);
    const lossTrades = trades.filter(t => !t.isWin);
    const avgWinRoe = winTrades.length > 0 ? winTrades.reduce((acc, t) => acc + t.roePercent, 0) / winTrades.length : 0;
    const avgLossRoe = lossTrades.length > 0 ? lossTrades.reduce((acc, t) => acc + t.roePercent, 0) / lossTrades.length : 0;
    const worstLoss = lossTrades.length > 0 ? Math.min(...lossTrades.map(t => t.roePercent)) : 0;

    summaryRows.push({
      leverage: `${lev}x`,
      trades: trades.length,
      winRate: `${winRate.toFixed(1)}%`,
      pf: pf.toFixed(2),
      totalPnl: `${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(1)}%`,
      accountGrowth: `${(equity - 100) >= 0 ? '+' : ''}${(equity - 100).toFixed(1)}%`,
      maxDd: `${maxDd.toFixed(1)}%`,
      calmar: calmar.toFixed(2),
      avgWinRoe: `+${avgWinRoe.toFixed(1)}%`,
      avgLossRoe: `${avgLossRoe.toFixed(1)}%`,
      worstLoss: `${worstLoss.toFixed(1)}%`,
      liqCount,
    });
  }

  console.log('========================================================================================');
  console.log('📊【新高顶背离闪击战】不同杠杆梯度表现对照表 (15m 速战速决 · 动态紧止损)');
  console.log('========================================================================================');
  console.table(summaryRows);

  console.log('\n========================================================================================');
  console.log('🎯【逐笔微观审查 (以 10x 杠杆为例)】');
  console.log('========================================================================================');
  const sampleLev = 10;
  for (let i = 0; i < filteredSignals.length; i++) {
    const sig = filteredSignals[i];
    const bars = minuteData.candles.get(sig.symbol);
    if (!bars) continue;
    const res = simulateBlitzTrade(sig, bars, sampleLev, 5, 2, true);
    if (!res) continue;
    console.log(
      `#${i + 1} [${sig.symbol.padEnd(10)}] ` +
      `24h: +${sig.dayChangePercent.toFixed(1).padStart(5)}% | ` +
      `持仓: ${res.durationMinutes}m | ` +
      `离场: ${res.exitReason.padEnd(10)} | ` +
      `逆行MAE: +${res.maxAdversePct.toFixed(2)}% | ` +
      `单笔ROE: ${(res.roePercent >= 0 ? '+' : '') + res.roePercent.toFixed(2) + '%'} | ` +
      `${res.isWin ? '✅ 盈利' : '❌ 止损'}`
    );
  }
}

main().catch(console.error);
