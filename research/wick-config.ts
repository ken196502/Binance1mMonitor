export const WICK_MA_PERIODS = [3, 5, 10, 15, 20] as const;

export interface WickExitPlan {
  firstTakeProfitPercent: number;
  firstStopLossPercent: number;
  finalTakeProfitPercent: number;
  finalStopLossPercent: number;
}

export interface WickParameters extends Partial<WickExitPlan> {
  holdMinutes: number;
  dayGainFraction?: number;
  minGreenRatio?: number;
  minConsecutiveGreenBars?: number;
  maxUpperShadowRatio?: number;
  exitX?: number; // 第一阶段分母：TP1 = dayChange / exitX, SL1 = dayChange / exitX
  exitN?: number; // 第二阶段止损倍数：SL2 = dayChange * exitN / exitX
  exitM?: number; // 第二阶段止盈倍数：TP2 = dayChange * exitM / exitX
}

// Fractions of the initial position: first exit 50%, final exit the remaining 50%.
export const WICK_FIRST_CLOSE_FRACTION = 0.5;

export interface WickConfig {
  topN: number;
  indicatorWindow: number; // Closed candles; live default keeps 200 including one forming bar.
  minStreakCount: number;
  gainMode: 'day-fraction' | 'fixed';
  dayGainFraction?: number;
  dayGainFractions: number[];
  minStreakGainPercent: number;
  minDayChangePercent: number;
  minGreenRatio?: number;
  minGreenRatios: number[];
  minConsecutiveGreenBars?: number;
  consecutiveGreenBars: number[];
  maxUpperShadowRatio?: number;
  maxUpperShadowRatios: number[];
  supportMaPeriods: readonly number[];
  takerFeeBps: number;
  slippageBps: number;
  minTrades: number;
  trainRatio: number;
  validationRatio: number;
  holdMinutes: number[];
  exitX?: number;
  exitXs?: number[];
  exitN?: number;
  exitNs?: number[];
  exitM?: number;
  exitMs?: number[];
  exitPlans?: WickExitPlan[];
  stopAtHigh?: boolean;
}

export const WICK_CONFIG: WickConfig = {
  topN: 10,
  indicatorWindow: 199,
  minStreakCount: 2,
  gainMode: 'day-fraction',
  dayGainFraction: 0.05,
  dayGainFractions: [0.03, 0.05, 0.08],
  minStreakGainPercent: 1,
  minDayChangePercent: 0,
  minGreenRatio: 0.7,
  minGreenRatios: [0.6, 0.7],
  minConsecutiveGreenBars: 7,
  consecutiveGreenBars: [7, 9],
  maxUpperShadowRatio: 0.3,
  maxUpperShadowRatios: [0.3, 0.5],
  supportMaPeriods: WICK_MA_PERIODS,
  takerFeeBps: 5,
  slippageBps: 2,
  minTrades: 100,
  trainRatio: 0.6,
  validationRatio: 0.2,
  holdMinutes: [15],
  exitX: 80,
  exitXs: [60, 80, 100],
  exitN: 1.5,
  exitNs: [1.2, 1.5, 2.0],
  exitM: 6,
  exitMs: [4, 6, 8, 10],
  exitPlans: [
    { firstTakeProfitPercent: 0.1, firstStopLossPercent: 0.1, finalTakeProfitPercent: 0.5, finalStopLossPercent: 0.2 },
    { firstTakeProfitPercent: 0.2, firstStopLossPercent: 0.2, finalTakeProfitPercent: 1, finalStopLossPercent: 0.3 },
    { firstTakeProfitPercent: 0.3, firstStopLossPercent: 0.3, finalTakeProfitPercent: 2, finalStopLossPercent: 0.5 },
  ],
  stopAtHigh: false,
};

