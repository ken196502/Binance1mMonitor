export * from "./strategy-legacy-config.ts";
import { StrategyCompatibilityTracker, shortCompatibilitySignal } from "./strategy-compat.ts";
import { reboundPreset, deepReboundPreset, streakPreset, hourlyPreset } from "./strategy-presets.ts";
import { PeakReboundStrategyTracker } from "./peak-rebound-strategy.ts";
import { PEAK_REBOUND_LIVE_DEFAULT_CONFIG, DEEP_REBOUND_LIVE_DEFAULT_CONFIG, STREAK_LIVE_DEFAULT_CONFIG, HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG,
  type UnifiedLiveConfig, type UnifiedLiveSignal, type WatchState } from "./strategy-legacy-config.ts";
import type { Candle } from "./macd.ts";
import type { Ticker24h } from "./binance.ts";

export class UnifiedShortStrategyTracker extends StrategyCompatibilityTracker {
  private config;
  constructor(config: UnifiedLiveConfig = {}) {
    super([], config.preventConflict ?? true);
    this.config = { reboundConfig: { ...PEAK_REBOUND_LIVE_DEFAULT_CONFIG, ...config.reboundConfig }, deepReboundConfig: { ...DEEP_REBOUND_LIVE_DEFAULT_CONFIG, ...config.deepReboundConfig },
      streakConfig: { ...STREAK_LIVE_DEFAULT_CONFIG, ...config.streakConfig }, hourlySuppressionConfig: { ...HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG, ...config.hourlySuppressionConfig },
      enableRebound: config.enableRebound ?? true, enableDeepRebound: config.enableDeepRebound ?? true, enableStreak: config.enableStreak ?? true, enableHourlySuppression: config.enableHourlySuppression ?? true };
    this.updateConfig({});
  }
  updateConfig(updates: Partial<UnifiedLiveConfig>): void {
    for (const key of ["reboundConfig", "deepReboundConfig", "streakConfig", "hourlySuppressionConfig"] as const) if (updates[key]) Object.assign(this.config[key], updates[key]);
    for (const key of ["enableRebound", "enableDeepRebound", "enableStreak", "enableHourlySuppression"] as const) if (updates[key] !== undefined) this.config[key] = updates[key];
    if (updates.preventConflict !== undefined) this.preventConflict = updates.preventConflict;
    const enabled = [this.config.enableRebound, this.config.enableDeepRebound, this.config.enableStreak, this.config.enableHourlySuppression];
    this.engine.setStrategies([reboundPreset(this.config.reboundConfig), deepReboundPreset(this.config.deepReboundConfig), streakPreset(this.config.streakConfig), hourlyPreset(this.config.hourlySuppressionConfig)].map((s, i) => ({ ...s, enabled: enabled[i] })));
  }
  getConfig(): UnifiedLiveConfig { return structuredClone({ ...this.config, preventConflict: this.preventConflict }); }
  onRankUpdate(symbol: string, dayChange: number, now = Date.now()): void { this.engine.onRank(symbol, 1, dayChange, now); }
  getReboundWatchlist() { return this.engine.getWatch("rebound").getWatchlist(); }
  restoreReboundWatchlist(states: WatchState[]): void { this.engine.getWatch("rebound").restoreWatchlist(states); }
  getReboundTracker(): PeakReboundStrategyTracker { return new PeakReboundStrategyTracker(this.config.reboundConfig, this.engine); }
  checkCandles(symbol: string, dayChange: number, rank: number, candles: Candle[], now = Date.now(), ticker?: Ticker24h | null): UnifiedLiveSignal | null {
    const match = this.match(symbol, dayChange, rank, candles, now, ticker);
    return match ? shortCompatibilitySignal(match, this.config) : null;
  }
  /** Historical scripts used this private method via an any cast. */
  private checkStreakSignal(symbol: string, dayChange: number, candles: Candle[], ticker?: Ticker24h | null) {
    const tracker = new UnifiedShortStrategyTracker({ ...this.config, enableRebound: false, enableDeepRebound: false, enableHourlySuppression: false, preventConflict: false });
    return tracker.checkCandles(symbol, dayChange, 1, candles, candles.at(-2)!.time + 60_000, ticker)?.details.streakSignal ?? null;
  }
}
