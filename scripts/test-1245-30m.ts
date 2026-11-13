import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import type { MinuteDataset } from '../research/gainers-types.ts';
import { calculateSma } from '../research/peak-rebound-signals.ts';
import { computeMacd } from '../src/macd.ts';
import { UnifiedShortStrategyTracker } from '../src/unified-short-strategy.ts';
import type { Candle } from '../src/macd.ts';

const MINUTE = 60000;

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

async function run1245Backtest() {
  console.log('========================================================================================');
  console.log('🚀【策略 1, 2, 4, 5 (剔除第3项右侧回调反弹) 最大 30m 持仓实测回测】');
  console.log('   策略 1: 左侧3W底背离弹射做多 (w_bottom_divergence, 3x, 30m持仓)');
  console.log('   策略 2: 首次跌10%弱反弹做空 (rebound, 3x, 30m持仓)');
  console.log('   策略 4: 新高左侧顶背离闪击做空 (streak, 10x, 15m闪击)');
  console.log('   策略 5: 跌到20%+次级反弹做空 (deep_rebound, 3x, 30m持仓)');
  console.log('   (已彻底排除策略 3: 右侧回调反弹做多 pullback_rebound)');
  console.log('   仓位规则: 全局至多 4 仓，每策略限 1 仓，单笔 25% 保证金，两段式止盈，移动保本，扣除费率与滑点');
  console.log('========================================================================================\n');

  console.log('载入 168 小时行情数据中...');
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

  const syms = Array.from(minuteData.candles.keys());

  // 预计算 MACD
  const macdMap = new Map<string, { dif: number[]; dea: number[]; hist: number[] }>();
  for (const sym of syms) {
    const bars = minuteData.candles.get(sym)!;
    const closes = bars.map(b => b[4]);
    macdMap.set(sym, computeMacd(closes));
  }

  // 建立快速索引
  const candleMap = new Map<string, Candle[]>();
  const timeIndices = new Map<string, Map<number, number>>();

  for (const sym of syms) {
    const rawBars = minuteData.candles.get(sym)!;
    const cList: Candle[] = [];
    const tMap = new Map<number, number>();
    for (let idx = 0; idx < rawBars.length; idx++) {
      const b = rawBars[idx];
      cList.push({ time: b[0], open: b[1], high: b[2], low: b[3], close: b[4], volume: b[5] });
      tMap.set(b[0], idx);
    }
    candleMap.set(sym, cList);
    timeIndices.set(sym, tMap);
  }

  const holdM = 30; // 最大 30 分钟持仓
  const tp1Long = 3.0, tp2Long = 8.0, slLong = 3.5, sl2Long = 7.0;
  const tp1Short = 3.5, tp2Short = 8.0, slShort = 3.5, sl2Short = 7.0;

  // 1, 2, 4, 5 Tracker:
  // 策略 1: 左侧3W底背离弹射做多 (w_bottom_divergence)
  // 策略 2: 首次跌10%弱反弹做空 (rebound)
  // (策略 3: 右侧回调反弹做多 pullback_rebound 已排除)
  // 策略 4: 新高顶背离闪击做空 (streak)
  // 策略 5: 跌到20%+次级反弹做空 (deep_rebound)
  const shortTracker = new UnifiedShortStrategyTracker({
    preventConflict: true,
    enableStreak: true,      // 策略 4. 新高顶背离闪击 (15m)
    enableRebound: true,     // 策略 2. 首次跌10%弱反弹 (30m)
    enableDeepRebound: true, // 策略 5. 跌到20%+次级反弹 (30m)
    enableExtremeDev: false,
    streakConfig: { holdMinutes: 15 },
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
  const closedTrades: any[] = [];
  const symbolCooldown = new Map<string, number>();

  let peakEquity = 100;
  let currentEquity = 100;
  let maxDrawdown = 0;

  // Step through every minute
  for (let tIdx = 0; tIdx < allTimesSorted.length; tIdx++) {
    const nowTime = allTimesSorted[tIdx];
    const bTime = Math.floor(nowTime / (60 * MINUTE)) * (60 * MINUTE);
    const board = gainerBoards.get(bTime);
    if (!board) continue;

    let rank1Sym: string | null = null, rank1Gain = 0;
    for (const [sym, row] of board) {
      if (row.rank === 1) { rank1Sym = sym; rank1Gain = row.dayChange; break; }
    }
    if (rank1Sym) shortTracker.onRankUpdate(rank1Sym, rank1Gain, nowTime);

    // 仓位状态轮询与撮合
    for (let pIdx = activePositions.length - 1; pIdx >= 0; pIdx--) {
      const pos = activePositions[pIdx];
      const sMap = candleMap.get(pos.symbol);
      const cIdx = timeIndices.get(pos.symbol)?.get(nowTime);
      if (sMap && cIdx !== undefined) {
        const curBar = sMap[cIdx];
        const h = curBar.high, l = curBar.low, c = curBar.close;

        if (pos.side === 'LONG') {
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
              pos.sl2Price = pos.entryPrice;
              if (h >= pos.tp2Price) {
                pos.netPnlPercent += calcTradeReturn('LONG', pos.entryPrice, pos.tp2Price).netPercent * 0.5;
                pos.st2Done = true;
                pos.reason2 = 'target';
              }
            }
          }

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

            // 更新净值曲线与最大回撤
            const marginFraction = 0.25; // 4 仓各 25%
            currentEquity *= (1 + (pos.netPnlPercent / 100) * marginFraction);
            if (currentEquity > peakEquity) peakEquity = currentEquity;
            const dd = ((peakEquity - currentEquity) / peakEquity) * 100;
            if (dd > maxDrawdown) maxDrawdown = dd;

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
              netPercent: pos.netPnlPercent,
              reasons: `${pos.reason1 ?? 'none'}/${pos.reason2 ?? 'none'}`,
            });
            activePositions.splice(pIdx, 1);
            continue;
          }
        } else {
          // SHORT
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

            const marginFraction = 0.25;
            currentEquity *= (1 + (pos.netPnlPercent / 100) * marginFraction);
            if (currentEquity > peakEquity) peakEquity = currentEquity;
            const dd = ((peakEquity - currentEquity) / peakEquity) * 100;
            if (dd > maxDrawdown) maxDrawdown = dd;

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
              netPercent: pos.netPnlPercent,
              reasons: `${pos.reason1 ?? 'none'}/${pos.reason2 ?? 'none'}`,
            });
            activePositions.splice(pIdx, 1);
            continue;
          }
        }
      }
    }

    if (activePositions.length >= 4) continue;

    // 检查新入场 (1, 2, 4, 5)
    for (const [sym, row] of board) {
      if (row.rank > 10 || row.dayChange < 20) continue;
      if (activePositions.some(p => p.symbol === sym)) continue;
      if ((symbolCooldown.get(sym) ?? 0) > nowTime) continue;

      const fullBars = candleMap.get(sym);
      const curIdx = timeIndices.get(sym)?.get(nowTime);
      if (!fullBars || curIdx === undefined || curIdx < 45 || curIdx >= fullBars.length - 1) continue;

      const candlesSlice = fullBars.slice(0, curIdx + 2);
      const targetIdx = curIdx;
      const closedBar = fullBars[targetIdx];
      const nextOpen = fullBars[targetIdx + 1]?.open ?? closedBar.close;

      // 1 & 2: 做空 (streak + rebound)
      const shortSig = shortTracker.checkCandles(sym, row.dayChange, row.rank, candlesSlice, nowTime);
      if (shortSig) {
        const stratType = shortSig.type;
        const countThisStrat = activePositions.filter(p => p.stratType === stratType).length;
        if (countThisStrat < 1 && activePositions.length < 4) {
          const entryPrice = nextOpen;
          const exitParams = shortSig.exitParams;
          const isStreak = stratType === 'streak';
          const tp1 = isStreak ? (row.dayChange / 50) : (exitParams.tp1Percent ?? tp1Short);
          const tp2 = isStreak ? (row.dayChange / 25) : (exitParams.tp2Percent ?? tp2Short);
          const sl = isStreak ? (row.dayChange / 50) : (exitParams.stopLossPercent ?? slShort);
          const sl2 = isStreak ? (row.dayChange / 25) : (exitParams.stopLoss2Percent ?? (exitParams.stopLossPercent ? exitParams.stopLossPercent * 2 : slShort * 2));
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
            sl2Price: entryPrice * (1 + sl2 / 100),
            st1Done: false,
            st2Done: false,
            netPnlPercent: 0,
            holdDeadline: nowTime + exitParams.holdMinutes * MINUTE,
          });
          continue;
        }
      }

      // 策略 1: 【左侧 3W 底背离弹射做多】 (w_bottom_divergence)
      // (注: 策略 3 右侧回调反弹已剔除)
      const closes = fullBars.map(c => c.close);
      const highs = fullBars.map(c => c.high);
      const lows = fullBars.map(c => c.low);
      const opens = fullBars.map(c => c.open);
      const macd = macdMap.get(sym)!;
      const dif = macd.dif;
      const hist = macd.hist;

      let longSig1 = false;
      const countLong1 = activePositions.filter(p => p.stratType === 'w_bottom_divergence').length;
      if (countLong1 < 1 && activePositions.length < 4 && row.dayChange >= 20.0) {
        let high30 = 0;
        for (let k = Math.max(0, targetIdx - 30); k <= targetIdx; k++) if (highs[k] > high30) high30 = highs[k];
        const drop30 = high30 > 0 ? ((high30 - closedBar.low) / high30) * 100 : 0;
        if (drop30 >= 4.0) {
          let prevMinIdx = -1, prevMinLow = Infinity;
          for (let k = Math.max(0, targetIdx - 25); k <= targetIdx - 8; k++) {
            if (lows[k] < prevMinLow) { prevMinLow = lows[k]; prevMinIdx = k; }
          }
          if (prevMinIdx > 0 && Number.isFinite(prevMinLow)) {
            let midPeak = 0;
            for (let k = prevMinIdx; k <= targetIdx; k++) if (highs[k] > midPeak) midPeak = highs[k];
            const midBounce = ((midPeak - prevMinLow) / prevMinLow) * 100;
            if (midBounce >= 1.5) {
              let midMin = Infinity;
              for (let k = prevMinIdx; k <= targetIdx; k++) if (lows[k] < midMin) midMin = lows[k];
              // 严格过滤底部不断降低：当前低点与中途最低均不破前底 (0.2%微弱误差容忍)
              if (closedBar.low <= prevMinLow * 1.005 && closedBar.low >= prevMinLow * 0.998 && midMin >= prevMinLow * 0.998) {
                if (dif[targetIdx] > dif[prevMinIdx] && hist[targetIdx] > hist[prevMinIdx]) {
                  const prevBar = fullBars[targetIdx - 1];
                  if (prevBar && closedBar.close > closedBar.open && closedBar.close > prevBar.high * 0.999) {
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
          stratType: 'w_bottom_divergence',
          stratLabel: '左侧3W底背离',
          entryTime: nowTime,
          entryPrice,
          tp1Price: entryPrice * (1 + tp1Long / 100),
          tp2Price: entryPrice * (1 + tp2Long / 100),
          slPrice: entryPrice * (1 - slLong / 100),
          sl2Price: entryPrice * (1 - sl2Long / 100),
          st1Done: false,
          st2Done: false,
          netPnlPercent: 0,
          holdDeadline: nowTime + holdM * MINUTE,
        });
        continue;
      }
    }
  }

  // 结算汇总
  let totalNet = 0, grossGains = 0, grossLosses = 0, wins = 0;
  let totalDuration = 0;
  const stratStats = new Map<string, { total: number; wins: number; netPnl: number; grossG: number; grossL: number; label: string; totalDur: number }>();

  for (const tr of closedTrades) {
    totalNet += tr.netPercent;
    totalDuration += tr.durationMinutes;
    if (tr.netPercent > 0) { wins++; grossGains += tr.netPercent; }
    else { grossLosses += Math.abs(tr.netPercent); }

    let st = stratStats.get(tr.stratType);
    if (!st) { st = { total: 0, wins: 0, netPnl: 0, grossG: 0, grossL: 0, label: tr.stratLabel, totalDur: 0 }; stratStats.set(tr.stratType, st); }
    st.total++;
    st.netPnl += tr.netPercent;
    st.totalDur += tr.durationMinutes;
    if (tr.netPercent > 0) { st.wins++; st.grossG += tr.netPercent; }
    else { st.grossL += Math.abs(tr.netPercent); }
  }

  const pf = grossLosses > 0 ? grossGains / grossLosses : 999;
  const wr = closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0;
  const avgDur = closedTrades.length > 0 ? totalDuration / closedTrades.length : 0;

  console.log('========================================================================================');
  console.log('📊【1245 最大 30m 持仓实测总战绩】');
  console.log('========================================================================================');
  console.log(`总交易笔数: ${closedTrades.length} 笔`);
  console.log(`综合胜率: ${wr.toFixed(1)}% (${wins} 胜 / ${closedTrades.length - wins} 负)`);
  console.log(`累计净收益率: +${totalNet.toFixed(2)}%`);
  console.log(`盈亏比 (Profit Factor): ${pf.toFixed(2)}`);
  console.log(`最大回撤 (MDD): ${maxDrawdown.toFixed(2)}%`);
  console.log(`真实平均持仓周期: ${avgDur.toFixed(1)} 分钟`);
  console.log('----------------------------------------------------------------------------------------');
  console.log('🔍【各策略细分战绩贡献表】:');
  console.log('----------------------------------------------------------------------------------------');
  for (const [stType, st] of stratStats) {
    const stWr = (st.wins / st.total) * 100;
    const stPf = st.grossL > 0 ? st.grossG / st.grossL : 999;
    const stAvgDur = st.totalDur / st.total;
    const sign = st.netPnl >= 0 ? '+' : '';
    console.log(`• [${st.label}] (${stType}): ${st.total} 笔 | 胜率 ${stWr.toFixed(1)}% (${st.wins}W/${st.total - st.wins}L) | 净收益 ${sign}${st.netPnl.toFixed(2)}% | PF: ${stPf.toFixed(2)} | 平均持仓: ${stAvgDur.toFixed(1)}m`);
  }
  console.log('========================================================================================\n');
}

run1245Backtest();
