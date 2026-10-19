import type { Frame, Manifest } from './types.ts';
import { MINUTE, type MinuteDataset } from './gainers-types.ts';
import { validateWickConfig, wickCombinations, type WickConfig, type WickParameters } from './wick-config.ts';
import { buildWickSignals } from './wick-signals.ts';
import { backtestWick, type WickMetrics } from './wick-backtest.ts';

export interface WickTrial {
  id: string;
  parameters: WickParameters;
  train: WickMetrics;
  validation: WickMetrics | null;
}
export function runWickStudy(hourly: Manifest, minute: MinuteDataset, frames: Frame[], config: WickConfig, log = console.log) {
  const c = validateWickConfig(config);
  const { start, end } = hourly, duration = (end - start) / MINUTE;
  const trainEnd = start + Math.floor(duration * c.trainRatio) * MINUTE;
  const validationEnd = trainEnd + Math.floor(duration * c.validationRatio) * MINUTE;
  const horizon = Math.max(...c.holdMinutes);
  if (Math.min(trainEnd - start, validationEnd - trainEnd, end - validationEnd) < horizon * MINUTE) throw new Error('每个分段必须覆盖最长持仓窗口');
  const signalAudit = { rankedMinutes: 0, bullishStreakMinutes: 0, gainQualifiedMinutes: 0, noMaMinutes: 0, matchedMinutes: 0 };
  const signals = buildWickSignals(minute, frames, c, signalAudit);
  const combinations = wickCombinations(c);
  log(`信号直接做空 / 两段平仓：${signals.length} 个候选分钟，${combinations.length} 组预定参数；整笔交易统计`);
  const trials: WickTrial[] = combinations.map((parameters, i) => ({ parameters, id: `staged-${i + 1}`, validation: null,
    train: backtestWick(minute, signals, parameters, c, start, trainEnd).metrics }));
  const order = (a: WickTrial, b: WickTrial, key: 'train' | 'validation') =>
    (b[key]!.meanNetPercent ?? -Infinity) - (a[key]!.meanNetPercent ?? -Infinity)
    || a[key]!.maxDrawdownPoints - b[key]!.maxDrawdownPoints || a.id.localeCompare(b.id);
  const minValidation = Math.max(1, Math.ceil(c.minTrades / 3));
  const shortlist = trials.filter(t => t.train.trades >= c.minTrades && t.train.missing === 0)
    .sort((a, b) => order(a, b, 'train')).slice(0, 5);
  for (const t of shortlist) t.validation = backtestWick(minute, signals, t.parameters, c, trainEnd, validationEnd).metrics;
  const selected = shortlist.filter(t => t.validation!.trades >= minValidation && t.validation!.missing === 0)
    .sort((a, b) => order(a, b, 'validation'))[0];
  const test = selected ? backtestWick(minute, signals, selected.parameters, c, validationEnd, end) : null;
  const trainingTrial = selected ?? [...trials].sort((a, b) => order(a, b, 'train'))[0];
  const trainingReplay = { trialId: trainingTrial.id, parameters: trainingTrial.parameters, exploratory: !selected,
    ...backtestWick(minute, signals, trainingTrial.parameters, c, start, trainEnd) };
  const baselineParameters = combinations[0];
  const baseline = { parameters: baselineParameters, ...backtestWick(minute, signals, baselineParameters, c, start, end) };
  return { version: 3 as const, strategy: 'gainers-streak-green-market-staged-short' as const, createdAt: new Date().toISOString(),
    closePlan: { firstPercentOfInitial: 50, finalPercentOfRemaining: 100, finalCumulativePercent: 100 },
    hourly, minute: minute.manifest, config: c, split: { start, trainEnd, validationEnd, end }, signals, signalAudit, trials, trainingReplay, baseline,
    winner: selected && test ? { trialId: selected.id, parameters: selected.parameters, train: selected.train,
      validation: selected.validation!, test: test.metrics, testTrades: test.trades, testOrders: test.orders,
      sufficientTest: test.metrics.trades >= minValidation && test.metrics.missing === 0 } : null };
}
export type WickStudy = ReturnType<typeof runWickStudy>;
