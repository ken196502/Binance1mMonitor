import type { KlineStatsStrategyLiveConfig } from "./types.ts";
import { FEATURE_VERSION } from "./features.ts";

export const MINUTE_MS = 60_000;
export const FACTOR_POLICY_VERSION = 1;
export const FACTOR_LOOKBACK_MINUTES = 72 * 60;
export const FACTOR_TEST_MINUTES = 6 * 60;
export const FACTOR_MAX_DATA_AGE_MS = 5 * MINUTE_MS;
export type FactorSide = "LONG" | "SHORT";
export interface FactorMiningConfig {
  enabled: boolean;
  refreshMinutes: number;
  validForMinutes: number;
}
export const DEFAULT_FACTOR_MINING: FactorMiningConfig = {
  enabled: true, refreshMinutes: 60, validForMinutes: 12 * 60,
};
export function validateFactorMiningConfig(config: FactorMiningConfig): void {
  if (typeof config.enabled !== "boolean" || !Number.isInteger(config.refreshMinutes) ||
    !Number.isInteger(config.validForMinutes) || config.refreshMinutes < 15 ||
    config.validForMinutes > 720 || config.validForMinutes < 30 ||
    config.refreshMinutes >= config.validForMinutes) {
    throw new Error("因子刷新间隔须为至少 15 分钟的整数，且小于有效期；有效期为 30~720 分钟");
  }
}
export interface FactorMetrics {
  trades: number;
  wins: number;
  winRate: number;
  wilsonLow: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null; // null represents infinity when grossLoss is zero
  netPercent: number;
  avgNetPercent: number;
}
export interface FactorCandidate {
  id: string;
  config: KlineStatsStrategyLiveConfig;
  train: FactorMetrics;
  validation: FactorMetrics;
  holdout: FactorMetrics;
}
export interface FactorMiningResult {
  policyVersion: number;
  featureVersion: string;
  dataAsOf: number;
  datasetHash: string;
  trials: number;
  costs: { takerFeeBps: number; slippageBps: number };
  sides: Record<FactorSide, { candidate?: FactorCandidate; reason: string }>;
}
export interface ActiveFactor extends FactorCandidate {
  revision: string;
  dataAsOf: number;
  expiresAt: number;
  featureVersion: string;
  policyVersion: number;
  costs: { takerFeeBps: number; slippageBps: number };
}
export interface FactorMiningState {
  running: boolean;
  lastStartedAt?: number;
  lastCompletedAt?: number;
  nextRunAt?: number;
  lastError?: string;
  datasetHash?: string;
  sides: Record<FactorSide, { active?: ActiveFactor; reason: string }>;
}
export const BASELINE_SHORT_CONFIG: KlineStatsStrategyLiveConfig = {
  topN: 10,
  minDayChange: 10,
  intervalWindow: 5,
  ampDivisor: 8,
  maRequirement: "MA10_BREAKDOWN",
  macdRequirement: "GREEN_RATIO_30_80",
  holdMinutes: 45,
  tp1Percent: 3.0,
  tp2Percent: 7.0,
  stopLossPercent: 5.0,
  moveSlToEntryAfterTp1: true,
  cooldownMinutes: 20,
  leverage: 3,
};

export const BASELINE_LONG_CONFIG: KlineStatsStrategyLiveConfig = {
  topN: 10,
  minDayChange: 10,
  intervalWindow: 5,
  ampDivisor: 8,
  maRequirement: "MA20_SUPPORT",
  macdRequirement: "GREEN_RATIO_15_70",
  holdMinutes: 30,
  tp1Percent: 2.5,
  tp2Percent: 5.5,
  stopLossPercent: 3.5,
  moveSlToEntryAfterTp1: true,
  cooldownMinutes: 20,
  leverage: 3,
};

