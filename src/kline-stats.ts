// K线量化统计与特征分析核心模块
// 纯 TypeScript 实现（无平台专属依赖），前后端同源复用：
// - 前端：用于 1m K 线图表区间标记与实时统计面板渲染
// - 后端/研究：用于策略挖掘脚本特征计算与回测

import type {
  ChartBar,
  IntervalSignal,
  MaAlignmentInfo,
  MaAlignmentType,
  MaItem,
  MacdStatsInfo,
  OhlcComparisonInfo,
} from "./types.ts";

export const STATS_MA_PERIODS = [5, 10, 20, 30, 60] as const;

/**
 * 分析指定 K 线处的均线排列状态与各周期均线特征
 */
export function analyzeMaAlignment(
  bars: readonly ChartBar[],
  targetIndex = bars.length - 1,
  periods: readonly number[] = STATS_MA_PERIODS,
): MaAlignmentInfo {
  const bar = bars[targetIndex];
  const mas: Record<number, MaItem> = {};

  if (!bar) {
    return {
      type: "tangled",
      label: "暂无数据",
      order: [...periods],
      orderText: "-",
      mas,
    };
  }

  const validPeriods: number[] = [];

  for (const p of periods) {
    const val = bar.ma[String(p)];
    if (val != null && Number.isFinite(val)) {
      validPeriods.push(p);

      // 计算斜率（回溯最多 3 根 K 线）
      const prevBar = targetIndex >= 3 ? bars[targetIndex - 3] : bars[0];
      const prevVal = prevBar?.ma[String(p)];
      let slope: "up" | "down" | "flat" = "flat";
      if (prevVal != null && Number.isFinite(prevVal) && prevVal > 0) {
        const changePct = ((val - prevVal) / prevVal) * 100;
        if (changePct > 0.05) slope = "up";
        else if (changePct < -0.05) slope = "down";
      }

      const biasPercent = ((bar.close - val) / val) * 100;
      const support = bar.low <= val && bar.close > val;
      const resistance = bar.high >= val && bar.close < val;
      const isAbove = bar.close > val;
      const breakout = bar.open <= val && bar.close > val;
      const breakdown = bar.open >= val && bar.close < val;

      mas[p] = {
        period: p,
        value: val,
        slope,
        biasPercent,
        support,
        resistance,
        isAbove,
        breakout,
        breakdown,
      };
    }
  }

  // 均线按数值从高到低排序
  const sortedPeriods = [...validPeriods].sort((a, b) => {
    const va = mas[a]?.value ?? 0;
    const vb = mas[b]?.value ?? 0;
    return vb - va;
  });

  const orderText = sortedPeriods.map((p) => `MA${p}`).join(" > ");

  // 判断多头/空头排列
  let type: MaAlignmentType = "tangled";
  let label = "交织震荡";

  const hasAll5 = validPeriods.length >= 5 && [5, 10, 20, 30, 60].every((p) => validPeriods.includes(p));
  const hasShort3 = [5, 10, 20].every((p) => validPeriods.includes(p));

  const isFullBull =
    hasAll5 &&
    (mas[5]?.value ?? 0) > (mas[10]?.value ?? 0) &&
    (mas[10]?.value ?? 0) > (mas[20]?.value ?? 0) &&
    (mas[20]?.value ?? 0) > (mas[30]?.value ?? 0) &&
    (mas[30]?.value ?? 0) > (mas[60]?.value ?? 0);

  const isFullBear =
    hasAll5 &&
    (mas[5]?.value ?? 0) < (mas[10]?.value ?? 0) &&
    (mas[10]?.value ?? 0) < (mas[20]?.value ?? 0) &&
    (mas[20]?.value ?? 0) < (mas[30]?.value ?? 0) &&
    (mas[30]?.value ?? 0) < (mas[60]?.value ?? 0);

  const isShortBull =
    hasShort3 &&
    (mas[5]?.value ?? 0) > (mas[10]?.value ?? 0) &&
    (mas[10]?.value ?? 0) > (mas[20]?.value ?? 0);

  const isShortBear =
    hasShort3 &&
    (mas[5]?.value ?? 0) < (mas[10]?.value ?? 0) &&
    (mas[10]?.value ?? 0) < (mas[20]?.value ?? 0);

  if (isFullBull) {
    type = "bullish_full";
    label = "完全多头排列";
  } else if (isFullBear) {
    type = "bearish_full";
    label = "完全空头排列";
  } else if (isShortBull) {
    type = "bullish_short";
    label = "短均线多头";
  } else if (isShortBear) {
    type = "bearish_short";
    label = "短均线空头";
  }

  return {
    type,
    label,
    order: sortedPeriods,
    orderText,
    mas,
  };
}

