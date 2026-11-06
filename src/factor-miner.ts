import { FEATURE_VERSION, type FeatureVector } from "./features.ts";
import { replayStrategies, type ReplayStrategy, type ReplayTrade } from "./strategy-replay.ts";
import type { FactorDataset } from "./factor-data.ts";
import {
  FACTOR_LOOKBACK_MINUTES, FACTOR_TEST_MINUTES, FACTOR_POLICY_VERSION, MINUTE_MS,
  passesFactorMetrics, type FactorCandidate, type FactorMetrics, type FactorMiningResult, type FactorSide,
} from "./factor-policy.ts";

export function factorMetrics(trades: ReplayTrade[]): FactorMetrics {
  const wins = trades.filter(t => t.isWin).length;
  const n = trades.length;
  const p = n ? wins / n : 0;
  const z2 = 1.96 ** 2;
  const wilsonLow = n ? (p + z2 / (2 * n) - 1.96 * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n) * 100 : 0;
  const grossProfit = trades.reduce((s, t) => s + Math.max(0, t.netPercent), 0);
  const grossLoss = trades.reduce((s, t) => s + Math.max(0, -t.netPercent), 0);
  const netPercent = grossProfit - grossLoss;
  return { trades: n, wins, winRate: p * 100, wilsonLow, grossProfit, grossLoss,
    profitFactor: grossLoss ? grossProfit / grossLoss : grossProfit ? null : 0,
    netPercent, avgNetPercent: n ? netPercent / n : 0 };
}

export function factorCandidates(): ReplayStrategy[] {
  const candidates: ReplayStrategy[] = [];
  for (const side of ["LONG", "SHORT"] as const) {
    for (const intervalWindow of [5, 10]) for (const ampDivisor of [8, 10]) {
      const mas = side === "LONG" ? ["MA10_SUPPORT", "MA20_SUPPORT"] : ["MA10_BREAKDOWN", "MA60_RESIST"];
      const macds = side === "LONG" ? ["GREEN_RATIO_15_50", "GOLDEN_CROSS_RECENT", "HIST_EXPANDING"] : ["GREEN_RATIO_30_80", "DEATH_CROSS_RECENT", "HIST_WEAKENING"];
      for (const maRequirement of mas) for (const macdRequirement of macds) for (const holdMinutes of [20, 30]) {
        candidates.push({
          id: `${side}:${intervalWindow}:${ampDivisor}:${maRequirement}:${macdRequirement}:${holdMinutes}`,
          side, intervalWindow, ampDivisor, maRequirement, macdRequirement, holdMinutes,
          topN: 10, minDayChange: 10, tp1Percent: 2.5, tp2Percent: 5,
          stopLossPercent: side === "LONG" ? 3 : 3.5, cooldownMinutes: 20,
          moveSlToEntryAfterTp1: true, leverage: 3,
        });
      }
    }
  }
  return candidates;
}

/** Select on train/validation only; inspect the final holdout ONCE per direction. */
export function mineFactors(data: FactorDataset, costs: FactorMiningResult["costs"], candidates = factorCandidates()): FactorMiningResult {
  const end = data.dataAsOf;
  const holdout = { start: end - FACTOR_TEST_MINUTES * MINUTE_MS, end };
  const validation = { start: holdout.start - FACTOR_TEST_MINUTES * MINUTE_MS, end: holdout.start };
  const train = { start: end - FACTOR_LOOKBACK_MINUTES * MINUTE_MS, end: validation.start };
  const fvCache = new Map<string, FeatureVector | null>();
  const evaluate = (strategy: ReplayStrategy, range: { start: number; end: number }) => factorMetrics(
    replayStrategies(data.candles, data.indices, data.times, data.boards, [strategy], range, { costs, fvCache, leverage: 3 }).trades,
  );
  const result: FactorMiningResult = {
    policyVersion: FACTOR_POLICY_VERSION, featureVersion: FEATURE_VERSION, dataAsOf: end,
    datasetHash: data.datasetHash, trials: candidates.length, costs,
    sides: { LONG: { reason: "训练/验证样本不足或收益未达标" }, SHORT: { reason: "训练/验证样本不足或收益未达标" } },
  };
  for (const side of ["LONG", "SHORT"] as FactorSide[]) {
    let best: { strategy: ReplayStrategy; train: FactorMetrics; validation: FactorMetrics } | undefined;
    for (const strategy of candidates.filter(c => c.side === side)) {
      const trainMetrics = evaluate(strategy, train);
      if (!passesFactorMetrics(trainMetrics, 10)) continue;
      const valMetrics = evaluate(strategy, validation);
      if (!passesFactorMetrics(valMetrics, 8, true)) continue;
      if (!best || valMetrics.wilsonLow > best.validation.wilsonLow ||
        (valMetrics.wilsonLow === best.validation.wilsonLow && valMetrics.avgNetPercent > best.validation.avgNetPercent)) {
        best = { strategy, train: trainMetrics, validation: valMetrics };
      }
    }
    if (!best) continue;
    const holdoutMetrics = evaluate(best.strategy, holdout);
    if (!passesFactorMetrics(holdoutMetrics, 5)) {
      result.sides[side] = { reason: "候选在最新 6 小时留出检验未达标" };
      continue;
    }
    const { id, side: _, ...config } = best.strategy;
    const candidate: FactorCandidate = { id, config: config as FactorCandidate["config"],
      train: best.train, validation: best.validation, holdout: holdoutMetrics };
    result.sides[side] = { candidate, reason: "近期验证和留出检验通过" };
  }
  return result;
}
