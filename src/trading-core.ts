import type { PaperDirectionStats } from "./types.ts";

export type TradeSide = "LONG" | "SHORT";
export const FIRST_CLOSE_FRACTION = 0.5;
export const DEFAULT_MARGIN_RATE = 0.2;
export const DEFAULT_MAX_POSITIONS = 5;
export const DEFAULT_MAX_PER_STRATEGY = 1;
export const DEFAULT_COSTS = { takerFeeBps: 5, slippageBps: 2 };

/** Costs are charged once on each leg's entry and exit notional. */
export function calcTradeReturn(side: TradeSide, entry: number, exit: number, costs = DEFAULT_COSTS) {
  const grossPercent = (side === "LONG" ? exit - entry : entry - exit) / entry * 100;
  const feePercent = costs.takerFeeBps / 100 * (1 + exit / entry);
  const slippagePercent = costs.slippageBps / 100 * (1 + exit / entry);
  return { grossPercent, feePercent, slippagePercent, netPercent: grossPercent - feePercent - slippagePercent };
}

/**
 * 根据策略胜率动态计算开仓杠杆倍数:
 * - 超过 80% 胜率: 10x
 * - 超过 72% 胜率: 5x
 * - 超过 65% 胜率: 3x
 * - 65% 及以下胜率: 1x (不加杠杆防回撤)
 * - 无胜率数据 / 未平仓过时使用 fallback (默认 3x)
 */
export function getLeverageForWinRate(winRate?: number | null, fallback = 3): number {
  if (winRate === undefined || winRate === null || !Number.isFinite(winRate) || winRate <= 0) {
    return fallback;
  }
  if (winRate > 80) return 10;
  if (winRate > 72) return 5;
  if (winRate > 65) return 3;
  return 1;
}

/** The remaining leg breaks even after both entry and exit costs. */
export function breakevenPrice(side: TradeSide, entry: number, costs = DEFAULT_COSTS): number {
  const cost = (costs.takerFeeBps + costs.slippageBps) / 10_000;
  return entry * (side === "LONG" ? (1 + cost) / (1 - cost) : (1 - cost) / (1 + cost));
}

/** Never round up or impose a minimum that exceeds the equity allocation. */
export function orderMargin(equity: number, rate = DEFAULT_MARGIN_RATE): number {
  return Math.floor(Math.max(0, equity) * rate * 100 + 1e-8) / 100;
}

export function summarizeDirections(
  trades: readonly { side: TradeSide; totalNetPnlUsdt: number }[],
): Record<TradeSide, PaperDirectionStats> {
  const empty = (): PaperDirectionStats => ({ totalTrades: 0, winningTrades: 0, losingTrades: 0, breakevenTrades: 0, winRate: 0, totalNetPnlUsdt: 0, profitFactor: 0 });
  const result = { LONG: empty(), SHORT: empty() };
  const grossGains = { LONG: 0, SHORT: 0 };
  const grossLosses = { LONG: 0, SHORT: 0 };
  for (const trade of trades) {
    const stats = result[trade.side];
    stats.totalTrades++;
    stats.totalNetPnlUsdt += trade.totalNetPnlUsdt;
    if (trade.totalNetPnlUsdt > 0.001) {
      stats.winningTrades++;
      grossGains[trade.side] += trade.totalNetPnlUsdt;
    } else if (trade.totalNetPnlUsdt < -0.001) {
      stats.losingTrades++;
      grossLosses[trade.side] += Math.abs(trade.totalNetPnlUsdt);
    } else {
      stats.breakevenTrades++;
    }
  }
  for (const side of ["LONG", "SHORT"] as const) {
    const stats = result[side];
    stats.winRate = stats.totalTrades ? stats.winningTrades / stats.totalTrades * 100 : 0;
    stats.profitFactor =
      grossLosses[side] > 0
        ? grossGains[side] / grossLosses[side]
        : grossGains[side] > 0
          ? Infinity
          : 0;
  }
  return result;
}
