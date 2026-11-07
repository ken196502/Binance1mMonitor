import { all, any, rule as r, ref, compileFeatureSpec, type FeatureRule } from "./strategy-rules.ts";
import type { StrategyDefinition } from "./strategy-definition.ts";
import type { PaperStrategyConfig } from "./paper-trading.ts";
import type { KlineStatsStrategySpec } from "./features.ts";
import type { PaperExitParams } from "./types.ts";
import {
  STREAK_LIVE_DEFAULT_CONFIG, PEAK_REBOUND_LIVE_DEFAULT_CONFIG, DEEP_REBOUND_LIVE_DEFAULT_CONFIG,
  HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG, W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG,
  type StreakStrategyLiveConfig, type PeakReboundLiveConfig, type DeepReboundLiveConfig,
  type HourlySuppressionLiveConfig, type WBottomDivergenceLiveConfig,
} from "./strategy-legacy-config.ts";

function exit(config: PaperExitParams): PaperExitParams {
  const result: PaperExitParams = { holdMinutes: config.holdMinutes };
  for (const key of ["exitX", "exitN", "exitM", "tp1Percent", "tp2Percent", "stopLossPercent", "moveSlToEntryAfterTp1", "leverage"] as const) {
    if (config[key] !== undefined) Object.assign(result, { [key]: config[key] });
  }
  return result;
}
function preset(id: string, label: string, side: "LONG" | "SHORT", minBars: number, rules: FeatureRule[], config: PaperExitParams, cooldownMinutes = 0): StrategyDefinition {
  return { id, label, side, enabled: true, minBars, entry: all(...rules), exit: exit(config), cooldownMinutes };
}
export function streakPreset(config: Partial<StreakStrategyLiveConfig> = {}): StrategyDefinition {
  const c = { ...STREAK_LIVE_DEFAULT_CONFIG, ...config };
  const rules: FeatureRule[] = [r("dayChange", ">", 0), r("rank", "<=", c.topN), r(`surge.${c.xMinutes ?? 5}`, ">=", ref("dayChange", 1 / c.ampDivisor)), ...c.supportMaPeriods.map(p => r(`support.${p}`, "==", false))];
  if (c.require24hNewHigh ?? true) rules.push(r("new24hHigh", "==", true));
  if (c.minStreakCount !== undefined && c.minStreakCount > 0) rules.push(r(`streak.${c.requireBearish ? 1 : 0}.up`, ">=", c.minStreakCount));
  if (c.minUpperShadowRatio !== undefined && c.maxUpperShadowRatio !== undefined) rules.push(r("upperShadowRatio", ">=", c.minUpperShadowRatio), r("upperShadowRatio", "<", c.maxUpperShadowRatio));
  if (c.requireBearish) rules.push(r("price.close", "<", ref("price.open")));
  if (c.maxLowerShadowPercent !== undefined) rules.push(r("lowerWick", "<=", c.maxLowerShadowPercent));
  if (!c.requireMacdDivergence && (c.requireDeaDivergence ?? true)) {
    rules.push(r(`deaPeak.${c.deaLookbackMinutes ?? 30}.ago`, ">=", 1), r("deaSlope", "<", 0));
  } else if (c.requireMacdDivergence ?? true) {
    const p = `pivotHigh.${c.divergenceLookbackMin ?? 10}.${c.divergenceLookbackMax ?? 120}`;
    rules.push(r("price.high", ">=", ref(`${p}.price`)), r("hist", "<", ref(`${p}.hist`)));
    if (c.requireDoubleDivergence ?? true) rules.push(r("dif", "<", ref(`${p}.dif`)));
  }
  return preset("streak", "新高顶背离", "SHORT", Math.max(35, ...c.supportMaPeriods), rules, c);
}
export function reboundPreset(config: Partial<PeakReboundLiveConfig> = {}): StrategyDefinition {
  const c = { ...PEAK_REBOUND_LIVE_DEFAULT_CONFIG, ...config };
  const rules: FeatureRule[] = [r("dayChange", ">", 0), r("watch.ready", "==", true), r("watch.state", "==", "rebounded"),
    r(`ma.${c.longMa}.value`, ">", ref(`ma.${c.mediumMa ?? c.shortMa}.value`)),
    r("price.high", ">", ref(`ma.${c.shortMa}.value`)), r("price.close", "<", ref(`ma.${c.shortMa}.value`))];
  if (c.mediumMa !== undefined) rules.push(r(`ma.${c.mediumMa}.value`, ">", ref(`ma.${c.shortMa}.value`)));
  if (c.longMaOffsetPercent > 0) rules.push(r(`ma.${c.longMa}.value`, ">=", ref("price.high", 1 + c.longMaOffsetPercent / 100)));
  if (c.requireMaSlopeDown) {
    rules.push(r(`ma.${c.longMa}.slope2`, "<=", 0));
    if (c.mediumMa !== undefined) rules.push(r(`ma.${c.mediumMa}.slope2`, "<=", 0));
  }
  if (c.minGreenRatio20 > 0) rules.push(r("greenRatio.20", ">", c.minGreenRatio20));
  if (c.minReboundUpCandles !== undefined) rules.push(r("watch.upCandles", ">=", c.minReboundUpCandles));
  if (c.maxFibRetracement !== undefined) rules.push(r("watch.fib", "<=", c.maxFibRetracement));
  if (c.requireBearishOrUpperShadow) rules.push(any(r("price.close", "<=", ref("price.open")), r("upperRangeRatio", ">=", c.minUpperShadowRatio ?? 0.3)));
  return { ...preset("rebound", "首次跌10%", "SHORT", Math.max(c.shortMa, c.mediumMa ?? 0, c.longMa, 30) + 4, rules, c, c.holdMinutes),
    observation: { rank: 1, watchWindowHours: c.watchWindowHours, pullbackPercent: c.pullbackX, reboundPercent: c.reboundY, historyBars: 120 } };
}
export function deepReboundPreset(config: Partial<DeepReboundLiveConfig> = {}): StrategyDefinition {
  const c = { ...DEEP_REBOUND_LIVE_DEFAULT_CONFIG, ...config };
  const rules: FeatureRule[] = [r("dayChange", ">", 0), r("dropFrom24hHigh", ">=", c.pullbackX), r(`surge.${c.lowWindowMinutes}`, ">=", c.reboundY),
    r("price.close", "<", ref(`ma.${c.shortMa}.value`)), r(`ma.${c.shortMa}.value`, "<", ref("price.high")), r(`ma.${c.shortMa}.value`, "<", ref(`ma.${c.longMa}.value`))];
  if (c.requireMaSlopeDown) rules.push(r(`ma.${c.longMa}.slope2`, "<=", 0));
  if (c.minGreenRatio20 > 0) rules.push(r("greenRatio.20", ">", c.minGreenRatio20));
  return preset("deep_rebound", "跌到20%+", "SHORT", Math.max(36, c.shortMa + 3, c.longMa + 3), rules, c, c.cooldownMinutes);
}
export function hourlyPreset(config: Partial<HourlySuppressionLiveConfig> = {}): StrategyDefinition {
  const c = { ...HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG, ...config };
  const rules: FeatureRule[] = [r("dayChange", ">", 0), r("rank", "<=", c.topN), r("dayChange", ">=", c.minDayChange ?? 0),
    r("price.high", ">", ref("ma.60.value")), r("price.low", "<", ref("ma.60.value")), r("greenStreak", ">=", Math.max(1, c.nGreenBars))];
  if (c.requireSurge ?? true) rules.push(r(`surge.${c.xMinutes ?? 5}`, ">=", ref("dayChange", 1 / (c.ampDivisor ?? 10))));
  if (c.minDropFrom24h !== undefined && c.minDropFrom24h > 0) rules.push(r("dropFrom24hHigh", ">=", c.minDropFrom24h));
  if (c.requireMa60GtMa10GtMa20) rules.push(r("ma.60.value", ">", ref("ma.10.value")), r("ma.10.value", ">", ref("ma.20.value")));
  if (c.requireCloseBelowMa) rules.push(r("price.close", "<", ref("ma.60.value")));
  if (c.requireBearish) rules.push(r("price.close", "<", ref("price.open")));
  if (c.requireMaSlopeDown) rules.push(r("ma.60.slope3", "<=", 0));
  return preset("hourly_suppression", "小时线压制", "SHORT", 66, rules, c, c.cooldownMinutes);
}
export function wBottomPreset(config: Partial<WBottomDivergenceLiveConfig> = {}): StrategyDefinition {
  const c = { ...W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG, ...config };
  const p = `pivotLow.${c.prevBottomMinBars}.${c.prevBottomMaxBars}`;
  const rules: FeatureRule[] = [r("rank", "<=", c.topN), r("dayChange", ">=", c.minDayChange), r("drop.31", ">=", c.minDropPercent),
    r(`${p}.bounce`, ">=", c.minNecklineBounce), r(`${p}.ratio`, ">=", c.minBottomFloorRatio), r(`${p}.ratio`, "<=", c.maxBottomToleranceRatio)];
  if (c.requireMacdDivergence) rules.push(r("dif", ">", ref(`${p}.dif`)), r("hist", ">", ref(`${p}.hist`)));
  if (c.requireCatapultBull) rules.push(r("price.close", ">", ref("price.open")), r("price.close", ">", ref("price.previousHigh", 0.999)));
  return preset("w_bottom_divergence", "左侧3W底背离", "LONG", 41, rules, c, c.cooldownMinutes);
}
export function quantPreset(side: "LONG" | "SHORT", c: KlineStatsStrategySpec): StrategyDefinition {
  let label = side === "SHORT" ? "冲高破位" : "回踩支撑";
  if (["MA20_RESIST", "MA30_RESIST", "MA60_RESIST"].includes(c.maRequirement ?? "")) label = "均线受阻";
  if (c.maRequirement === "MA_BEARISH_STACK") label = "空头排列";
  if (c.maRequirement === "MA_BULLISH_STACK") label = "多头排列";
  if (["MA10_BREAKOUT", "MA20_BREAKOUT"].includes(c.maRequirement ?? "")) label = "均线突破";
  return { id: `kline_stats_${side.toLowerCase()}`, label, side, enabled: true, minBars: 60,
    entry: compileFeatureSpec(side, c), exit: exit({ holdMinutes: c.holdMinutes ?? (side === "SHORT" ? 45 : 30),
      tp1Percent: c.tp1Percent ?? (side === "SHORT" ? 3 : 2.5), tp2Percent: c.tp2Percent ?? (side === "SHORT" ? 7 : 5.5),
      stopLossPercent: c.stopLossPercent ?? (side === "SHORT" ? 5 : 3.5), moveSlToEntryAfterTp1: c.moveSlToEntryAfterTp1 ?? true, leverage: c.leverage ?? 3 }),
    cooldownMinutes: c.cooldownMinutes ?? 20, cooldownFrom: "exit", cooldownGroup: "quant", factorManaged: true };
}

