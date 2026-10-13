import { matchesMinuteEntry } from './gainers-backtest.ts';
import { summarize } from './backtest.ts';
import { MINUTE, type GainersParameters, type MinuteDataset, type MinuteSignal } from './gainers-types.ts';
import type { Metrics } from './types.ts';
import { deaLevel, matchesFifteen, type MiningParameters } from './fifteen.ts';
import { matchesBtcFive } from './btc-five.ts';

/** Fixed-size isolated USDT margin. All values are explicit simulation inputs. */
export interface AccountOptions {
  initialBalanceUSDT: number;
  marginPerTradeUSDT: number;
  leverage: number;
  maxPositions: number;
  maintenanceMarginPercent: number;
  liquidationFeeBps: number;
  costBps: number;
}
export const DEFAULT_ACCOUNT: AccountOptions = {
  initialBalanceUSDT: 1000, marginPerTradeUSDT: 100, leverage: 10, maxPositions: 10,
  maintenanceMarginPercent: 0.5, liquidationFeeBps: 50, costBps: 7,
};
export interface AccountTrade {
  symbol: string; entryTime: number; exitTime: number; entryPrice: number; exitPrice: number;
  reason: 'stop' | 'target' | 'timeout' | 'liquidation' | 'missing'; ambiguous: boolean;
  leverage: number; marginUSDT: number; notionalUSDT: number; quantity: number; liquidationPrice: number;
  grossPnlUSDT: number; entryCostUSDT: number; exitCostUSDT: number; liquidationFeeUSDT: number;
  insuranceShortfallUSDT: number; netPnlUSDT: number; netPercent: number; marginReturnPercent: number;
  supportMa: string | null;
  minuteDea?: number; minuteDif?: number; minuteDeaLevel?: string; minuteDirection?: string;
  minuteStreakCount?: number; minuteStreakDirection?: string | null;
  fifteenStreakCount?: number; fifteenStreakDirection?: string | null;
  fifteenClosedAt?: number | null; fifteenDea?: number | null; fifteenDif?: number | null;
  fifteenDeaLevel?: string | null; fifteenDirection?: string | null; fifteenSupportMa?: string | null;
  btcFiveSymbol?: string; btcFiveClosedAt?: number | null; btcFiveDea?: number | null; btcFiveDif?: number | null;
  btcFiveDeaLevel?: string | null; btcFiveDirection?: string | null; btcFiveSupportMa?: string | null;
  btcFiveStreakCount?: number; btcFiveStreakDirection?: string | null;
}
export interface EquityPoint { time: number; phase: 'settled' | 'entry'; freeUSDT: number; lockedMarginUSDT: number; unrealizedPnlUSDT: number; equityUSDT: number; positions: number }
export interface AccountMetrics extends Metrics {
  initialBalanceUSDT: number; finalBalanceUSDT: number; netPnlUSDT: number; accountReturnPercent: number;
  maxEquityDrawdownUSDT: number; maxEquityDrawdownPercent: number; minFreeUSDT: number;
  maxLockedMarginUSDT: number; maxConcurrentPositions: number; skippedFunds: number; skippedPositionLimit: number;
  liquidations: number; totalCostsUSDT: number; insuranceShortfallUSDT: number;
  meanMarginReturnPercent: number | null; valid: boolean;
}
export interface AccountResult { metrics: AccountMetrics; trades: AccountTrade[]; equity: EquityPoint[] }
export interface AccountTrial { id: string; round: number; parameters: MiningParameters; train: AccountMetrics; validation: AccountMetrics | null }

export function validateAccount(o: AccountOptions) {
  for (const key of ['initialBalanceUSDT', 'marginPerTradeUSDT', 'leverage', 'maxPositions'] as const) {
    if (!Number.isFinite(o[key]) || o[key] <= 0) throw new Error(`${key} 必须为正数`);
  }
  if (!Number.isInteger(o.leverage) || o.leverage > 125 || !Number.isInteger(o.maxPositions) || o.maxPositions > 100) throw new Error('杠杆需为1..125整数，最大持仓需为1..100整数');
  if (![o.costBps, o.liquidationFeeBps, o.maintenanceMarginPercent].every((v) => Number.isFinite(v) && v >= 0)
      || o.costBps > 200 || o.liquidationFeeBps > 500 || o.maintenanceMarginPercent + o.costBps / 100 >= 100 / o.leverage) throw new Error('成本或维持保证金率无效，初始保证金必须高于维持保证金及预估平仓成本');
  const required = o.marginPerTradeUSDT * (1 + o.leverage * o.costBps / 10000);
  if (required > o.initialBalanceUSDT + 1e-9) throw new Error('初始资金不足以支付一笔保证金及开仓成本');
}

