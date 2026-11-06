// K线量化统计与特征分析核心模块
// 纯 TypeScript 实现（无平台专属依赖），前后端同源复用：
// - 前端：用于 1m K 线图表区间标记与实时统计面板渲染
// - 后端/研究：用于策略挖掘脚本特征计算与回测

import type {
  ChartBar,
  IntervalSignal,
  MaAlignmentInfo,
  MaAlignmentType,
  Ma3BarPattern,
  Ma3BarStep,
  MaItem,
  MacdStatsInfo,
  OhlcComparisonInfo,
  PrecursorFeatures,
} from "./types.ts";

export const STATS_MA_PERIODS = [5, 10, 20, 30, 60] as const;

/**
 * 辅助计算单根 K 线的均线排列状态与间距
 */
function classifySingleBarMa(
  bars: readonly ChartBar[],
  idx: number,
  periods: readonly number[],
): {
  type: MaAlignmentType;
  label: string;
  orderText: string;
  sortedPeriods: number[];
  spreadMa5Ma10: number;
  spreadMa5Ma20: number;
  mas: Record<number, MaItem>;
} {
  const mas: Record<number, MaItem> = {};
  const bar = bars[idx];
  if (!bar) {
    return {
      type: "tangled",
      label: "暂无数据",
      orderText: "-",
      sortedPeriods: [...periods],
      spreadMa5Ma10: 0,
      spreadMa5Ma20: 0,
      mas,
    };
  }

  const validPeriods: number[] = [];

  for (const p of periods) {
    const val = bar.ma[String(p)];
    if (val != null && Number.isFinite(val)) {
      validPeriods.push(p);

      // 计算斜率（回溯最多 3 根 K 线）
      const prevBar = idx >= 3 ? bars[idx - 3] : bars[0];
      const prevVal = prevBar?.ma[String(p)];
      let slope: "up" | "down" | "flat" = "flat";
      if (prevVal != null && Number.isFinite(prevVal) && prevVal > 0) {
        const changePct = ((val - prevVal) / prevVal) * 100;
        if (changePct > 0.05) slope = "up";
        else if (changePct < -0.05) slope = "down";
      }

      const biasPercent = val > 0 ? ((bar.close - val) / val) * 100 : 0;
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

  const sortedPeriods = [...validPeriods].sort((a, b) => {
    const va = mas[a]?.value ?? 0;
    const vb = mas[b]?.value ?? 0;
    return vb - va;
  });

  const orderText = sortedPeriods.map((p) => `MA${p}`).join(" > ");

  const hasAll5 = validPeriods.length >= 5 && [5, 10, 20, 30, 60].every((p) => validPeriods.includes(p));
  const hasShort3 = [5, 10, 20].every((p) => validPeriods.includes(p));

  const ma5 = mas[5]?.value ?? 0;
  const ma10 = mas[10]?.value ?? 0;
  const ma20 = mas[20]?.value ?? 0;
  const ma30 = mas[30]?.value ?? 0;
  const ma60 = mas[60]?.value ?? 0;

  const isFullBull = hasAll5 && ma5 > ma10 && ma10 > ma20 && ma20 > ma30 && ma30 > ma60;
  const isFullBear = hasAll5 && ma5 < ma10 && ma10 < ma20 && ma20 < ma30 && ma30 < ma60;
  const isShortBull = hasShort3 && ma5 > ma10 && ma10 > ma20;
  const isShortBear = hasShort3 && ma5 < ma10 && ma10 < ma20;

  let type: MaAlignmentType = "tangled";
  let label = "交织震荡";

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

  const spreadMa5Ma10 = ma10 > 0 ? ((ma5 - ma10) / ma10) * 100 : 0;
  const spreadMa5Ma20 = ma20 > 0 ? ((ma5 - ma20) / ma20) * 100 : 0;

  return {
    type,
    label,
    orderText,
    sortedPeriods,
    spreadMa5Ma10,
    spreadMa5Ma20,
    mas,
  };
}

/**
 * 分析指定 K 线处的均线排列状态与各周期均线特征
 * 【升级】：比对最近 3 根 1m K 线的均线动态演化过程 (T-2, T-1, T)，
 * 准确识别“刚成多头起爆”、“持续3根稳定多头”、“多头拐头收敛”及连续根数。
 */
export function analyzeMaAlignment(
  bars: readonly ChartBar[],
  targetIndex = bars.length - 1,
  periods: readonly number[] = STATS_MA_PERIODS,
): MaAlignmentInfo {
  const bar = bars[targetIndex];
  if (!bar) {
    return {
      type: "tangled",
      label: "暂无数据",
      order: [...periods],
      orderText: "-",
      mas: {},
    };
  }

  // 1. 获取当前根 (T0) 及前两根 (T-1, T-2) 的均线状态
  const t0Idx = targetIndex;
  const t1Idx = Math.max(0, targetIndex - 1);
  const t2Idx = Math.max(0, targetIndex - 2);

  const step0 = classifySingleBarMa(bars, t2Idx, periods);
  const step1 = classifySingleBarMa(bars, t1Idx, periods);
  const step2 = classifySingleBarMa(bars, t0Idx, periods);

  const history3Bars: Ma3BarStep[] = [
    {
      barIndex: t2Idx,
      time: bars[t2Idx]?.time ?? 0,
      type: step0.type,
      label: step0.label,
      orderText: step0.orderText,
      spreadMa5Ma10: step0.spreadMa5Ma10,
      spreadMa5Ma20: step0.spreadMa5Ma20,
    },
    {
      barIndex: t1Idx,
      time: bars[t1Idx]?.time ?? 0,
      type: step1.type,
      label: step1.label,
      orderText: step1.orderText,
      spreadMa5Ma10: step1.spreadMa5Ma10,
      spreadMa5Ma20: step1.spreadMa5Ma20,
    },
    {
      barIndex: t0Idx,
      time: bars[t0Idx]?.time ?? 0,
      type: step2.type,
      label: step2.label,
      orderText: step2.orderText,
      spreadMa5Ma10: step2.spreadMa5Ma10,
      spreadMa5Ma20: step2.spreadMa5Ma20,
    },
  ];

  // 2. 比对最近 3 根 1m K 线排列模式
  const isBull = (t: MaAlignmentType) => t === "bullish_full" || t === "bullish_short";
  const isBear = (t: MaAlignmentType) => t === "bearish_full" || t === "bearish_short";

  let pattern3Bars: Ma3BarPattern = "tangled";
  let pattern3BarsLabel = "交织震荡";
  let isDiverging = false;

  if (isBull(step2.type)) {
    const all3Bull = isBull(step0.type) && isBull(step1.type) && isBull(step2.type);
    if (all3Bull) {
      if (step2.spreadMa5Ma10 > step1.spreadMa5Ma10) {
        pattern3Bars = "sustained_bull";
        pattern3BarsLabel = "持续多头 (加速发散)";
        isDiverging = true;
      } else if (step2.spreadMa5Ma10 < step1.spreadMa5Ma10 * 0.9) {
        pattern3Bars = "bull_converging";
        pattern3BarsLabel = "多头收敛 (动能减弱)";
        isDiverging = false;
      } else {
        pattern3Bars = "sustained_bull";
        pattern3BarsLabel = "持续3根多头 (趋势稳固)";
        isDiverging = true;
      }
    } else {
      // 前 2 根至少有 1 根不是多头，最新刚走出多头
      pattern3Bars = "fresh_bull";
      pattern3BarsLabel = "刚成多头 (起爆交叉)";
      isDiverging = true;
    }
  } else if (isBear(step2.type)) {
    const all3Bear = isBear(step0.type) && isBear(step1.type) && isBear(step2.type);
    if (all3Bear) {
      if (step2.spreadMa5Ma10 < step1.spreadMa5Ma10) {
        pattern3Bars = "sustained_bear";
        pattern3BarsLabel = "持续空头 (加速下行)";
        isDiverging = true;
      } else if (step2.spreadMa5Ma10 > step1.spreadMa5Ma10 * 0.9) {
        pattern3Bars = "bear_converging";
        pattern3BarsLabel = "空头收敛 (跌势放缓)";
        isDiverging = false;
      } else {
        pattern3Bars = "sustained_bear";
        pattern3BarsLabel = "持续3根空头 (空头压制)";
        isDiverging = true;
      }
    } else {
      pattern3Bars = "fresh_bear";
      pattern3BarsLabel = "刚成空头 (破位死叉)";
      isDiverging = true;
    }
  } else {
    pattern3Bars = "tangled";
    pattern3BarsLabel = "交织缠绕震荡";
    isDiverging = false;
  }

  // 3. 计算连续保持当前排列状态的根数 (Streak)
  let streakBars = 1;
  for (let i = targetIndex - 1; i >= 0; i--) {
    const prev = classifySingleBarMa(bars, i, periods);
    if (prev.type === step2.type) {
      streakBars++;
    } else {
      break;
    }
  }

  // 4. 演变轨迹路径文本
  const toShort = (l: string) =>
    l.replace("排列", "").replace("震荡", "").replace("短均线", "短").replace("完全", "");
  const transitionText = `${toShort(step0.label)} ➔ ${toShort(step1.label)} ➔ ${toShort(step2.label)}`;

  return {
    type: step2.type,
    label: step2.label,
    order: step2.sortedPeriods,
    orderText: step2.orderText,
    mas: step2.mas,
    pattern3Bars,
    pattern3BarsLabel,
    history3Bars,
    transitionText,
    streakBars,
    isDiverging,
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
  windowMinutes?: number;           // 区间窗口大小 (如 3, 5, 10, 15, 30 分钟，默认 15)
  mode?: "surge" | "drop" | "both"; // 冲高 / 回撤 / 全部 (默认 "both")
  minDayChange?: number;            // 最小 24h 涨幅过滤，默认 0 (不过滤)
  ampDivisor?: number;              // 可选过滤除数：若传入则过滤该段振幅/24h < 1/ampDivisor
  minRatio?: number;                // 可选显式最小比例过滤
}

/**
 * 将 1m K 线按指定区间窗口 (windowMinutes) 划分，并在每个区间内提取“最大振幅段”，
 * 计算该段实际振幅、该段振幅占 24h 涨幅比例、以及该段严格范围内的 MACD 绿柱比例。
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

  // Missing 24h data cannot be inferred from a shorter chart window.
  const effectiveDayChange = dc ?? 0;
  const dayMagnitude = Math.abs(effectiveDayChange);
  const minDayChange = options.minDayChange ?? 0;
  if (dayMagnitude < minDayChange) return [];
  if (options.ampDivisor != null && (!Number.isFinite(options.ampDivisor) || options.ampDivisor <= 0)) return [];

  const windowMinutes = Math.max(1, options.windowMinutes ?? 15);
  const mode = options.mode ?? "both";
  const targetRatio = options.minRatio ?? (options.ampDivisor != null ? 1 / options.ampDivisor : null);

  // 1. 按 windowMinutes 划分区间 (时间桶对齐: floor(time / (W * 60_000)))
  const bucketMs = windowMinutes * 60_000;
  const buckets = new Map<number, { startIdx: number; endIdx: number }>();
  const hasValidTimes = bars.length >= 2 && bars[1].time > bars[0].time;

  for (let i = 0; i < bars.length; i++) {
    const key = hasValidTimes
      ? Math.floor(bars[i].time / bucketMs) * bucketMs
      : Math.floor(i / windowMinutes);
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, { startIdx: i, endIdx: i });
    } else {
      existing.endIdx = i;
    }
  }

  const signals: IntervalSignal[] = [];

  for (const [bucketTime, { startIdx, endIdx }] of buckets.entries()) {
    // 寻找区间内最大冲高段: i <= j 使得 (high[j] - low[i]) / low[i] 最大
    let minLowIdx = startIdx;
    let minLowVal = bars[startIdx].low;
    let maxSurgeAmp = 0;
    let bestSurge = {
      startIdx,
      endIdx: startIdx,
      amp: 0,
      startPrice: bars[startIdx].low,
      endPrice: bars[startIdx].high,
    };

    for (let k = startIdx; k <= endIdx; k++) {
      if (bars[k].low < minLowVal) {
        minLowVal = bars[k].low;
        minLowIdx = k;
      }
      if (minLowVal > 0) {
        const amp = ((bars[k].high - minLowVal) / minLowVal) * 100;
        if (amp >= maxSurgeAmp) {
          maxSurgeAmp = amp;
          bestSurge = {
            startIdx: minLowIdx,
            endIdx: k,
            amp,
            startPrice: minLowVal,
            endPrice: bars[k].high,
          };
        }
      }
    }

    // 寻找区间内最大回撤段: i <= j 使得 (high[i] - low[j]) / high[i] 最大
    let maxHighIdx = startIdx;
    let maxHighVal = bars[startIdx].high;
    let maxDropAmp = 0;
    let bestDrop = {
      startIdx,
      endIdx: startIdx,
      amp: 0,
      startPrice: bars[startIdx].high,
      endPrice: bars[startIdx].low,
    };

    for (let k = startIdx; k <= endIdx; k++) {
      if (bars[k].high > maxHighVal) {
        maxHighVal = bars[k].high;
        maxHighIdx = k;
      }
      if (maxHighVal > 0) {
        const amp = ((maxHighVal - bars[k].low) / maxHighVal) * 100;
        if (amp >= maxDropAmp) {
          maxDropAmp = amp;
          bestDrop = {
            startIdx: maxHighIdx,
            endIdx: k,
            amp,
            startPrice: maxHighVal,
            endPrice: bars[k].low,
          };
        }
      }
    }

    // 根据模式确定代表段
    type ChosenType = "surge" | "drop";
    let chosenType: ChosenType;
    let seg: typeof bestSurge;

    if (mode === "surge") {
      chosenType = "surge";
      seg = bestSurge;
    } else if (mode === "drop") {
      chosenType = "drop";
      seg = bestDrop;
    } else {
      // mode === "both": 选择振幅更大的一段
      if (bestSurge.amp >= bestDrop.amp) {
        chosenType = "surge";
        seg = bestSurge;
      } else {
        chosenType = "drop";
        seg = bestDrop;
      }
    }

    // 计算该段振幅 / 24h 涨幅比例
    const ratioToDayChange =
      dayMagnitude > 0 ? seg.amp / dayMagnitude : 0;
    const divisor = ratioToDayChange > 0 ? 1 / ratioToDayChange : 0;

    // 若调用方传入了硬性阈值过滤 (兼容旧逻辑)，则校验
    if (targetRatio != null && ratioToDayChange < targetRatio) {
      continue;
    }

    // 计算该段严格范围内的 MACD 绿柱比例
    const segStart = Math.min(seg.startIdx, seg.endIdx);
    const segEnd = Math.max(seg.startIdx, seg.endIdx);
    const segBarsCount = segEnd - segStart + 1;
    let greenCount = 0;
    for (let k = segStart; k <= segEnd; k++) {
      if (bars[k].hist > 0) greenCount++;
    }
    const segmentGreenRatio = segBarsCount > 0 ? greenCount / segBarsCount : 0;

    // 【核心因果特性】：提取该达标振幅段“启动前一段区间”的特征统计 (起爆前兆特征)
    const burstStartIdx = seg.startIdx; // 冲高/回撤实际爆发启动点
    const preEndIdx = burstStartIdx - 1;
    const preStartIdx = Math.max(0, burstStartIdx - windowMinutes);
    const preBars = bars.slice(preStartIdx, preEndIdx + 1);

    let preGreenCount = 0;
    let preMinLow = Infinity;
    let preMaxHigh = -Infinity;
    for (const b of preBars) {
      if (b.hist > 0) preGreenCount++;
      if (b.low < preMinLow) preMinLow = b.low;
      if (b.high > preMaxHigh) preMaxHigh = b.high;
    }
    const preGreenRatio = preBars.length > 0 ? preGreenCount / preBars.length : 0;
    const preAmpPercent = preMinLow > 0 && preMaxHigh > 0
      ? ((preMaxHigh - preMinLow) / preMinLow) * 100
      : 0;

    // 起爆点前夕 (preEndIdx) 的均线排列与支撑阻力
    const preMaAlignment = analyzeMaAlignment(bars, preEndIdx);
    const preOhlc = analyzeOhlcComparison(bars, preEndIdx);
    const preMacd = analyzeMacdStats(bars, preEndIdx);

    const precursor: PrecursorFeatures | undefined = preBars.length ? {
      windowMinutes,
      startTime: preBars[0]?.time ?? bars[preStartIdx].time,
      endTime: preBars[preBars.length - 1]?.time ?? bars[preEndIdx].time,
      startBarIndex: preStartIdx,
      endBarIndex: preEndIdx,
      greenRatio: preGreenRatio,
      greenCount: preGreenCount,
      totalBars: preBars.length,
      maAlignment: preMaAlignment,
      ohlc: preOhlc,
      macd: preMacd,
      preAmpPercent,
    } : undefined;

    // 当时均线排列、OHLC 对比与 MACD 状态 (在段终点处取值)
    const maAlignment = analyzeMaAlignment(bars, seg.endIdx);
    const ohlc = analyzeOhlcComparison(bars, seg.endIdx);
    const macd = analyzeMacdStats(bars, seg.endIdx);

    const intervalStartMs = hasValidTimes ? bucketTime : bars[startIdx].time;
    const intervalEndMs = hasValidTimes ? bucketTime + bucketMs : bars[endIdx].time;

    signals.push({
      time: bars[seg.endIdx].time,
      barIndex: seg.endIdx,
      type: chosenType,
      windowMinutes,
      intervalChangePercent: seg.amp,
      dayChangePercent: effectiveDayChange,
      ratioToDayChange,
      divisor: divisor > 0 ? Number(divisor.toFixed(1)) : 0,
      price: bars[seg.endIdx].close,
      maAlignment,
      ohlc,
      macd,

      intervalStartTime: intervalStartMs,
      intervalEndTime: intervalEndMs,
      segmentStartTime: bars[seg.startIdx].time,
      segmentEndTime: bars[seg.endIdx].time,
      segmentStartPrice: seg.startPrice,
      segmentEndPrice: seg.endPrice,
      segmentBarsCount: segBarsCount,
      segmentGreenCount: greenCount,
      segmentGreenRatio,
      precursor,
    });
  }

  // 按时间倒序排序 (最新区间排在最前)
  signals.sort((a, b) => b.time - a.time);

  return signals;
}
