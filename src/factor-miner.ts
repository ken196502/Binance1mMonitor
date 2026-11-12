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
      { minHighChange24h: 20, ampDivisor: 8, minStreakCount: 2, holdMinutes: 15, exitX: 50, exitN: 1.5, exitM: 3.0 },
      { minHighChange24h: 20, ampDivisor: 10, minStreakCount: 2, holdMinutes: 15, exitX: 50, exitN: 1.5, exitM: 3.0 },
      { minHighChange24h: 20, ampDivisor: 12, minStreakCount: 2, holdMinutes: 15, exitX: 50, exitN: 1.5, exitM: 3.0 },
      { minHighChange24h: 20, ampDivisor: 10, minStreakCount: 1, holdMinutes: 15, exitX: 50, exitN: 1.5, exitM: 3.0 },
      { minHighChange24h: 20, ampDivisor: 10, minStreakCount: 3, holdMinutes: 15, exitX: 50, exitN: 1.5, exitM: 3.0 },
      { minHighChange24h: 20, ampDivisor: 10, minStreakCount: 2, holdMinutes: 10, exitX: 40, exitN: 1.2, exitM: 2.5 },
      { minHighChange24h: 20, ampDivisor: 10, minStreakCount: 2, holdMinutes: 20, exitX: 60, exitN: 1.8, exitM: 3.5 },
    ].map(c => ({ strategyId: "streak", config: c, definition: streakPreset(c) })),

    hourly_suppression: [
      { minHighChange24h: 20, ampDivisor: 10, nGreenBars: 4, holdMinutes: 30, exitX: 50 },
      { minHighChange24h: 20, ampDivisor: 8, nGreenBars: 3, holdMinutes: 20, exitX: 40 },
      { minHighChange24h: 20, ampDivisor: 12, nGreenBars: 5, holdMinutes: 45, exitX: 60 },
      { minHighChange24h: 20, ampDivisor: 10, nGreenBars: 3, holdMinutes: 30, exitX: 50 },
      { minHighChange24h: 20, ampDivisor: 8, nGreenBars: 4, holdMinutes: 15, exitX: 40 },
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
  
  // 1. 做空高胜率候选网格 (覆盖历史验证最佳的 5m/10m 冲高诱多、MA破位/受阻、绿柱比例与大波段止盈止损)
  // 核心约束：24h最高涨幅不到 20% 的做空失败概率极大，加入 24h 最高涨幅区间网格 [20%+] 与 [20%~100%]
  const shortHighRanges = [
    { minHighChange24h: 20 },
    { minHighChange24h: 20, maxHighChange24h: 100 },
  ] as const;

  for (const intervalWindow of [5, 10, 15]) {
    for (const ampDivisor of [8, 10]) {
      const shortMas = ["MA10_BREAKDOWN", "MA20_RESIST", "MA60_RESIST", "MA20_BREAKDOWN"] as const;
      const shortMacds = ["GREEN_RATIO_30_80", "HIST_WEAKENING", "DIF_HIGH_LEVEL"] as const;
      const shortCandles = ["UPPER_SHADOW_PINBAR", "BEARISH_BAR", "NONE"] as const;
      for (const maRequirement of shortMas) {
        for (const macdRequirement of shortMacds) {
          for (const candleRequirement of shortCandles) {
            for (const holdMinutes of [30, 45]) {
              for (const range of shortHighRanges) {
                const rangeTag = range.maxHighChange24h ? `HC${range.minHighChange24h}_${range.maxHighChange24h}` : `HC${range.minHighChange24h}`;
                candidates.push({
                  id: `SHORT:${intervalWindow}:${ampDivisor}:${maRequirement}:${macdRequirement}:${candleRequirement}:${holdMinutes}:${rangeTag}`,
                  side: "SHORT",
                  intervalWindow,
                  ampDivisor,
                  maRequirement,
                  macdRequirement,
                  candleRequirement,
                  holdMinutes,
                  topN: 10,
                  minHighChange24h: range.minHighChange24h,
                  maxHighChange24h: range.maxHighChange24h,
                  tp1Percent: 3.0,
                  tp2Percent: 7.0,
                  stopLossPercent: 5.0,
                  cooldownMinutes: holdMinutes,
                  moveSlToEntryAfterTp1: true,
                  leverage: 3,
                });
              }
            }
          }
        }
      }
    }
  }

  // 2. 做多高胜率候选网格 (顺势冲高回踩 MA20/MA10 支撑、多头排列与健康绿柱)
  for (const intervalWindow of [5, 10, 15]) {
    for (const ampDivisor of [8, 10]) {
      const longMas = ["MA10_SUPPORT", "MA20_SUPPORT", "MA_BULLISH_STACK", "MA_FRESH_BULL"] as const;
      const longMacds = ["GREEN_RATIO_15_70", "GOLDEN_CROSS_RECENT", "HIST_EXPANDING"] as const;
      const longCandles = ["LOWER_SHADOW_HAMMER", "BULLISH_BAR", "NONE"] as const;
      for (const maRequirement of longMas) {
        for (const macdRequirement of longMacds) {
          for (const candleRequirement of longCandles) {
            for (const holdMinutes of [20, 30]) {
              candidates.push({
                id: `LONG:${intervalWindow}:${ampDivisor}:${maRequirement}:${macdRequirement}:${candleRequirement}:${holdMinutes}`,
                side: "LONG",
                intervalWindow,
                ampDivisor,
                maRequirement,
                macdRequirement,
                candleRequirement,
                holdMinutes,
                topN: 10,
                minDayChange: 10,
                tp1Percent: 2.5,
                tp2Percent: 5.5,
                stopLossPercent: 3.5,
                cooldownMinutes: holdMinutes,
                moveSlToEntryAfterTp1: true,
                leverage: 3,
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
export function mineFactors(
  data: FactorDataset,
  costs: FactorMiningResult["costs"],
  candidates = factorCandidates(),
  windows?: Partial<FactorWindows>,
  targetStrategyId?: string,
): FactorMiningResult {
  const end = data.dataAsOf;
  const { train, validation, holdout } = factorRanges(end, windows);
  const fvCache = new Map<string, FeatureVector | null>();
  const evaluate = (strategy: ReplayStrategy, range: { start: number; end: number }) => factorMetrics(
    replayStrategies(data.candles, data.indices, data.times, data.boards, [strategy], range, { costs, fvCache, leverage: 3 }).trades,
  );
  const result: FactorMiningResult = {
    windows: factorWindows(windows),
    policyVersion: FACTOR_POLICY_VERSION, featureVersion: FEATURE_VERSION, dataAsOf: end,
    datasetHash: data.datasetHash, trials: 0, costs,
    sides: { LONG: { reason: "非本轮目标策略" }, SHORT: { reason: "非本轮目标策略" } },
    targetStrategyId,
  };
  const hasValidation = validation.end > validation.start;

  // Determine if we should evaluate quant sides (LONG/SHORT)
  const shouldEvaluateSide = (side: FactorSide) => {
    if (!targetStrategyId) return true;
    if (side === "LONG" && targetStrategyId === "kline_stats_long") return true;
    if (side === "SHORT" && targetStrategyId === "kline_stats_short") return true;
    return false;
  };

  const sidesToEvaluate = (["LONG", "SHORT"] as FactorSide[]).filter(shouldEvaluateSide);
  for (const side of sidesToEvaluate) {
    result.sides[side] = { reason: "训练/验证样本不足或收益未达标" };
    const sideCandidates = candidates.filter(c => c.side === side);
    result.trials += sideCandidates.length;
    let best: { strategy: ReplayStrategy; train: FactorMetrics; validation?: FactorMetrics } | undefined;
    for (const strategy of sideCandidates) {
      const trainMetrics = evaluate(strategy, train);
      if (!passesFactorMetrics(trainMetrics, 3)) continue;
      let valMetrics: FactorMetrics | undefined;
      if (hasValidation) {
        valMetrics = evaluate(strategy, validation);
        if (!passesFactorMetrics(valMetrics, 1, true)) continue;
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
    if (!passesFactorMetrics(holdoutMetrics, 1)) {
      result.sides[side] = { reason: `候选在留出检验未达标 (笔数${holdoutMetrics.trades}, 胜率${holdoutMetrics.winRate.toFixed(1)}%, 净利${holdoutMetrics.netPercent.toFixed(1)}%)` };
      continue;
    }
    const { id, side: _, ...config } = best.strategy;
    const candidate: FactorCandidate = { id, config: config as FactorCandidate["config"],
      train: best.train, validation: best.validation, holdout: holdoutMetrics };
    result.sides[side] = { candidate, reason: "近期训练和留出检验通过" };
  }

  const presetCandidates = presetStrategyCandidates();
  result.strategies = {};
  const presetIds = Object.keys(presetCandidates);
  const strategiesToEvaluate = targetStrategyId
    ? (presetIds.includes(targetStrategyId) ? [targetStrategyId] : [])
    : presetIds;

  if (targetStrategyId && presetIds.includes(targetStrategyId)) {
    result.trials = presetCandidates[targetStrategyId].length;
  } else if (!targetStrategyId) {
    result.trials = candidates.length;
  }

  for (const strategyId of strategiesToEvaluate) {
    const items = presetCandidates[strategyId];
    let best: { config: Record<string, any>; train: FactorMetrics; validation?: FactorMetrics; holdout: FactorMetrics } | undefined;
    let maxTrainTrades = 0;
    let bestFailedTrain: FactorMetrics | undefined;
    let bestFailedVal: FactorMetrics | undefined;
    let bestFailedHold: FactorMetrics | undefined;

    for (const item of items) {
      const trainTrades = replayStrategies(data.candles, data.indices, data.times, data.boards, [item.definition], train, { costs, fvCache, leverage: 3 }).trades;
      const trainMetrics = factorMetrics(trainTrades);
      if (trainMetrics.trades > maxTrainTrades) {
        maxTrainTrades = trainMetrics.trades;
      }
      if (!bestFailedTrain || trainMetrics.avgNetPercent > bestFailedTrain.avgNetPercent) {
        bestFailedTrain = trainMetrics;
      }

      if (trainMetrics.trades < 2 || trainMetrics.winRate < 60 || trainMetrics.netPercent <= 0) continue;

      let valMetrics: FactorMetrics | undefined;
      if (hasValidation) {
        const valTrades = replayStrategies(data.candles, data.indices, data.times, data.boards, [item.definition], validation, { costs, fvCache, leverage: 3 }).trades;
        valMetrics = factorMetrics(valTrades);
        if (valMetrics.trades > 0 && (valMetrics.winRate < 50 || valMetrics.netPercent < 0)) {
          bestFailedVal = valMetrics;
          continue;
        }
      }

      const holdTrades = replayStrategies(data.candles, data.indices, data.times, data.boards, [item.definition], holdout, { costs, fvCache, leverage: 3 }).trades;
      const holdMetrics = factorMetrics(holdTrades);
      if (holdMetrics.trades > 0 && (holdMetrics.winRate < 50 || holdMetrics.netPercent < 0)) {
        bestFailedHold = holdMetrics;
        continue;
      }

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
      let failReason = "近期样本不足或未达收益门槛";
      if (maxTrainTrades === 0) {
        failReason = "近期训练集无触发样本 (0 笔，未出现该形态)";
      } else if (maxTrainTrades < 2) {
        failReason = `近期训练样本不足 (最多仅 ${maxTrainTrades} 笔，门槛要求 >= 2 笔)`;
      } else if (bestFailedHold) {
        failReason = `候选在留出检验未达标 (笔数 ${bestFailedHold.trades}, 胜率 ${bestFailedHold.winRate.toFixed(1)}%, 净利 ${bestFailedHold.netPercent.toFixed(1)}%)`;
      } else if (bestFailedVal) {
        failReason = `候选在验证集未达标 (笔数 ${bestFailedVal.trades}, 胜率 ${bestFailedVal.winRate.toFixed(1)}%, 净利 ${bestFailedVal.netPercent.toFixed(1)}%)`;
      } else if (bestFailedTrain) {
        if (bestFailedTrain.winRate < 60) {
          failReason = `训练集胜率未达标 (最高胜率仅 ${bestFailedTrain.winRate.toFixed(1)}% < 60%，样本 ${bestFailedTrain.trades} 笔)`;
        } else if (bestFailedTrain.netPercent <= 0) {
          failReason = `训练集净收益未达标 (净利 ${bestFailedTrain.netPercent.toFixed(1)}% <= 0，样本 ${bestFailedTrain.trades} 笔)`;
        } else {
          failReason = `训练集回测未通过 (笔数 ${bestFailedTrain.trades}, 胜率 ${bestFailedTrain.winRate.toFixed(1)}%, 净利 ${bestFailedTrain.netPercent.toFixed(1)}%)`;
        }
      }
      result.strategies[strategyId] = {
        reason: failReason,
      };
    }
  }

  return result;
}
