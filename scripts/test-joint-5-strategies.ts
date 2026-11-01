import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import type { MinuteDataset } from '../research/gainers-types.ts';
import { HOUR } from '../research/types.ts';
import { MINUTE } from '../research/gainers-types.ts';
import { calculateSma } from '../research/peak-rebound-signals.ts';
import { computeMacd } from '../src/macd.ts';
import {
  UnifiedShortStrategyTracker,
} from '../src/unified-short-strategy.ts';
import type { Candle } from '../src/macd.ts';

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

export function calcTradeReturn(
  side: 'LONG' | 'SHORT',
  entryPrice: number,
  exitPrice: number,
  costs = { takerFeeBps: 5, slippageBps: 2 }
) {
  const grossPercent =
    side === 'LONG'
      ? ((exitPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - exitPrice) / entryPrice) * 100;

  const entryFeePercent = costs.takerFeeBps / 100;
  const exitFeePercent = (costs.takerFeeBps / 100) * (exitPrice / entryPrice);
  const slippagePercent = (costs.slippageBps / 100) * (1 + exitPrice / entryPrice);
  const netPercent = grossPercent - entryFeePercent - exitFeePercent - slippagePercent;
  return { grossPercent, netPercent };
}

interface SimulatedTrade {
  symbol: string;
  side: 'LONG' | 'SHORT';
  stratType: string;
  stratLabel: string;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  durationMinutes: number;
  dayChange: number;
  netPercent: number;
  reasons: string;
}

interface TestRunResult {
  holdMinutesSetting: number;
  trades: SimulatedTrade[];
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  pf: number;
  maxDrawdown: number;
  avgDuration: number;
  byStrat: Map<string, { total: number; wins: number; netPnl: number; pf: number; label: string }>;
}