// M + q*(entry-mark) = q*mark*(MMR + closing cost). Reserve the closing cost
// in the trigger so ordinary stop fills cannot borrow unsecured closing fees.
export function liquidationRatio(o: AccountOptions) {
  return (1 + 1 / o.leverage) / (1 + o.maintenanceMarginPercent / 100 + o.costBps / 10000);
}
/** GPU must see liquidation when it is nearer than the strategy stop. */
export function accountGpuParameters(p: GainersParameters, o: AccountOptions): GainersParameters {
  return { ...p, stopLossPercent: Math.min(p.stopLossPercent, (liquidationRatio(o) - 1) * 100) };
}

function planExit(data: MinuteDataset, signal: MinuteSignal, p: MiningParameters, o: AccountOptions, offsetHint: number): AccountTrade {
  const bars = data.candles.get(signal.symbol)!;
  const first = bars[signal.index + 1];
  const entryPrice = first[1], margin = o.marginPerTradeUSDT, notional = margin * o.leverage, quantity = notional / entryPrice;
  const stop = entryPrice * (1 + p.stopLossPercent / 100), target = entryPrice * (1 - p.takeProfitPercent / 100);
  const liquidationPrice = entryPrice * liquidationRatio(o);
  const adverse = Math.min(stop, liquidationPrice);
  let exitPrice = entryPrice, exitTime = signal.time, reason: AccountTrade['reason'] = 'missing', ambiguous = false;
  for (let offset = Math.max(0, offsetHint); offset < p.holdMinutes; offset++) {
    const c = bars[signal.index + 1 + offset];
    if (!c || c[0] !== signal.time + offset * MINUTE) {
      const previous = bars[signal.index + offset];
      exitPrice = offset > 0 ? previous[4] : entryPrice;
      exitTime = signal.time + offset * MINUTE;
      break;
    }
    exitTime = c[0] + MINUTE;
    ambiguous = c[1] < adverse && c[1] > target && c[2] >= adverse && c[3] <= target;
    // An opening gap can pass both stop and liquidation before execution.
    if (c[1] >= liquidationPrice) { exitPrice = c[1]; reason = 'liquidation'; break; }
    if (c[1] >= stop) { exitPrice = c[1]; reason = 'stop'; break; }
    if (c[1] <= target) { exitPrice = c[1]; reason = 'target'; break; }
    if (c[2] >= adverse) { exitPrice = adverse; reason = liquidationPrice <= stop ? 'liquidation' : 'stop'; break; }
    if (c[3] <= target) { exitPrice = target; reason = 'target'; break; }
    if (offset === p.holdMinutes - 1) { exitPrice = c[4]; reason = 'timeout'; break; }
  }
  const grossPnlUSDT = quantity * (entryPrice - exitPrice);
  const entryCostUSDT = notional * o.costBps / 10000;
  const requestedExitCost = quantity * exitPrice * o.costBps / 10000;
  const requestedLiquidationFee = reason === 'liquidation' ? quantity * exitPrice * o.liquidationFeeBps / 10000 : 0;
  const residual = Math.max(0, margin + grossPnlUSDT);
  // Isolated liquidation consumes at most that position's remaining margin.
  const exitCostUSDT = reason === 'liquidation' ? Math.min(residual, requestedExitCost) : requestedExitCost;
  const liquidationFeeUSDT = Math.min(Math.max(0, residual - exitCostUSDT), requestedLiquidationFee);
  const insuranceShortfallUSDT = reason === 'liquidation' ? Math.max(0, -margin - grossPnlUSDT) : 0;
  const netPnlUSDT = grossPnlUSDT + insuranceShortfallUSDT - entryCostUSDT - exitCostUSDT - liquidationFeeUSDT;
  return { symbol: signal.symbol, entryTime: signal.time, exitTime, entryPrice, exitPrice, reason, ambiguous, supportMa: signal.supportMa,
    ...(signal.streak ? { minuteStreakCount: signal.streak.count, minuteStreakDirection: signal.streak.direction } : {}),
    ...(signal.fifteen?.streak ? { fifteenStreakCount: signal.fifteen.streak.count, fifteenStreakDirection: signal.fifteen.streak.direction } : {}),
    ...(signal.fifteen === undefined ? {} : { minuteDea: signal.dea, minuteDif: signal.dif,
      minuteDeaLevel: deaLevel(signal.dea, signal.peakDea, p.highRatio), minuteDirection: signal.dif >= signal.dea ? 'bull' : 'bear',
      fifteenClosedAt: signal.fifteen?.closedAt ?? null,
      fifteenDea: signal.fifteen?.dea ?? null, fifteenDif: signal.fifteen?.dif ?? null,
      fifteenDeaLevel: signal.fifteen ? deaLevel(signal.fifteen.dea, signal.fifteen.peakDea, p.fifteenHighRatio) : null, fifteenDirection: signal.fifteen?.direction ?? null,
      fifteenSupportMa: signal.fifteen?.supportMa ?? null }),
    ...(signal.btcFive === undefined ? {} : { minuteDea: signal.dea, minuteDif: signal.dif,
      minuteDeaLevel: deaLevel(signal.dea, signal.peakDea, p.highRatio), minuteDirection: signal.dif >= signal.dea ? 'bull' : 'bear',
      btcFiveSymbol: signal.btcFive?.symbol, btcFiveClosedAt: signal.btcFive?.closedAt ?? null,
      btcFiveDea: signal.btcFive?.dea ?? null, btcFiveDif: signal.btcFive?.dif ?? null,
      btcFiveDeaLevel: signal.btcFive ? deaLevel(signal.btcFive.dea, signal.btcFive.peakDea, p.btcFiveHighRatio) : null,
      btcFiveDirection: signal.btcFive?.direction ?? null, btcFiveSupportMa: signal.btcFive?.supportMa ?? null,
      btcFiveStreakCount: signal.btcFive?.streak?.count, btcFiveStreakDirection: signal.btcFive?.streak?.direction }),
    leverage: o.leverage, marginUSDT: margin, notionalUSDT: notional, quantity, liquidationPrice,
    grossPnlUSDT, entryCostUSDT, exitCostUSDT, liquidationFeeUSDT, insuranceShortfallUSDT, netPnlUSDT,
    netPercent: netPnlUSDT / notional * 100, marginReturnPercent: netPnlUSDT / margin * 100 };
}

