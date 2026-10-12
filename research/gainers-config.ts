import type { GainersGrid, GainersOptions } from "./gainers-types.ts";

export const GAINERS_GRID: GainersGrid = {
  highRatio: [0.8], holdMinutes: [15, 30, 60, 120, 240],
  stopLossPercent: [0.2, 0.3, 0.5], takeProfitPercent: [1.5, 2, 3, 5],
};
export function validateGainersGrid(value: unknown): GainersGrid {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("gainers 参数网格必须是 JSON 对象");
  const input = value as Record<string, unknown>;
  const keys = Object.keys(GAINERS_GRID) as (keyof GainersGrid)[];
  if (Object.keys(input).some((k) => !keys.includes(k as keyof GainersGrid))) throw new Error("gainers 1m 网格只接受高位比例、持有分钟数、止损、止盈；不接受死叉、连阴、量比等入场过滤");
  for (const key of keys) {
    const values = input[key];
    if (!Array.isArray(values) || !values.length || values.length > 100 || new Set(values).size !== values.length) throw new Error(`${key} 必须是非空且不重复的数组`);
    if (values.some((v) => typeof v !== "number" || !Number.isFinite(v) || v <= 0 ||
      (key === "highRatio" || key === "stopLossPercent" ? v > 1 : key === "holdMinutes" ? !Number.isInteger(v) || v > 1440 : v >= 100))) throw new Error(`${key} 包含无效值（止损必须 >0 且 ≤1%）`);
  }
  const grid = input as unknown as GainersGrid;
  if (Math.max(...grid.takeProfitPercent) / Math.min(...grid.stopLossPercent) < 3 - 1e-12) throw new Error("至少需要一组止盈/止损比 ≥3 的参数");
  return grid;
}
export function validateGainersOptions(o: GainersOptions): void {
  for (const [key, min, max] of [["topN", 1, 100], ["highWindow", 35, 1000], ["rounds", 1, 10], ["trialsPerRound", 1, 500], ["minTrades", 1, 100000], ["seed", 0, 0xffffffff]] as const) {
    if (!Number.isInteger(o[key]) || o[key] < min || o[key] > max) throw new Error(`${key} 需为 ${min}–${max} 的整数`);
  }
  if (![o.trainRatio, o.validationRatio].every((v) => Number.isFinite(v) && v > 0) || o.trainRatio + o.validationRatio >= 1) throw new Error("训练/验证比例需 >0 且合计 <1");
  if (![o.feeBps, o.slippageBps].every((v) => Number.isFinite(v) && v >= 0 && v <= 100)) throw new Error("单边成本需为 0–100 bps");
  validateGainersGrid(o.grid);
}
