// MACD computation and high-position death-cross detection.
// Standard MACD(12, 26, 9): DIF = EMA(fast) - EMA(slow); DEA = EMA(signal) of DIF; hist = 2*(DIF-DEA).

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Exponential moving average. Seeded with the first value (standard EMA seeding). */
export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = new Array(values.length);
  if (values.length === 0) return out;
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[i] : values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export interface MacdResult {
  dif: number[];
  dea: number[];
  hist: number[];
}

export interface Streak {
  count: number;
  direction: "up" | "down" | null;
}

/**
 * Count consecutive same-direction 1m candles from the latest *closed* candle
 * backward. The last element of the kline array is the still-forming (未收盘)
 * 1m candle, so it is excluded — its direction is not final and could flip
 * before close. A candle is 阳 (up) when close > open, 阴 (down) when close <
 * open. The run restarts whenever the direction flips; a doji (close === open)
 * breaks it. Returns { count: 0, direction: null } when there is no closed
 * candle yet or the latest closed candle is a doji.
 */
export function consecutiveStreak(candles: Candle[]): Streak {
  // Skip the last candle: it is the in-progress 1m bar, not closed yet.
  return consecutiveStreakAt(candles, candles.length - 2);
}

/** Shared closed-bar rule; opposite colour, doji or a missing interval ends a run. */
export function consecutiveStreakAt(
  candles: readonly Pick<Candle, 'open' | 'close' | 'time'>[],
  targetIndex: number,
  intervalMs = 60_000,
): Streak {
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= candles.length || !Number.isFinite(intervalMs) || intervalMs <= 0) return { count: 0, direction: null };
  const last = candles[targetIndex];
  if (!last || last.close === last.open) return { count: 0, direction: null };
  const dir = last.close > last.open ? "up" : "down";
  let count = 0;
  for (let i = targetIndex; i >= 0; i--) {
    if (i < targetIndex && candles[i + 1].time - candles[i].time !== intervalMs) break;
    const c = candles[i];
    const d = c.close > c.open ? "up" : c.close < c.open ? "down" : null;
    if (d !== dir) break;
    count++;
  }
  return { count, direction: dir };
}
export const SUPPORT_MA_PERIODS = [5, 7, 10, 20, 25, 30, 60, 99, 120] as const;

/** Shared monitor/research rule. Read only candles up to the specified closed bar. */
export function calculateSupportMaAt(
  candles: readonly Pick<Candle, "close" | "low">[],
  targetIndex: number,
  periods: readonly number[] = SUPPORT_MA_PERIODS,
): string | null {
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= candles.length) return null;
  const candle = candles[targetIndex];
  if (!candle) return null;

  const close = candle.close;
  const low = candle.low;

  let bestPeriod: number | null = null;
  let maxMaValue = -Infinity;

  for (const p of periods) {
    if (targetIndex + 1 < p) continue; // not enough candles to compute MA
    let sum = 0;
    for (let i = targetIndex - p + 1; i <= targetIndex; i++) {
      sum += candles[i].close;
    }
    const ma = sum / p;
    // 条件：收盘价大于 且 最低价小于
    if (close > ma && low < ma) {
      // 如果有多条，取数值最大的那个
      if (ma > maxMaValue) {
        maxMaValue = ma;
        bestPeriod = p;
      }
    }
  }

  return bestPeriod !== null ? `ma${bestPeriod}` : null;
}

export function calculateSupportMa(
  candles: Candle[],
  periods: readonly number[] = SUPPORT_MA_PERIODS,
): string | null {
  // Monitor input ends with a still-forming bar. Preserve its closed-bar behavior.
  return calculateSupportMaAt(candles, candles.length - 2, periods);
}
export function computeMacd(closes: number[], fast = 12, slow = 26, signal = 9): MacdResult {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const dif = closes.map((_, i) => emaFast[i] - emaSlow[i]);
  const dea = ema(dif, signal);
  const hist = dif.map((_, i) => 2 * (dif[i] - dea[i]));
  return { dif, dea, hist };
}

export interface AnalyzeOptions {
  /** "High position" = current DEA is at/above this fraction of the highest DEA
   *  observed in the window. e.g. 0.8 → within 80% of the recent high. */
  highRatio?: number;
  /** How many recent DEA values define the observation window (defaults to all). */
  highWindow?: number;
}

export type MacdState =
  | "high-death-cross" // DEA near its window-high, fresh bearish cross on the last closed candle
  | "high-below" // DEA near its window-high, already below DEA (bearish, not fresh)
  | "high-above" // DEA near its window-high, above DEA (bullish)
  | "low-death-cross" // DEA not near high, fresh bearish cross
  | "low-below" // DEA not near high, below DEA (bearish, not fresh)
  | "low-above"; // DEA not near high, above DEA (bullish)

export interface MacdSignal {
  dif: number;
  dea: number;
  hist: number;
  state: MacdState;
  freshCross: boolean; // DIF crossed below DEA on the last closed candle
  goldenCross: boolean; // DIF crossed above DEA on the last closed candle
  highPosition: boolean; // current DEA is at/near the highest DEA in the window
  deathCross: boolean; // DIF < DEA right now
  alert: boolean; // high-position death cross alert, armed until the next golden cross
}

