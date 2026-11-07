import { validateRules, type FeatureRule } from "./strategy-rules.ts";
import type { ObservationSpec } from "./strategy-watch.ts";
import type { PaperExitParams } from "./types.ts";

export interface StrategyDefinition {
  id: string;
  label: string;
  side: "LONG" | "SHORT";
  enabled: boolean;
  minBars: number;
  entry: FeatureRule;
  observation?: ObservationSpec;
  exit: PaperExitParams;
  cooldownMinutes: number;
  cooldownFrom?: "entry" | "exit";
  cooldownGroup?: string;
  /** Quant candidates retain the existing validation/expiry gate. */
  factorManaged?: boolean;
}
export function validateStrategies(value: unknown): asserts value is StrategyDefinition[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error("strategies 必须是最多 50 个策略的数组");
  const ids = new Set<string>();
  for (const s of value) {
    if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error("策略必须是对象");
    if (typeof s.id !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{0,199}$/.test(s.id) || ids.has(s.id)) throw new Error(`策略 ID 无效或重复: ${s.id}`);
    ids.add(s.id);
    if (typeof s.label !== "string" || !s.label.trim() || s.label.length > 80 || !["LONG", "SHORT"].includes(s.side) || typeof s.enabled !== "boolean") throw new Error("策略名称、方向或开关无效");
    const number = (v: unknown, min: number, max: number, name: string, integer = false) => {
      if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || integer && !Number.isInteger(v)) throw new Error(`${name} 必须在 ${min}~${max} 之间${integer ? "，且为整数" : ""}`);
    };
    number(s.minBars, 1, 500, "minBars", true);
    number(s.cooldownMinutes, 0, 10080, "cooldownMinutes");
    if (s.cooldownFrom !== undefined && !["entry", "exit"].includes(s.cooldownFrom)) throw new Error("冷却起点无效");
    if (s.cooldownGroup !== undefined && (typeof s.cooldownGroup !== "string" || s.cooldownGroup.length > 64)) throw new Error("冷却组无效");
    if (s.factorManaged !== undefined && typeof s.factorManaged !== "boolean") throw new Error("factorManaged 必须是布尔值");
    if (["kline_stats_long", "kline_stats_short"].includes(s.id) && s.factorManaged !== true) throw new Error("量化预设必须保留因子验证标记");
    if (s.factorManaged && s.id !== `kline_stats_${s.side.toLowerCase()}`) throw new Error("因子管理仅用于对应方向的量化预设");
    validateRules(s.entry);
    if (!s.exit || typeof s.exit !== "object" || Array.isArray(s.exit)) throw new Error("缺少退出参数");
    number(s.exit.holdMinutes, 1, 10080, "holdMinutes");
    for (const key of ["tp1Percent", "tp2Percent", "stopLossPercent"] as const) {
      if (s.exit[key] !== undefined) number(s.exit[key], 0.001, 99, key);
      else if (s.exit.exitX === undefined) throw new Error(`缺少 ${key} 或动态退出分母 exitX`);
    }
    if (s.exit.tp2Percent === undefined && s.exit.exitM === undefined || s.exit.stopLossPercent === undefined && s.exit.exitN === undefined) throw new Error("动态退出需要 exitX、exitN、exitM");
    for (const key of ["exitX", "exitN", "exitM"] as const) if (s.exit[key] !== undefined) number(s.exit[key], 0.001, 10000, key);
    if (s.exit.leverage !== undefined) number(s.exit.leverage, 1, 100, "leverage");
    if (s.exit.moveSlToEntryAfterTp1 !== undefined && typeof s.exit.moveSlToEntryAfterTp1 !== "boolean") throw new Error("保本开关必须是布尔值");
    if (s.exit.tp1Percent !== undefined && s.exit.tp2Percent !== undefined && s.exit.tp2Percent < s.exit.tp1Percent) throw new Error("TP2 不能小于 TP1");
    if (s.observation !== undefined) {
      if (!s.observation || typeof s.observation !== "object" || Array.isArray(s.observation)) throw new Error("观察参数无效");
      number(s.observation.rank, 1, 1000, "observation.rank", true);
      number(s.observation.watchWindowHours, 0.01, 720, "watchWindowHours");
      number(s.observation.pullbackPercent, 0.001, 99, "pullbackPercent");
      number(s.observation.reboundPercent, 0.001, 10000, "reboundPercent");
      number(s.observation.historyBars, 1, 500, "historyBars", true);
    }
  }
}
