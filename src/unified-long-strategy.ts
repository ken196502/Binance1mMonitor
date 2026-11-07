export * from "./strategy-legacy-config.ts";
import { StrategyCompatibilityTracker } from "./strategy-compat.ts";
import { wBottomPreset } from "./strategy-presets.ts";
import { W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG, type UnifiedLongLiveConfig, type UnifiedLongLiveSignal } from "./strategy-legacy-config.ts";
import type { Candle } from "./macd.ts";

export class UnifiedLongStrategyTracker extends StrategyCompatibilityTracker {
  private config;
  constructor(config: UnifiedLongLiveConfig = {}) {
    super([], config.preventConflict ?? true);
    this.config = { wBottomDivergenceConfig: { ...W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG, ...config.wBottomDivergenceConfig }, enableWBottomDivergence: config.enableWBottomDivergence ?? true };
    this.updateConfig({});
  }
  updateConfig(updates: Partial<UnifiedLongLiveConfig>): void {
    if (updates.wBottomDivergenceConfig) Object.assign(this.config.wBottomDivergenceConfig, updates.wBottomDivergenceConfig);
    if (updates.enableWBottomDivergence !== undefined) this.config.enableWBottomDivergence = updates.enableWBottomDivergence;
    if (updates.preventConflict !== undefined) this.preventConflict = updates.preventConflict;
    this.engine.setStrategies([{ ...wBottomPreset(this.config.wBottomDivergenceConfig), enabled: this.config.enableWBottomDivergence }]);
  }
  checkCandles(symbol: string, dayChange: number, rank: number | null, candles: Candle[], now = Date.now()): UnifiedLongLiveSignal | null {
    if (rank === null) return null;
    const match = this.match(symbol, dayChange, rank, candles, now);
    if (!match) return null;
    const c = this.config.wBottomDivergenceConfig, p = `pivotLow.${c.prevBottomMinBars}.${c.prevBottomMaxBars}`;
    const read = (field: string) => Number(match.monitor.read(field));
    return { id: `long-w-div-${symbol}-${match.monitor.bar!.time}`, type: "w_bottom_divergence", label: match.strategy.label, symbol, time: match.time, dayChangePercent: dayChange,
      entryPrice: match.monitor.bar!.close, side: "LONG", exitParams: { holdMinutes: c.holdMinutes, stopLossPercent: c.stopLossPercent, tp1Percent: c.tp1Percent, tp2Percent: c.tp2Percent, moveSlToEntryAfterTp1: c.moveSlToEntryAfterTp1, leverage: c.leverage },
      details: { drop30: read("drop.31"), prevLow: read(`${p}.price`), difNow: read("dif"), difPrev: read(`${p}.dif`) } };
  }
}
