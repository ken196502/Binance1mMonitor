import { summarize } from './backtest.ts';
import { MINUTE, type MinuteDataset } from './gainers-types.ts';
import { WICK_FIRST_CLOSE_FRACTION, type WickConfig, type WickParameters } from './wick-config.ts';
import type { WickSignal } from './wick-signals.ts';

export type WickExitReason = 'stop' | 'target' | 'timeout';
export interface WickExit {
  stage: 1 | 2;
  fraction: number; // Fraction of original quantity, never of the remaining quantity.
  cumulativeClosedPercent: 50 | 100;
  exitTime: number;
  exitPrice: number;
  reason: WickExitReason;
  grossPercent: number;
  entryFeePercent: number;
  exitFeePercent: number;
  slippagePercent: number;
  netPercent: number; // Contribution relative to initial notional.
}
export interface WickTrade {
  signal: WickSignal;
  entryTime: number; // Entry minute open, not a claimed tick-accurate fill time.
  exitTime: number; // Exit minute close.
  entryPrice: number;
  exitPrice: number;
  reason: WickExitReason; // Final exit reason; the first exit may have a different reason.
  exits: WickExit[];
  ambiguous: boolean;
  ignoredUnorderedTarget: boolean;
  grossPercent: number;
  entryFeePercent: number;
  exitFeePercent: number;
  slippagePercent: number;
  netPercent: number;
  netR: number;
}
export interface WickOrder {
  signal: WickSignal;
  entryPrice: number | null;
  status: 'closed' | 'missing';
  resolvedAt: number;
  entryTime: number | null;
  exits: WickExit[];
  remainingFraction: number;
  entryFeePercent: number; // Full entry charge, including positions with incomplete exit data.
}

export function wickReturn(entry: number, exit: number, reason: WickTrade['reason'], c: WickConfig) {
  const grossPercent = (entry - exit) / entry * 100;
  const entryFeePercent = c.takerFeeBps / 100;
  const exitFeePercent = c.takerFeeBps / 100 * exit / entry;
  // Market entry and each market exit pay slippage on their own notionals.
  const slippagePercent = c.slippageBps / 100 * (1 + exit / entry);
  return { grossPercent, entryFeePercent, exitFeePercent, slippagePercent,
    netPercent: grossPercent - entryFeePercent - exitFeePercent - slippagePercent };
}

export function plannedWickReward(p: WickParameters, c: WickConfig, dayChangePercent = 20) {
  const tp1 = p.exitX != null ? (dayChangePercent / p.exitX) : (p.firstTakeProfitPercent ?? 0.1);
  const sl1 = p.exitX != null ? (dayChangePercent / p.exitX) : (p.firstStopLossPercent ?? 0.1);
  const sl2 = p.exitX != null && p.exitN != null ? (dayChangePercent * p.exitN / p.exitX) : (p.finalStopLossPercent ?? 0.2);
  const tp2 = p.exitX != null && p.exitM != null ? (dayChangePercent * p.exitM / p.exitX) : (p.finalTakeProfitPercent ?? 0.5);
  const firstWin = wickReturn(100, 100 - tp1, 'target', c).netPercent;
  const firstLoss = wickReturn(100, 100 + sl1, 'stop', c).netPercent;
  const finalWin = wickReturn(100, 100 - tp2, 'target', c).netPercent;
  const finalLoss = wickReturn(100, 100 + sl2, 'stop', c).netPercent;
  const f = WICK_FIRST_CLOSE_FRACTION;
  const bothTargets = f * firstWin + (1 - f) * finalWin;
  const bothStops = f * firstLoss + (1 - f) * finalLoss;
  return { bothTargetsNetPercent: bothTargets, bothStopsNetPercent: bothStops,
    firstTargetFinalStopNetPercent: f * firstWin + (1 - f) * finalLoss,
    firstStopFinalTargetNetPercent: f * firstLoss + (1 - f) * finalWin,
    nominalRewardRisk: (f * tp1 + (1 - f) * tp2) / (f * sl1 + (1 - f) * sl2),
    netRewardRisk: bothTargets > 0 ? bothTargets / -bothStops : null };
}

/** Wilson interval is descriptive; repeated signals/symbols need not be independent. */
export function wilsonInterval(wins: number, n: number): [number, number] | null {
  if (!n) return null;
  const z = 1.959963984540054, p = wins / n, d = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / d;
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, center - half) * 100, Math.min(1, center + half) * 100];
}

