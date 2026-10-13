import { shortReturn } from './backtest.ts';
import { validateGainersGrid } from './gainers-config.ts';
import type { GainersGrid, GainersParameters, MinuteTrial } from './gainers-types.ts';
import type { Metrics } from './types.ts';
import { STREAK_AXES } from './streak.ts';
import { FIFTEEN_AXES, type MiningParameters } from './fifteen.ts';
import { BTC_FIVE_AXES } from './btc-five.ts';

const STATE_AXES = { ...FIFTEEN_AXES, ...BTC_FIVE_AXES };
const RATIO_AXES = ['fifteenHighRatio', 'btcFiveHighRatio'] as const;

export type MiningGrid = GainersGrid & { [K in keyof typeof STATE_AXES]?: NonNullable<MiningParameters[K]>[] } & { minuteStreak?: number[]; fifteenStreak?: number[]; fifteenHighRatio?: number[]; btcFiveHighRatio?: number[]; btcFiveStreak?: number[] };
export function validateMiningGrid(input: unknown): MiningGrid {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('挖掘网格必须是对象');
  const base = { ...input } as Record<string, unknown>;
  const extra: Record<string, string[]> = {};
  for (const [key, allowed] of Object.entries(STATE_AXES)) {
    if (key in base) {
      const values = base[key];
      if (!Array.isArray(values) || !values.length || new Set(values).size !== values.length || values.some((v) => !allowed.includes(v))) throw new Error(`${key} 候选值无效`);
      extra[key] = values; delete base[key];
    }
  }
  const numeric: Pick<MiningGrid, typeof STREAK_AXES[number] | typeof RATIO_AXES[number]> = {};
  for (const key of [...STREAK_AXES, ...RATIO_AXES] as const) if (key in base) {
    const values = base[key];
    if (!Array.isArray(values) || !values.length || values.length > 100 || new Set(values).size !== values.length
        || values.some((v) => typeof v !== 'number' || !Number.isFinite(v) || (key === 'fifteenHighRatio' || key === 'btcFiveHighRatio' ? v <= 0 || v > 1 : !Number.isInteger(v) || Math.abs(v) > 100))) throw new Error(`${key} 候选值无效`);
    numeric[key] = values; delete base[key];
  }
  const g = validateGainersGrid(base);
  if (extra.fifteenDea || extra.fifteenDif || numeric.fifteenStreak || numeric.fifteenHighRatio) { extra.fifteenDea ??= ['any']; extra.fifteenDif ??= ['any']; }
  if (extra.btcFiveDea || extra.btcFiveDif || numeric.btcFiveStreak || numeric.btcFiveHighRatio) { extra.btcFiveDea ??= ['any']; extra.btcFiveDif ??= ['any']; }
  if (extra.fifteenDea && extra.btcFiveDea) throw new Error('15m 与 BTC 5m 是独立研究，请使用各自网格');
  if (extra.minuteDea || extra.minuteDif) { extra.minuteDea ??= ['any']; extra.minuteDif ??= ['any']; }
  return { ...g, ...extra, ...numeric };
}

export function rewardRisk(p: GainersParameters, cost: number) {
  const gain = shortReturn(100, 100 - p.takeProfitPercent, cost).netPercent;
  const loss = -shortReturn(100, 100 + p.stopLossPercent, cost).netPercent;
  return { nominal: p.takeProfitPercent / p.stopLossPercent, net: gain / loss, gain, loss, breakEvenWinRate: loss / (gain + loss) * 100 };
}