/**
 * Whether the row is currently under a high-position-death-cross alert, armed
 * until the next golden cross. Walks the window to find the most recent death
 * cross that happened while DEA was at/near its window peak, then checks that no
 * golden cross (DIF crossing back above DEA) has occurred since. Stateless: the
 * verdict is recomputed from the candle window each call, so it self-corrects
 * across refreshes and survives restarts.
 */
function alertArmed(dif: number[], dea: number[], opts: {
  warmup: number;
  highRatio: number;
  highWindow: number;
  n: number;
}): boolean {
  const { warmup, highRatio, highWindow, n } = opts;
  // Rolling max DEA over the highWindow-length window ending at index i
  // (clamped to start at the EMA warmup so early, unsettled values are ignored).
  const windowMaxAt = (i: number): number => {
    const s = Math.max(warmup, i - highWindow + 1);
    let m = -Infinity;
    for (let j = s; j <= i; j++) if (dea[j] > m) m = dea[j];
    return m;
  };
  const highPosAt = (i: number): boolean => {
    const m = windowMaxAt(i);
    return dea[i] > 0 && dea[i] >= highRatio * m;
  };
  let lastHighDeathIdx = -1;
  for (let i = warmup + 1; i < n; i++) {
    if (dif[i - 1] >= dea[i - 1] && dif[i] < dea[i] && highPosAt(i)) lastHighDeathIdx = i;
  }
  if (lastHighDeathIdx < 0) return false;
  // A golden cross after the trigger resolves the alert.
  for (let i = lastHighDeathIdx + 1; i < n; i++) {
    if (dif[i - 1] <= dea[i - 1] && dif[i] > dea[i]) return false;
  }
  return true;
}

/**
 * Analyze MACD on a series of 1m closes.
 * Returns null if there isn't enough history to compute a stable MACD.
 *
 * "High position" is defined per user spec: the current DEA is at or near the
 * highest DEA value within the observation window (highWindow, default = all
 * warmed-up values), AND the current DEA is > 0 (above the zero axis). "Near" =
 * >= highRatio × max DEA in the window.
 *
 * The alert is *persistent*: once a high-position death cross fires, the row
 * stays armed until the next golden cross (DIF crossing back above DEA), not
 * just for the single cross candle.
 */
export function analyzeMacd(closes: number[], opts: AnalyzeOptions = {}): MacdSignal | null {
  if (closes.length < 35) return null;
  const { dif, dea, hist } = computeMacd(closes);
  const n = dif.length;
  const curDif = dif[n - 1];
  const curDea = dea[n - 1];
  const curHist = hist[n - 1];
  const prevDif = dif[n - 2];
  const prevDea = dea[n - 2];

  // Skip the EMA warmup (slow + signal ≈ 35) so the window max reflects settled values.
  const warmup = 35;
  const highRatio = opts.highRatio ?? 0.8;
  const window = opts.highWindow ?? Math.max(0, n - warmup);
  const start = Math.max(warmup, n - window);
  let maxDea = -Infinity;
  for (let i = start; i < n; i++) if (dea[i] > maxDea) maxDea = dea[i];
  // Per spec, "high" requires the current DEA itself to be above the zero axis
  // (DEA > 0) — a rising but still-negative DEA near its recent peak is not a
  // high position.
  const highPosition = curDea > 0 && curDea >= highRatio * maxDea;

  const freshCross = prevDif >= prevDea && curDif < curDea; // fresh death cross on the last candle
  const goldenCross = prevDif <= prevDea && curDif > curDea; // fresh golden cross on the last candle
  const deathCross = curDif < curDea;
  // Persistent alert: armed from a high-position death cross until the next golden cross.
  const alert = alertArmed(dif, dea, { warmup, highRatio, highWindow: window, n });

  let state: MacdState;
  if (highPosition) {
    state = freshCross ? "high-death-cross" : deathCross ? "high-below" : "high-above";
  } else {
    state = freshCross ? "low-death-cross" : deathCross ? "low-below" : "low-above";
  }

  return {
    dif: curDif,
    dea: curDea,
    hist: curHist,
    state,
    freshCross,
    goldenCross,
    highPosition,
    deathCross,
    alert,
  };
}

export type DiffLevel = "high" | "mid" | "low";

/**
 * 判定 DIFF 档位：
 * 过去 N 根 diff 峰值的百分之 x 且大于 0 算高，大于 0 算中，小于 0 算低。
 */
export function diffLevel(
  diff: number,
  peakDiff: number,
  highRatio = 0.8,
): DiffLevel {
  return diff > 0 && diff >= highRatio * peakDiff ? "high" : diff >= 0 ? "mid" : "low";
}

