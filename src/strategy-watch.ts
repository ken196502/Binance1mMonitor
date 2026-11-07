import type { Candle } from "./macd.ts";
import type { WatchState } from "./strategy-legacy-config.ts";

export interface ObservationSpec {
  rank: number;
  watchWindowHours: number;
  pullbackPercent: number;
  reboundPercent: number;
  historyBars: number;
}
export interface Observation extends WatchState { lastBarTime?: number; ready?: boolean }

/** Stateful market features. Entry conditions and trade decisions do not belong here. */
export class FeatureWatch {
  private states = new Map<string, Observation>();
  onRank(symbol: string, dayChange: number, now: number): void {
    if (dayChange <= 0) return;
    const existing = this.states.get(symbol);
    if (existing) { existing.lastRank1Time = now; existing.dayChangeAtRank1 = dayChange; return; }
    this.states.set(symbol, { symbol, enteredAt: now, lastRank1Time: now, dayChangeAtRank1: dayChange,
      state: "watching_peak", peakPrice: 0, peakTime: now, troughPrice: 0, troughTime: now, troughIndex: 0, cooldownUntil: 0 });
  }
  getWatchlist(): Observation[] { return structuredClone([...this.states.values()]); }
  restoreWatchlist(states: WatchState[]): void {
    this.states.clear();
    for (const state of states) if (state && typeof state.symbol === "string") this.states.set(state.symbol, { ...state });
  }
  observe(symbol: string, bars: Candle[], spec: ObservationSpec, now: number): Observation | undefined {
    const item = this.states.get(symbol);
    if (!item) return;
    if (now - item.lastRank1Time > spec.watchWindowHours * 3_600_000) { this.states.delete(symbol); return; }
    const idx = bars.length - 1;
    const bar = bars[idx];
    if (!bar || now < item.cooldownUntil) return;
    if (item.lastBarTime !== undefined && bar.time <= item.lastBarTime) return item;
    item.lastBarTime = bar.time;
    item.ready = false;
    const reset = () => Object.assign(item, { state: "watching_peak", peakPrice: bar.high, peakTime: bar.time,
      troughPrice: bar.low, troughTime: bar.time, troughIndex: idx });
    if (!item.peakPrice) {
      const history = bars.slice(Math.max(0, idx - spec.historyBars));
      const peak = history.reduce((a, b) => b.high > a.high ? b : a);
      const trough = history.filter(b => b.time >= peak.time).reduce((a, b) => b.low < a.low ? b : a);
      Object.assign(item, { peakPrice: peak.high, peakTime: peak.time, troughPrice: trough.low, troughTime: trough.time, troughIndex: bars.indexOf(trough) });
      if ((peak.high - trough.low) / peak.high * 100 >= spec.pullbackPercent) item.state = (bar.high - trough.low) / trough.low * 100 >= spec.reboundPercent ? "rebounded" : "pulled_back";
      return item;
    }
    if (item.state === "watching_peak") {
      if (bar.high >= item.peakPrice) reset();
      else if ((item.peakPrice - bar.low) / item.peakPrice * 100 >= spec.pullbackPercent) Object.assign(item, { state: "pulled_back", troughPrice: bar.low, troughTime: bar.time, troughIndex: idx });
      return item;
    }
    if (bar.high > item.peakPrice) { reset(); return item; }
    if (item.state === "pulled_back") {
      if (bar.low < item.troughPrice) Object.assign(item, { troughPrice: bar.low, troughTime: bar.time, troughIndex: idx });
      if ((bar.high - item.troughPrice) / item.troughPrice * 100 >= spec.reboundPercent) item.state = "rebounded";
      else return item;
    }
    if (bar.low < item.troughPrice) { Object.assign(item, { state: "pulled_back", troughPrice: bar.low, troughTime: bar.time, troughIndex: idx }); return item; }
    item.ready = true;
    return item;
  }
  commit(symbol: string, bar: Candle, cooldownUntil: number): void {
    const state = this.states.get(symbol);
    if (state) Object.assign(state, { state: "watching_peak", ready: false, peakPrice: bar.high, peakTime: bar.time,
      troughPrice: bar.low, troughTime: bar.time, cooldownUntil });
  }
}
