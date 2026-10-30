import { MINUTE, type MinuteDataset } from './gainers-types.ts';
import type { ExitReason } from './peak-rebound-types.ts';
import { calcReturn, wilsonInterval } from './peak-rebound-backtest.ts';
import type { GroupShortSignal } from './surge-signal-group-types.ts';

export interface GroupTradeExit {
  stage: 1 | 2;
  fraction: number;
  exitTime: number;
  exitPrice: number;
  reason: ExitReason;
  grossPercent: number;
  netPercent: number;
}

export interface GroupTrade {
  subStrategyId: string;
  subStrategyName: string;
  symbol: string;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  durationMinutes: number;
  dayChangePercent: number;
  surgePercent: number;
  requiredSurge: number;
  reason: ExitReason;
  grossPercent: number;
  netPercent: number;
  exits: GroupTradeExit[];
}

export interface GroupBacktestMetrics {
  totalTrades: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  winRate95: [number, number] | null;
  grossPnlPercent: number;
  netPnlPercent: number;
  profitFactor: number | null;
  meanTradePercent: number;
  meanWinPercent: number;
  meanLossPercent: number;
  maxDrawdownPercent: number;
  bySubStrategy: Record<
    string,
    {
      name: string;
      trades: number;
      wins: number;
      losses: number;
      winRate: number;
      netPnl: number;
      profitFactor: number | null;
    }
  >;
}

export function backtestGroupSignals(
  data: MinuteDataset,
  signals: GroupShortSignal[],
  options: { takerFeeBps?: number; slippageBps?: number } = {},
): { metrics: GroupBacktestMetrics; trades: GroupTrade[] } {
  const takerFeeBps = options.takerFeeBps ?? 5;
  const slippageBps = options.slippageBps ?? 2;
  const costs = { takerFeeBps, slippageBps };

  const trades: GroupTrade[] = [];
  const occupiedUntil = new Map<string, number>();

  for (const sig of signals) {
    if ((occupiedUntil.get(sig.symbol) ?? -Infinity) > sig.time) {
      continue;
    }

    const bars = data.candles.get(sig.symbol);
    if (!bars) continue;

    const fillIndex = sig.index + 1;
    if (fillIndex >= bars.length) continue;

    const entryBar = bars[fillIndex];
    if (!entryBar || entryBar[0] !== sig.time) continue;

    const entryPrice = entryBar[1]; // 下一根 Open 做空
    const entryTime = sig.time;
    const { holdMinutes, exitX, exitN, exitM } = sig.exitParams;

    const dayChange = Math.max(10, sig.dayChangePercent);

    // 两段式退出计算
    const tp1Pct = dayChange / exitX;
    const sl1Pct = dayChange / exitX;
    const tp2Pct = (dayChange * exitM) / exitX;
    const sl2Pct = (dayChange * exitN) / exitX;

    const target1 = entryPrice * (1 - tp1Pct / 100);
    const stop1 = entryPrice * (1 + sl1Pct / 100);
    const target2 = entryPrice * (1 - tp2Pct / 100);
    const stop2 = entryPrice * (1 + sl2Pct / 100);

    const tradeExits: GroupTradeExit[] = [];
    let remainingFraction = 1.0;
    let finalExitPrice = entryPrice;
    let finalExitTime = entryTime;
    let finalReason: ExitReason = 'timeout';

    for (let offset = 0; offset < holdMinutes; offset++) {
      const curIdx = fillIndex + offset;
      if (curIdx >= bars.length) break;

      const b = bars[curIdx];
      const barTime = b[0];
      const open = b[1];
      const high = b[2];
      const low = b[3];
      const close = b[4];

      // 阶段一 (50%)
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
          const fraction = 0.5;
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
        }
      }

      // 阶段二 (剩余 50%)
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

      // 超时平仓
      if (offset === holdMinutes - 1 && remainingFraction > 0) {
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

    const totalGross = tradeExits.reduce((sum, e) => sum + e.grossPercent, 0);
    const totalNet = tradeExits.reduce((sum, e) => sum + e.netPercent, 0);

    trades.push({
      subStrategyId: sig.subStrategyId,
      subStrategyName: sig.subStrategyName,
      symbol: sig.symbol,
      entryTime,
      entryPrice,
      exitTime: finalExitTime,
      exitPrice: finalExitPrice,
      durationMinutes: Math.round((finalExitTime - entryTime) / MINUTE),
      dayChangePercent: sig.dayChangePercent,
      surgePercent: sig.surgePercent,
      requiredSurge: sig.requiredSurgePercent,
      reason: finalReason,
      grossPercent: totalGross,
      netPercent: totalNet,
      exits: tradeExits,
    });

    occupiedUntil.set(sig.symbol, finalExitTime);
  }

  // 统计指标
  const winning = trades.filter((t) => t.netPercent > 0);
  const losing = trades.filter((t) => t.netPercent < 0);

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

  let peakEquity = 0;
  let cumPnl = 0;
  let maxDd = 0;
  for (const t of trades) {
    cumPnl += t.netPercent;
    if (cumPnl > peakEquity) peakEquity = cumPnl;
    const dd = peakEquity - cumPnl;
    if (dd > maxDd) maxDd = dd;
  }

  // 按子策略细分
  const bySubStrategy: GroupBacktestMetrics['bySubStrategy'] = {};
  for (const t of trades) {
    if (!bySubStrategy[t.subStrategyId]) {
      bySubStrategy[t.subStrategyId] = {
        name: t.subStrategyName,
        trades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        netPnl: 0,
        profitFactor: null,
      };
    }
    const stat = bySubStrategy[t.subStrategyId];
    stat.trades++;
    if (t.netPercent > 0) stat.wins++;
    else stat.losses++;
    stat.netPnl += t.netPercent;
  }

  for (const id of Object.keys(bySubStrategy)) {
    const stat = bySubStrategy[id];
    stat.winRate = stat.trades ? (stat.wins / stat.trades) * 100 : 0;
    const subWins = trades.filter((t) => t.subStrategyId === id && t.netPercent > 0).reduce((s, t) => s + t.netPercent, 0);
    const subLoss = Math.abs(trades.filter((t) => t.subStrategyId === id && t.netPercent < 0).reduce((s, t) => s + t.netPercent, 0));
    stat.profitFactor = subLoss > 0 ? subWins / subLoss : subWins > 0 ? Infinity : null;
  }

  return {
    metrics: {
      totalTrades: trades.length,
      winCount: winning.length,
      lossCount: losing.length,
      winRate,
      winRate95,
      grossPnlPercent: grossPnl,
      netPnlPercent: netPnl,
      profitFactor,
      meanTradePercent: meanTrade,
      meanWinPercent: meanWin,
      meanLossPercent: meanLoss,
      maxDrawdownPercent: maxDd,
      bySubStrategy,
    },
    trades,
  };
}