/**
 * 对比指定 K 线 OHLC 与各周期均线及 K 线形态结构
 */
export function analyzeOhlcComparison(
  bars: readonly ChartBar[],
  targetIndex = bars.length - 1,
  periods: readonly number[] = STATS_MA_PERIODS,
): OhlcComparisonInfo {
  const bar = bars[targetIndex];
  if (!bar) {
    return {
      close: 0,
      open: 0,
      high: 0,
      low: 0,
      bodyPercent: 0,
      upperWickPercent: 0,
      lowerWickPercent: 0,
      isBullish: true,
      supports: [],
      resistances: [],
      aboveCount: 0,
    };
  }

  const base = bar.open > 0 ? bar.open : bar.close;
  const bodyPercent = base > 0 ? ((bar.close - bar.open) / base) * 100 : 0;
  const upperBody = Math.max(bar.open, bar.close);
  const lowerBody = Math.min(bar.open, bar.close);
  const upperWickPercent = upperBody > 0 ? ((bar.high - upperBody) / upperBody) * 100 : 0;
  const lowerWickPercent = lowerBody > 0 ? ((lowerBody - bar.low) / lowerBody) * 100 : 0;

  const supports: number[] = [];
  const resistances: number[] = [];
  let aboveCount = 0;

  for (const p of periods) {
    const val = bar.ma[String(p)];
    if (val != null && Number.isFinite(val)) {
      if (bar.low <= val && bar.close > val) supports.push(p);
      if (bar.high >= val && bar.close < val) resistances.push(p);
      if (bar.close > val) aboveCount++;
    }
  }

  return {
    close: bar.close,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    bodyPercent,
    upperWickPercent,
    lowerWickPercent,
    isBullish: bar.close >= bar.open,
    supports,
    resistances,
    aboveCount,
  };
}

/**
 * 统计指定 K 线处的 MACD 绿柱比例、连绿数及多空状态
 */
export function analyzeMacdStats(
  bars: readonly ChartBar[],
  targetIndex = bars.length - 1,
): MacdStatsInfo {
  const bar = bars[targetIndex];
  if (!bar) {
    return {
      hist: 0,
      dif: 0,
      dea: 0,
      isBullishCross: false,
      isAboveZero: false,
      greenBarRatio15: 0,
      greenCount15: 0,
      greenBarRatio30: 0,
      greenCount30: 0,
      greenStreak: 0,
      redStreak: 0,
    };
  }

  // 15 根窗口
  const start15 = Math.max(0, targetIndex - 14);
  let green15 = 0;
  let total15 = 0;
  for (let i = start15; i <= targetIndex; i++) {
    total15++;
    if (bars[i].hist > 0) green15++;
  }
  const greenBarRatio15 = total15 > 0 ? green15 / total15 : 0;

  // 30 根窗口
  const start30 = Math.max(0, targetIndex - 29);
  let green30 = 0;
  let total30 = 0;
  for (let i = start30; i <= targetIndex; i++) {
    total30++;
    if (bars[i].hist > 0) green30++;
  }
  const greenBarRatio30 = total30 > 0 ? green30 / total30 : 0;

  // 连绿 / 连红
  let greenStreak = 0;
  let redStreak = 0;
  if (bar.hist > 0) {
    for (let i = targetIndex; i >= 0; i--) {
      if (bars[i].hist > 0) greenStreak++;
      else break;
    }
  } else if (bar.hist < 0) {
    for (let i = targetIndex; i >= 0; i--) {
      if (bars[i].hist < 0) redStreak++;
      else break;
    }
  }

  return {
    hist: bar.hist,
    dif: bar.dif,
    dea: bar.dea,
    isBullishCross: bar.dif >= bar.dea,
    isAboveZero: bar.dif > 0 && bar.dea > 0,
    greenBarRatio15,
    greenCount15: green15,
    greenBarRatio30,
    greenCount30: green30,
    greenStreak,
    redStreak,
  };
}

