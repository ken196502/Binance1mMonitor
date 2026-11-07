import { StrategyEngine, type StrategyMatch } from "./strategy-engine.ts";
import { StrategyFeatureMonitor } from "./strategy-features.ts";
import type { Candle } from "./macd.ts";
import type { Ticker24h } from "./binance.ts";
import type { StrategyDefinition } from "./strategy-definition.ts";
import type { PeakReboundLiveSignal, UnifiedLiveSignal, UnifiedSignalType } from "./strategy-legacy-config.ts";

/** Compatibility shell for old scripts. Signal decisions only run through StrategyEngine. */
export class StrategyCompatibilityTracker {
  readonly engine: StrategyEngine;
  protected activePositions = new Map<string, { tradeId: string; type: string; entryTime: number; maxExitTime: number }>();
  constructor(strategies: StrategyDefinition[], protected preventConflict = true) { this.engine = new StrategyEngine(strategies); }
  registerPosition(symbol: string, info: { tradeId: string; type: string; entryTime: number; maxExitTime: number }): void { this.activePositions.set(symbol, info); }
  closePosition(symbol: string): void { this.activePositions.delete(symbol); }
  isSymbolBusy(symbol: string, now = Date.now()): boolean {
    const position = this.activePositions.get(symbol);
    if (!position) return false;
    if (now >= position.maxExitTime) { this.activePositions.delete(symbol); return false; }
    return true;
  }
  protected match(symbol: string, dayChange: number, rank: number, candles: Candle[], now: number, ticker?: Ticker24h | null): StrategyMatch | undefined {
    if (this.preventConflict && this.isSymbolBusy(symbol, now)) return;
    const monitor = new StrategyFeatureMonitor(candles, { ...ticker, symbol, priceChangePercent: dayChange, lastPrice: candles.at(-2)?.close ?? 0, quoteVolume: ticker?.quoteVolume ?? 0 }, rank);
    const match = this.engine.evaluate(monitor, now)[0];
    if (match) {
      this.engine.commit(match, now);
      if (this.preventConflict) this.registerPosition(symbol, { tradeId: `${match.strategy.id}-${symbol}-${match.time}`, type: match.strategy.id,
        entryTime: match.time, maxExitTime: match.time + match.strategy.exit.holdMinutes * 60_000 });
    }
    return match;
  }
}
export function reboundDetails(match: StrategyMatch, shortMa: number, mediumMa?: number): PeakReboundLiveSignal {
  const read = (f: string) => Number(match.monitor.read(f, match.observation));
  return { symbol: match.monitor.ticker.symbol, time: match.time, dayChangePercent: match.observation?.dayChangeAtRank1 ?? match.monitor.ticker.priceChangePercent,
    peakPrice: read("watch.peakPrice"), troughPrice: read("watch.troughPrice"), pullbackPercent: read("watch.pullback"), reboundPercent: read("watch.rebound"),
    fibRetracement: read("watch.fib"), reboundUpCandles: read("watch.upCandles"), upperShadowRatio: read("upperRangeRatio"), piercedMa: shortMa, mediumMa,
    greenRatio20: read("greenRatio.20"), candle: match.monitor.bar! };
}
export function shortCompatibilitySignal(match: StrategyMatch, configs: {
  streakConfig: import("./strategy-legacy-config.ts").StreakStrategyLiveConfig;
  reboundConfig: import("./strategy-legacy-config.ts").PeakReboundLiveConfig;
  deepReboundConfig: import("./strategy-legacy-config.ts").DeepReboundLiveConfig;
  hourlySuppressionConfig: import("./strategy-legacy-config.ts").HourlySuppressionLiveConfig;
}): UnifiedLiveSignal {
  const { strategy, monitor } = match;
  const read = (field: string) => Number(monitor.read(field, match.observation));
  const details: UnifiedLiveSignal["details"] = {};
  if (strategy.id === "rebound") details.reboundSignal = reboundDetails(match, configs.reboundConfig.shortMa, configs.reboundConfig.mediumMa);
  if (strategy.id === "deep_rebound") details.deepReboundSignal = { dropFrom24h: read("dropFrom24hHigh"), reboundFrom10m: read(`surge.${configs.deepReboundConfig.lowWindowMinutes}`), greenRatio20: read("greenRatio.20"), ma15: read(`ma.${configs.deepReboundConfig.shortMa}.value`), ma30: read(`ma.${configs.deepReboundConfig.longMa}.value`) };
  if (strategy.id === "hourly_suppression") details.hourlySuppressionSignal = { ma60: read("ma.60.value"), high: monitor.bar!.high, low: monitor.bar!.low, close: monitor.bar!.close, nGreenBars: configs.hourlySuppressionConfig.nGreenBars, xRisePercent: read(`surge.${configs.hourlySuppressionConfig.xMinutes ?? 5}`), dropFrom24h: read("dropFrom24hHigh") };
  if (strategy.id === "streak") {
    const c = configs.streakConfig, p = `pivotHigh.${c.divergenceLookbackMin ?? 10}.${c.divergenceLookbackMax ?? 120}`;
    details.streakSignal = { streakCount: read("streak.0.count"), amp30Percent: read(`surge.${c.xMinutes ?? 5}`), greenRatio: 0, consecutiveGreenBars: 0, upperShadowRatio: read("upperShadowRatio"),
      divergence: c.requireMacdDivergence ? { prevPeakPrice: read(`${p}.price`), prevPeakTime: read(`${p}.time`), curHist: read("hist"), prevHist: read(`${p}.hist`), curDif: read("dif"), prevDif: read(`${p}.dif`) }
        : c.requireDeaDivergence ? { curDea: read("dea"), maxDea: read(`deaPeak.${c.deaLookbackMinutes ?? 30}.value`), deaPeakOffsetBars: read(`deaPeak.${c.deaLookbackMinutes ?? 30}.ago`) } : undefined };
  }
  return { id: `${strategy.id}-${monitor.ticker.symbol}-${match.time}`, type: strategy.id as UnifiedSignalType, label: strategy.label,
    symbol: monitor.ticker.symbol, time: match.time, dayChangePercent: monitor.ticker.priceChangePercent, entryPrice: monitor.bar!.close,
    exitParams: { exitX: 35, exitN: 2, exitM: 3, ...strategy.exit }, details };
}
