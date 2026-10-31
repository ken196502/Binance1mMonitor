import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import type { MinuteDataset } from '../research/gainers-types.ts';
import { HOUR } from '../research/types.ts';
import { computeMacd, calculateSupportMaAt } from '../src/macd.ts';
import { calcReturn } from '../research/peak-rebound-backtest.ts';

// 1. 数据装载器
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

export interface EnsembleSignal {
  type: 'streak' | 'rebound' | 'deep_rebound' | 'extreme_dev';
  name: string;
  symbol: string;
  entryTime: number;
  entryPrice: number;
  dayChangePercent: number;
  rank: number;
  holdMinutes: number;
  stopLossPercent?: number;
  tp1Percent?: number;
  tp2Percent?: number;
  exitX: number;
  exitN: number;
  exitM: number;
  moveSlToEntryAfterTp1: boolean;
}

import { calculateSma, buildPeakReboundSignals } from '../research/peak-rebound-signals.ts';

// 提取全四大策略信号 (精准对齐生产环境 102 笔基底信号)
async function extractAllSignals(
  minuteData: MinuteDataset,
  frames: any[]
): Promise<EnsembleSignal[]> {
  const boards = new Map<number, Map<string, { rank: number; dayChange: number }>>();
  for (const frame of frames) {
    const symbolMap = new Map<string, { rank: number; dayChange: number }>();
    for (const b of frame.boards.gainers) {
      symbolMap.set(b.symbol, { rank: b.rank, dayChange: b.dayChange });
    }
    boards.set(frame.time, symbolMap);
  }

  const signals: EnsembleSignal[] = [];

  // --- 策略二：首次跌到10% (Peak Rebound) ---
  const reboundSignals = buildPeakReboundSignals(minuteData, frames, {
    pullbackX: 10.0,
    reboundY: 4.0,
    shortMa: 5,
    mediumMa: 15,
    longMa: 30,
    longMaOffsetPercent: 0.5,
    minGreenRatio20: 0.65,
    requireMaSlopeDown: true,
  });

  for (const rs of reboundSignals) {
    const bars = minuteData.candles.get(rs.symbol);
    if (!bars) continue;
    const fillIdx = rs.index + 1;
    if (fillIdx >= bars.length) continue;
    const entryBar = bars[fillIdx];

    signals.push({
      type: 'rebound',
      name: '首次跌10%',
      symbol: rs.symbol,
      entryTime: entryBar[0],
      entryPrice: entryBar[1],
      dayChangePercent: rs.dayChangePercent,
      rank: 1,
      holdMinutes: 90,
      stopLossPercent: 10.0,
      tp1Percent: 4.0,
      tp2Percent: 8.0,
      exitX: 45,
      exitN: 2.0,
      exitM: 4.0,
      moveSlToEntryAfterTp1: true,
    });
  }

  // --- 策略一、三、四扫描 ---
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

      const nextBar = bars[i + 1];
      if (!nextBar) continue;

      // --- 策略四：冲高极度乖离 (Extreme Dev) ---
      if (row.rank <= 10 && row.dayChange >= 20) {
        const startX = Math.max(0, i - 2);
        let minLow3 = Infinity;
        for (let k = startX; k <= i; k++) if (lows[k] < minLow3) minLow3 = lows[k];
        if (minLow3 > 0) {
          const surge3 = ((closes[i] - minLow3) / minLow3) * 100;
          if (surge3 >= row.dayChange / 3.5 && surge3 >= 4.0) {
            const ma30 = calculateSma(closes, i, 30);
            if (ma30 != null && ((closes[i] - ma30) / ma30) * 100 >= 1.5) {
              signals.push({
                type: 'extreme_dev',
                name: '冲高极度乖离',
                symbol: sym,
                entryTime: nextBar[0],
                entryPrice: nextBar[1],
                dayChangePercent: row.dayChange,
                rank: row.rank,
                holdMinutes: 90,
                stopLossPercent: 10.0,
                tp1Percent: 4.0,
                tp2Percent: 8.0,
                exitX: 45,
                exitN: 2.0,
                exitM: 4.0,
                moveSlToEntryAfterTp1: true,
              });
            }
          }
        }
      }

      // --- 策略一：新高顶背离 (Streak / ATH Divergence) ---
      if (row.rank <= 10 && row.dayChange >= 15) {
        const startX5 = Math.max(0, i - 4);
        let minLow5 = Infinity;
        for (let k = startX5; k <= i; k++) if (lows[k] < minLow5) minLow5 = lows[k];
        if (minLow5 > 0) {
          const surge5 = ((highs[i] - minLow5) / minLow5) * 100;
          if (surge5 >= row.dayChange / 10.0 && highs[i] >= curMax24h) {
            if (calculateSupportMaAt(candlesList, i, [3, 7, 15]) === null) {
              const startLook = Math.max(0, i - 120);
              const endLook = Math.max(0, i - 10);
              if (endLook > startLook) {
                let prevMaxH = 0;
                let prevIdx = -1;
                for (let k = startLook; k <= endLook; k++) {
                  if (highs[k] > prevMaxH) { prevMaxH = highs[k]; prevIdx = k; }
                }
                if (prevIdx >= 0 && highs[i] >= prevMaxH && hist[i] < hist[prevIdx] && dif[i] < dif[prevIdx]) {
                  signals.push({
                    type: 'streak',
                    name: '新高顶背离',
                    symbol: sym,
                    entryTime: nextBar[0],
                    entryPrice: nextBar[1],
                    dayChangePercent: row.dayChange,
                    rank: row.rank,
                    holdMinutes: 15,
                    exitX: 50,
                    exitN: 1.5,
                    exitM: 3.0,
                    moveSlToEntryAfterTp1: false,
                  });
                }
              }
            }
          }
        }
      }

      // --- 策略三：跌到20%+ (Deep Rebound) ---
      if (curMax24h > 0) {
        const dropFromMax = ((curMax24h - closes[i]) / curMax24h) * 100;
        if (dropFromMax >= 20.0) {
          const start10 = Math.max(0, i - 9);
          let minLow10 = Infinity;
          for (let k = start10; k <= i; k++) if (lows[k] < minLow10) minLow10 = lows[k];
          if (minLow10 > 0) {
            const reb10 = ((highs[i] - minLow10) / minLow10) * 100;
            if (reb10 >= 5.0) {
              const ma15 = calculateSma(closes, i, 15);
              const ma30 = calculateSma(closes, i, 30);
              if (ma15 != null && ma30 != null && ma15 < ma30 && closes[i] < ma15 && highs[i] > ma15) {
                let slopeDown = true;
                if (i >= 2) {
                  const pMa30 = calculateSma(closes, i - 2, 30);
                  if (pMa30 != null && ma30 >= pMa30) slopeDown = false;
                }
                if (slopeDown) {
                  let greenCount = 0;
                  for (let k = Math.max(0, i - 19); k <= i; k++) if (hist[k] > 0) greenCount++;
                  if (greenCount / 20 >= 0.65) {
                    signals.push({
                      type: 'deep_rebound',
                      name: '跌到20%+',
                      symbol: sym,
                      entryTime: nextBar[0],
                      entryPrice: nextBar[1],
                      dayChangePercent: row.dayChange,
                      rank: row.rank,
                      holdMinutes: 90,
                      stopLossPercent: 10.0,
                      tp1Percent: 4.0,
                      tp2Percent: 8.0,
                      exitX: 45,
                      exitN: 2.0,
                      exitM: 4.0,
                      moveSlToEntryAfterTp1: true,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  signals.sort((a, b) => a.entryTime - b.entryTime);
  return signals;
}

export interface PortfolioSimOptions {
  marginRate?: number;             // 默认 0.20 (20% 资产量)
  useDynamicMargin?: boolean;      // 是否按资产量 20% 动态计算保证金 (默认 true)
  fixedMarginUsdt?: number;        // 固定保证金模式金额 (默认 20 USDT)
  maxPositions?: number;           // 最大同时持仓数 (默认 5)
  maxPositionsPerStrategy?: number;// 每个策略最大同时持仓数 (默认 1，保证四大策略至少各持仓 1 笔)
}

// 模拟组合执行
export function runPortfolioSimulation(
  signals: EnsembleSignal[],
  minuteData: MinuteDataset,
  streakLeverage: number,
  trendLeverage: number = 3,
  options: PortfolioSimOptions = {}
) {
  const marginRate = options.marginRate ?? 0.20;
  const useDynamicMargin = options.useDynamicMargin ?? true;
  const fixedMarginUsdt = options.fixedMarginUsdt ?? 20.0;
  const maxPositions = options.maxPositions ?? 5;
  const maxPositionsPerStrategy = options.maxPositionsPerStrategy ?? 1;

  const occupiedUntil = new Map<string, number>();
  let balance = 100.0;
  let peak = 100.0;
  let maxDd = 0;
  const trades: any[] = [];
  const feeRate = 0.0014; // 14 bps 双边

  const activePositions: Array<{
    symbol: string;
    type: string;
    exitTime: number;
    marginUsdt: number;
    pnlPct: number;
    tradeObj: any;
  }> = [];

  for (const sig of signals) {
    // 1. 释放已在 sig.entryTime 前结清的活跃持仓，并结算盈亏
    for (let i = activePositions.length - 1; i >= 0; i--) {
      if (activePositions[i].exitTime <= sig.entryTime) {
        const closed = activePositions[i];
        const pnlUsdt = closed.marginUsdt * (closed.pnlPct / 100);
        balance += pnlUsdt;
        if (balance > peak) peak = balance;
        const curDd = ((peak - balance) / peak) * 100;
        if (curDd > maxDd) maxDd = curDd;
        closed.tradeObj.pnlUsdt = pnlUsdt;
        closed.tradeObj.isWin = pnlUsdt > 0.001;
        trades.push(closed.tradeObj);
        activePositions.splice(i, 1);
      }
    }

    // 2. 检查同币互斥 (同一币种同时只持有一笔仓位)
    const occ = occupiedUntil.get(sig.symbol) ?? -Infinity;
    if (sig.entryTime < occ) continue;

    // 3. 全局最大同时持仓数限制
    if (maxPositions && activePositions.length >= maxPositions) {
      continue;
    }

    // 4. 单策略最大同时持仓数限制 (保证四大策略至少各持仓 1 笔，互不挤占)
    if (maxPositionsPerStrategy) {
      const stratCount = activePositions.filter((p) => p.type === sig.type).length;
      if (stratCount >= maxPositionsPerStrategy) {
        continue;
      }
    }

    const bars = minuteData.candles.get(sig.symbol);
    if (!bars) continue;

    const fillIdx = bars.findIndex(b => b[0] === sig.entryTime);
    if (fillIdx < 0) continue;

    const leverage = sig.type === 'streak' ? streakLeverage : trendLeverage;

    const entry = sig.entryPrice;
    const dayChange = Math.max(10, sig.dayChangePercent);

    // 计算止盈止损线
    const tp1Pct = sig.tp1Percent ?? (dayChange / sig.exitX);
    const sl1Pct = sig.stopLossPercent ?? (dayChange / sig.exitX);
    let sl2Pct = sig.stopLossPercent ?? ((dayChange * sig.exitN) / sig.exitX);
    const tp2Pct = sig.tp2Percent ?? ((dayChange * sig.exitM) / sig.exitX);

    const tp1Price = entry * (1 - tp1Pct / 100);
    const sl1Price = entry * (1 + sl1Pct / 100);
    let sl2Price = entry * (1 + sl2Pct / 100);
    const tp2Price = entry * (1 - tp2Pct / 100);

    const liqPct = (100.0 / leverage) * 0.95;
    const liqPrice = entry * (1 + liqPct / 100);

    let stage1Done = false;
    let stage1Return = 0;
    let stage2Return = 0;
    let remainingFraction = 1.0;
    let exitReason = 'timeout';
    let isLiquidated = false;
    let exitTime = sig.entryTime + sig.holdMinutes * 60 * 1000;

    const maxSteps = Math.min(sig.holdMinutes, bars.length - fillIdx);

    for (let step = 0; step < maxSteps; step++) {
      const b = bars[fillIdx + step];
      const high = b[2];
      const low = b[3];
      const close = b[4];
      const curTime = b[0];

      if (high >= liqPrice) {
        isLiquidated = true;
        exitReason = 'liquidated';
        stage1Return = -0.5;
        stage2Return = -0.5;
        remainingFraction = 0;
        exitTime = curTime;
        break;
      }

      if (!stage1Done) {
        if (low <= tp1Price) {
          stage1Done = true;
          remainingFraction = 0.5;
          stage1Return = (tp1Pct / 100 - feeRate) * 0.5;
          if (sig.moveSlToEntryAfterTp1) {
            sl2Price = entry * 1.002;
            sl2Pct = 0.2;
          }
        } else if (high >= sl1Price) {
          stage1Done = true;
          remainingFraction = 0.5;
          const gross = -((high - entry) / entry);
          stage1Return = (gross - feeRate) * 0.5;
        }
      }

      if (stage1Done && remainingFraction > 0) {
        if (low <= tp2Price) {
          stage2Return = (tp2Pct / 100 - feeRate) * 0.5;
          remainingFraction = 0;
          exitReason = 'target';
          exitTime = curTime;
          break;
        } else if (high >= sl2Price) {
          const gross = -((high - entry) / entry);
          stage2Return = (gross - feeRate) * 0.5;
          remainingFraction = 0;
          exitReason = 'stop';
          exitTime = curTime;
          break;
        }
      }

      if (step === maxSteps - 1) {
        exitReason = 'timeout';
        exitTime = curTime;
        const closeReturn = ((entry - close) / entry) - feeRate;
        if (!stage1Done) stage1Return = closeReturn * 0.5;
        if (remainingFraction > 0) stage2Return = closeReturn * remainingFraction;
      }
    }

    // 币种冷却锁：同币种在当前波段未结束前（或 holdMinutes 期间）禁止重复重入做空
    // 避免在同一波暴涨行情中提前止盈/止损后，立刻在更高点被二次拉升打穿
    occupiedUntil.set(sig.symbol, Math.max(sig.entryTime + sig.holdMinutes * 60 * 1000, exitTime));

    const netFraction = stage1Return + stage2Return;
    const unleveragedPct = netFraction * 100;
    const leveragedPct = unleveragedPct * leverage;

    // 单笔保证金：支持动态资产量 20% 或固定金额
    const marginUsdt = useDynamicMargin
      ? Math.max(5.0, balance * marginRate)
      : fixedMarginUsdt;

    const tradeObj = {
      symbol: sig.symbol,
      type: sig.type,
      name: sig.name,
      leverage,
      unleveragedPct,
      leveragedPct,
      marginUsdt,
      pnlUsdt: 0,
      isWin: false,
      exitReason,
      isLiquidated,
      entryTime: sig.entryTime,
      exitTime,
    };

    activePositions.push({
      symbol: sig.symbol,
      type: sig.type,
      exitTime,
      marginUsdt,
      pnlPct: leveragedPct,
      tradeObj,
    });
  }

  // 释放剩余未结清仓位
  for (const closed of activePositions) {
    const pnlUsdt = closed.marginUsdt * (closed.pnlPct / 100);
    balance += pnlUsdt;
    if (balance > peak) peak = balance;
    const curDd = ((peak - balance) / peak) * 100;
    if (curDd > maxDd) maxDd = curDd;
    closed.tradeObj.pnlUsdt = pnlUsdt;
    closed.tradeObj.isWin = pnlUsdt > 0.001;
    trades.push(closed.tradeObj);
  }

  const wins = trades.filter(t => t.isWin).length;
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
  const gains = trades.filter(t => t.pnlUsdt > 0).reduce((acc, t) => acc + t.pnlUsdt, 0);
  const losses = trades.filter(t => t.pnlUsdt < 0).reduce((acc, t) => acc + Math.abs(t.pnlUsdt), 0);
  const pf = losses > 0 ? gains / losses : (gains > 0 ? Infinity : 1.0);
  const totalReturn = ((balance - 100) / 100) * 100;
  const calmar = maxDd > 0 ? totalReturn / maxDd : 0;
  const liqs = trades.filter(t => t.isLiquidated).length;

  const typeMap: Record<string, any[]> = {};
  for (const t of trades) {
    if (!typeMap[t.type]) typeMap[t.type] = [];
    typeMap[t.type].push(t);
  }

  const subStats: Record<string, any> = {};
  for (const [k, arr] of Object.entries(typeMap)) {
    const sWins = arr.filter(x => x.isWin).length;
    const sGains = arr.filter(x => x.pnlUsdt > 0).reduce((acc, x) => acc + x.pnlUsdt, 0);
    const sLosses = arr.filter(x => x.pnlUsdt < 0).reduce((acc, x) => acc + Math.abs(x.pnlUsdt), 0);
    const sPf = sLosses > 0 ? sGains / sLosses : (sGains > 0 ? Infinity : 1.0);
    const sPnl = arr.reduce((acc, x) => acc + x.pnlUsdt, 0);
    subStats[k] = {
      name: arr[0].name,
      trades: arr.length,
      winRate: `${((sWins / arr.length) * 100).toFixed(1)}%`,
      pf: sPf.toFixed(2),
      pnlUsdt: `${sPnl >= 0 ? '+' : ''}${sPnl.toFixed(2)}U`,
    };
  }

  return {
    streakLeverage: `${streakLeverage}x`,
    trendLeverage: `${trendLeverage}x`,
    trades: trades.length,
    winRate: `${winRate.toFixed(1)}%`,
    pf: pf.toFixed(2),
    totalPnlUsdt: `${balance >= 100 ? '+' : ''}${(balance - 100).toFixed(2)}U`,
    totalReturn: `${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(1)}%`,
    maxDd: `${maxDd.toFixed(1)}%`,
    calmar: calmar.toFixed(2),
    liqs,
    subStats,
  };
}

async function main() {
  console.log('========================================================================================');
  console.log('👑【四大策略联合实盘组合回测】新高背离独立杠杆对比测试');
  console.log('  • 顺势衰竭三大策略: 固定 3x 杠杆 · 10% 大止损 · 90m 长波段 · TP 4%/8% 动态保本');
  console.log('  • 新高顶背离闪击战: 对比 1x, 2x, 3x, 5x, 8x, 10x 独立杠杆');
  console.log('  • 仓位管理: 动态 20% 资产量保证金 (复利风控) · 全局最大 5 仓 · 每策略至多 1 仓 (保证四大策略均可开仓)');
  console.log('========================================================================================\n');

  const minuteData = await loadAllMinutes();
  const hourlyDir = path.resolve('data/research/hourly-168h');
  const hourly = await loadDataset(hourlyDir);
  const frames = buildFrames(hourly, 10, 1);

  const signals = await extractAllSignals(minuteData, frames);
  console.log(`✅ 全系统检测到四大策略有效信号: ${signals.length} 笔`);
  console.log(`   - 新高顶背离 (15m 闪击) : ${signals.filter(s => s.type === 'streak').length} 笔`);
  console.log(`   - 首次跌10% (90m 波段)  : ${signals.filter(s => s.type === 'rebound').length} 笔`);
  console.log(`   - 跌到20%+ (90m 波段)   : ${signals.filter(s => s.type === 'deep_rebound').length} 笔`);
  console.log(`   - 冲高极度乖离 (90m 波段): ${signals.filter(s => s.type === 'extreme_dev').length} 笔\n`);

  // 1. 运行皇冠推荐：动态 20% 资产量 + 全局限仓 5 笔 (严格每策略至多 1 仓，四大策略均衡各持仓 1 笔)
  const dynamicResults: any[] = [];
  const testLeverages = [1, 2, 3, 5, 8, 10, 12, 15];

  for (const lev of testLeverages) {
    dynamicResults.push(runPortfolioSimulation(signals, minuteData, lev, 3, {
      useDynamicMargin: true,
      marginRate: 0.20,
      maxPositions: 5,
      maxPositionsPerStrategy: 1,
    }));
  }

  console.log('========================================================================================');
  console.log('👑【皇冠最优推荐：动态 20% 资产量保证金】(初本 100 USDT · 单笔 20% 资产 · 全局限 5 仓 · 严格每策略 1 仓)');
  console.log('========================================================================================');
  console.table(dynamicResults);

  // 2. 对比固定 20U 保证金模式 (严格每策略至多 1 仓)
  const fixedResults: any[] = [];
  for (const lev of testLeverages) {
    fixedResults.push(runPortfolioSimulation(signals, minuteData, lev, 3, {
      useDynamicMargin: false,
      fixedMarginUsdt: 20.0,
      maxPositions: 5,
      maxPositionsPerStrategy: 1,
    }));
  }

  console.log('\n========================================================================================');
  console.log('📊【固定 20U 保证金模式对比】(单笔固定 20 USDT · 全局限 5 仓 · 严格每策略 1 仓)');
  console.log('========================================================================================');
  console.table(fixedResults);

  // 打印四大子策略在 10x vs 3x 下的细分贡献 (严格每策略至多 1 仓)
  console.log('\n========================================================================================');
  console.log('🔍【四大子策略分项贡献拆解 (动态 20% 仓位 · 新高顶背离 10x vs 3x · 严格每策略 1 仓)】');
  console.log('========================================================================================');
  for (const lev of [3, 5, 10]) {
    const res = runPortfolioSimulation(signals, minuteData, lev, 3, {
      useDynamicMargin: true,
      marginRate: 0.20,
      maxPositions: 5,
      maxPositionsPerStrategy: 1,
    });
    console.log(`\n▶️ 当【新高顶背离】采用 ${lev}x 杠杆 (顺势衰竭保持 3x) 时各子策略明细:`);
    console.table(Object.values(res.subStats));
  }
}

main().catch(console.error);
