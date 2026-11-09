import { factorRanges, factorWindows, type FactorWindows } from "./factor-settings.ts";
import { FEATURE_VERSION, type FeatureVector } from "./features.ts";
import { replayStrategies, type ReplayStrategy, type ReplayTrade } from "./strategy-replay.ts";
import type { FactorDataset } from "./factor-data.ts";
import type { StrategyDefinition } from "./strategy-definition.ts";
import {
  streakPreset, hourlyPreset, deepReboundPreset, reboundPreset, wBottomPreset,
} from "./strategy-presets.ts";
import {
  FACTOR_POLICY_VERSION,
  passesFactorMetrics, type FactorCandidate, type FactorMetrics, type FactorMiningResult, type FactorSide,
} from "./factor-policy.ts";

export interface PresetCandidateItem {
  strategyId: string;
  config: Record<string, any>;
  definition: StrategyDefinition;
}

export function presetStrategyCandidates(): Record<string, PresetCandidateItem[]> {
  return {
    streak: [
      { ampDivisor: 8, minStreakCount: 2, holdMinutes: 15, exitX: 50, exitN: 1.5, exitM: 3.0 },
      { ampDivisor: 10, minStreakCount: 2, holdMinutes: 15, exitX: 50, exitN: 1.5, exitM: 3.0 },
      { ampDivisor: 12, minStreakCount: 2, holdMinutes: 15, exitX: 50, exitN: 1.5, exitM: 3.0 },
      { ampDivisor: 10, minStreakCount: 1, holdMinutes: 15, exitX: 50, exitN: 1.5, exitM: 3.0 },
      { ampDivisor: 10, minStreakCount: 3, holdMinutes: 15, exitX: 50, exitN: 1.5, exitM: 3.0 },
      { ampDivisor: 10, minStreakCount: 2, holdMinutes: 10, exitX: 40, exitN: 1.2, exitM: 2.5 },
      { ampDivisor: 10, minStreakCount: 2, holdMinutes: 20, exitX: 60, exitN: 1.8, exitM: 3.5 },
    ].map(c => ({ strategyId: "streak", config: c, definition: streakPreset(c) })),

    hourly_suppression: [
      { ampDivisor: 10, nGreenBars: 4, holdMinutes: 30, exitX: 50 },
      { ampDivisor: 8, nGreenBars: 3, holdMinutes: 20, exitX: 40 },
      { ampDivisor: 12, nGreenBars: 5, holdMinutes: 45, exitX: 60 },
      { ampDivisor: 10, nGreenBars: 3, holdMinutes: 30, exitX: 50 },
      { ampDivisor: 8, nGreenBars: 4, holdMinutes: 15, exitX: 40 },
    ].map(c => ({ strategyId: "hourly_suppression", config: c, definition: hourlyPreset(c) })),

    deep_rebound: [
      { pullbackX: 20, reboundY: 5, holdMinutes: 30 },
      { pullbackX: 15, reboundY: 3, holdMinutes: 20 },
      { pullbackX: 25, reboundY: 7, holdMinutes: 30 },
      { pullbackX: 20, reboundY: 3, holdMinutes: 20 },
    ].map(c => ({ strategyId: "deep_rebound", config: c, definition: deepReboundPreset(c) })),

    rebound: [
      { pullbackX: 10, reboundY: 3, holdMinutes: 30 },
      { pullbackX: 8, reboundY: 2, holdMinutes: 20 },
      { pullbackX: 12, reboundY: 4, holdMinutes: 30 },
    ].map(c => ({ strategyId: "rebound", config: c, definition: reboundPreset(c) })),

    w_bottom_divergence: [
      { minDropPercent: 10, minNecklineBounce: 5, holdMinutes: 30 },
      { minDropPercent: 8, minNecklineBounce: 3, holdMinutes: 20 },
      { minDropPercent: 12, minNecklineBounce: 6, holdMinutes: 30 },
    ].map(c => ({ strategyId: "w_bottom_divergence", config: c, definition: wBottomPreset(c) })),
  };
}

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
    for (const intervalWindow of [15, 30]) for (const ampDivisor of [8, 10]) {
      // 监控 ovcl (Open, High/Vol, Close, Low) vs maN 的核心交互形态
      const mas = side === "LONG"
        ? ["MA10_SUPPORT", "MA20_SUPPORT", "MA10_BREAKOUT", "MA10_CLOSE_ABOVE"] as const
        : ["MA10_BREAKDOWN", "MA20_BREAKDOWN", "MA20_RESIST", "MA10_CLOSE_BELOW"] as const;

      // 短周期 DIF 周期高低位 + MACD 关键形态
      const macds = side === "LONG"
        ? ["DIF_LOW_LEVEL", "GOLDEN_CROSS_RECENT", "HIST_EXPANDING"] as const
        : ["DIF_HIGH_LEVEL", "DEATH_CROSS_RECENT", "HIST_WEAKENING"] as const;

      // 微观 K 线形态 (长上影冲高回落/长下影探底回升/阴阳实体确认)
      const candles = side === "LONG"
        ? ["LOWER_SHADOW_HAMMER", "BULLISH_BAR", "NONE"] as const
        : ["UPPER_SHADOW_PINBAR", "BEARISH_BAR", "NONE"] as const;

      for (const maRequirement of mas) {
        for (const macdRequirement of macds) {
          for (const candleRequirement of candles) {
            for (const holdMinutes of [10, 15]) {
              candidates.push({
                id: `${side}:${intervalWindow}:${ampDivisor}:${maRequirement}:${macdRequirement}:${candleRequirement}:${holdMinutes}`,
                side, intervalWindow, ampDivisor, maRequirement, macdRequirement, candleRequirement, holdMinutes,
                topN: 10, minDayChange: 10, tp1Percent: 2.5, tp2Percent: 5,
                stopLossPercent: side === "LONG" ? 3 : 3.5, cooldownMinutes: 3,
                moveSlToEntryAfterTp1: true, leverage: 3,
              });
            }
          }
        }
      }
    }
  }
  return candidates;
}