export function validateWickConfig(value: unknown): WickConfig {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const number = (v: unknown, min: number, max: number, integer = false) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isInteger(v));
  if (!object(value) || Object.keys(value).some(k => !Object.hasOwn(WICK_CONFIG, k))) throw new Error('wick 配置包含未知字段；旧版 profiles 不适用于两段平仓，请使用 exitPlans');
  const c = { ...structuredClone(WICK_CONFIG), ...value } as WickConfig;

  // Normalize grid arrays from either array form or scalar override
  if (value && 'dayGainFractions' in value && Array.isArray(value.dayGainFractions)) c.dayGainFractions = value.dayGainFractions as number[];
  else if (value && 'dayGainFraction' in value) c.dayGainFractions = Array.isArray(value.dayGainFraction) ? value.dayGainFraction as number[] : [Number(value.dayGainFraction)];

  if (value && 'minGreenRatios' in value && Array.isArray(value.minGreenRatios)) c.minGreenRatios = value.minGreenRatios as number[];
  else if (value && 'minGreenRatio' in value) c.minGreenRatios = Array.isArray(value.minGreenRatio) ? value.minGreenRatio as number[] : [Number(value.minGreenRatio)];

  if (value && 'consecutiveGreenBars' in value && Array.isArray(value.consecutiveGreenBars)) c.consecutiveGreenBars = value.consecutiveGreenBars as number[];
  else if (value && 'minConsecutiveGreenBars' in value) c.consecutiveGreenBars = Array.isArray(value.minConsecutiveGreenBars) ? value.minConsecutiveGreenBars as number[] : [Number(value.minConsecutiveGreenBars)];

  if (value && 'maxUpperShadowRatios' in value && Array.isArray(value.maxUpperShadowRatios)) c.maxUpperShadowRatios = value.maxUpperShadowRatios as number[];
  else if (value && 'maxUpperShadowRatio' in value) c.maxUpperShadowRatios = Array.isArray(value.maxUpperShadowRatio) ? value.maxUpperShadowRatio as number[] : [Number(value.maxUpperShadowRatio)];

  if (value && 'exitXs' in value && Array.isArray(value.exitXs)) c.exitXs = value.exitXs as number[];
  else if (value && 'exitX' in value) c.exitXs = Array.isArray(value.exitX) ? value.exitX as number[] : [Number(value.exitX)];

  if (value && 'exitNs' in value && Array.isArray(value.exitNs)) c.exitNs = value.exitNs as number[];
  else if (value && 'exitN' in value) c.exitNs = Array.isArray(value.exitN) ? value.exitN as number[] : [Number(value.exitN)];

  if (value && 'exitMs' in value && Array.isArray(value.exitMs)) c.exitMs = value.exitMs as number[];
  else if (value && 'exitM' in value) c.exitMs = Array.isArray(value.exitM) ? value.exitM as number[] : [Number(value.exitM)];

  // If exitPlans is explicitly provided in value without dynamic exit params, favor exitPlans
  if (value && 'exitPlans' in value && !('exitXs' in value || 'exitX' in value || 'exitNs' in value || 'exitN' in value || 'exitMs' in value || 'exitM' in value)) {
    delete c.exitXs;
    delete c.exitNs;
    delete c.exitMs;
  }

  for (const [k, min, max, int] of [
    ['topN', 1, 100, true], ['indicatorWindow', 120, 1500, true], ['minStreakCount', 2, 120, true],
    ['minStreakGainPercent', 0, 100, false], ['minDayChangePercent', 0, 10000, false],
    ['takerFeeBps', 0, 100, false],
    ['slippageBps', 0, 100, false], ['minTrades', 1, 100000, true],
  ] as const) if (!number(c[k], min, max, int)) throw new Error(`wick ${k} 无效`);

  if (c.stopAtHigh !== undefined && typeof c.stopAtHigh !== 'boolean') throw new Error('wick stopAtHigh 无效');
  if (!['day-fraction', 'fixed'].includes(c.gainMode)) throw new Error('wick 涨幅模式或撤单配置无效');
  if (![c.trainRatio, c.validationRatio].every(v => number(v, 0.001, 0.999)) || c.trainRatio + c.validationRatio >= 1) throw new Error('wick 训练/验证比例合计必须 <1');

  for (const [k, min, max, int] of [
    ['dayGainFractions', 0.001, 10, false],
    ['minGreenRatios', 0, 1, false],
    ['consecutiveGreenBars', 1, 30, true],
    ['maxUpperShadowRatios', 0, 10, false],
    ['holdMinutes', 1, 1440, true],
  ] as const) {
    const arr = c[k];
    if (!Array.isArray(arr) || !arr.length || arr.length > 100 || new Set(arr).size !== arr.length || arr.some(v => !number(v, min, max, int))) {
      throw new Error(`wick ${k} 无效`);
    }
  }

  if (c.exitXs) {
    for (const [k, min, max, int] of [
      ['exitXs', 1, 10000, false],
      ['exitNs', 0.1, 100, false],
      ['exitMs', 0.1, 100, false],
    ] as const) {
      const arr = c[k];
      if (!Array.isArray(arr) || !arr.length || arr.length > 100 || new Set(arr).size !== arr.length || arr.some(v => !number(v, min, max, int))) {
        throw new Error(`wick ${k} 无效`);
      }
    }
  }

  if (!Array.isArray(c.supportMaPeriods) || !c.supportMaPeriods.length || c.supportMaPeriods.some(v => !number(v, 1, 500, true))) {
    throw new Error('wick supportMaPeriods 无效');
  }

  if (c.exitPlans) {
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
  }
  const exitCombinationsCount = (c.exitXs && c.exitNs && c.exitMs)
    ? c.exitXs.length * c.exitNs.length * c.exitMs.length
    : (c.exitPlans?.length ?? 1);
  const combinationsCount = c.holdMinutes.length * c.dayGainFractions.length * c.minGreenRatios.length * c.consecutiveGreenBars.length * c.maxUpperShadowRatios.length * exitCombinationsCount;
  if (combinationsCount > 10000) throw new Error('wick 网格最多10000组，请缩小配置');
  return c;
}

export function wickCombinations(c: WickConfig): WickParameters[] {
  const result: WickParameters[] = [];
  const useDynamic = Array.isArray(c.exitXs) && c.exitXs.length > 0 &&
                     Array.isArray(c.exitNs) && c.exitNs.length > 0 &&
                     Array.isArray(c.exitMs) && c.exitMs.length > 0;

  for (const holdMinutes of c.holdMinutes) {
    for (const dayGainFraction of c.dayGainFractions) {
      for (const minGreenRatio of c.minGreenRatios) {
        for (const minConsecutiveGreenBars of c.consecutiveGreenBars) {
          for (const maxUpperShadowRatio of c.maxUpperShadowRatios) {
            if (useDynamic) {
              for (const exitX of c.exitXs!) {
                for (const exitN of c.exitNs!) {
                  for (const exitM of c.exitMs!) {
                    result.push({
                      holdMinutes,
                      dayGainFraction,
                      minGreenRatio,
                      minConsecutiveGreenBars,
                      maxUpperShadowRatio,
                      exitX,
                      exitN,
                      exitM,
                    });
                  }
                }
              }
            } else if (c.exitPlans) {
              for (const exit of c.exitPlans) {
                result.push({
                  holdMinutes,
                  dayGainFraction,
                  minGreenRatio,
                  minConsecutiveGreenBars,
                  maxUpperShadowRatio,
                  ...exit,
                });
              }
            }
          }
        }
      }
    }
  }
  return result;
}
