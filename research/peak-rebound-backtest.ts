import { MINUTE, type MinuteDataset } from './gainers-types.ts';
import type {
  ExitReason,
  PeakReboundExit,
  PeakReboundMetrics,
  PeakReboundOrder,
  PeakReboundParameters,
  PeakReboundSignal,
  PeakReboundTrade,
} from './peak-rebound-types.ts';

export const FIRST_STAGE_FRACTION = 0.5;

export interface CostOptions {
  takerFeeBps?: number;
  slippageBps?: number;
}

export function calcReturn(
  entryPrice: number,
  exitPrice: number,
  reason: ExitReason,
  costs: CostOptions = {},
) {
  const takerFeeBps = costs.takerFeeBps ?? 5;
  const slippageBps = costs.slippageBps ?? 2;

  // Short position: gross = (entry - exit) / entry * 100
  const grossPercent = ((entryPrice - exitPrice) / entryPrice) * 100;
  const entryFeePercent = takerFeeBps / 100;
  const exitFeePercent = (takerFeeBps / 100) * (exitPrice / entryPrice);
  const slippagePercent = (slippageBps / 100) * (1 + exitPrice / entryPrice);
  const netPercent = grossPercent - entryFeePercent - exitFeePercent - slippagePercent;

  return {
    grossPercent,
    entryFeePercent,
    exitFeePercent,
    slippagePercent,
    netPercent,
  };
}

/** Wilson 95% confidence interval for win rate */
export function wilsonInterval(wins: number, n: number): [number, number] | null {
  if (!n) return null;
  const z = 1.959963984540054;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, center - half) * 100, Math.min(1, center + half) * 100];
}

export function summarizeTrades(
  trades: PeakReboundTrade[],
  orders: PeakReboundOrder[],
  skippedBusy = 0,
  signalCount = orders.length + skippedBusy,
): PeakReboundMetrics {
  const winning = trades.filter((t) => t.netPercent > 0);
  const losing = trades.filter((t) => t.netPercent < 0);
  const breakevens = trades.length - winning.length - losing.length;

  const totalNetPnl = trades.reduce((sum, t) => sum + t.netPercent, 0);
  const totalGrossPnl = trades.reduce((sum, t) => sum + t.grossPercent, 0);
  const totalCosts = trades.reduce((sum, t) => sum + t.entryFeePercent + t.exitFeePercent + t.slippagePercent, 0);

  const grossGains = winning.reduce((sum, t) => sum + t.netPercent, 0);
  const grossLosses = Math.abs(losing.reduce((sum, t) => sum + t.netPercent, 0));

  const meanWin = winning.length ? grossGains / winning.length : null;
  const meanLoss = losing.length ? grossLosses / losing.length : null;
  const realizedRewardRisk = meanWin != null && meanLoss != null && meanLoss > 0 ? meanWin / meanLoss : null;
  const profitFactor = grossLosses > 0 ? grossGains / grossLosses : grossGains > 0 ? Infinity : null;

  const filled = orders.filter((o) => o.entryTime != null).length;

  return {
    signalCount,
    submitted: orders.length,
    filled,
    fillRate: orders.length ? (filled / orders.length) * 100 : null,
    missingAfterFill: orders.filter((o) => o.status === 'missing' && o.entryTime != null).length,
    partialOrders: orders.filter((o) => o.exits.length === 1).length,
    skippedBusy,
    trades: trades.length,
    wins: winning.length,
    losses: losing.length,
    breakevens,
    winRate: trades.length ? (winning.length / trades.length) * 100 : null,
    winRate95: wilsonInterval(winning.length, trades.length),
    grossPnlPercent: totalGrossPnl,
    netPnlPercent: totalNetPnl,
    totalCostsPercent: totalCosts,
    profitFactor,
    meanTradePercent: trades.length ? totalNetPnl / trades.length : null,
    meanWinPercent: meanWin,
    meanLossPercent: meanLoss,
    realizedRewardRisk,
    meanNetR: trades.length ? trades.reduce((sum, t) => sum + t.netR, 0) / trades.length : null,
    firstExits: {
      target: trades.filter((t) => t.exits[0]?.reason === 'target').length,
      stop: trades.filter((t) => t.exits[0]?.reason === 'stop').length,
      timeout: trades.filter((t) => t.exits[0]?.reason === 'timeout').length,
    },
    exits: {
      target: trades.filter((t) => t.reason === 'target').length,
      stop: trades.filter((t) => t.reason === 'stop').length,
      timeout: trades.filter((t) => t.reason === 'timeout').length,
    },
  };
}