export interface DiffAnalysisOptions {
  /** "High position" = current DIF is at/above this fraction of the highest DIF observed in the window. Default 0.8. */
  highRatio?: number;
  /** How many recent DIF values define the observation window (defaults to all settled values). */
  highWindow?: number;
  /**
   * Whether to evaluate on the latest closed candle (index n - 2).
   * Defaults to true because monitor candles end with a still-forming bar.
   */
  useClosedBar?: boolean;
}

export interface DiffSignal {
  dif: number;
  level: DiffLevel;
  peakDif: number;
}

/**
 * Analyze DIFF level on a series of closes.
 * DIFF is defined as the MACD Histogram (红绿柱): 2 * (DIF - DEA).
 * Positive (>0) = green bar (中/高), Negative (<0) = red bar (严格为低).
 * Returns null if there isn't enough history to compute a stable MACD.
 */
export function analyzeDiff(
  closes: number[],
  opts: DiffAnalysisOptions = {},
): DiffSignal | null {
  if (closes.length < 35) return null;
  const { hist } = computeMacd(closes);
  const n = hist.length;

  const useClosedBar = opts.useClosedBar ?? true;
  const targetIdx = useClosedBar ? n - 2 : n - 1;
  if (targetIdx < 0 || targetIdx >= n) return null;

  const curDif = hist[targetIdx];
  const warmup = 35;
  const highRatio = opts.highRatio ?? 0.8;
  const window = opts.highWindow ?? Math.max(0, targetIdx + 1 - warmup);
  const start = Math.max(warmup, targetIdx + 1 - window);
  let maxDif = -Infinity;
  for (let i = start; i <= targetIdx; i++) {
    if (hist[i] > maxDif) maxDif = hist[i];
  }

  const level = diffLevel(curDif, maxDif, highRatio);
  return {
    dif: curDif,
    level,
    peakDif: maxDif,
  };
}

export const FIVE_MIN_MS = 5 * 60 * 1000;

/**
 * 将 1m K 线聚合为 5m K 线。
 * 按整 5 分钟时间戳（time % 300,000 === 0）分组计算 open, high, low, close, volume。
 */
export function aggregate1mTo5m(candles1m: Candle[]): Candle[] {
  if (candles1m.length === 0) return [];
  const groups = new Map<number, Candle[]>();
  for (const c of candles1m) {
    const bucketTime = Math.floor(c.time / FIVE_MIN_MS) * FIVE_MIN_MS;
    let list = groups.get(bucketTime);
    if (!list) {
      list = [];
      groups.set(bucketTime, list);
    }
    list.push(c);
  }

  const result: Candle[] = [];
  for (const [time, bars] of groups.entries()) {
    bars.sort((a, b) => a.time - b.time);
    const open = bars[0].open;
    const close = bars[bars.length - 1].close;
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    for (const b of bars) {
      if (b.high > high) high = b.high;
      if (b.low < low) low = b.low;
      volume += b.volume;
    }
    result.push({ time, open, high, low, close, volume });
  }

  result.sort((a, b) => a.time - b.time);
  return result;
}

/**
 * 用 1m K 线增量计算/更新 5m K 线序列：
 * 保留历史已有的 5m 完整根数，对于 1m K 线覆盖的时间段（含正在形成的 5m K 线）进行动态合成与更新。
 */
export function update5mFrom1m(cached5m: Candle[], candles1m: Candle[], maxBars = 100): Candle[] {
  if (candles1m.length === 0) return cached5m;
  if (cached5m.length === 0) return aggregate1mTo5m(candles1m).slice(-maxBars);

  const first1mTime = candles1m[0].time;
  const firstBucketTime = Math.floor(first1mTime / FIVE_MIN_MS) * FIVE_MIN_MS;
  const isFirstBucketComplete = first1mTime === firstBucketTime;

  const aggregated5m = aggregate1mTo5m(candles1m);
  const map = new Map<number, Candle>();
  for (const c of cached5m) {
    map.set(c.time, c);
  }

  for (const bar of aggregated5m) {
    // 若 1m 序列首根不是在 5m 边界（首桶不完整），且缓存中已有完整的该桶，则不被残缺数据覆盖
    if (bar.time === firstBucketTime && !isFirstBucketComplete && map.has(bar.time)) {
      continue;
    }
    map.set(bar.time, bar);
  }

  const result = Array.from(map.values()).sort((a, b) => a.time - b.time);
  return result.length > maxBars ? result.slice(-maxBars) : result;
}

export const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * 计算最近一个整点到当前的最高价（包含整点后所有 1m K 线的最高价及最新现价）
 */
export function calculateMaxHour(candles: Candle[], lastPrice?: number): number | null {
  if (candles.length === 0) return null;
  const refTime = candles[candles.length - 1].time;
  const hourStart = Math.floor(refTime / ONE_HOUR_MS) * ONE_HOUR_MS;
  let maxH = -Infinity;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].time < hourStart) break;
    if (candles[i].high > maxH) {
      maxH = candles[i].high;
    }
  }
  if (lastPrice !== undefined && lastPrice > maxH) {
    maxH = lastPrice;
  }
  return Number.isFinite(maxH) ? maxH : null;
}