export interface MiningSearch {
  candidates: MiningParameters[];
  plan: { possible: number; selected: number; exhaustive: boolean; method: string; strata: number; maxTrials: number };
}
export function miningSearch(input: unknown, cost: number, minNetRR: number, seed: number, maxTrials = 400_000): MiningSearch {
  if (!Number.isInteger(maxTrials) || maxTrials < 1 || maxTrials > 400_000) throw new Error('max-trials 必须为1..400000的整数');
  const g = validateMiningGrid(input);
  const deaKey = g.btcFiveDea ? 'btcFiveDea' : 'fifteenDea';
  const difKey = g.btcFiveDea ? 'btcFiveDif' : 'fifteenDif';
  const ratioKey = g.btcFiveDea ? 'btcFiveHighRatio' : 'fifteenHighRatio';
  const streakKey = g.btcFiveDea ? 'btcFiveStreak' : 'fifteenStreak';
  const rawBase = Object.entries(g).filter(([k]) => !STREAK_AXES.includes(k as typeof STREAK_AXES[number])).reduce((n, [, a]) => n * a!.length, 1);
  if (rawBase > 2_000_000) throw new Error('不含连阳/连阴的原始网格最多允许200万个组合，请缩小网格');
  if (g.holdMinutes.some((v) => v > 60)) throw new Error('超短线挖掘最长持有期不得超过 60 分钟');
  const bases: MiningParameters[] = [];
  for (const highRatio of g.highRatio) for (const holdMinutes of g.holdMinutes)
    for (const stopLossPercent of g.stopLossPercent) for (const takeProfitPercent of g.takeProfitPercent) {
      const p = { highRatio, holdMinutes, stopLossPercent, takeProfitPercent };
      const rr = rewardRisk(p, cost);
      if (rr.nominal >= 3 - 1e-12 && rr.net >= minNetRR - 1e-12) {
        for (const minuteDea of g.minuteDea ?? [undefined]) for (const minuteDif of g.minuteDif ?? [undefined])
          for (const fifteenDea of g[deaKey] ?? [undefined]) for (const fifteenDif of g[difKey] ?? [undefined])
            for (const fifteenHighRatio of g[ratioKey] ?? [undefined]) {
              // Each timeframe's negative/any DEA ignores only its OWN high threshold.
              if ((minuteDea === 'low' || minuteDea === 'any') && highRatio !== g.highRatio[0]) continue;
              if ((fifteenDea === 'low' || fifteenDea === 'any') && fifteenHighRatio !== g[ratioKey]?.[0]) continue;
              bases.push({ ...p, ...(minuteDea === undefined ? {} : { minuteDea, minuteDif }),
                ...(fifteenDea === undefined ? {} : { [deaKey]: fifteenDea, [difKey]: fifteenDif }),
                ...(fifteenHighRatio === undefined ? {} : { [ratioKey]: fifteenHighRatio }) });
            }
      }
    }
  if (!bases.length) throw new Error('没有同时满足名义 ≥3R 和扣费后盈亏比门槛的参数');
  if (bases.length > 600_000) throw new Error('不含连阳/连阴的有效网格最多允许600000组');
  const minuteValues = g.minuteStreak ?? [undefined], fifteenValues = g[streakKey] ?? [undefined];
  const possible = bases.length * minuteValues.length * fifteenValues.length;
  let state = seed;
  const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
  const shuffle = <T>(values: T[]) => {
    for (let i = values.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [values[i], values[j]] = [values[j], values[i]]; }
  };
  const result: MiningParameters[] = [];
  const withStreak = (p: MiningParameters, minuteStreak: number | undefined, fifteenStreak: number | undefined) => ({ ...p,
    ...(minuteStreak === undefined ? {} : { minuteStreak }), ...(fifteenStreak === undefined ? {} : { [streakKey]: fifteenStreak }) });
  const families = new Map<string, MiningParameters[]>();
  for (const p of bases) {
    const key = JSON.stringify([p.minuteDea, p.minuteDif, p[deaKey], p[difKey]]);
    const group = families.get(key) ?? []; group.push(p); families.set(key, group);
  }
  const strata = families.size * minuteValues.length * fifteenValues.length;
  if (possible <= maxTrials) {
    for (const p of bases) for (const minuteStreak of minuteValues) for (const fifteenStreak of fifteenValues) result.push(withStreak(p, minuteStreak, fifteenStreak));
  } else {
    // Equal allocation across state-pair × independent streak-pair strata.
    // Sample before observing prices/returns, without replacement within each stratum.
    if (maxTrials < strata) throw new Error(`max-trials 至少为 ${strata}，才能覆盖全部状态与连阳/连阴组合`);
    const groups = [...families.values()].flatMap((base) => minuteValues.flatMap((minuteStreak) => fifteenValues.map((fifteenStreak) => ({ base, minuteStreak, fifteenStreak, quota: 0 }))));
    shuffle(groups);
    let remaining = maxTrials;
    while (remaining) {
      const active = groups.filter((g) => g.quota < g.base.length);
      const share = Math.max(1, Math.floor(remaining / active.length));
      for (const group of active) { const n = Math.min(remaining, share, group.base.length - group.quota); group.quota += n; remaining -= n; if (!remaining) break; }
    }
    for (const group of groups) {
      const selected = new Set<number>();
      for (let j = group.base.length - group.quota; j < group.base.length; j++) {
        const k = Math.floor(random() * (j + 1)); selected.add(selected.has(k) ? j : k);
      }
      for (const i of selected) result.push(withStreak(group.base[i], group.minuteStreak, group.fifteenStreak));
    }
  }
  shuffle(result);
  return { candidates: result, plan: { possible, selected: result.length, exhaustive: possible <= maxTrials,
    method: possible <= maxTrials ? 'exhaustive' : 'stratified-state-streak-v1', strata, maxTrials } };
}
export function miningGrid(input: unknown, cost: number, minNetRR: number, seed: number, maxTrials = 400_000): MiningParameters[] {
  return miningSearch(input, cost, minNetRR, seed, maxTrials).candidates;
}

export function trainOrder(a: MinuteTrial, b: MinuteTrial) {
  return (b.train.meanNetPercent ?? -Infinity) - (a.train.meanNetPercent ?? -Infinity)
    || a.train.maxDrawdownPoints - b.train.maxDrawdownPoints || a.id.localeCompare(b.id);
}
export function validationOrder(a: MinuteTrial, b: MinuteTrial) {
  return (b.validation!.meanNetPercent ?? -Infinity) - (a.validation!.meanNetPercent ?? -Infinity)
    || a.validation!.maxDrawdownPoints - b.validation!.maxDrawdownPoints || a.id.localeCompare(b.id);
}
export function positive(m: Metrics, minTrades: number) {
  return m.trades >= minTrades && m.missing === 0 && (m.meanNetPercent ?? -Infinity) > 0
    && (m.profitFactor == null ? m.lossPercent === 0 : m.profitFactor > 1);
}
export function trainingDiscovery(trials: MinuteTrial[], minTrades: number, previousMean: number | null) {
  const best = trials.filter((t) => positive(t.train, minTrades)).sort(trainOrder)[0];
  return best && (previousMean == null || best.train.meanNetPercent! > previousMean + 1e-12) ? best : null;
}