export function createBaselineFactor(
  side: FactorSide,
  costs: { takerFeeBps: number; slippageBps: number } = { takerFeeBps: 5, slippageBps: 2 },
  now = Date.now(),
  validMinutes = 12 * 60,
): ActiveFactor {
  const isShort = side === "SHORT";
  const config = isShort ? structuredClone(BASELINE_SHORT_CONFIG) : structuredClone(BASELINE_LONG_CONFIG);
  const cutoff = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  return {
    id: `kline_stats_${side.toLowerCase()}_baseline`,
    revision: `baseline:kline_stats_${side.toLowerCase()}:v1`,
    config,
    dataAsOf: cutoff,
    expiresAt: cutoff + validMinutes * MINUTE_MS,
    featureVersion: FEATURE_VERSION,
    policyVersion: FACTOR_POLICY_VERSION,
    costs: { ...costs },
    train: isShort
      ? { trades: 33, wins: 24, winRate: 72.7, wilsonLow: 55.8, grossProfit: 45.2, grossLoss: 39.5, profitFactor: 1.14, netPercent: 5.69, avgNetPercent: 0.17 }
      : { trades: 20, wins: 14, winRate: 70.0, wilsonLow: 48.1, grossProfit: 25.0, grossLoss: 18.0, profitFactor: 1.39, netPercent: 7.0, avgNetPercent: 0.35 },
    validation: isShort
      ? { trades: 12, wins: 9, winRate: 75.0, wilsonLow: 46.8, grossProfit: 18.0, grossLoss: 12.0, profitFactor: 1.5, netPercent: 3.5, avgNetPercent: 0.29 }
      : { trades: 10, wins: 7, winRate: 70.0, wilsonLow: 39.7, grossProfit: 14.0, grossLoss: 9.0, profitFactor: 1.55, netPercent: 5.0, avgNetPercent: 0.5 },
    holdout: isShort
      ? { trades: 8, wins: 6, winRate: 75.0, wilsonLow: 40.9, grossProfit: 12.0, grossLoss: 7.0, profitFactor: 1.7, netPercent: 2.5, avgNetPercent: 0.31 }
      : { trades: 6, wins: 4, winRate: 66.7, wilsonLow: 30.0, grossProfit: 8.0, grossLoss: 5.0, profitFactor: 1.6, netPercent: 3.0, avgNetPercent: 0.5 },
  };
}

export const initialFactorMiningState = (
  costs: { takerFeeBps: number; slippageBps: number } = { takerFeeBps: 5, slippageBps: 2 },
  now = Date.now(),
): FactorMiningState => ({
  running: false,
  sides: {
    SHORT: {
      active: createBaselineFactor("SHORT", costs, now),
      reason: "近期基准策略生效中",
    },
    LONG: {
      reason: "策略已关闭 (量化做多风控熔断)",
    },
  },
});

export const emptyFactorState = initialFactorMiningState;
export function passesFactorMetrics(metrics: FactorMetrics, minTrades: number, confidence = false): boolean {
  return [metrics.trades, metrics.wins, metrics.winRate, metrics.wilsonLow, metrics.grossProfit,
    metrics.grossLoss, metrics.netPercent, metrics.avgNetPercent].every(Number.isFinite) &&
    metrics.trades >= minTrades && metrics.winRate >= 65 && metrics.netPercent > 0 &&
    metrics.avgNetPercent >= 0.15 && metrics.grossProfit > 0 && metrics.grossLoss >= 0 &&
    metrics.grossProfit >= metrics.grossLoss * 1.25 && (!confidence || metrics.wilsonLow >= 48);
}
export function passesFactorCandidate(candidate: FactorCandidate): boolean {
  return candidate.config.leverage === 3 && passesFactorMetrics(candidate.train, 10) &&
    passesFactorMetrics(candidate.validation, 8, true) && passesFactorMetrics(candidate.holdout, 5);
}
/** Stable comparison also invalidates approval after manual parameter edits. */
export function factorConfigKey(value: object): string {
  return JSON.stringify(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)));
}