/** Select on train/validation only; inspect the final holdout ONCE per direction. */
export function mineFactors(data: FactorDataset, costs: FactorMiningResult["costs"], candidates = factorCandidates(), windows?: Partial<FactorWindows>): FactorMiningResult {
  const end = data.dataAsOf;
  const { train, validation, holdout } = factorRanges(end, windows);
  const fvCache = new Map<string, FeatureVector | null>();
  const evaluate = (strategy: ReplayStrategy, range: { start: number; end: number }) => factorMetrics(
    replayStrategies(data.candles, data.indices, data.times, data.boards, [strategy], range, { costs, fvCache, leverage: 3 }).trades,
  );
  const result: FactorMiningResult = {
    windows: factorWindows(windows),
    policyVersion: FACTOR_POLICY_VERSION, featureVersion: FEATURE_VERSION, dataAsOf: end,
    datasetHash: data.datasetHash, trials: candidates.length, costs,
    sides: { LONG: { reason: "训练/验证样本不足或收益未达标" }, SHORT: { reason: "训练/验证样本不足或收益未达标" } },
  };
  const hasValidation = validation.end > validation.start;
  for (const side of ["LONG", "SHORT"] as FactorSide[]) {
    let best: { strategy: ReplayStrategy; train: FactorMetrics; validation?: FactorMetrics } | undefined;
    for (const strategy of candidates.filter(c => c.side === side)) {
      const trainMetrics = evaluate(strategy, train);
      if (!passesFactorMetrics(trainMetrics, 10)) continue;
      let valMetrics: FactorMetrics | undefined;
      if (hasValidation) {
        valMetrics = evaluate(strategy, validation);
        if (!passesFactorMetrics(valMetrics, 8, true)) continue;
      }
      const score = valMetrics ?? trainMetrics;
      const bestScore = best ? (best.validation ?? best.train) : undefined;
      if (!best || !bestScore || score.wilsonLow > bestScore.wilsonLow ||
        (score.wilsonLow === bestScore.wilsonLow && score.avgNetPercent > bestScore.avgNetPercent)) {
        best = { strategy, train: trainMetrics, validation: valMetrics };
      }
    }
    if (!best) continue;
    const holdoutMetrics = evaluate(best.strategy, holdout);
    if (!passesFactorMetrics(holdoutMetrics, 5)) {
      result.sides[side] = { reason: `候选在留出检验未达标` };
      continue;
    }
    const { id, side: _, ...config } = best.strategy;
    const candidate: FactorCandidate = { id, config: config as FactorCandidate["config"],
      train: best.train, validation: best.validation, holdout: holdoutMetrics };
    result.sides[side] = { candidate, reason: "近期训练和留出检验通过" };
  }

  const presetCandidates = presetStrategyCandidates();
  result.strategies = {};
  for (const [strategyId, items] of Object.entries(presetCandidates)) {
    let best: { config: Record<string, any>; train: FactorMetrics; validation?: FactorMetrics; holdout: FactorMetrics } | undefined;
    for (const item of items) {
      const trainTrades = replayStrategies(data.candles, data.indices, data.times, data.boards, [item.definition], train, { costs, fvCache, leverage: 3 }).trades;
      const trainMetrics = factorMetrics(trainTrades);
      if (trainMetrics.trades < 2 || trainMetrics.winRate < 60 || trainMetrics.netPercent <= 0) continue;

      let valMetrics: FactorMetrics | undefined;
      if (hasValidation) {
        const valTrades = replayStrategies(data.candles, data.indices, data.times, data.boards, [item.definition], validation, { costs, fvCache, leverage: 3 }).trades;
        valMetrics = factorMetrics(valTrades);
        if (valMetrics.trades > 0 && (valMetrics.winRate < 50 || valMetrics.netPercent < 0)) continue;
      }

      const holdTrades = replayStrategies(data.candles, data.indices, data.times, data.boards, [item.definition], holdout, { costs, fvCache, leverage: 3 }).trades;
      const holdMetrics = factorMetrics(holdTrades);
      if (holdMetrics.trades > 0 && (holdMetrics.winRate < 50 || holdMetrics.netPercent < 0)) continue;

      const score = (valMetrics ?? trainMetrics).avgNetPercent;
      const bestScore = best ? (best.validation ?? best.train).avgNetPercent : -Infinity;
      if (!best || score > bestScore) {
        best = { config: item.config, train: trainMetrics, validation: valMetrics, holdout: holdMetrics };
      }
    }

    if (best) {
      result.strategies[strategyId] = {
        candidate: {
          strategyId,
          config: best.config,
          train: best.train,
          validation: best.validation,
          holdout: best.holdout,
        },
        reason: "近期行情回测验证通过",
      };
    } else {
      result.strategies[strategyId] = {
        reason: "近期样本不足或未达收益门槛",
      };
    }
  }

  return result;
}