export function summarizeWick(trades: WickTrade[], orders: WickOrder[], purged = 0, skippedBusy = 0, signalCount = orders.length + purged + skippedBusy) {
  const base = summarize(trades, orders.filter(o => o.status === 'missing').length, purged);
  const winning = trades.filter(t => t.netPercent > 0), losing = trades.filter(t => t.netPercent < 0);
  const meanWinPercent = winning.length ? winning.reduce((n, t) => n + t.netPercent, 0) / winning.length : null;
  const meanLossPercent = losing.length ? -losing.reduce((n, t) => n + t.netPercent, 0) / losing.length : null;
  const filled = orders.filter(o => o.entryTime != null).length;
  return { ...base, signalCount, submitted: orders.length, filled, fillRate: orders.length ? filled / orders.length * 100 : null,
    missingAfterFill: orders.filter(o => o.status === 'missing' && o.entryTime != null).length,
    partialOrders: orders.filter(o => o.exits.length === 1).length,
    firstExits: { target: trades.filter(t => t.exits[0].reason === 'target').length, stop: trades.filter(t => t.exits[0].reason === 'stop').length, timeout: trades.filter(t => t.exits[0].reason === 'timeout').length },
    firstTargetFinalStop: trades.filter(t => t.exits[0].reason === 'target' && t.reason === 'stop').length,
    firstStopFinalTarget: trades.filter(t => t.exits[0].reason === 'stop' && t.reason === 'target').length,
    skippedBusy, losses: losing.length, breakevens: trades.length - winning.length - losing.length,
    meanWinPercent, meanLossPercent, realizedRewardRisk: meanWinPercent != null && meanLossPercent != null ? meanWinPercent / meanLossPercent : null,
    winRate95: wilsonInterval(winning.length, trades.length),
    meanNetR: trades.length ? trades.reduce((n, t) => n + t.netR, 0) / trades.length : null,
    ambiguous: trades.filter(t => t.ambiguous).length,
    ignoredUnorderedTargets: trades.filter(t => t.ignoredUnorderedTarget).length,
    exits: { target: trades.filter(t => t.reason === 'target').length, stop: trades.filter(t => t.reason === 'stop').length, timeout: trades.filter(t => t.reason === 'timeout').length },
  };
}
export type WickMetrics = ReturnType<typeof summarizeWick>;

export function matchesWickSignal(signal: WickSignal, p: WickParameters): boolean {
  if (p.dayGainFraction != null && signal.streakGainPercent < signal.dayChangePercent * p.dayGainFraction) return false;
  if (p.minGreenRatio != null && signal.greenRatio <= p.minGreenRatio) return false;
  if (p.minConsecutiveGreenBars != null && signal.consecutiveGreenBars !== undefined && signal.consecutiveGreenBars < p.minConsecutiveGreenBars) return false;
  if (p.maxUpperShadowRatio != null && signal.upperShadowRatio !== undefined && signal.upperShadowRatio >= p.maxUpperShadowRatio) return false;
  return true;
}