async function runJointSimulation(
  holdM: number,
  minuteData: MinuteDataset,
  frames: any[],
  allTimesSorted: number[],
  gainerBoards: Map<number, Map<string, any>>
): Promise<TestRunResult> {
    // Exit parameters: Standard two-stage exit across all durations
    const tp1Long = 3.0, tp2Long = 8.0, slLong = 7.0;
    const tp1Short = 3.5, tp2Short = 8.0, slShort = 7.0;

  // 1. Initialize Short Tracker (3 Shorts: streak 15m, rebound holdM, deep_rebound holdM)
  const shortTracker = new UnifiedShortStrategyTracker({
    preventConflict: true,
    enableStreak: true,      // 1. 新高左侧顶背离 (15m 闪击)
    enableRebound: true,     // 2. 见顶右侧首次跌10%弱反弹
    enableDeepRebound: true, // 3. 见顶右侧跌到20%+次级反弹
    enableExtremeDev: false,
    streakConfig: {
      holdMinutes: 15,
    },
    reboundConfig: {
      holdMinutes: holdM,
      tp1Percent: tp1Short,
      tp2Percent: tp2Short,
      stopLossPercent: slShort,
      moveSlToEntryAfterTp1: true,
    },
    deepReboundConfig: {
      holdMinutes: holdM,
      tp1Percent: tp1Short,
      tp2Percent: tp2Short,
      stopLossPercent: slShort,
      moveSlToEntryAfterTp1: true,
    },
  });

  // Track active positions
  interface ActiveSimPosition {
    symbol: string;
    side: 'LONG' | 'SHORT';
    stratType: string;
    stratLabel: string;
    entryTime: number;
    entryPrice: number;
    tp1Price: number;
    tp2Price: number;
    slPrice: number;
    sl2Price: number;
    st1Done: boolean;
    st2Done: boolean;
    netPnlPercent: number;
    holdDeadline: number;
    reason1?: string;
    reason2?: string;
  }

  const activePositions: ActiveSimPosition[] = [];
  const closedTrades: SimulatedTrade[] = [];
  const symbolCooldown = new Map<string, number>();

  // Map of candles and indicators per symbol
  const candleMap = new Map<string, Candle[]>();
  const macdMap = new Map<string, { dif: number[]; dea: number[]; hist: number[] }>();

  for (const [sym, rawBars] of minuteData.candles) {
    const list: Candle[] = rawBars.map((b: any) => ({
      time: b[0],
      open: b[1],
      high: b[2],
      low: b[3],
      close: b[4],
      volume: b[5],
    }));
    candleMap.set(sym, list);
    macdMap.set(sym, computeMacd(list.map(c => c.close)));
  }

  // Pre-index candles by time
  const timeIndices = new Map<string, Map<number, number>>();
  for (const [sym, list] of candleMap) {
    const idxMap = new Map<number, number>();
    for (let i = 0; i < list.length; i++) idxMap.set(list[i].time, i);
    timeIndices.set(sym, idxMap);
  }

  // Step through every minute
  for (let tIdx = 0; tIdx < allTimesSorted.length; tIdx++) {
    const nowTime = allTimesSorted[tIdx];
    const bTime = Math.floor(nowTime / HOUR) * HOUR;
    const board = gainerBoards.get(bTime);
    if (!board) continue;

    // Rank 1 update for rebound tracker
    let rank1Sym: string | null = null;
    let rank1Gain = 0;
    for (const [sym, row] of board) {
      if (row.rank === 1) {
        rank1Sym = sym;
        rank1Gain = row.dayChange;
        break;
      }
    }
    if (rank1Sym) {
      shortTracker.onRankUpdate(rank1Sym, rank1Gain, nowTime);
    }

    // A. Update Active Positions
    for (let pIdx = activePositions.length - 1; pIdx >= 0; pIdx--) {
      const pos = activePositions[pIdx];
      const sMap = candleMap.get(pos.symbol);
      const cIdx = timeIndices.get(pos.symbol)?.get(nowTime);
      if (sMap && cIdx !== undefined) {
        const curBar = sMap[cIdx];
        const h = curBar.high, l = curBar.low, c = curBar.close;

        if (pos.side === 'LONG') {
          // Check stage 1
          if (!pos.st1Done) {
            if (l <= pos.slPrice) {
              pos.netPnlPercent = calcTradeReturn('LONG', pos.entryPrice, pos.slPrice).netPercent;
              pos.st1Done = true;
              pos.st2Done = true;
              pos.reason1 = 'stop';
              pos.reason2 = 'stop';
            } else if (h >= pos.tp1Price) {
              pos.netPnlPercent += calcTradeReturn('LONG', pos.entryPrice, pos.tp1Price).netPercent * 0.5;
              pos.st1Done = true;
              pos.reason1 = 'target';
              pos.sl2Price = pos.entryPrice; // Lock breakeven
              if (h >= pos.tp2Price) {
                pos.netPnlPercent += calcTradeReturn('LONG', pos.entryPrice, pos.tp2Price).netPercent * 0.5;
                pos.st2Done = true;
                pos.reason2 = 'target';
              }
            }
          }

          // Check stage 2
          if (pos.st1Done && !pos.st2Done) {
            if (l <= pos.sl2Price) {
              pos.netPnlPercent += calcTradeReturn('LONG', pos.entryPrice, pos.sl2Price).netPercent * 0.5;
              pos.st2Done = true;
              pos.reason2 = 'stop';
            } else if (h >= pos.tp2Price) {
              pos.netPnlPercent += calcTradeReturn('LONG', pos.entryPrice, pos.tp2Price).netPercent * 0.5;
              pos.st2Done = true;
              pos.reason2 = 'target';
            }
          }

          // Check timeout or both stages complete
          const isTimeout = nowTime >= pos.holdDeadline;
          if (pos.st2Done || isTimeout) {
            if (isTimeout && !pos.st2Done) {
              const rem = !pos.st1Done ? 1.0 : 0.5;
              pos.netPnlPercent += calcTradeReturn('LONG', pos.entryPrice, c).netPercent * rem;
              if (!pos.reason1) pos.reason1 = 'timeout';
              pos.reason2 = 'timeout';
            }

            shortTracker.closePosition(pos.symbol);
            symbolCooldown.set(pos.symbol, nowTime + 20 * MINUTE);
            closedTrades.push({
              symbol: pos.symbol,
              side: pos.side,
              stratType: pos.stratType,
              stratLabel: pos.stratLabel,
              entryTime: pos.entryTime,
              entryPrice: pos.entryPrice,
              exitTime: nowTime,
              exitPrice: c,
              durationMinutes: Math.round((nowTime - pos.entryTime) / MINUTE),
              dayChange: board.get(pos.symbol)?.dayChange ?? 0,
              netPercent: pos.netPnlPercent,
              reasons: `${pos.reason1 ?? 'none'}/${pos.reason2 ?? 'none'}`,
            });
            activePositions.splice(pIdx, 1);
            continue;
          }
        } else {
          // SHORT position
          if (!pos.st1Done) {
            if (h >= pos.slPrice) {
              pos.netPnlPercent = calcTradeReturn('SHORT', pos.entryPrice, pos.slPrice).netPercent;
              pos.st1Done = true;
              pos.st2Done = true;
              pos.reason1 = 'stop';
              pos.reason2 = 'stop';
            } else if (l <= pos.tp1Price) {
              pos.netPnlPercent += calcTradeReturn('SHORT', pos.entryPrice, pos.tp1Price).netPercent * 0.5;
              pos.st1Done = true;
              pos.reason1 = 'target';
              pos.sl2Price = pos.entryPrice;
              if (l <= pos.tp2Price) {
                pos.netPnlPercent += calcTradeReturn('SHORT', pos.entryPrice, pos.tp2Price).netPercent * 0.5;
                pos.st2Done = true;
                pos.reason2 = 'target';
              }
            }
          }

          if (pos.st1Done && !pos.st2Done) {
            if (h >= pos.sl2Price) {
              pos.netPnlPercent += calcTradeReturn('SHORT', pos.entryPrice, pos.sl2Price).netPercent * 0.5;
              pos.st2Done = true;
              pos.reason2 = 'stop';
            } else if (l <= pos.tp2Price) {
              pos.netPnlPercent += calcTradeReturn('SHORT', pos.entryPrice, pos.tp2Price).netPercent * 0.5;
              pos.st2Done = true;
              pos.reason2 = 'target';
            }
          }

          const isTimeout = nowTime >= pos.holdDeadline;
          if (pos.st2Done || isTimeout) {
            if (isTimeout && !pos.st2Done) {
              const rem = !pos.st1Done ? 1.0 : 0.5;
              pos.netPnlPercent += calcTradeReturn('SHORT', pos.entryPrice, c).netPercent * rem;
              if (!pos.reason1) pos.reason1 = 'timeout';
              pos.reason2 = 'timeout';
            }

            shortTracker.closePosition(pos.symbol);
            symbolCooldown.set(pos.symbol, nowTime + 20 * MINUTE);
            closedTrades.push({
              symbol: pos.symbol,
              side: pos.side,
              stratType: pos.stratType,
              stratLabel: pos.stratLabel,
              entryTime: pos.entryTime,
              entryPrice: pos.entryPrice,
              exitTime: nowTime,
              exitPrice: c,
              durationMinutes: Math.round((nowTime - pos.entryTime) / MINUTE),
              dayChange: board.get(pos.symbol)?.dayChange ?? 0,
              netPercent: pos.netPnlPercent,
              reasons: `${pos.reason1 ?? 'none'}/${pos.reason2 ?? 'none'}`,
            });
            activePositions.splice(pIdx, 1);
            continue;
          }
        }
      }
    }

    // B. Check New Entries (3 Shorts + 2 Longs)
    if (activePositions.length >= 5) continue;

    for (const [sym, row] of board) {
      if (row.rank > 10 || row.dayChange < 20) continue;
      if (activePositions.some(p => p.symbol === sym)) continue;
      if ((symbolCooldown.get(sym) ?? 0) > nowTime) continue;

      const fullBars = candleMap.get(sym);
      const curIdx = timeIndices.get(sym)?.get(nowTime);
      if (!fullBars || curIdx === undefined || curIdx < 45 || curIdx >= fullBars.length - 1) continue;

      const candlesSlice = fullBars.slice(0, curIdx + 2); // closed bar + next forming
      const targetIdx = curIdx;
      const closedBar = fullBars[targetIdx];
      const nextOpen = fullBars[targetIdx + 1]?.open ?? closedBar.close;

      // -------------------------------------------------------------
      // 1. 检查三大做空策略 (3 Shorts: streak, rebound, deep_rebound)
      // -------------------------------------------------------------
      const shortSig = shortTracker.checkCandles(sym, row.dayChange, row.rank, candlesSlice, nowTime);
      if (shortSig) {
        const stratType = shortSig.type;
        const countThisStrat = activePositions.filter(p => p.stratType === stratType).length;
        if (countThisStrat < 1 && activePositions.length < 5) {
          const entryPrice = nextOpen;
          const exitParams = shortSig.exitParams;
          const isStreak = stratType === 'streak';
          const tp1 = isStreak ? (row.dayChange / 50) : (exitParams.tp1Percent ?? tp1Short);
          const tp2 = isStreak ? (row.dayChange * 3.0 / 50) : (exitParams.tp2Percent ?? tp2Short);
          const sl = isStreak ? (row.dayChange * 1.5 / 50) : (exitParams.stopLossPercent ?? slShort);

          activePositions.push({
            symbol: sym,
            side: 'SHORT',
            stratType,
            stratLabel: shortSig.label,
            entryTime: nowTime,
            entryPrice,
            tp1Price: entryPrice * (1 - tp1 / 100),
            tp2Price: entryPrice * (1 - tp2 / 100),
            slPrice: entryPrice * (1 + sl / 100),
            sl2Price: entryPrice * (1 + sl / 100),
            st1Done: false,
            st2Done: false,
            netPnlPercent: 0,
            holdDeadline: nowTime + exitParams.holdMinutes * MINUTE,
          });
          continue;
        }
      }

      // -------------------------------------------------------------
      // 2. 检查两大做多策略 (2 Longs: 右侧回调反弹 + 左侧3W底背离弹射)
      // -------------------------------------------------------------
      const closes = fullBars.map(c => c.close);
      const highs = fullBars.map(c => c.high);
      const lows = fullBars.map(c => c.low);
      const opens = fullBars.map(c => c.open);
      const macd = macdMap.get(sym)!;
      const dif = macd.dif;
      const hist = macd.hist;

      // 做多策略一：【右侧回调反弹做多】 (Right-side Pullback Bounce Long)
      // 龙头冲高见顶后的右侧深蹲/回踩MA30黄金生命线踩稳
      let longSig1 = false;
      const countLong1 = activePositions.filter(p => p.stratType === 'pullback_rebound').length;

      if (countLong1 < 1 && activePositions.length < 5 && row.dayChange >= 25.0) {
        const start24h = Math.max(0, targetIdx - 1439);
        let high24h = 0;
        for (let k = start24h; k <= targetIdx; k++) if (highs[k] > high24h) high24h = highs[k];

        if (high24h > 0) {
          const dropFrom24h = ((high24h - closedBar.close) / high24h) * 100;
          if (dropFrom24h >= 10.0 && dropFrom24h <= 20.0) {
            const ma30 = calculateSma(closes, targetIdx, 30);
            const ma30Prev = calculateSma(closes, targetIdx - 3, 30);
            if (ma30 && ma30Prev && ma30 > ma30Prev) {
              if (closedBar.low <= ma30 * 1.003 && closedBar.close >= ma30 * 0.998) {
                if (dif[targetIdx] > 0) {
                  const range = closedBar.high - closedBar.low;
                  const lowerWick = Math.min(closedBar.open, closedBar.close) - closedBar.low;
                  const isBull = closedBar.close >= closedBar.open;
                  if (isBull || (range > 0 && lowerWick / range >= 0.40)) {
                    longSig1 = true;
                  }
                }
              }
            }
          }
        }
      }

      if (longSig1) {
        const entryPrice = nextOpen;
        activePositions.push({
          symbol: sym,
          side: 'LONG',
          stratType: 'pullback_rebound',
          stratLabel: '右侧回调反弹',
          entryTime: nowTime,
          entryPrice,
          tp1Price: entryPrice * (1 + tp1Long / 100),
          tp2Price: entryPrice * (1 + tp2Long / 100),
          slPrice: entryPrice * (1 - slLong / 100),
          sl2Price: entryPrice * (1 - slLong / 100),
          st1Done: false,
          st2Done: false,
          netPnlPercent: 0,
          holdDeadline: nowTime + holdM * MINUTE,
        });
        continue;
      }

      // 做多策略二：【左侧 3W 底背离弹射做多】 (Left-side 3W Bottom Divergence Catapult Long)
      // 在 10~40 根内构成 W 底 (或 3W 底) 且 MACD 双重强底背离，弹射收阳
      let longSig2 = false;
      const countLong2 = activePositions.filter(p => p.stratType === 'w_bottom_divergence').length;

      if (countLong2 < 1 && activePositions.length < 5) {
        let high30 = 0;
        for (let k = Math.max(0, targetIdx - 30); k <= targetIdx; k++) if (highs[k] > high30) high30 = highs[k];
        const drop30 = high30 > 0 ? ((high30 - closedBar.low) / high30) * 100 : 0;

        if (drop30 >= 4.0) {
          // 寻找前低波谷 (8~25 根前)
          let prevMinIdx = -1, prevMinLow = Infinity;
          for (let k = Math.max(0, targetIdx - 25); k <= targetIdx - 8; k++) {
            if (lows[k] < prevMinLow) {
              prevMinLow = lows[k];
              prevMinIdx = k;
            }
          }

          if (prevMinIdx > 0 && Number.isFinite(prevMinLow)) {
            // 两底之间有波峰反弹构成 W 颈线
            let midPeak = 0;
            for (let k = prevMinIdx; k <= targetIdx; k++) if (highs[k] > midPeak) midPeak = highs[k];
            const midBounce = ((midPeak - prevMinLow) / prevMinLow) * 100;

            if (midBounce >= 1.5) {
              // 第二底平齐或微创新低 (W 底特征)
              if (closedBar.low <= prevMinLow * 1.005 && closedBar.low >= prevMinLow * 0.97) {
                // MACD DIF 快线抬高且 Hist 红柱显著收窄
                if (dif[targetIdx] > dif[prevMinIdx] && hist[targetIdx] > hist[prevMinIdx]) {
                  // 弹射阳线: 收盘突破前一根高点或收出实体阳线
                  if (closedBar.close > closedBar.open && closedBar.close > highs[targetIdx - 1] * 0.999) {
                    longSig2 = true;
                  }
                }
              }
            }
          }
        }
      }

      if (longSig2) {
        const entryPrice = nextOpen;
        activePositions.push({
          symbol: sym,
          side: 'LONG',
          stratType: 'w_bottom_divergence',
          stratLabel: '左侧3W底背离',
          entryTime: nowTime,
          entryPrice,
          tp1Price: entryPrice * (1 + tp1Long / 100),
          tp2Price: entryPrice * (1 + tp2Long / 100),
          slPrice: entryPrice * (1 - slLong / 100),
          sl2Price: entryPrice * (1 - slLong / 100),
          st1Done: false,
          st2Done: false,
          netPnlPercent: 0,
          holdDeadline: nowTime + holdM * MINUTE,
        });
        continue;
      }
    }
  }

  // Calculate statistics
  const totalTrades = closedTrades.length;
  const wins = closedTrades.filter(t => t.netPercent > 0).length;
  const losses = totalTrades - wins;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const netPnl = closedTrades.reduce((a, b) => a + b.netPercent, 0);
  const gains = closedTrades.filter(t => t.netPercent > 0).reduce((a, b) => a + b.netPercent, 0);
  const lossSum = Math.abs(closedTrades.filter(t => t.netPercent < 0).reduce((a, b) => a + b.netPercent, 0));
  const pf = lossSum > 0 ? gains / lossSum : gains > 0 ? 999 : 0;

  let peak = 0, cur = 0, maxDrawdown = 0;
  for (const t of closedTrades) {
    cur += t.netPercent;
    if (cur > peak) peak = cur;
    if (peak - cur > maxDrawdown) maxDrawdown = peak - cur;
  }

  const avgDuration = totalTrades > 0
    ? closedTrades.reduce((a, b) => a + b.durationMinutes, 0) / totalTrades
    : 0;

  const byStrat = new Map<string, { total: number; wins: number; netPnl: number; pf: number; label: string }>();
  for (const t of closedTrades) {
    let s = byStrat.get(t.stratType);
    if (!s) {
      s = { total: 0, wins: 0, netPnl: 0, pf: 0, label: t.stratLabel };
      byStrat.set(t.stratType, s);
    }
    s.total++;
    if (t.netPercent > 0) s.wins++;
    s.netPnl += t.netPercent;
  }
  for (const [type, s] of byStrat) {
    const sTrades = closedTrades.filter(t => t.stratType === type);
    const sGains = sTrades.filter(t => t.netPercent > 0).reduce((a, b) => a + b.netPercent, 0);
    const sLoss = Math.abs(sTrades.filter(t => t.netPercent < 0).reduce((a, b) => a + b.netPercent, 0));
    s.pf = sLoss > 0 ? sGains / sLoss : sGains > 0 ? 999 : 0;
  }

  return {
    holdMinutesSetting: holdM,
    trades: closedTrades,
    totalTrades,
    wins,
    losses,
    winRate,
    netPnl,
    pf,
    maxDrawdown,
    avgDuration,
    byStrat,
  };
}

