import { evaluateRules } from "./strategy-rules.ts";
import { validateStrategies, type StrategyDefinition } from "./strategy-definition.ts";
import { StrategyFeatureMonitor } from "./strategy-features.ts";
import { FeatureWatch, type Observation } from "./strategy-watch.ts";
import type { WatchState } from "./strategy-legacy-config.ts";

export interface StrategyMatch {
  strategy: StrategyDefinition;
  monitor: StrategyFeatureMonitor;
  observation?: Observation;
  time: number;
}
export interface StrategyMonitorResult { id: string; symbol: string; time: number; pass: boolean; failedReason?: string }
export interface StrategyRuntimeState {
  watches: Record<string, WatchState[]>;
  cooldowns: [string, number][];
  consumedBars: [string, number][];
}

/** All strategies follow observe -> evaluate -> commit, with no strategy-name branches. */
export class StrategyEngine {
  private definitions: StrategyDefinition[] = [];
  private watches = new Map<string, FeatureWatch>();
  private cooldowns = new Map<string, number>();
  private consumedBars = new Map<string, number>();
  private results: StrategyMonitorResult[] = [];
  constructor(strategies: StrategyDefinition[] = []) { this.setStrategies(strategies); }
  setStrategies(strategies: StrategyDefinition[]): void { validateStrategies(strategies); this.definitions = structuredClone(strategies); }
  getStrategies(): StrategyDefinition[] { return structuredClone(this.definitions); }
  getWatch(id: string): FeatureWatch {
    if (!this.watches.has(id)) this.watches.set(id, new FeatureWatch());
    return this.watches.get(id)!;
  }
  getWatchedSymbols(now = Date.now()): string[] {
    return [...new Set(this.definitions.filter(s => s.enabled && s.observation).flatMap(s => this.getWatch(s.id).getWatchlist()
      .filter(w => now - w.lastRank1Time <= s.observation!.watchWindowHours * 3_600_000).map(w => w.symbol)))];
  }
  onRank(symbol: string, rank: number, dayChange: number, now: number): void {
    for (const s of this.definitions) if (s.observation?.rank === rank) this.getWatch(s.id).onRank(symbol, dayChange, now);
  }
  evaluate(monitor: StrategyFeatureMonitor, now: number, eligible: (strategy: StrategyDefinition) => boolean = () => true): StrategyMatch[] {
    const matches: StrategyMatch[] = [];
    this.results = [];
    if (!monitor.bar) return matches;
    for (const strategy of this.definitions) {
      const observation = strategy.observation && monitor.bar.time + 60_000 <= now && monitor.bars.length >= strategy.minBars
        ? this.getWatch(strategy.id).observe(monitor.ticker.symbol, monitor.bars, strategy.observation, now) : undefined;
      let result: { pass: boolean; failedReason?: string };
      if (!strategy.enabled) result = { pass: false, failedReason: "策略已关闭" };
      else if (monitor.bar.time + 60_000 > now) result = { pass: false, failedReason: "K线尚未收盘" };
      else if (monitor.bars.length < strategy.minBars) result = { pass: false, failedReason: `连续K线不足 ${strategy.minBars} 根` };
      else if (!eligible(strategy)) result = { pass: false, failedReason: "仓位或因子验证暂不允许入场" };
      else if ((this.consumedBars.get(`${strategy.id}:${monitor.ticker.symbol}`) ?? -Infinity) >= monitor.bar.time) result = { pass: false, failedReason: "本根信号已执行" };
      else if ((this.cooldowns.get(`${strategy.cooldownGroup ?? strategy.id}:${monitor.ticker.symbol}`) ?? 0) > now) result = { pass: false, failedReason: "冷却中" };
      else result = evaluateRules(strategy.entry, field => monitor.read(field, observation));
      this.results.push({ id: strategy.id, symbol: monitor.ticker.symbol, time: monitor.bar.time + 60_000, ...result });
      if (result.pass) matches.push({ strategy, monitor, observation: observation && structuredClone(observation), time: monitor.bar.time + 60_000 });
    }
    return matches;
  }
  getResults(): StrategyMonitorResult[] { return structuredClone(this.results); }
  commit(match: StrategyMatch, now: number): void {
    const { strategy: s, monitor } = match;
    this.consumedBars.set(`${s.id}:${monitor.ticker.symbol}`, monitor.bar!.time);
    const cooldownUntil = now + s.cooldownMinutes * 60_000;
    if (s.cooldownFrom !== "exit") this.cooldowns.set(`${s.cooldownGroup ?? s.id}:${monitor.ticker.symbol}`, cooldownUntil);
    if (s.observation) this.getWatch(s.id).commit(monitor.ticker.symbol, monitor.bar!, cooldownUntil);
  }
  recordExit(id: string, symbol: string, now: number): void {
    const s = this.definitions.find(s => s.id === id);
    if (s?.cooldownFrom === "exit") this.cooldowns.set(`${s.cooldownGroup ?? s.id}:${symbol}`, now + s.cooldownMinutes * 60_000);
  }
  exportState(): StrategyRuntimeState {
    return { watches: Object.fromEntries([...this.watches].map(([id, watch]) => [id, watch.getWatchlist()])), cooldowns: [...this.cooldowns], consumedBars: [...this.consumedBars] };
  }
  restoreState(state: StrategyRuntimeState): void {
    for (const [id, states] of Object.entries(state.watches ?? {})) this.getWatch(id).restoreWatchlist(states);
    this.cooldowns = new Map(state.cooldowns ?? []);
    this.consumedBars = new Map(state.consumedBars ?? []);
  }
}
