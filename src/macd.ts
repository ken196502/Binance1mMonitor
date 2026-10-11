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
 * Count consecutive same-direction 1m candles from the latest candle backward.
 * A candle is 阳 (up) when close > open, 阴 (down) when close < open. The run
 * restarts whenever the direction flips; a doji (close === open) breaks it.
 * Returns { count: 0, direction: null } when the latest candle is a doji.
 */
export function consecutiveStreak(candles: Candle[]): Streak {
  const last = candles[candles.length - 1];
  if (!last || last.close === last.open) return { count: 0, direction: null };
  const dir = last.close > last.open ? "up" : "down";
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i];
    const d = c.close > c.open ? "up" : c.close < c.open ? "down" : null;
    if (d !== dir) break;
    count++;
  }
  return { count, direction: dir };
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
   *  observed in the window. e.g. 0.9 → within 90% of the recent high. */
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
    return m > 0 && dea[i] >= highRatio * m;
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
 * warmed-up values). "Near" = >= highRatio × max DEA in the window.
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
  const highRatio = opts.highRatio ?? 0.9;
  const window = opts.highWindow ?? Math.max(0, n - warmup);
  const start = Math.max(warmup, n - window);
  let maxDea = -Infinity;
  for (let i = start; i < n; i++) if (dea[i] > maxDea) maxDea = dea[i];
  // Only treat as "high" when the window actually reached a positive peak;
  // otherwise everything below zero would falsely qualify as "near the high".
  const highPosition = maxDea > 0 && curDea >= highRatio * maxDea;

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

export const STATE_LABEL: Record<MacdState, string> = {
  "high-death-cross": "⚠️ 高位死叉",
  "high-below": "高位空头",
  "high-above": "高位多头",
  "low-death-cross": "低位死叉",
  "low-below": "低位空头",
  "low-above": "低位多头",
};
