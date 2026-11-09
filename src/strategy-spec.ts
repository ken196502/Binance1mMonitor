import { validateRules } from "./strategy-rules.ts";
// Shared by the API validator, evaluator and browser form.
export const INTERVAL_WINDOWS = [3, 5, 10, 15, 30, 60] as const;
export const MA_REQUIREMENTS = [
  "NONE", "MA10_SUPPORT", "MA20_SUPPORT", "MA30_SUPPORT", "MA60_SUPPORT",
  "MA10_BREAKOUT", "MA20_BREAKOUT", "MA_BULLISH_STACK", "MA_FRESH_BULL", "MA_SUSTAINED_BULL",
  "MA60_RESIST", "MA20_RESIST", "MA30_RESIST", "MA10_BREAKDOWN", "MA20_BREAKDOWN",
  "MA10_CLOSE_BELOW", "MA20_CLOSE_BELOW", "MA10_CLOSE_ABOVE", "MA20_CLOSE_ABOVE",
  "MA_BEARISH_STACK", "MA_FRESH_BEAR", "MA_SUSTAINED_BEAR", "BIAS_RATIO_HIGH",
] as const;
export const MACD_REQUIREMENTS = [
  "NONE", "GREEN_RATIO_15_50", "GREEN_RATIO_20_50", "GREEN_RATIO_15_70",
  "GREEN_RATIO_30_70", "GREEN_RATIO_30_80", "GREEN_STREAK_3", "HIST_WEAKENING",
  "HIST_EXPANDING", "DEATH_CROSS_RECENT", "GOLDEN_CROSS_RECENT", "TOP_DIVERGENCE",
  "BOTTOM_DIVERGENCE", "TF5M_CONFIRM",
  "DIF_HIGH_LEVEL", "DIF_LOW_LEVEL", "DIF_CROSS_ZERO_DOWN", "DIF_CROSS_ZERO_UP",
] as const;
export const CANDLE_REQUIREMENTS = [
  "NONE", "UPPER_SHADOW_PINBAR", "BEARISH_BAR", "LOWER_SHADOW_HAMMER", "BULLISH_BAR",
] as const;

export function validateStrategySpec(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("策略参数必须是对象");
  const spec = value as Record<string, unknown>;
  if (spec.rules !== undefined) {
    if (!Array.isArray(spec.rules)) throw new Error("rules 必须是数组");
    for (const rule of spec.rules) validateRules(rule);
  }
  const numeric: Record<string, [number, number]> = {
    topN: [1, 1000], minDayChange: [0, 10000], ampDivisor: [0.001, 10000],
    holdMinutes: [1, 10080], tp1Percent: [0.001, 99], tp2Percent: [0.001, 99],
    stopLossPercent: [0.001, 99], cooldownMinutes: [0, 10080], leverage: [1, 100],
  };
  for (const [key, [min, max]] of Object.entries(numeric)) {
    const n = spec[key];
    if (n !== undefined && (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max)) {
      throw new Error(`${key} 必须在 ${min} ~ ${max} 之间`);
    }
  }
  for (const [key, allowed] of Object.entries({
    intervalWindow: INTERVAL_WINDOWS,
    maRequirement: MA_REQUIREMENTS,
    macdRequirement: MACD_REQUIREMENTS,
    candleRequirement: CANDLE_REQUIREMENTS,
  })) {
    if (spec[key] !== undefined && !(allowed as readonly unknown[]).includes(spec[key])) throw new Error(`不支持的 ${key}: ${spec[key]}`);
  }
  if (spec.moveSlToEntryAfterTp1 !== undefined && typeof spec.moveSlToEntryAfterTp1 !== "boolean") throw new Error("moveSlToEntryAfterTp1 必须是布尔值");
  if (typeof spec.tp1Percent === "number" && typeof spec.tp2Percent === "number" && spec.tp2Percent < spec.tp1Percent) throw new Error("TP2 不能小于 TP1");
}
