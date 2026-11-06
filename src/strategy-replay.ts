import { computeFeatureVector, evaluateFeatureSpec, type FeatureVector, type KlineStatsStrategySpec } from "./features.ts";
import type { Candle } from "./macd.ts";
import { breakevenPrice, calcTradeReturn, orderMargin, summarizeDirections } from "./trading-core.ts";

const MINUTE = 60_000;
export interface ReplayStrategy extends KlineStatsStrategySpec {
  id: string;
  side: "LONG" | "SHORT";
  holdMinutes: number;
  tp1Percent: number;
  tp2Percent: number;
  stopLossPercent: number;
}
export type MinuteBoard = Map<string, { rank: number; dayChange: number; high24h?: number; low24h?: number }>;
export interface ReplayTrade {
  strategyId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  netPercent: number;
  totalNetPnlUsdt: number;
  isWin: boolean;
  reason: string;
  st1Done: boolean;
}

/** One execution path for candidate evaluation and portfolio replay. */
export function replayStrategies(
  candlesMap: Map<string, Candle[]>,
  timeIndices: Map<string, Map<number, number>>,
  allTimesSorted: number[],
  framesMap: Map<number, MinuteBoard>,
  strategies: ReplayStrategy[],
  range: { start: number; end: number },
  options: {
    maxPositions?: number;
    marginPercent?: number;
    leverage?: number;
    intrabarMode?: "conservative" | "optimistic";
    fvCache?: Map<string, FeatureVector | null>;
    costs?: { takerFeeBps: number; slippageBps: number };
  } = {},
) {
  interface Position {
    strategy: ReplayStrategy;
    symbol: string;
    entryTime: number;
    entryPrice: number;
    margin: number;
    notional: number;
    tp1: number;
    tp2: number;
    sl: number;
    st1Done: boolean;
    netPercent: number;
    lastPrice: number;
    lastTime: number;
  }
  const active = new Map<string, Position>();
  const cooldown = new Map<string, number>();
  const trades: ReplayTrade[] = [];
  let balance = 100;
  let peakEquity = 100;
  let maxDrawdownUsdt = 0;
  let maxDrawdownPct = 0;
  let maxConcurrentPositions = 0;
  let board: MinuteBoard = new Map();
  const maxPositions = options.maxPositions ?? 5;
  const rate = (options.marginPercent ?? 20) / 100;
  if (!Number.isInteger(maxPositions) || maxPositions < 1 || maxPositions > 5 || !Number.isFinite(rate) || rate <= 0 || rate > 0.2) {
    throw new Error("回测最多 5 仓，单笔保证金最多为净权益的 20%");
  }

  const equity = () => balance + [...active.values()].reduce((sum, p) => {
    const ret = calcTradeReturn(p.strategy.side, p.entryPrice, p.lastPrice, options.costs);
    return sum + p.notional * (p.netPercent + (p.st1Done ? 0.5 : 1) * ret.netPercent) / 100;
  }, 0);
  const markEquity = () => {
    const value = equity();
    peakEquity = Math.max(peakEquity, value);
    maxDrawdownUsdt = Math.max(maxDrawdownUsdt, peakEquity - value);
    maxDrawdownPct = Math.max(maxDrawdownPct, (peakEquity - value) / peakEquity * 100);
  };
  const realize = (p: Position, price: number, fraction: number) => {
    const net = calcTradeReturn(p.strategy.side, p.entryPrice, price, options.costs).netPercent * fraction;
    p.netPercent += net;

  };
  const finish = (p: Position, price: number, time: number, reason: string) => {
    realize(p, price, p.st1Done ? 0.5 : 1);
    const pnl = p.notional * p.netPercent / 100;
    balance += pnl;
    trades.push({
      strategyId: p.strategy.id, symbol: p.symbol, side: p.strategy.side,
      entryTime: p.entryTime, exitTime: time, entryPrice: p.entryPrice, exitPrice: price,
      netPercent: p.netPercent, totalNetPnlUsdt: pnl, isWin: pnl > 0.001, reason, st1Done: p.st1Done,
    });
    active.delete(p.symbol);
    cooldown.set(p.symbol, time + (p.strategy.cooldownMinutes ?? 20) * MINUTE);
  };
  const processBar = (p: Position, bar: Candle) => {
    const long = p.strategy.side === "LONG";
    p.lastPrice = bar.close;
    p.lastTime = bar.time + MINUTE;
    // At the deadline only the opening price is known; do not use that minute's future range.
    if (bar.time >= p.entryTime + p.strategy.holdMinutes * MINUTE) {
      finish(p, bar.open, bar.time, p.st1Done ? "TP1_TIMEOUT" : "TIMEOUT");
      return;
    }
    const hitStop = () => long ? bar.low <= p.sl : bar.high >= p.sl;
    const stop = () => finish(p, long ? Math.min(bar.low, p.sl) : Math.max(bar.high, p.sl), bar.time + MINUTE, "SL");
    if (options.intrabarMode !== "optimistic" && hitStop()) {
      stop();
      return;
    }
    const firstThisBar = !p.st1Done && (long ? bar.high >= p.tp1 : bar.low <= p.tp1);
    if (firstThisBar) {
      realize(p, p.tp1, 0.5);
      p.st1Done = true;
      if (p.strategy.moveSlToEntryAfterTp1 !== false) p.sl = breakevenPrice(p.strategy.side, p.entryPrice, options.costs);
    }
    if (p.st1Done && (long ? bar.high >= p.tp2 : bar.low <= p.tp2)) {
      finish(p, p.tp2, bar.time + MINUTE, "TP2");
    } else if (hitStop()) {
      // OHLC cannot resolve a TP1 / new stop ordering; use the conservative adverse path.
      stop();
    }
  };

  for (const now of allTimesSorted) {
    // Carry only already available boards, including the last pre-range snapshot.
    if (framesMap.has(now)) board = framesMap.get(now)!;
    if (now < range.start) continue;
    if (now + MINUTE > range.end) break;

    // Mark at this minute's open before sizing; closed-bar extremes are not known yet.
    for (const p of active.values()) {
      const index = timeIndices.get(p.symbol)?.get(now);
      const bar = index === undefined ? undefined : candlesMap.get(p.symbol)?.[index];
      if (bar) p.lastPrice = bar.open;
    }
    markEquity();
    for (const strategy of strategies) {
      if (active.size >= maxPositions) break;
      if ([...active.values()].some(p => p.strategy.id === strategy.id)) continue;
      for (const [symbol, info] of board) {
        if (active.has(symbol) || (cooldown.get(symbol) ?? 0) > now) continue;
        const bars = candlesMap.get(symbol);
        const index = timeIndices.get(symbol)?.get(now);
        if (!bars || index === undefined || index < 60 || bars[index - 1].time + MINUTE !== now) continue;
        if (info.rank > (strategy.topN ?? 10) || info.dayChange < (strategy.minDayChange ?? 10)) continue;
        const key = `${symbol}:${now}:${info.rank}:${info.dayChange}:${info.high24h}:${info.low24h}`;
        let fv = options.fvCache?.get(key);
        if (fv === undefined) {
          fv = computeFeatureVector(bars, {
            symbol, lastPrice: bars[index - 1].close, priceChangePercent: info.dayChange,
            quoteVolume: 0, highPrice: info.high24h, lowPrice: info.low24h,
          }, index - 1, { rank: info.rank });
          options.fvCache?.set(key, fv);
        }
        if (!fv || !evaluateFeatureSpec(strategy.side, fv, strategy).pass) continue;
        const margin = orderMargin(equity(), rate);
        const used = [...active.values()].reduce((sum, p) => sum + p.margin, 0);
        if (margin <= 0 || margin > Math.min(balance, equity()) - used + 1e-8) continue;
        const entry = bars[index].open;
        if (!(entry > 0)) continue;
        const sign = strategy.side === "LONG" ? 1 : -1;
        active.set(symbol, {
          strategy, symbol, entryTime: now, entryPrice: entry, margin,
          notional: margin * (strategy.leverage ?? options.leverage ?? 3),
          tp1: entry * (1 + sign * strategy.tp1Percent / 100),
          tp2: entry * (1 + sign * strategy.tp2Percent / 100),
          sl: entry * (1 - sign * strategy.stopLossPercent / 100),
          st1Done: false, netPercent: 0, lastPrice: entry, lastTime: now,
        });
        maxConcurrentPositions = Math.max(maxConcurrentPositions, active.size);
        break;
      }
    }
    // Include the entry candle. No closing proceeds fund entries earlier in the same candle.
    for (const p of [...active.values()]) {
      const index = timeIndices.get(p.symbol)?.get(now);
      const bar = index === undefined ? undefined : candlesMap.get(p.symbol)?.[index];
      if (bar) processBar(p, bar);
    }
    markEquity();
  }
  // Liquidate at the last observed price; never leave losing open trades out of the report.
  for (const p of [...active.values()]) finish(p, p.lastPrice, p.lastTime, "END_OF_PERIOD");
  markEquity();
  const bySide = summarizeDirections(trades);
  const wins = bySide.LONG.winningTrades + bySide.SHORT.winningTrades;
  return {
    initialBalance: 100, finalBalance: balance, netPnlUsdt: balance - 100, roiPct: balance - 100,
    totalTrades: trades.length, wins, winRate: trades.length ? wins / trades.length * 100 : 0,
    bySide, trades, maxDrawdownUsdt, maxDrawdownPct, maxConcurrentPositions,
  };
}