export function backtestWick(data: MinuteDataset, signals: WickSignal[], p: WickParameters, c: WickConfig, start: number, end: number) {
  const trades: WickTrade[] = [], orders: WickOrder[] = [];
  const available = new Map<string, number>();
  let purged = 0, skippedBusy = 0, signalCount = 0;
  for (const signal of signals) {
    if (signal.time < start || signal.time >= end) continue;
    if (!matchesWickSignal(signal, p)) continue;
    signalCount++;
    if ((available.get(signal.symbol) ?? -Infinity) > signal.time) { skippedBusy++; continue; }
    // Purge the full holding horizon before reading any future prices.
    const latestExit = signal.time + p.holdMinutes * MINUTE;
    if (latestExit > end) { purged++; continue; }
    const bars = data.candles.get(signal.symbol) ?? [];
    const fillIndex = signal.index + 1, entryBar = bars[fillIndex];
    const order: WickOrder = { signal, entryPrice: null, status: 'missing', resolvedAt: latestExit,
      entryTime: null, exits: [], remainingFraction: 0, entryFeePercent: 0 };
    orders.push(order);
    if (entryBar?.[0] !== signal.time) { available.set(signal.symbol, latestExit); continue; }
    // Closed signal -> immediately execute at the next minute's first available price.
    const entry = entryBar[1];
    order.entryTime = signal.time; order.entryPrice = entry; order.remainingFraction = 1;
    order.entryFeePercent = c.takerFeeBps / 100;
    const sl1 = p.exitX != null ? (signal.dayChangePercent / p.exitX) : (p.firstStopLossPercent ?? 0.1);
    const tp1 = p.exitX != null ? (signal.dayChangePercent / p.exitX) : (p.firstTakeProfitPercent ?? 0.1);
    const sl2 = p.exitX != null && p.exitN != null ? (signal.dayChangePercent * p.exitN / p.exitX) : (p.finalStopLossPercent ?? 0.2);
    const tp2 = p.exitX != null && p.exitM != null ? (signal.dayChangePercent * p.exitM / p.exitX) : (p.finalTakeProfitPercent ?? 0.5);

    const levels = [
      { stop: entry * (1 + sl1 / 100), target: entry * (1 - tp1 / 100) },
      { stop: entry * (1 + sl2 / 100), target: entry * (1 - tp2 / 100) },
    ].map(v => ({ ...v, targetTouch: v.target }));
    {
      let ignoredUnorderedTarget = false, ambiguous = false;
      order.status = 'missing'; order.resolvedAt = order.entryTime! + p.holdMinutes * MINUTE;
      const closeStage = (exitPrice: number, reason: WickExitReason, time: number) => {
        const stage = (order.exits.length + 1) as 1 | 2;
        const fraction = stage === 1 ? WICK_FIRST_CLOSE_FRACTION : 1 - WICK_FIRST_CLOSE_FRACTION;
        const returns = wickReturn(entry, exitPrice, reason, c);
        order.exits.push({ stage, fraction, cumulativeClosedPercent: stage === 1 ? 50 : 100,
          exitTime: time + MINUTE, exitPrice, reason,
          grossPercent: returns.grossPercent * fraction, entryFeePercent: returns.entryFeePercent * fraction,
          exitFeePercent: returns.exitFeePercent * fraction, slippagePercent: returns.slippagePercent * fraction,
          netPercent: returns.netPercent * fraction });
        order.remainingFraction = stage === 1 ? 1 - fraction : 0;
      };
      for (let offset = 0; offset < p.holdMinutes; offset++) {
        const bar = bars[fillIndex + offset], time = order.entryTime! + offset * MINUTE;
        if (!bar || bar[0] !== time) break;
        // After a stage-one stop, low may predate activation of stage two.
        // Require the close to prove a subsequent target. High still proves a stop.
        let canUseOpen = true, targetProvenByLow = true;
        while (order.exits.length < 2) {
          const { stop, target, targetTouch } = levels[order.exits.length];
          let exit: number | null = null, reason: WickExitReason = 'timeout';
          let atOpen = false;
          if (canUseOpen && bar[1] >= stop) { exit = bar[1]; reason = 'stop'; atOpen = true; }
          else if (canUseOpen && bar[1] <= targetTouch) { exit = bar[1]; reason = 'target'; atOpen = true; }
          else {
            if (bar[2] >= stop && bar[3] <= targetTouch) ambiguous = true;
            if (!targetProvenByLow && bar[3] <= targetTouch && bar[4] > targetTouch) ignoredUnorderedTarget = true;
            if (bar[2] >= stop) { exit = stop; reason = 'stop'; }
            else if ((targetProvenByLow ? bar[3] : bar[4]) <= targetTouch) { exit = target; reason = 'target'; }
          }
          if (exit == null) break;
          closeStage(exit, reason, time);
          canUseOpen = atOpen;
          // Crossing first target proves reaching a farther target in the same fall.
          // A first stop proves only the high and the subsequent close.
          targetProvenByLow = atOpen || (targetProvenByLow && reason === 'target');
        }
        if (offset === p.holdMinutes - 1) {
          while (order.exits.length < 2) closeStage(bar[4], 'timeout', time);
        }
        if (order.exits.length === 2) {
          const total = (key: 'grossPercent' | 'entryFeePercent' | 'exitFeePercent' | 'slippagePercent' | 'netPercent') =>
            order.exits.reduce((sum, e) => sum + e[key], 0);
          order.status = 'closed'; order.resolvedAt = time + MINUTE;
          const netPercent = total('netPercent');
          const initialRisk = WICK_FIRST_CLOSE_FRACTION * sl1 + (1 - WICK_FIRST_CLOSE_FRACTION) * sl2;
          trades.push({ signal, entryTime: order.entryTime!, exitTime: order.resolvedAt, entryPrice: entry,
            exitPrice: order.exits.reduce((sum, e) => sum + e.exitPrice * e.fraction, 0), reason: order.exits[1].reason,
            exits: order.exits, ambiguous, ignoredUnorderedTarget, grossPercent: total('grossPercent'),
            entryFeePercent: total('entryFeePercent'), exitFeePercent: total('exitFeePercent'), slippagePercent: total('slippagePercent'),
            netPercent, netR: netPercent / initialRisk });
          break;
        }
      }
    }
    available.set(signal.symbol, order.resolvedAt);
  }
  return { metrics: summarizeWick(trades, orders, purged, skippedBusy, signalCount), trades, orders };
}
