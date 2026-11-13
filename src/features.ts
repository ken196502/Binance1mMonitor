import path from "node:path";
import { mkdir, appendFile } from "node:fs/promises";
import type { Candle } from "./macd.ts";
import { computeMacd, ema, aggregate1mTo5m, aggregate1mTo15m } from "./macd.ts";
import type { Ticker24h } from "./binance.ts";
import { compileFeatureSpec, evaluateRules, readFeaturePath, type FeatureCondition } from "./strategy-rules.ts";
import { INTERVAL_WINDOWS } from "./strategy-spec.ts";
import { DEFAULT_RESEARCH_ROOT, DEFAULT_SIGNALS_DIR } from "./factor-data.ts";

export const FEATURE_VERSION = "3.0.0";

export const FEATURE_SURGE_WINDOWS = INTERVAL_WINDOWS;
export const FEATURE_MA_PERIODS = [5, 10, 20, 30, 60] as const;
export const FEATURE_GREEN_WINDOWS = [3, 5, 10, 15, 20, 30, 60] as const;

export type MaAlignmentStack =
  | "bull_full"
  | "bull_short"
  | "bear_full"
  | "bear_short"
  | "tangled";

export type Ma3BarsStackPattern =
  | "sustained_bull"
  | "fresh_bull"
  | "sustained_bear"
  | "fresh_bear"
  | "bull_converging"
  | "bear_converging"
  | "tangled";

export interface MaFeatureItem {
  value: number;
  emaValue: number;
  slope3: number;
  biasPct: number;
  biasRatio: number;
  support: boolean;
  resist: boolean;
  breakout: boolean;
  breakdown: boolean;
  close_below: boolean;
  close_above: boolean;
}

export interface MultiTfFeature {
  stack: MaAlignmentStack;
  macdHist: number;
  macdHistSlope: number;
  closeVsMa20: number;
}

export interface FeatureVector {
  version: string;
  time: number;
  close: number;
  price: { open: number; high: number; low: number; close: number };

  // A. 区间涨跌幅
  surge: Record<number, number>;      // (当前 high - 窗口最低 low) / 窗口最低 low * 100
  drop: Record<number, number>;       // (窗口最高 high - 当前 low) / 窗口最高 high * 100
  closeChange: Record<number, number>;// (当前 close - 窗口初 close) / 窗口初 close * 100
  body: number;                       // 实体 %
  upperWick: number;                  // 上影线 %
  lowerWick: number;                  // 下影线 %

  // B. 24h
  dayChange: number;                  // ticker priceChangePercent
  rank: number;
  dayChangeDelta: Record<number, number>; // 15, 60 分钟内 24h 涨幅变化
  posIn24hRange: number;              // (close - low24h) / (high24h - low24h)，取值 0~1
  dropFrom24hHigh: number;            // 距 24h 最高价的回撤 %
  highChange24h: number;              // 24h 内最高涨幅 %: ((high24h - open24h) / open24h) * 100

  // 归一化（A ÷ B）
  surgeRatio: Record<number, number>; // surge[W] / dayChange
  dropRatio: Record<number, number>;  // drop[W] / dayChange

  // C. 均线
  ma: Record<number, MaFeatureItem>;
  stack: MaAlignmentStack;
  stack3Bars: Ma3BarsStackPattern;    // 最近 3 根 1m K 线排列模式对比
  maStreak: number;                   // 连续保持当前排列状态的根数
  aboveCount: number;

  // D. MACD
  dif: number;
  dea: number;
  hist: number;
  difPct: number;                     // DIF / close * 100
  deaPct: number;                     // DEA / close * 100
  greenRatio: Record<number, number>; // 10, 15, 20, 30
  greenStreak: number;
  redStreak: number;
  goldenCrossAgo: number;             // 距最近一次金叉的根数
  deathCrossAgo: number;              // 距最近一次死叉的根数
  histSlope: number;                  // hist[t] - hist[t-1]
  histPeakAgo: number;                // 柱体在本轮绿/红柱中的峰值距今根数
  deaPeakAgo: number;                 // DEA 在本轮中的峰值距今根数
  topDivergence: boolean;             // 价格新高而 DEA 或柱体未创新高
  bottomDivergence: boolean;          // 价格新低而 DEA 或柱体未创新低
  difLevel?: "high" | "mid" | "low";  // 短周期 DIF 相对高低位 (30 根窗口)
  difPos?: number;                    // 短周期 DIF 在波段中的归一化位置 (0~1)
  hasBigBull120?: boolean;            // 120分钟内是否存在>=1分钟5%大阳线
  maxBullishGain120?: number;         // 120分钟内最大1分钟阳线涨幅 %

