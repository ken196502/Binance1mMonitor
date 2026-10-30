import { MINUTE, type MinuteDataset } from './gainers-types.ts';
import type { ExitReason } from './peak-rebound-types.ts';
import { calcReturn, wilsonInterval } from './peak-rebound-backtest.ts';
import type {
  SurgeShortExitConfig,
  SurgeShortMetrics,
  SurgeShortSignal,
  SurgeShortTrade,
  SurgeShortTradeExit,
} from './surge-short-types.ts';

export interface BacktestOptions {
  takerFeeBps?: number;
  slippageBps?: number;
  maxActivePositions?: number;
}

export function backtestSurgeShort(
  data: MinuteDataset,
  signals: SurgeShortSignal[],
  exitConfig: SurgeShortExitConfig,
  options: BacktestOptions = {},
): { metrics: SurgeShortMetrics; trades: SurgeShortTrade[] } {
  const takerFeeBps = options.takerFeeBps ?? 5;
  const slippageBps = options.slippageBps ?? 2;
  const costs = { takerFeeBps, slippageBps };

  const trades: SurgeShortTrade[] = [];
  const symbolAvailableAt = new Map<string, number>();

  for (const signal of signals) {
    // 检查标的是否在占用中 (同一标的持仓互斥)
    if ((symbolAvailableAt.get(signal.symbol) ?? -Infinity) > signal.time) {
      continue;
    }

    const bars = data.candles.get(signal.symbol);
    if (!bars) continue;

    const fillIndex = signal.index + 1;
    if (fillIndex >= bars.length) continue;

    const entryBar = bars[fillIndex];
    if (!entryBar || entryBar[0] !== signal.time) continue;

    const entryPrice = entryBar[1]; // 下一根 Open 做空
    const entryTime = signal.time;
    const maxExitTime = entryTime + exitConfig.holdMinutes * MINUTE;

    const dayChange = Math.max(10, signal.dayChangePercent);

    // 确定止盈止损线
    let target1: number;
    let stop1: number;
    let target2: number;
    let stop2: number;

    if (exitConfig.exitType === 'two-stage-dynamic') {
      const exitX = exitConfig.exitX ?? 35;
      const exitN = exitConfig.exitN ?? 2.0;
      const exitM = exitConfig.exitM ?? 2.0;

      const tp1Pct = dayChange / exitX;
      const sl1Pct = dayChange / exitX;
      const tp2Pct = (dayChange * exitM) / exitX;
      const sl2Pct = (dayChange * exitN) / exitX;

      target1 = entryPrice * (1 - tp1Pct / 100);
      stop1 = entryPrice * (1 + sl1Pct / 100);
      target2 = entryPrice * (1 - tp2Pct / 100);
      stop2 = entryPrice * (1 + sl2Pct / 100);
    } else if (exitConfig.exitType === 'surge-proportional') {
      const tpPct = signal.surgePercent * (exitConfig.surgeTpRatio ?? 0.5);
      const slPct = signal.surgePercent * (exitConfig.surgeSlRatio ?? 0.5);

      target1 = entryPrice * (1 - tpPct / 100);
      stop1 = entryPrice * (1 + slPct / 100);
      target2 = target1;
      stop2 = stop1;
    } else if (exitConfig.exitType === 'fixed-tp-sl') {
      const tpPct = exitConfig.takeProfitPercent ?? 3.0;
      const slPct = exitConfig.stopLossPercent ?? 2.0;

      target1 = entryPrice * (1 - tpPct / 100);
      stop1 = entryPrice * (1 + slPct / 100);
      target2 = target1;
      stop2 = stop1;
    } else {
      // time-only
      target1 = -Infinity;
      stop1 = Infinity;
      target2 = -Infinity;
      stop2 = Infinity;
    }

    const tradeExits: SurgeShortTradeExit[] = [];
    let remainingFraction = 1.0;
    let finalExitPrice = entryPrice;
    let finalExitTime = entryTime;
    let finalReason: ExitReason = 'timeout';

    // 模拟持仓 K 线推进
    for (let offset = 0; offset < exitConfig.holdMinutes; offset++) {
      const currentIdx = fillIndex + offset;
      if (currentIdx >= bars.length) break;

      const b = bars[currentIdx];
      const barTime = b[0];
      const open = b[1];
      const high = b[2];
      const low = b[3];
      const close = b[4];

      // 处理阶段一 (50% 仓位)
      if (tradeExits.length === 0) {
        let hitStop = false;
        let hitTarget = false;
        let exitPrice = 0;
        let reason: ExitReason = 'timeout';

        if (open >= stop1) {
          hitStop = true;
          exitPrice = open;
          reason = 'stop';
        } else if (open <= target1) {
          hitTarget = true;
          exitPrice = open;
          reason = 'target';
        } else if (high >= stop1 && low <= target1) {
          // 同根 K 线打中止盈止损，保守按止损计
          hitStop = true;
          exitPrice = stop1;
          reason = 'stop';
        } else if (high >= stop1) {
          hitStop = true;
          exitPrice = stop1;
          reason = 'stop';
        } else if (low <= target1) {
          hitTarget = true;
          exitPrice = target1;
          reason = 'target';
        }

        if (hitStop || hitTarget) {
          const fraction = exitConfig.exitType === 'two-stage-dynamic' ? 0.5 : 1.0;
          const ret = calcReturn(entryPrice, exitPrice, reason, costs);
          tradeExits.push({
            stage: 1,
            fraction,
            exitTime: barTime,
            exitPrice,
            reason,
            grossPercent: ret.grossPercent * fraction,
            netPercent: ret.netPercent * fraction,
          });
          remainingFraction -= fraction;
          finalExitPrice = exitPrice;
          finalExitTime = barTime;
          finalReason = reason;

          if (remainingFraction <= 0) break;
        }
      }

      // 处理阶段二 (剩余 50% 仓位)
      if (tradeExits.length === 1 && remainingFraction > 0) {
        let hitStop = false;
        let hitTarget = false;
        let exitPrice = 0;
        let reason: ExitReason = 'timeout';

        if (open >= stop2) {
          hitStop = true;
          exitPrice = open;
          reason = 'stop';
        } else if (open <= target2) {
          hitTarget = true;
          exitPrice = open;
          reason = 'target';
        } else if (high >= stop2 && low <= target2) {
          hitStop = true;
          exitPrice = stop2;
          reason = 'stop';
        } else if (high >= stop2) {
          hitStop = true;
          exitPrice = stop2;
          reason = 'stop';
        } else if (low <= target2) {
          hitTarget = true;
          exitPrice = target2;
          reason = 'target';
        }

        if (hitStop || hitTarget) {
          const fraction = remainingFraction;
          const ret = calcReturn(entryPrice, exitPrice, reason, costs);
          tradeExits.push({
            stage: 2,
            fraction,
            exitTime: barTime,
            exitPrice,
            reason,
            grossPercent: ret.grossPercent * fraction,
            netPercent: ret.netPercent * fraction,
          });
          remainingFraction = 0;
          finalExitPrice = exitPrice;
          finalExitTime = barTime;
          finalReason = reason;
          break;
        }
      }

      // 达到最长持仓超时强制市价平仓
      if (offset === exitConfig.holdMinutes - 1 && remainingFraction > 0) {
        const exitPrice = close;
        const ret = calcReturn(entryPrice, exitPrice, 'timeout', costs);
        tradeExits.push({
          stage: tradeExits.length === 0 ? 1 : 2,
          fraction: remainingFraction,
          exitTime: barTime,
          exitPrice,
          reason: 'timeout',
          grossPercent: ret.grossPercent * remainingFraction,
          netPercent: ret.netPercent * remainingFraction,
        });
        remainingFraction = 0;
        finalExitPrice = exitPrice;
        finalExitTime = barTime;
        finalReason = 'timeout';
        break;
      }
    }

    if (tradeExits.length === 0) continue;

    // 汇总该笔交易收益
    const totalGross = tradeExits.reduce((sum, e) => sum + e.grossPercent, 0);
    const totalNet = tradeExits.reduce((sum, e) => sum + e.netPercent, 0);
    const entryFee = (costs.takerFeeBps / 100);
    const exitFee = (costs.takerFeeBps / 100) * (finalExitPrice / entryPrice);
    const slippage = (costs.slippageBps / 100) * (1 + finalExitPrice / entryPrice);

    trades.push({
      symbol: signal.symbol,
      entryTime,
      entryPrice,
      exitTime: finalExitTime,
      exitPrice: finalExitPrice,
      durationMinutes: Math.round((finalExitTime - entryTime) / MINUTE),
      dayChangePercent: signal.dayChangePercent,
      surgePercent: signal.surgePercent,
      requiredSurge: signal.requiredSurgePercent,
      maDev: signal.ma30DeviationPercent,
      reason: finalReason,
      grossPercent: totalGross,
      netPercent: totalNet,
      entryFeePercent: entryFee,
      exitFeePercent: exitFee,
      slippagePercent: slippage,
      exits: tradeExits,
    });

    // 释放标的占用
    symbolAvailableAt.set(signal.symbol, finalExitTime);
  }

  // 计算综合统计指标
  const winning = trades.filter((t) => t.netPercent > 0);
  const losing = trades.filter((t) => t.netPercent < 0);
  const breakeven = trades.length - winning.length - losing.length;

  const grossPnl = trades.reduce((sum, t) => sum + t.grossPercent, 0);
  const netPnl = trades.reduce((sum, t) => sum + t.netPercent, 0);

  const grossWins = winning.reduce((sum, t) => sum + t.netPercent, 0);
  const grossLosses = Math.abs(losing.reduce((sum, t) => sum + t.netPercent, 0));

  const winRate = trades.length ? (winning.length / trades.length) * 100 : 0;
  const winRate95 = wilsonInterval(winning.length, trades.length);
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : null;

  const meanTrade = trades.length ? netPnl / trades.length : 0;
  const meanWin = winning.length ? grossWins / winning.length : 0;
  const meanLoss = losing.length ? grossLosses / losing.length : 0;
  const rewardRisk = meanLoss > 0 ? meanWin / meanLoss : null;

  // 最大回撤
  let peakEquity = 0;
  let cumPnl = 0;
  let maxDd = 0;
  for (const t of trades) {
    cumPnl += t.netPercent;
    if (cumPnl > peakEquity) peakEquity = cumPnl;
    const dd = peakEquity - cumPnl;
    if (dd > maxDd) maxDd = dd;
  }

  const exitReasons: Record<string, number> = {};
  for (const t of trades) {
    exitReasons[t.reason] = (exitReasons[t.reason] ?? 0) + 1;
  }

  const metrics: SurgeShortMetrics = {
    totalTrades: trades.length,
    winCount: winning.length,
    lossCount: losing.length,
    breakevenCount: breakeven,
    winRate,
    winRate95,
    grossPnlPercent: grossPnl,
    netPnlPercent: netPnl,
    profitFactor,
    meanTradePercent: meanTrade,
    meanWinPercent: meanWin,
    meanLossPercent: meanLoss,
    rewardRiskRatio: rewardRisk,
    maxDrawdownPercent: maxDd,
    exitReasons,
  };

  return { metrics, trades };
}