/** Chronological account ledger. Skipped entries do not create phantom positions. */
export function backtestAccount(data: MinuteDataset, signals: MinuteSignal[], p: MiningParameters,
  start: number, end: number, o: AccountOptions, offsets?: readonly number[]): AccountResult {
  validateAccount(o);
  if (offsets && (offsets.length !== signals.length || offsets.some((v) => !Number.isInteger(v) || v < -1 || v >= p.holdMinutes))) throw new Error('账户GPU退出位置不匹配');
  if (start >= end || start % MINUTE || end % MINUTE) throw new Error('账户区间必须按分钟对齐');
  const arrivals = new Map<number, { signal: MinuteSignal; index: number }[]>();
  signals.forEach((s, index) => { if (s.time >= start && s.time < end && matchesMinuteEntry(s, p.highRatio, p) && matchesFifteen(s, p) && matchesBtcFive(s, p)) { const list = arrivals.get(s.time) ?? []; list.push({ signal: s, index }); arrivals.set(s.time, list); } });
  const active = new Map<string, { trade: AccountTrade; signal: MinuteSignal }>();
  const trades: AccountTrade[] = [], equity: EquityPoint[] = [];
  let free = o.initialBalanceUSDT, missing = 0, purged = 0, skippedFunds = 0, skippedPositionLimit = 0;
  let peak = free, maxDD = 0, maxDDPercent = 0, minFree = free, maxLocked = 0, maxConcurrent = 0;
  function capture(time: number, phase: EquityPoint['phase']) {
    let unrealizedPnlUSDT = 0, lockedMarginUSDT = 0;
    for (const { trade, signal } of active.values()) {
      const offset = (time - signal.time) / MINUTE;
      const price = offset === 0 ? trade.entryPrice : data.candles.get(signal.symbol)![signal.index + offset][4];
      // Account mark is the previous closed trade-price candle, not a live mark feed.
      unrealizedPnlUSDT += Math.max(-trade.marginUSDT, trade.quantity * (trade.entryPrice - price));
      lockedMarginUSDT += trade.marginUSDT;
    }
    const equityUSDT = free + lockedMarginUSDT + unrealizedPnlUSDT;
    peak = Math.max(peak, equityUSDT);
    maxDD = Math.max(maxDD, peak - equityUSDT);
    maxDDPercent = Math.max(maxDDPercent, peak > 0 ? (peak - equityUSDT) / peak * 100 : 0);
    minFree = Math.min(minFree, free); maxLocked = Math.max(maxLocked, lockedMarginUSDT); maxConcurrent = Math.max(maxConcurrent, active.size);
    equity.push({ time, phase, freeUSDT: free, lockedMarginUSDT, unrealizedPnlUSDT, equityUSDT, positions: active.size });
  }
  for (let time = start; time <= end; time += MINUTE) {
    for (const [symbol, position] of active) if (position.trade.exitTime <= time) {
      const t = position.trade;
      free += t.marginUSDT + t.netPnlUSDT + t.entryCostUSDT;
      if (t.reason === 'missing') missing++;
      trades.push(t); active.delete(symbol);
    }
    capture(time, 'settled');
    // Same-minute capacity conflicts are decided by symbol code, not future PnL.
    const entries = (arrivals.get(time) ?? []).sort((a, b) => a.signal.symbol.localeCompare(b.signal.symbol));
    for (const { signal: s, index } of entries) {
      if (!matchesMinuteEntry(s, p.highRatio, p) || !matchesFifteen(s, p) || !matchesBtcFive(s, p) || active.has(s.symbol)) continue;
      if (s.time + p.holdMinutes * MINUTE > end) { purged++; continue; }
      if (active.size >= o.maxPositions) { skippedPositionLimit++; continue; }
      const required = o.marginPerTradeUSDT * (1 + o.leverage * o.costBps / 10000);
      if (free + 1e-9 < required) { skippedFunds++; continue; }
      const first = data.candles.get(s.symbol)?.[s.index + 1];
      if (!first || first[0] !== s.time) { missing++; continue; }
      free -= required;
      const trade = planExit(data, s, p, o, offsets?.[index] ?? -1);
      active.set(s.symbol, { signal: s, trade });
    }
    if (entries.length) capture(time, 'entry');
  }
  if (active.size) throw new Error('账户区间结束仍存在未结算仓位');
  const summary = summarize(trades, missing, purged);
  const netPnlUSDT = free - o.initialBalanceUSDT;
  return { trades, equity, metrics: { ...summary, initialBalanceUSDT: o.initialBalanceUSDT, finalBalanceUSDT: free,
    netPnlUSDT, accountReturnPercent: netPnlUSDT / o.initialBalanceUSDT * 100,
    maxEquityDrawdownUSDT: maxDD, maxEquityDrawdownPercent: maxDDPercent, minFreeUSDT: minFree,
    maxLockedMarginUSDT: maxLocked, maxConcurrentPositions: maxConcurrent, skippedFunds, skippedPositionLimit,
    liquidations: trades.filter((t) => t.reason === 'liquidation').length,
    totalCostsUSDT: trades.reduce((n, t) => n + t.entryCostUSDT + t.exitCostUSDT + t.liquidationFeeUSDT, 0),
    insuranceShortfallUSDT: trades.reduce((n, t) => n + t.insuranceShortfallUSDT, 0),
    meanMarginReturnPercent: trades.length ? trades.reduce((n, t) => n + t.marginReturnPercent, 0) / trades.length : null,
    valid: missing === 0 } };
}

export function accountTrainOrder(a: AccountTrial, b: AccountTrial) {
  return b.train.accountReturnPercent - a.train.accountReturnPercent || a.train.maxEquityDrawdownPercent - b.train.maxEquityDrawdownPercent || a.id.localeCompare(b.id);
}
export function accountValidationOrder(a: AccountTrial, b: AccountTrial) {
  return b.validation!.accountReturnPercent - a.validation!.accountReturnPercent || a.validation!.maxEquityDrawdownPercent - b.validation!.maxEquityDrawdownPercent || a.id.localeCompare(b.id);
}
export function accountQualified(m: AccountMetrics, minTrades: number) {
  return m.valid && m.trades >= minTrades && m.accountReturnPercent > 0 && m.liquidations === 0 && (m.profitFactor == null ? m.lossPercent === 0 : m.profitFactor > 1);
}
export function accountDiscovery(trials: AccountTrial[], minTrades: number, previousReturn: number | null) {
  const best = trials.filter((t) => accountQualified(t.train, minTrades)).sort(accountTrainOrder)[0];
  return best && (previousReturn == null || best.train.accountReturnPercent > previousReturn + 1e-12) ? best : null;
}
