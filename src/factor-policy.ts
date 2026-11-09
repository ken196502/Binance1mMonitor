import { DEFAULT_FACTOR_MINING, type FactorWindows } from "./factor-settings.ts";
export { DEFAULT_FACTOR_MINING, validateFactorMiningConfig, type FactorMiningConfig } from "./factor-settings.ts";
import type { KlineStatsStrategyLiveConfig, StrategyFault } from "./types.ts";
export type { StrategyFault };

export const MINUTE_MS = 60_000;
export const FACTOR_POLICY_VERSION = 2;
export const FACTOR_LOOKBACK_MINUTES = 48 * 60;
export const FACTOR_TEST_MINUTES = DEFAULT_FACTOR_MINING.holdoutMinutes;
export const FACTOR_MAX_DATA_AGE_MS = 5 * MINUTE_MS;
export type FactorSide = "LONG" | "SHORT";
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
  validation?: FactorMetrics;
  holdout: FactorMetrics;
}
export interface StrategyMiningCandidate {
  strategyId: string;
  config: Record<string, any>;
  train: FactorMetrics;
  validation?: FactorMetrics;
  holdout: FactorMetrics;
}
export interface FactorMiningResult {
  windows?: FactorWindows;
  policyVersion: number;
  featureVersion: string;
  dataAsOf: number;
  datasetHash: string;
  trials: number;
  costs: { takerFeeBps: number; slippageBps: number };
  sides: Record<FactorSide, { candidate?: FactorCandidate; reason: string }>;
  strategies?: Record<string, { candidate?: StrategyMiningCandidate; reason: string }>;
  timings?: {
    loadDatasetMs?: number;
    mineFactorsMs?: number;
    totalWorkerMs?: number;
  };
}
export interface ActiveFactor extends FactorCandidate {
  windows?: FactorWindows;
  revision: string;
  dataAsOf: number;
  expiresAt: number;
  featureVersion: string;
  policyVersion: number;
  costs: { takerFeeBps: number; slippageBps: number };
}
export interface FactorMiningRunRecord {
  id: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  durationSec: string;
  timeoutUsagePercent: string;
  trials: number;
  status: "success" | "failed" | "aborted";
  error?: string;
  appliedSides: string[];
  appliedStrategies: string[];
  timings?: {
    loadDatasetMs?: number;
    mineFactorsMs?: number;
    totalWorkerMs?: number;
  };
}
export interface FactorMiningState {
  running: boolean;
  lastStartedAt?: number;
  lastCompletedAt?: number;
  lastDurationMs?: number;
  lastDurationSec?: string;
  nextRunAt?: number;
  lastError?: string;
  datasetHash?: string;
  sides: Record<FactorSide, { active?: ActiveFactor; reason: string }>;
  history?: FactorMiningRunRecord[];
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

/** Preset parameters are candidates, never evidence of a recent validation run. */
export const initialFactorMiningState = (): FactorMiningState => ({
  running: false,
  sides: {
    SHORT: { reason: "等待近期行情挖掘与验证" },
    LONG: { reason: "等待近期行情挖掘与验证" },
  },
  history: [],
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
    (!candidate.validation || passesFactorMetrics(candidate.validation, 8, true)) && passesFactorMetrics(candidate.holdout, 5);
}
/** Stable comparison also invalidates approval after manual parameter edits. */
export function factorConfigKey(value: object): string {
  return JSON.stringify(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)));
}
