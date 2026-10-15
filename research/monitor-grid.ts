import { validateGainersGrid } from './gainers-config.ts';
import { rewardRisk } from './miner-core.ts';
import type { GainersGrid } from './gainers-types.ts';
import type { MiningParameters } from './fifteen.ts';
import type { DiffLevel } from '../src/macd.ts';

export interface MonitorGrid extends GainersGrid {
  diff1mLevel: DiffLevel[]; diff5mLevel: DiffLevel[]; fiveHighRatio: number[];
  minuteStreak: number[]; minDrawdownPercent: number[];
}
export const MONITOR_BASELINE: MiningParameters = { monitorMode: 'baseline', highRatio: 0.8, fiveHighRatio: 0.8,
  holdMinutes: 15, stopLossPercent: 0.3, takeProfitPercent: 2 };

export function validateMonitorGrid(input: unknown): MonitorGrid {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('新维度网格必须为对象');
  const raw = { ...input } as Record<string, unknown>, extras: Record<string, unknown> = {};
  for (const key of ['diff1mLevel', 'diff5mLevel', 'fiveHighRatio', 'minuteStreak', 'minDrawdownPercent']) {
    const values = raw[key];
    if (!Array.isArray(values) || !values.length || values.length > 100 || new Set(values).size !== values.length) throw new Error(`${key} 必须是非空、不重复的候选数组`);
    const valid = values.every((v) => key.endsWith('Level') ? ['high', 'mid', 'low'].includes(v)
      : typeof v === 'number' && Number.isFinite(v) && (key === 'minuteStreak' ? Number.isInteger(v) && Math.abs(v) <= 100
        : key === 'fiveHighRatio' ? v > 0 && v <= 1 : v >= 0 && v < 100));
    if (!valid) throw new Error(`${key} 候选无效`);
    extras[key] = values; delete raw[key];
  }
  const base = validateGainersGrid(raw);
  if (base.holdMinutes.some((v) => v > 60)) throw new Error('新维度挖掘最长持有60分钟');
  const grid = { ...base, ...extras } as MonitorGrid;
  if (Object.values(grid).reduce((n, a) => n * a.length, 1) > 2_000_000) throw new Error('原始网格最多200万组合');
  return grid;
}

/** Fix the sampling plan without observing any returns. Every state/streak/drawdown family is represented. */
export function monitorSearch(grid: MonitorGrid, cost: number, minNetRR: number, seed: number, maxTrials: number) {
  if (!Number.isInteger(maxTrials) || maxTrials < 1 || maxTrials > 400000) throw new Error('max-trials 必须为1..400000');
  const families = new Map<string, MiningParameters[]>();
  for (const diff1mLevel of grid.diff1mLevel) for (const diff5mLevel of grid.diff5mLevel)
    for (const minuteStreak of grid.minuteStreak) for (const minDrawdownPercent of grid.minDrawdownPercent) {
      const group: MiningParameters[] = [];
      for (const highRatio of diff1mLevel === 'low' ? grid.highRatio.slice(0, 1) : grid.highRatio)
        for (const fiveHighRatio of diff5mLevel === 'low' ? grid.fiveHighRatio.slice(0, 1) : grid.fiveHighRatio)
          for (const holdMinutes of grid.holdMinutes) for (const stopLossPercent of grid.stopLossPercent) for (const takeProfitPercent of grid.takeProfitPercent) {
            const p: MiningParameters = { monitorMode: 'grid', diff1mLevel, diff5mLevel, minuteStreak, minDrawdownPercent,
              highRatio, fiveHighRatio, holdMinutes, stopLossPercent, takeProfitPercent };
            const rr = rewardRisk(p, cost);
            if (rr.nominal >= 3 - 1e-12 && rr.net >= minNetRR - 1e-12) group.push(p);
          }
      if (group.length) families.set(JSON.stringify([diff1mLevel, diff5mLevel, minuteStreak, minDrawdownPercent]), group);
    }
  if (!families.size) throw new Error('没有达到扣费后盈亏比门槛的候选');
  const possible = [...families.values()].reduce((n, g) => n + g.length, 0);
  if (maxTrials < families.size) throw new Error(`max-trials 至少 ${families.size}，以覆盖全部状态/连续/回撤组合`);
  let state = seed;
  const shuffle = <T>(a: T[]) => { for (let i = a.length - 1; i > 0; i--) { state = (Math.imul(1664525, state) + 1013904223) >>> 0; const j = Math.floor(state / 4294967296 * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } };
  const groups = [...families.values()]; groups.forEach(shuffle); shuffle(groups);
  const candidates: MiningParameters[] = [];
  for (let i = 0; candidates.length < Math.min(possible, maxTrials); i++) {
    for (const group of groups) {
      if (group[i]) candidates.push(group[i]);
      if (candidates.length === Math.min(possible, maxTrials)) break;
    }
  }
  shuffle(candidates);
  return { candidates, plan: { possible, selected: candidates.length, exhaustive: candidates.length === possible,
    strata: groups.length, method: 'histogram-state-streak-drawdown-v1', seed, maxTrials } };
}