export function backtestPeakRebound(
  data: MinuteDataset,
  signals: PeakReboundSignal[],
  p: PeakReboundParameters,
  start: number,
  end: number,
  costs: CostOptions = {},
): { metrics: PeakReboundMetrics; trades: PeakReboundTrade[]; orders: PeakReboundOrder[] } {
  const trades: PeakReboundTrade[] = [];
  const orders: PeakReboundOrder[] = [];
  const available = new Map<string, number>();
  let skippedBusy = 0;
  let signalCount = 0;

  for (const signal of signals) {
    if (signal.time < start || signal.time >= end) continue;
    signalCount++;

    if ((available.get(signal.symbol) ?? -Infinity) > signal.time) {
      skippedBusy++;
      continue;
    }

    const latestExit = signal.time + p.holdMinutes * MINUTE;
    if (latestExit > end) continue;

    const bars = data.candles.get(signal.symbol) ?? [];
    const fillIndex = signal.index + 1;
    const entryBar = bars[fillIndex];

    const order: PeakReboundOrder = {
      signal,
      entryPrice: null,
      status: 'missing',
      resolvedAt: latestExit,
      entryTime: null,
      exits: [],
      remainingFraction: 0,
      entryFeePercent: 0,
    };
    orders.push(order);

    if (!entryBar || entryBar[0] !== signal.time) {
      available.set(signal.symbol, latestExit);
      continue;
    }

    // Market short fill at next minute open
    const entry = entryBar[1];
    order.entryTime = signal.time;
    order.entryPrice = entry;
    order.remainingFraction = 1;
    order.entryFeePercent = (costs.takerFeeBps ?? 5) / 100;

    // Two-stage dynamic levels based on dayChangePercent
    const dayChange = Math.max(10, signal.dayChangePercent);
    const sl1 = dayChange / p.exitX;
    const tp1 = dayChange / p.exitX;
    const sl2 = (dayChange * p.exitN) / p.exitX;
    const tp2 = (dayChange * p.exitM) / p.exitX;

    const levels = [
      { stop: entry * (1 + sl1 / 100), target: entry * (1 - tp1 / 100) },
      { stop: entry * (1 + sl2 / 100), target: entry * (1 - tp2 / 100) },
    ];

    let ambiguous = false;
    order.status = 'missing';
    order.resolvedAt = order.entryTime + p.holdMinutes * MINUTE;

    const closeStage = (exitPrice: number, reason: ExitReason, time: number) => {
      const stage = (order.exits.length + 1) as 1 | 2;
      const fraction = stage === 1 ? FIRST_STAGE_FRACTION : 1 - FIRST_STAGE_FRACTION;
      const returns = calcReturn(entry, exitPrice, reason, costs);

      order.exits.push({
        stage,
        fraction,
        cumulativeClosedPercent: stage === 1 ? 50 : 100,
        exitTime: time + MINUTE,
        exitPrice,
        reason,
        grossPercent: returns.grossPercent * fraction,
        entryFeePercent: returns.entryFeePercent * fraction,
        exitFeePercent: returns.exitFeePercent * fraction,
        slippagePercent: returns.slippagePercent * fraction,
        netPercent: returns.netPercent * fraction,
      });
      order.remainingFraction = stage === 1 ? 1 - fraction : 0;
    };

    for (let offset = 0; offset < p.holdMinutes; offset++) {
      const bar = bars[fillIndex + offset];
      const time = order.entryTime + offset * MINUTE;
      if (!bar || bar[0] !== time) break;

      let canUseOpen = true;
      while (order.exits.length < 2) {
        const { stop, target } = levels[order.exits.length];
        let exit: number | null = null;
        let reason: ExitReason = 'timeout';
        let atOpen = false;

        // Open gap check
        if (canUseOpen && bar[1] >= stop) {
          exit = bar[1];
          reason = 'stop';
          atOpen = true;
        } else if (canUseOpen && bar[1] <= target) {
          exit = bar[1];
          reason = 'target';
          atOpen = true;
        } else {
          // Intraday touch (prioritize stop loss on double-touch)
          if (bar[2] >= stop && bar[3] <= target) ambiguous = true;

          if (bar[2] >= stop) {
            exit = stop;
            reason = 'stop';
          } else if (bar[3] <= target) {
            exit = target;
            reason = 'target';
          }
        }

        if (exit == null) break;
        closeStage(exit, reason, time);
        canUseOpen = atOpen;
      }

      // If hold limit reached and position remains open, close at bar close
      if (offset === p.holdMinutes - 1) {
        while (order.exits.length < 2) {
          closeStage(bar[4], 'timeout', time);
        }
      }

      if (order.exits.length === 2) {
        order.status = 'closed';
        order.resolvedAt = time + MINUTE;

        const totalNetPercent = order.exits.reduce((sum, e) => sum + e.netPercent, 0);
        const totalGrossPercent = order.exits.reduce((sum, e) => sum + e.grossPercent, 0);
        const totalEntryFee = order.exits.reduce((sum, e) => sum + e.entryFeePercent, 0);
        const totalExitFee = order.exits.reduce((sum, e) => sum + e.exitFeePercent, 0);
        const totalSlippage = order.exits.reduce((sum, e) => sum + e.slippagePercent, 0);

        const initialRisk = FIRST_STAGE_FRACTION * sl1 + (1 - FIRST_STAGE_FRACTION) * sl2;

        trades.push({
          signal,
          entryTime: order.entryTime,
          exitTime: order.resolvedAt,
          entryPrice: entry,
          exitPrice: order.exits.reduce((sum, e) => sum + e.exitPrice * e.fraction, 0),
          reason: order.exits[1].reason,
          exits: order.exits,
          ambiguous,
          grossPercent: totalGrossPercent,
          entryFeePercent: totalEntryFee,
          exitFeePercent: totalExitFee,
          slippagePercent: totalSlippage,
          netPercent: totalNetPercent,
          netR: totalNetPercent / initialRisk,
        });
        break;
      }
    }

    available.set(signal.symbol, order.resolvedAt);
  }

  return {
    metrics: summarizeTrades(trades, orders, skippedBusy, signalCount),
    trades,
    orders,
  };
}
