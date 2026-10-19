export interface WickExitPlan {
  firstTakeProfitPercent: number;
  firstStopLossPercent: number;
  finalTakeProfitPercent: number;
  finalStopLossPercent: number;
}
export interface WickParameters extends WickExitPlan {
  holdMinutes: number;
}
// Fractions of the initial position: first exit 50%, final exit the remaining 50%.
export const WICK_FIRST_CLOSE_FRACTION = 0.5;
export interface WickConfig {
  topN: number;
  indicatorWindow: number; // Closed candles; live default keeps 200 including one forming bar.
  minStreakCount: number;
  gainMode: 'day-fraction' | 'fixed';
  dayGainFraction: number;
  minStreakGainPercent: number;
  minDayChangePercent: number;
  minGreenRatio: number;
  takerFeeBps: number;
  slippageBps: number;
  minTrades: number;
  trainRatio: number;
  validationRatio: number;
  holdMinutes: number[];
  exitPlans: WickExitPlan[];
}
export const WICK_CONFIG: WickConfig = {
  topN: 10, indicatorWindow: 199, minStreakCount: 2, gainMode: 'day-fraction', dayGainFraction: 0.1,
  minStreakGainPercent: 1, minDayChangePercent: 0, minGreenRatio: 0.8,
  takerFeeBps: 5, slippageBps: 2,
  minTrades: 100, trainRatio: 0.6, validationRatio: 0.2,
  holdMinutes: [5, 15, 60],
  exitPlans: [
    { firstTakeProfitPercent: 0.1, firstStopLossPercent: 0.1, finalTakeProfitPercent: 0.5, finalStopLossPercent: 0.2 },
    { firstTakeProfitPercent: 0.2, firstStopLossPercent: 0.2, finalTakeProfitPercent: 1, finalStopLossPercent: 0.3 },
    { firstTakeProfitPercent: 0.3, firstStopLossPercent: 0.3, finalTakeProfitPercent: 2, finalStopLossPercent: 0.5 },
  ],
};
export function validateWickConfig(value: unknown): WickConfig {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const number = (v: unknown, min: number, max: number, integer = false) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isInteger(v));
  if (!object(value) || Object.keys(value).some(k => !Object.hasOwn(WICK_CONFIG, k))) throw new Error('wick 配置包含未知字段；旧版 profiles 不适用于两段平仓，请使用 exitPlans');
  const c = { ...structuredClone(WICK_CONFIG), ...value } as WickConfig;
  for (const [k, min, max, int] of [
    ['topN', 1, 100, true], ['indicatorWindow', 120, 1500, true], ['minStreakCount', 2, 120, true], ['dayGainFraction', 0.001, 10, false],
    ['minStreakGainPercent', 0, 100, false], ['minDayChangePercent', 0, 10000, false], ['minGreenRatio', 0, 1, false],
    ['takerFeeBps', 0, 100, false],
    ['slippageBps', 0, 100, false], ['minTrades', 1, 100000, true],
  ] as const) if (!number(c[k], min, max, int)) throw new Error(`wick ${k} 无效`);
  if (!['day-fraction', 'fixed'].includes(c.gainMode)) throw new Error('wick 涨幅模式或撤单配置无效');
  if (![c.trainRatio, c.validationRatio].every(v => number(v, 0.001, 0.999)) || c.trainRatio + c.validationRatio >= 1) throw new Error('wick 训练/验证比例合计必须 <1');
  if (!Array.isArray(c.holdMinutes) || !c.holdMinutes.length || c.holdMinutes.length > 100 || new Set(c.holdMinutes).size !== c.holdMinutes.length || c.holdMinutes.some(v => !number(v, 1, 1440, true))) throw new Error('wick holdMinutes 无效');
  if (!Array.isArray(c.exitPlans) || !c.exitPlans.length || c.exitPlans.length > 100) throw new Error('wick exitPlans 需为1至100组两段平仓参数');
  const keys = ['firstTakeProfitPercent', 'firstStopLossPercent', 'finalTakeProfitPercent', 'finalStopLossPercent'] as const;
  const seen = new Set<string>();
  for (const e of c.exitPlans) {
    if (!object(e) || Object.keys(e).some(k => !keys.includes(k as typeof keys[number])) || keys.some(k => !number(e[k], 0.001, k.includes('TakeProfit') ? 99 : 1))) throw new Error('wick 两段止盈需在(0,99]%，止损需在(0,1]%');
    if (e.finalTakeProfitPercent <= e.firstTakeProfitPercent || e.finalStopLossPercent < e.firstStopLossPercent) throw new Error('第二段止盈须大于第一段，第二段止损须不小于第一段；均以原始入场价为基准');
    const key = keys.map(k => e[k]).join('/');
    if (seen.has(key)) throw new Error('wick exitPlans 重复');
    seen.add(key);
  }
  if (c.holdMinutes.length * c.exitPlans.length > 10000) throw new Error('wick 网格最多10000组，请缩小配置');
  return c;
}
export function wickCombinations(c: WickConfig): WickParameters[] {
  return c.holdMinutes.flatMap(holdMinutes => c.exitPlans.map(exit => ({ holdMinutes, ...exit })));
}
