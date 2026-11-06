import type { KlineStatsStrategyLiveConfig } from "./types.ts";

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
export const emptyFactorState = (): FactorMiningState => ({
  running: false,
  sides: { LONG: { reason: "等待近期样本验证" }, SHORT: { reason: "等待近期样本验证" } },
});
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