async function main() {
  console.log('========================================================================================');
  console.log('🏆【3大做空 + 2大做多 协同全真模拟实测】');
  console.log('   做空体系: 新高左侧闪击(streak) + 见顶右侧首次跌10%(rebound) + 跌20%+次级反弹(deep_rebound)');
  console.log('   做多体系: 右侧回调反弹(pullback_rebound) + 左侧3W底背离弹射(w_bottom_divergence)');
  console.log('   风控机制: 全局至多 5 仓，每策略至多 1 仓，两段式止盈，移动保本止损，扣除费率与滑点');
  console.log('========================================================================================\n');

  console.log('载入 168 小时全市场行情数据中...');
  const hourly = await loadDataset(path.resolve('data/research/hourly-168h'));
  const frames = buildFrames(hourly, 10, 1);
  const minuteData = await loadAllMinutes();

  const gainerBoards = new Map<number, Map<string, any>>();
  for (const frame of frames) {
    const gMap = new Map<string, any>();
    for (const obs of frame.boards.gainers) gMap.set(obs.symbol, { rank: obs.rank, dayChange: obs.dayChange });
    gainerBoards.set(frame.time, gMap);
  }

  const allTimeSet = new Set<number>();
  for (const [, bars] of minuteData.candles) {
    for (const b of bars) allTimeSet.add(b[0]);
  }
  const allTimesSorted = Array.from(allTimeSet).sort((a, b) => a - b);
  console.log(`载入完成！共 ${minuteData.candles.size} 个标的，时间跨度包含 ${allTimesSorted.length} 分钟节点。\n`);

  // Test different holding periods: 30m, 45m, 60m, 90m
  const testHoldPeriods = [30, 45, 60, 90];
  const results: TestRunResult[] = [];

  for (const h of testHoldPeriods) {
    console.log(`▶ 正在模拟持仓周期: ${h} 分钟...`);
    const res = await runJointSimulation(h, minuteData, frames, allTimesSorted, gainerBoards);
    results.push(res);
  }

  console.log('\n========================================================================================');
  console.log('📊【3空2多 联合协同全真战绩对照表】');
  console.log('========================================================================================');
  console.log('| 持仓上限 | 总交易数 | 胜率(Win Rate) | 战绩(胜/负) | 累计净收益率 | 盈亏比(PF) | 最大回撤(MDD) | 真实平均持仓 |');
  console.log('| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |');

  for (const r of results) {
    console.log(
      `| ${String(r.holdMinutesSetting + 'm').padStart(7)} | ${String(r.totalTrades).padStart(7)} | ${(r.winRate.toFixed(1) + '%').padStart(14)} | ${String(`${r.wins}W/${r.losses}L`).padStart(11)} | ${(r.netPnl >= 0 ? '+' : '') + r.netPnl.toFixed(2) + '%'} | ${r.pf.toFixed(2).padStart(10)} | ${(r.maxDrawdown.toFixed(2) + '%').padStart(12)} | ${r.avgDuration.toFixed(1)}m |`
    );
  }

  for (const r of results) {
    console.log(`\n----------------------------------------------------------------------------------------`);
    console.log(`🔍【持仓周期 ${r.holdMinutesSetting}m 细分战绩 (3大做空 + 2大做多)】: 综合胜率 ${r.winRate.toFixed(1)}% | 净收益 +${r.netPnl.toFixed(2)}% | PF ${r.pf.toFixed(2)}`);
    console.log(`----------------------------------------------------------------------------------------`);
    console.log('| 策略方向 | 策略类型 | 策略标签 | 交易笔数 | 胜/负 | 胜率 | 净收益贡献 | 盈亏比(PF) |');
    console.log('| :---: | :--- | :--- | :---: | :---: | :---: | :---: | :---: |');

    for (const [type, s] of r.byStrat) {
      const sLoss = s.total - s.wins;
      const sWr = s.total > 0 ? (s.wins / s.total) * 100 : 0;
      const side = type === 'pullback_rebound' || type === 'w_bottom_divergence' ? '🟢 做多' : '🔴 做空';
      console.log(
        `| ${side} | ${type.padEnd(19)} | ${s.label.padEnd(10)} | ${String(s.total).padStart(6)} | ${String(`${s.wins}W/${sLoss}L`).padStart(7)} | ${(sWr.toFixed(1) + '%').padStart(6)} | ${(s.netPnl >= 0 ? '+' : '') + s.netPnl.toFixed(2) + '%'} | ${s.pf.toFixed(2)} |`
      );
    }
  }
}

main().catch(console.error);