  // 多周期（由 1m 聚合）
  tf5m: MultiTfFeature;
  tf15m: MultiTfFeature;
}

export interface FeatureRuleCondition extends FeatureCondition {
  dimension?: "A" | "B" | "C" | "D" | "TF";
}

export interface KlineStatsStrategySpec {
  topN?: number;
  minDayChange?: number;
  maxDayChange?: number;
  minHighChange24h?: number;
  maxHighChange24h?: number;
  avoidBigBull1m?: boolean;
  avoidBigBull1mBars?: number;
  avoidBigBull1mGain?: number;
  intervalWindow?: number;
  ampDivisor?: number;
  maRequirement?: string;
  macdRequirement?: string;
  candleRequirement?: string;
  rules?: FeatureRuleCondition[];
  holdMinutes?: number;
  tp1Percent?: number;
  tp2Percent?: number;
  stopLossPercent?: number;
  stopLoss2Percent?: number;
  exitN?: number;
  moveSlToEntryAfterTp1?: boolean;
  cooldownMinutes?: number;
  leverage?: number;
}

/**
 * 均线计算辅助工具（SMA）
 */
function calcSmaArray(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * 确定均线排列状态
 */
function determineStack(
  ma5?: number | null,
  ma10?: number | null,
  ma20?: number | null,
  ma30?: number | null,
  ma60?: number | null,
): MaAlignmentStack {
  if (ma5 == null || ma10 == null || ma20 == null) return "tangled";
  const has5 = ma30 != null && ma60 != null;
  if (has5 && ma5 > ma10 && ma10 > ma20 && ma20 > ma30! && ma30! > ma60!) {
    return "bull_full";
  }
  if (has5 && ma5 < ma10 && ma10 < ma20 && ma20 < ma30! && ma30! < ma60!) {
    return "bear_full";
  }
  if (ma5 > ma10 && ma10 > ma20) {
    return "bull_short";
  }
  if (ma5 < ma10 && ma10 < ma20) {
    return "bear_short";
  }
  return "tangled";
}

/**
 * 计算多周期特征（5m / 15m）
 */
function computeTfFeature(candles: Candle[], intervalMs: number): MultiTfFeature {
  if (candles.length < 20) {
    return { stack: "tangled", macdHist: 0, macdHistSlope: 0, closeVsMa20: 0 };
  }
  const aggregated =
    intervalMs === 15 * 60 * 1000 ? aggregate1mTo15m(candles) : aggregate1mTo5m(candles);
  if (aggregated.length < 5) {
    return { stack: "tangled", macdHist: 0, macdHistSlope: 0, closeVsMa20: 0 };
  }

  const closes = aggregated.map((c) => c.close);
  const lastIdx = closes.length - 1;
  const lastClose = closes[lastIdx];

  const ma5Arr = calcSmaArray(closes, 5);
  const ma10Arr = calcSmaArray(closes, 10);
  const ma20Arr = calcSmaArray(closes, 20);
  const ma30Arr = calcSmaArray(closes, 30);
  const ma60Arr = calcSmaArray(closes, 60);

  const stack = determineStack(
    ma5Arr[lastIdx],
    ma10Arr[lastIdx],
    ma20Arr[lastIdx],
    ma30Arr[lastIdx],
    ma60Arr[lastIdx],
  );

  const { hist } = computeMacd(closes);
  const curHist = hist[lastIdx] ?? 0;
  const prevHist = lastIdx > 0 ? (hist[lastIdx - 1] ?? 0) : 0;
  const macdHistSlope = curHist - prevHist;

  const ma20 = ma20Arr[lastIdx];
  const closeVsMa20 = ma20 != null && ma20 > 0 ? ((lastClose - ma20) / ma20) * 100 : 0;

  return { stack, macdHist: curHist, macdHistSlope, closeVsMa20 };
}

/**
 * 核心统一特征提取函数
 * 保证实盘与回测完全一致：
 * - 统一截取最近 500 根已收盘 K 线作为计算窗口 (Warmup Consistent)
 * - 确保 EMA / MACD / MA 种子一致，浮点精度误差 < 1e-9
 */
export function computeFeatureVector(
  candles: Candle[],
  ticker?: Ticker24h | null,
  targetIdx = candles.length - 2,
  options?: {
    rank?: number;
    dayChangeHistory?: Array<{ time: number; dayChange: number }>;
  },
): FeatureVector | null {
  if (!candles || candles.length === 0 || targetIdx < 0 || targetIdx >= candles.length) {
    return null;
  }

  // 统一回溯 500 根进行截取，确保回测和实盘使用完全相同长度的历史窗口
  const WARMUP_LIMIT = 500;
  let windowStart = Math.max(0, targetIdx - WARMUP_LIMIT + 1);
  for (let i = targetIdx; i > windowStart; i--) {
    if (candles[i].time - candles[i - 1].time !== 60_000) {
      windowStart = i;
      break;
    }
  }
  const subCandles = candles.slice(windowStart, targetIdx + 1);
  if (subCandles.length < 60) return null;
  const curSubIdx = subCandles.length - 1;

  const bar = subCandles[curSubIdx];
  if (!bar || bar.close <= 0) return null;

  const close = bar.close;
  const open = bar.open;
  const high = bar.high;
  const low = bar.low;

  // A. 区间涨跌幅与 K 线实体结构
  const surge: Record<number, number> = {};
  const drop: Record<number, number> = {};
  const closeChange: Record<number, number> = {};

  for (const w of FEATURE_SURGE_WINDOWS) {
    const wStart = Math.max(0, curSubIdx - w + 1);
    let minLow = Infinity;
    let maxHigh = -Infinity;
    for (let k = wStart; k <= curSubIdx; k++) {
      if (subCandles[k].low < minLow) minLow = subCandles[k].low;
      if (subCandles[k].high > maxHigh) maxHigh = subCandles[k].high;
    }
    surge[w] = minLow > 0 ? ((high - minLow) / minLow) * 100 : 0;
    drop[w] = maxHigh > 0 ? ((maxHigh - low) / maxHigh) * 100 : 0;

    const pastClose = subCandles[wStart].open > 0 ? subCandles[wStart].open : subCandles[wStart].close;
    closeChange[w] = pastClose > 0 ? ((close - pastClose) / pastClose) * 100 : 0;
  }

  const basePrice = open > 0 ? open : close;
  const body = basePrice > 0 ? (Math.abs(close - open) / basePrice) * 100 : 0;
  const upperBody = Math.max(open, close);
  const lowerBody = Math.min(open, close);
  const upperWick = basePrice > 0 ? (Math.max(0, high - upperBody) / basePrice) * 100 : 0;
  const lowerWick = basePrice > 0 ? (Math.max(0, lowerBody - low) / basePrice) * 100 : 0;

  // B. 24h 涨跌幅与位置
  const dayChange = ticker?.priceChangePercent ?? 0;
  const rank = options?.rank ?? 1;

  // 24h 高低点：优先 ticker，缺失时回退至 subCandles (至多 1440 根)
  let high24h = ticker?.highPrice && ticker.highPrice > 0 ? ticker.highPrice : 0;
  let low24h = ticker?.lowPrice && ticker.lowPrice > 0 ? ticker.lowPrice : 0;
  if (high24h <= 0 || low24h <= 0) {
    const start24h = Math.max(0, curSubIdx - 1439);
    let hMax = -Infinity;
    let lMin = Infinity;
    for (let k = start24h; k <= curSubIdx; k++) {
      if (subCandles[k].high > hMax) hMax = subCandles[k].high;
      if (subCandles[k].low < lMin) lMin = subCandles[k].low;
    }
    if (high24h <= 0 && hMax > 0) high24h = hMax;
    if (low24h <= 0 && lMin < Infinity) low24h = lMin;
  }

  const range = high24h - low24h;
  const posIn24hRange = range > 0 ? Math.max(0, Math.min(1, (close - low24h) / range)) : 0.5;
  const dropFrom24hHigh = high24h > 0 ? Math.max(0, ((high24h - close) / high24h) * 100) : 0;

  // 24h 最高涨幅 (24h high change percent)
  const open24h = ticker?.openPrice && ticker.openPrice > 0
    ? ticker.openPrice
    : (dayChange !== -100 && close > 0
      ? close / (1 + dayChange / 100)
      : subCandles[Math.max(0, curSubIdx - 1439)]?.open ?? close);
  const highChange24h = open24h > 0 ? Math.max(dayChange, ((high24h - open24h) / open24h) * 100) : dayChange;

  // 24h 变化速率
  const dayChangeDelta: Record<number, number> = { 15: 0, 60: 0 };
  if (options?.dayChangeHistory && options.dayChangeHistory.length > 0) {
    const nowTime = bar.time;
    const findPastDc = (offsetMin: number) => {
      const targetTime = nowTime - offsetMin * 60_000;
      let closest: { time: number; dayChange: number } | null = null;
      let minDiff = Infinity;
      for (const item of options.dayChangeHistory!) {
        const diff = Math.abs(item.time - targetTime);
        if (diff < minDiff && diff <= 5 * 60_000) {
          minDiff = diff;
          closest = item;
        }
      }
      return closest ? closest.dayChange : dayChange;
    };
    dayChangeDelta[15] = dayChange - findPastDc(15);
    dayChangeDelta[60] = dayChange - findPastDc(60);
  }

  // 归一化（A ÷ B）
  const surgeRatio: Record<number, number> = {};
  const dropRatio: Record<number, number> = {};
  const dcSafe = dayChange !== 0 ? Math.abs(dayChange) : 1;
  for (const w of FEATURE_SURGE_WINDOWS) {
    surgeRatio[w] = surge[w] / dcSafe;
    dropRatio[w] = drop[w] / dcSafe;
  }

  // C. 均线 (SMA + EMA)
  const closes = subCandles.map((c) => c.close);
  const ma: Record<number, MaFeatureItem> = {};
  let aboveCount = 0;

  for (const p of FEATURE_MA_PERIODS) {
    const smaArr = calcSmaArray(closes, p);
    const emaArr = ema(closes, p);
    const val = smaArr[curSubIdx] ?? close;
    const emaVal = emaArr[curSubIdx] ?? close;

    const prevSma = curSubIdx >= 3 ? (smaArr[curSubIdx - 3] ?? val) : val;
    const slope3 = prevSma > 0 ? ((val - prevSma) / prevSma) * 100 : 0;
    const biasPct = val > 0 ? ((close - val) / val) * 100 : 0;
    const biasRatio = biasPct / dcSafe;

    const support = low <= val && close > val;
    const resist = high >= val && close < val;
    const breakout = open <= val && close > val;
    const breakdown = open >= val && close < val;
    const close_below = close < val;
    const close_above = close > val;

    if (close > val) aboveCount++;

    ma[p] = {
      value: val,
      emaValue: emaVal,
      slope3,
      biasPct,
      biasRatio,
      support,
      resist,
      breakout,
      breakdown,
      close_below,
      close_above,
    };
  }

  const smaMap: Record<number, (number | null)[]> = {};
  for (const p of FEATURE_MA_PERIODS) {
    smaMap[p] = calcSmaArray(closes, p);
  }

  const stack = determineStack(
    ma[5]?.value,
    ma[10]?.value,
    ma[20]?.value,
    ma[30]?.value,
    ma[60]?.value,
  );

  // 比对最近 3 根 1m K 线的均线排列演变情况 (T-2, T-1, T0)
  const prev1Idx = Math.max(0, curSubIdx - 1);
  const stackPrev1 = determineStack(
    smaMap[5]?.[prev1Idx],
    smaMap[10]?.[prev1Idx],
    smaMap[20]?.[prev1Idx],
    smaMap[30]?.[prev1Idx],
    smaMap[60]?.[prev1Idx],
  );

  const prev2Idx = Math.max(0, curSubIdx - 2);
  const stackPrev2 = determineStack(
    smaMap[5]?.[prev2Idx],
    smaMap[10]?.[prev2Idx],
    smaMap[20]?.[prev2Idx],
    smaMap[30]?.[prev2Idx],
    smaMap[60]?.[prev2Idx],
  );

  const isBullStack = (s: MaAlignmentStack) => s === "bull_full" || s === "bull_short";
  const isBearStack = (s: MaAlignmentStack) => s === "bear_full" || s === "bear_short";

  let stack3Bars: Ma3BarsStackPattern = "tangled";
  if (isBullStack(stack)) {
    if (isBullStack(stackPrev1) && isBullStack(stackPrev2)) {
      stack3Bars = "sustained_bull";
    } else {
      stack3Bars = "fresh_bull"; // 刚转为多头 (起爆拐点)
    }
  } else if (isBearStack(stack)) {
    if (isBearStack(stackPrev1) && isBearStack(stackPrev2)) {
      stack3Bars = "sustained_bear";
    } else {
      stack3Bars = "fresh_bear"; // 刚转为空头 (破位拐点)
    }
  } else {
    stack3Bars = "tangled";
  }

  let maStreak = 1;
  for (let k = curSubIdx - 1; k >= 0; k--) {
    const sK = determineStack(
      smaMap[5]?.[k],
      smaMap[10]?.[k],
      smaMap[20]?.[k],
      smaMap[30]?.[k],
      smaMap[60]?.[k],
    );
    if (sK === stack) {
      maStreak++;
    } else {
      break;
    }
  }

  // D. MACD
  const { dif: difArr, dea: deaArr, hist: histArr } = computeMacd(closes);
  const dif = difArr[curSubIdx] ?? 0;
  const dea = deaArr[curSubIdx] ?? 0;
  const hist = histArr[curSubIdx] ?? 0;
  const difPct = close > 0 ? (dif / close) * 100 : 0;
  const deaPct = close > 0 ? (dea / close) * 100 : 0;

  // 绿柱占比
  const greenRatio: Record<number, number> = {};
  for (const n of FEATURE_GREEN_WINDOWS) {
    const start = Math.max(0, curSubIdx - n + 1);
    let count = 0;
    let total = 0;
    for (let k = start; k <= curSubIdx; k++) {
      total++;
      if ((histArr[k] ?? 0) > 0) count++;
    }
    greenRatio[n] = total > 0 ? count / total : 0;
  }

  // 连绿 / 连红
  let greenStreak = 0;
  for (let k = curSubIdx; k >= 0; k--) {
    if ((histArr[k] ?? 0) > 0) greenStreak++;
    else break;
  }
  let redStreak = 0;
  for (let k = curSubIdx; k >= 0; k--) {
    if ((histArr[k] ?? 0) < 0) redStreak++;
    else break;
  }

  // 金叉 / 死叉事件距今根数
  let goldenCrossAgo = 999;
  let deathCrossAgo = 999;
  for (let k = curSubIdx; k >= 1; k--) {
    const d0 = difArr[k - 1];
    const d1 = difArr[k];
    const e0 = deaArr[k - 1];
    const e1 = deaArr[k];
    if (goldenCrossAgo === 999 && d0 <= e0 && d1 > e1) {
      goldenCrossAgo = curSubIdx - k;
    }
    if (deathCrossAgo === 999 && d0 >= e0 && d1 < e1) {
      deathCrossAgo = curSubIdx - k;
    }
    if (goldenCrossAgo !== 999 && deathCrossAgo !== 999) break;
  }

  // 柱体斜率
  const prevHist = curSubIdx > 0 ? histArr[curSubIdx - 1] : 0;
  const histSlope = hist - prevHist;

  // 柱体峰值距今根数
  let histPeakAgo = 0;
  const streakLen = greenStreak > 0 ? greenStreak : redStreak > 0 ? redStreak : 1;
  let extremeHist = hist;
  for (let k = 0; k < streakLen; k++) {
    const val = histArr[curSubIdx - k] ?? 0;
    if (greenStreak > 0 && val > extremeHist) {
      extremeHist = val;
      histPeakAgo = k;
    } else if (redStreak > 0 && val < extremeHist) {
      extremeHist = val;
      histPeakAgo = k;
    }
  }

  // DEA 峰值距今根数 (30 根窗口)
  const deaLookback = Math.min(30, curSubIdx);
  let maxDea = -Infinity;
  let deaPeakIdx = curSubIdx;
  for (let k = curSubIdx - deaLookback; k <= curSubIdx; k++) {
    if (deaArr[k] > maxDea) {
      maxDea = deaArr[k];
      deaPeakIdx = k;
    }
  }
  const deaPeakAgo = curSubIdx - deaPeakIdx;

  // 顶背离 / 底背离判定
  let topDivergence = false;
  let bottomDivergence = false;
  const divWindow = Math.min(30, curSubIdx);
  if (divWindow >= 10) {
    let maxHighInWin = -Infinity;
    let minLowInWin = Infinity;
    let maxHighIdx = curSubIdx;
    let minLowIdx = curSubIdx;

    for (let k = curSubIdx - divWindow; k < curSubIdx; k++) {
      if (subCandles[k].high > maxHighInWin) {
        maxHighInWin = subCandles[k].high;
        maxHighIdx = k;
      }
      if (subCandles[k].low < minLowInWin) {
        minLowInWin = subCandles[k].low;
        minLowIdx = k;
      }
    }

    // 价格新高但 DEA 或柱体走低 (顶背离)
    if (high >= maxHighInWin && (dea < (deaArr[maxHighIdx] ?? 0) || hist < (histArr[maxHighIdx] ?? 0))) {
      topDivergence = true;
    }
    // 价格新低但 DEA 或柱体走高 (底背离)
    if (low <= minLowInWin && (dea > (deaArr[minLowIdx] ?? 0) || hist > (histArr[minLowIdx] ?? 0))) {
      bottomDivergence = true;
    }
  }

  // 短周期 DIF 相对高低位 (30 根窗口)
  const difLookback = Math.min(30, curSubIdx);
  let maxDif = -Infinity;
  let minDif = Infinity;
  for (let k = Math.max(0, curSubIdx - difLookback); k <= curSubIdx; k++) {
    const d = difArr[k] ?? 0;
    if (d > maxDif) maxDif = d;
    if (d < minDif) minDif = d;
  }
  const difRange = maxDif - minDif;
  const difPos = difRange > 0 ? (dif - minDif) / difRange : 0.5;
  const difLevel = (dif > 0 && maxDif > 0 && dif >= 0.8 * maxDif) || difPos >= 0.8 ? "high"
    : (dif < 0 && minDif < 0 && dif <= 0.8 * minDif) || difPos <= 0.2 ? "low"
    : "mid";

  // 120 分钟内 1m 大阳线检测
  const window120Start = Math.max(0, curSubIdx - 119);
  let maxBullishGain120 = 0;
  for (let k = window120Start; k <= curSubIdx; k++) {
    const b = subCandles[k];
    if (b.open > 0 && b.close > b.open) {
      const gain = ((b.close - b.open) / b.open) * 100;
      if (gain > maxBullishGain120) maxBullishGain120 = gain;
    }
  }
  const hasBigBull120 = maxBullishGain120 >= 5 - 1e-6;

  // 多周期 (5m / 15m)
  const tf5m = computeTfFeature(subCandles, 5 * 60 * 1000);
  const tf15m = computeTfFeature(subCandles, 15 * 60 * 1000);

  return {
    version: FEATURE_VERSION,
    time: bar.time,
    close,
    price: { open, high, low, close },
    surge,
    drop,
    closeChange,
    body,
    upperWick,
    lowerWick,
    dayChange,
    rank,
    dayChangeDelta,
    posIn24hRange,
    dropFrom24hHigh,
    highChange24h,
    surgeRatio,
    dropRatio,
    ma,
    stack,
    stack3Bars,
    maStreak,
    aboveCount,
    dif,
    dea,
    hist,
    difPct,
    deaPct,
    difLevel,
    difPos,
    hasBigBull120,
    maxBullishGain120,
    greenRatio,
    greenStreak,
    redStreak,
    goldenCrossAgo,
    deathCrossAgo,
    histSlope,
    histPeakAgo,
    deaPeakAgo,
    topDivergence,
    bottomDivergence,
    tf5m,
    tf15m,
  };
}

/**
 * 统一策略特征匹配规则评估器：
 * 删除两边重复的 switch 语句，对传入的 FeatureVector 统一执行判定。
 */
export function evaluateFeatureSpec(
  side: "LONG" | "SHORT",
  fv: FeatureVector,
  spec: KlineStatsStrategySpec,
): { pass: boolean; failedReason?: string } {
  const shouldAvoidBigBull = spec.avoidBigBull1m ?? (side === "SHORT");
  if (shouldAvoidBigBull && fv.hasBigBull120) {
    return { pass: false, failedReason: "120分钟内存在>=5%大阳线退避" };
  }
  const w = spec.intervalWindow ?? 5;
  if (!(FEATURE_SURGE_WINDOWS as readonly number[]).includes(w) || !Number.isFinite(spec.ampDivisor ?? 8) || (spec.ampDivisor ?? 8) <= 0) return { pass: false, failedReason: "invalid intervalWindow or ampDivisor" };
  return evaluateRules(compileFeatureSpec(side, spec), field => field === "relativeBias30"
    ? Math.abs(fv.ma[30]?.biasPct ?? 0) / Math.max(1, fv.dayChange)
    : readFeaturePath(fv, field));
}

/**
 * 2.6 信号快照落盘：
 * 每次信号触发，以及差一个条件就触发的“险些触发”，
 * 都把完整 FeatureVector、ticker 数据和配置版本写入 data/signals/YYYYMMDD.jsonl
 */
export async function appendSignalSnapshot(record: {
  time: number;
  symbol: string;
  type: string;
  side: "LONG" | "SHORT";
  triggered: boolean;
  failedReason?: string;
  featureVector: FeatureVector;
  strategy?: import("./strategy-definition.ts").StrategyDefinition;
  monitoredFeatures?: Record<string, unknown>;
  ticker?: any;
  configVersion?: string;
}): Promise<void> {
  try {
    const dateStr = new Date(record.time).toISOString().slice(0, 10).replace(/-/g, "");
    const dir = DEFAULT_SIGNALS_DIR;
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${dateStr}.jsonl`);
    await appendFile(file, JSON.stringify(record) + "\n", "utf8");
  } catch {}
}

/**
 * 2.6 1m 数据落盘：
 * 实盘把涨幅榜币种的已收盘 1m K 线按天写入 data/research/live-1m/
 */
export async function persistClosedCandleToDisk(symbol: string, candle: Candle): Promise<void> {
  return persistClosedCandlesToDisk(symbol, [candle]);
}

const archiveSeen = new Map<string, Map<number, string>>();
const archiveQueues = new Map<string, Promise<void>>();
/** Include warmup and REST gap repairs, not only the latest minute of each scan. */
export function persistClosedCandlesToDisk(symbol: string, candles: Candle[]): Promise<void> {
  const work = (archiveQueues.get(symbol) ?? Promise.resolve()).then(async () => {
    const seen = archiveSeen.get(symbol) ?? new Map<number, string>();
    const days = new Map<string, Array<{ time: number; line: string }>>();
    const now = Date.now();
    for (const candle of candles) {
      if (candle.time + 60_000 > now) continue;
      const line = JSON.stringify(candle);
      if (seen.get(candle.time) === line) continue;
      const day = new Date(candle.time).toISOString().slice(0, 10).replaceAll("-", "");
      const entries = days.get(day) ?? [];
      entries.push({ time: candle.time, line });
      days.set(day, entries);
    }
    if (!days.size) return;
    const dir = path.join(DEFAULT_RESEARCH_ROOT, "live-1m");
    await mkdir(dir, { recursive: true });
    for (const [day, entries] of days) {
      await appendFile(path.join(dir, `${symbol}-${day}.jsonl`), entries.map(e => e.line + "\n").join(""), "utf8");
      for (const entry of entries) seen.set(entry.time, entry.line);
    }
    const newest = Math.max(...seen.keys());
    for (const time of seen.keys()) if (time < newest - 48 * 3600_000) seen.delete(time);
    archiveSeen.set(symbol, seen);
  }).catch(error => console.warn(`[factor-mining] ${symbol} 行情归档失败:`, error.message));
  archiveQueues.set(symbol, work);
  return work;
}

