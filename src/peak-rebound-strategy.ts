export * from "./strategy-legacy-config.ts";
import { StrategyEngine } from "./strategy-engine.ts";
import { StrategyFeatureMonitor } from "./strategy-features.ts";
import { reboundPreset } from "./strategy-presets.ts";
import { reboundDetails } from "./strategy-compat.ts";
import { PEAK_REBOUND_LIVE_DEFAULT_CONFIG, type PeakReboundLiveConfig, type WatchState, type PeakReboundLiveSignal } from "./strategy-legacy-config.ts";
import type { Candle } from "./macd.ts";

export class PeakReboundStrategyTracker {
  private config: PeakReboundLiveConfig;
  readonly engine: StrategyEngine;
  constructor(config: Partial<PeakReboundLiveConfig> = {}, engine?: StrategyEngine) {
    this.config = { ...PEAK_REBOUND_LIVE_DEFAULT_CONFIG, ...config };
    this.engine = engine ?? new StrategyEngine([reboundPreset(this.config)]);
  }
  onRankUpdate(symbol: string, dayChange: number, now = Date.now()): void { this.engine.onRank(symbol, 1, dayChange, now); }
  getWatchlist(): WatchState[] { return this.engine.getWatch("rebound").getWatchlist(); }
  restoreWatchlist(states: WatchState[]): void { this.engine.getWatch("rebound").restoreWatchlist(states); }
  isWatching(symbol: string): boolean { return this.getWatchlist().some(s => s.symbol === symbol); }
  getWatchlistSymbols(): string[] { return this.getWatchlist().map(s => s.symbol); }
  updateConfig(updates: Partial<PeakReboundLiveConfig>): void {
    this.config = { ...this.config, ...updates };
    this.engine.setStrategies(this.engine.getStrategies().map(s => s.id === "rebound" ? { ...reboundPreset(this.config), enabled: s.enabled } : s));
  }
  checkCandles(symbol: string, candles: Candle[], now = Date.now()): PeakReboundLiveSignal | null {
    const state = this.getWatchlist().find(s => s.symbol === symbol);
    if (!state) return null;
    const monitor = new StrategyFeatureMonitor(candles, { symbol, lastPrice: candles.at(-2)?.close ?? 0, priceChangePercent: state.dayChangeAtRank1, quoteVolume: 0 }, 1);
    const match = this.engine.evaluate(monitor, now, s => s.id === "rebound")[0];
    if (!match) return null;
    const signal = reboundDetails(match, this.config.shortMa, this.config.mediumMa);
    this.engine.commit(match, now);
    return signal;
  }
}
export const peakReboundStrategy = new PeakReboundStrategyTracker();