export interface DetectIntervalOptions {
  windowMinutes?: number;      // 考察区间窗口 (默认 5 根 1m)
  ampDivisor?: number;         // 比例除数，即 24h涨幅 / ampDivisor (默认 10，即 10%)
  minRatio?: number;           // 或显式比例阈值 (如 0.10)，优先级高于 ampDivisor
  mode?: "surge" | "drop" | "both"; // 冲高 / 回撤 / 两者皆可 (默认 "surge")
  minDayChange?: number;       // 最小 24h 涨幅过滤，如 5.0 (%)
}

/**
 * 遍历 1m K 线序列，找出所有“区间涨跌幅 / 24h 涨幅达到指定比例”的区间信号点，
 * 并携带当时的均线排列、OHLC对比及 MACD 绿柱比例。
 */
export function detectIntervalSignals(
  bars: readonly ChartBar[],
  dayChangePercent?: number | null,
  options: DetectIntervalOptions = {},
): IntervalSignal[] {
  if (!bars || bars.length < 2) return [];

  const dc = typeof dayChangePercent === "number" && Number.isFinite(dayChangePercent)
    ? dayChangePercent
    : null;

  // 若无外部 24h 涨幅传入，则从 bars 整体首尾估算
  const effectiveDayChange = dc !== null
    ? dc
    : bars[0].open > 0
    ? ((bars[bars.length - 1].close - bars[0].open) / bars[0].open) * 100
    : 0;

  const minDayChange = options.minDayChange ?? 5.0;
  if (effectiveDayChange < minDayChange) return [];

  const windowMinutes = Math.max(2, options.windowMinutes ?? 5);
  const targetRatio = options.minRatio ?? (1 / (options.ampDivisor ?? 10));
  const divisor = 1 / targetRatio;
  const mode = options.mode ?? "surge";

  const signals: IntervalSignal[] = [];

  for (let i = windowMinutes - 1; i < bars.length; i++) {
    const startIdx = i - windowMinutes + 1;
    const curBar = bars[i];

    // 计算 windowMinutes 内的最低价与最高价
    let minLow = Infinity;
    let maxHigh = -Infinity;
    for (let k = startIdx; k <= i; k++) {
      if (bars[k].low < minLow) minLow = bars[k].low;
      if (bars[k].high > maxHigh) maxHigh = bars[k].high;
    }

    // 1. 冲高涨幅计算：以区间内最低价到当前最高价（或收盘价）的涨幅
    if (mode === "surge" || mode === "both") {
      if (minLow > 0) {
        const surgePercent = ((curBar.high - minLow) / minLow) * 100;
        const ratio = surgePercent / effectiveDayChange;
        if (ratio >= targetRatio) {
          const maAlignment = analyzeMaAlignment(bars, i);
          const ohlc = analyzeOhlcComparison(bars, i);
          const macd = analyzeMacdStats(bars, i);

          signals.push({
            time: curBar.time,
            barIndex: i,
            type: "surge",
            windowMinutes,
            intervalChangePercent: surgePercent,
            dayChangePercent: effectiveDayChange,
            ratioToDayChange: ratio,
            divisor: Number(divisor.toFixed(1)),
            price: curBar.close,
            maAlignment,
            ohlc,
            macd,
          });
          continue; // 同一根 bar 优先记为冲高
        }
      }
    }

    // 2. 回撤跌幅计算：以区间内最高价到当前最低价的跌幅
    if (mode === "drop" || mode === "both") {
      if (maxHigh > 0) {
        const dropPercent = ((maxHigh - curBar.low) / maxHigh) * 100;
        const ratio = dropPercent / effectiveDayChange;
        if (ratio >= targetRatio) {
          const maAlignment = analyzeMaAlignment(bars, i);
          const ohlc = analyzeOhlcComparison(bars, i);
          const macd = analyzeMacdStats(bars, i);

          signals.push({
            time: curBar.time,
            barIndex: i,
            type: "drop",
            windowMinutes,
            intervalChangePercent: dropPercent,
            dayChangePercent: effectiveDayChange,
            ratioToDayChange: ratio,
            divisor: Number(divisor.toFixed(1)),
            price: curBar.close,
            maAlignment,
            ohlc,
            macd,
          });
        }
      }
    }
  }

  return signals;
}