/** Migration boundary only. Runtime execution never branches on these legacy names. */
export function buildStrategyPresets(c: PaperStrategyConfig): StrategyDefinition[] {
  const strategies = [
    reboundPreset(c.reboundConfig), deepReboundPreset(c.deepReboundConfig),
    streakPreset({ topN: c.topN, supportMaPeriods: c.supportMaPeriods, ampDivisor: c.ampDivisor, holdMinutes: c.holdMinutes, exitX: c.exitX, exitN: c.exitN, exitM: c.exitM, ...c.streakConfig }),
    hourlyPreset(c.hourlySuppressionConfig), wBottomPreset(c.wBottomDivergenceConfig),
    quantPreset("SHORT", c.klineStatsShortConfig ?? {}), quantPreset("LONG", c.klineStatsLongConfig ?? {}),
  ];
  const enabled = [c.enableRebound, c.enableDeepRebound, c.enableStreak, c.enableHourlySuppression, c.enableWBottomDivergence, c.enableKlineStatsShort, c.enableKlineStatsLong];
  const leverage = [c.trendLeverage ?? c.leverage, c.trendLeverage ?? c.leverage, c.streakLeverage ?? 3, c.hourlySuppressionConfig?.leverage ?? c.trendLeverage ?? c.leverage,
    c.wBottomDivergenceConfig?.leverage ?? c.longLeverage ?? 3, c.klineStatsShortConfig?.leverage ?? c.klineStatsLeverage ?? 3, c.klineStatsLongConfig?.leverage ?? c.longLeverage ?? 3];
  return strategies.map((s, i) => ({ ...s, enabled: enabled[i] ?? true, exit: { ...s.exit, leverage: leverage[i] } }));
}
export const LEGACY_STRATEGY_KEYS = {
  rebound: ["reboundConfig", "enableRebound", "trendLeverage", "leverage"],
  deep_rebound: ["deepReboundConfig", "enableDeepRebound", "trendLeverage", "leverage"],
  streak: ["streakConfig", "enableStreak", "streakLeverage", "topN", "ampDivisor", "supportMaPeriods", "holdMinutes", "exitX", "exitN", "exitM"],
  hourly_suppression: ["hourlySuppressionConfig", "enableHourlySuppression", "trendLeverage", "leverage"],
  w_bottom_divergence: ["wBottomDivergenceConfig", "enableWBottomDivergence", "longLeverage"],
  kline_stats_short: ["klineStatsShortConfig", "enableKlineStatsShort", "klineStatsLeverage"],
  kline_stats_long: ["klineStatsLongConfig", "enableKlineStatsLong", "longLeverage"],
} as const;
