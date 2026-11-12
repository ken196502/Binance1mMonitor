import { calculateSma, computeMacd, ema, consecutiveStreakAt, type Candle } from "./macd.ts";
import { computeFeatureVector, type FeatureVector } from "./features.ts";
import type { Ticker24h } from "./binance.ts";
import type { Observation } from "./strategy-watch.ts";
import { readFeaturePath } from "./strategy-rules.ts";

/** One lazy cache per symbol / closed bar, reused by all parameter combinations. */
export class StrategyFeatureMonitor {
  readonly bars: Candle[];
  readonly bar: Candle | undefined;
  private cache = new Map<string, unknown>();
  private macdCache?: ReturnType<typeof computeMacd>;
  private vectorCache?: FeatureVector | null;
  constructor(candles: Candle[], readonly ticker: Ticker24h, readonly rank: number, targetIdx = candles.length - 2, vector?: FeatureVector | null) {
    let start = Math.max(0, targetIdx - 499);
    for (let i = targetIdx; i > start; i--) if (candles[i].time - candles[i - 1].time !== 60_000) { start = i; break; }
    this.bars = targetIdx >= 0 && targetIdx < candles.length ? candles.slice(start, targetIdx + 1) : [];
    this.bar = this.bars.at(-1);
    this.vectorCache = vector;
  }
  get vector(): FeatureVector | null {
    if (this.vectorCache === undefined) this.vectorCache = computeFeatureVector(this.bars, this.ticker, this.bars.length - 1, { rank: this.rank });
    return this.vectorCache;
  }
  private get macd() { return this.macdCache ??= computeMacd(this.bars.map(b => b.close)); }
  read(field: string, observation?: Observation): unknown {
    if (field.startsWith("watch.")) return this.readWatch(field.slice(6), observation);
    if (!this.cache.has(field)) this.cache.set(field, this.compute(field));
    return this.cache.get(field);
  }
  snapshot(): Record<string, unknown> { return Object.fromEntries(this.cache); }
  private compute(field: string): unknown {
    const bar = this.bar, idx = this.bars.length - 1;
    if (!bar || !(bar.open > 0 && bar.close > 0 && bar.low > 0 && bar.high > 0)) return undefined;
    if (field === "rank") return this.rank;
    if (field === "dayChange") return this.ticker.priceChangePercent;
    if (field === "close") return bar.close;
    if (field === "price.previousHigh") return this.bars[idx - 1]?.high;
    if (field.startsWith("price.")) return readFeaturePath(bar, field.slice(6));
    if (field === "upperShadowRatio") return Math.abs(bar.close - bar.open) > 0 ? Math.max(0, bar.high - Math.max(bar.open, bar.close)) / Math.abs(bar.close - bar.open) : 0;
    if (field === "upperRangeRatio") return bar.high > bar.low ? (bar.high - Math.max(bar.open, bar.close)) / (bar.high - bar.low) : 0;
    if (field === "lowerWick") return (Math.min(bar.open, bar.close) - bar.low) / bar.open * 100;
    if (field === "new24hHigh") return this.ticker.highPrice && this.ticker.highPrice > 0 ? bar.high >= this.ticker.highPrice * 0.999 : bar.high >= Math.max(...this.bars.slice(0, -1).map(b => b.high));
    if (field === "dropFrom24hHigh") {
      const high = this.ticker.highPrice && this.ticker.highPrice > 0 ? this.ticker.highPrice : Math.max(...this.bars.map(b => b.high));
      return (high - bar.close) / high * 100;
    }
    if (field === "highChange24h") {
      const high = this.ticker.highPrice && this.ticker.highPrice > 0 ? this.ticker.highPrice : Math.max(...this.bars.map(b => b.high));
      const dayChange = this.ticker.priceChangePercent ?? 0;
      const openPrice = this.ticker.openPrice && this.ticker.openPrice > 0
        ? this.ticker.openPrice
        : (bar.close > 0 && dayChange !== -100
          ? bar.close / (1 + dayChange / 100)
          : this.bars[0]?.open ?? bar.close);
      return openPrice > 0 ? Math.max(dayChange, ((high - openPrice) / openPrice) * 100) : dayChange;
    }
    // Native vector fields keep identical SMA arithmetic in cached replay and live monitoring.
    const cachedVectorValue = readFeaturePath(this.vector, field);
    if (cachedVectorValue !== undefined) return cachedVectorValue;
    const [kind, p1, p2, metric] = field.split(".");
    const n = Number(p1);
    if (["surge", "surgeRatio", "drop", "dropRatio", "range", "closeChange"].includes(kind)) {
      if (this.bars.length < n) return undefined;
      const window = this.bars.slice(-n), low = Math.min(...window.map(b => b.low)), high = Math.max(...window.map(b => b.high));
      const value = kind.startsWith("surge") ? (bar.high - low) / low * 100 : kind.startsWith("drop") ? (high - bar.low) / high * 100 : kind === "range" ? (high - low) / low * 100 : (bar.close - window[0].open) / window[0].open * 100;
      return kind.endsWith("Ratio") ? value / (Math.abs(this.ticker.priceChangePercent) || 1) : value;
    }
    if (kind === "ma" || kind === "support") {
      const value = calculateSma(this.bars.map(b => b.close), idx, n);
      if (value === null) return undefined;
      if (kind === "support") return bar.low < value && bar.close > value;
      switch (p2) {
        case "value": return value;
        case "emaValue": return ema(this.bars.map(b => b.close), n)[idx];
        case "support": return bar.low <= value && bar.close > value;
        case "resist": return bar.high >= value && bar.close < value;
        case "breakout": return bar.open <= value && bar.close > value;
        case "breakdown": return bar.open >= value && bar.close < value;
        case "close_below": return bar.close < value;
        case "close_above": return bar.close > value;
        case "biasPct": return (bar.close - value) / value * 100;
        case "biasRatio": return (bar.close - value) / value * 100 / (Math.abs(this.ticker.priceChangePercent) || 1);
        case "slope2": case "slope3": {
          const prev = calculateSma(this.bars.map(b => b.close), idx - Number(p2.at(-1)), n);
          return prev === null ? undefined : (value - prev) / prev * 100;
        }
      }
    }
    if (kind === "streak") {
      if (idx < n) return undefined;
      const s = consecutiveStreakAt(this.bars, idx - n);
      return p2 === "up" ? (s.direction === "up" ? s.count : 0) : s.count;
    }
    if (["dif", "dea", "hist"].includes(field)) return this.macd[field as "dif" | "dea" | "hist"][idx];
    if (field === "deaSlope") return this.macd.dea[idx] - this.macd.dea[idx - 1];
    if (field === "difLevel" || field === "diff1mLevel") {
      const difArr = this.macd.dif;
      const lookback = Math.min(30, idx);
      let maxDif = -Infinity;
      let minDif = Infinity;
      for (let k = Math.max(0, idx - lookback); k <= idx; k++) {
        const d = difArr[k] ?? 0;
        if (d > maxDif) maxDif = d;
        if (d < minDif) minDif = d;
      }
      const curDif = difArr[idx] ?? 0;
      const difRange = maxDif - minDif;
      const difPos = difRange > 0 ? (curDif - minDif) / difRange : 0.5;
      if ((curDif > 0 && maxDif > 0 && curDif >= 0.8 * maxDif) || difPos >= 0.8) return "high";
      if ((curDif < 0 && minDif < 0 && curDif <= 0.8 * minDif) || difPos <= 0.2) return "low";
      return "mid";
    }
    if (kind === "greenRatio") {
      if (this.bars.length < n) return undefined;
      return this.macd.hist.slice(-n).filter(v => v > 0).length / n;
    }
    if (field === "greenStreak" || field === "redStreak") {
      let count = 0;
      for (let i = idx; i >= 0 && (field === "greenStreak" ? this.macd.hist[i] > 0 : this.macd.hist[i] < 0); i--) count++;
      return count;
    }
    if (kind === "deaPeak") {
      let peak = Math.max(0, idx - n);
      for (let k = peak; k <= idx; k++) if (this.macd.dea[k] > this.macd.dea[peak]) peak = k;
      return p2 === "ago" ? idx - peak : this.macd.dea[peak];
    }
    if (kind === "pivotLow" || kind === "pivotHigh") {
      const end = idx - n, start = Math.max(0, idx - Number(p2));
      if (end < start) return undefined;
      let pivot = start;
      for (let k = start; k <= end; k++) if (kind === "pivotLow" ? this.bars[k].low < this.bars[pivot].low : this.bars[k].high > this.bars[pivot].high) pivot = k;
      const price = kind === "pivotLow" ? this.bars[pivot].low : this.bars[pivot].high;
      if (metric === "price") return price;
      if (metric === "time") return this.bars[pivot].time;
      if (metric === "hist" || metric === "dif") return this.macd[metric][pivot];
      if (metric === "bounce") return (Math.max(...this.bars.slice(pivot).map(b => b.high)) - price) / price * 100;
      if (metric === "ratio") return bar.low / price;
    }
    if (field === "relativeBias30") return Math.abs(Number(this.read("ma.30.biasPct"))) / Math.max(1, this.ticker.priceChangePercent);
    return readFeaturePath(this.vector, field);
  }
  private readWatch(field: string, state?: Observation): unknown {
    if (!state || !this.bar) return undefined;
    switch (field) {
      case "ready": return state.ready ?? false;
      case "state": return state.state;
      case "peakPrice": return state.peakPrice;
      case "troughPrice": return state.troughPrice;
      case "pullback": return (state.peakPrice - state.troughPrice) / state.peakPrice * 100;
      case "rebound": return (this.bar.high - state.troughPrice) / state.troughPrice * 100;
      case "fib": return state.peakPrice > state.troughPrice ? (this.bar.high - state.troughPrice) / (state.peakPrice - state.troughPrice) : 0;
      // Timestamps survive rolling-window eviction and restarts; array indices do not.
      case "upCandles": return this.bars.filter(b => b.time >= state.troughTime && b.close > b.open).length;
    }
  }
}
