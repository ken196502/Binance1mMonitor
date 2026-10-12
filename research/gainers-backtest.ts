import { deaLevel, type FifteenParameters } from './fifteen.ts';
import { matchesStreak } from './streak.ts';
import { shortReturn, summarize } from "./backtest.ts";
import { HOUR, type Dataset, type Frame } from "./types.ts";
import { validateGainersOptions } from "./gainers-config.ts";
import { calculateSupportMaAt, consecutiveStreakAt, SUPPORT_MA_PERIODS } from "../src/macd.ts";
import { MINUTE, type GainersOptions, type GainersParameters, type GainersStudy, type MinuteDataset, type MinuteSignal, type MinuteTrade, type MinuteTrial } from "./gainers-types.ts";

/** MACD predicates; the entry rule also requires an evaluated absence of MA support. */
export function highBull(dif: number, dea: number, peakDea: number, highRatio: number): boolean {
  return [dif, dea, peakDea, highRatio].every(Number.isFinite) && dea > 0 && peakDea > 0 && dif >= dea && dea >= highRatio * peakDea;
}

export function matchesMinuteEntry(signal: MinuteSignal, highRatio: number, p?: FifteenParameters): boolean {
  if (!matchesStreak(signal.streak, p?.minuteStreak)) return false;
  if (!p || p.minuteDea === undefined && p.minuteDif === undefined) return signal.supportMa === null && highBull(signal.dif, signal.dea, signal.peakDea, highRatio);
  if (signal.supportMa !== null || ![signal.dea, signal.dif, signal.peakDea].every(Number.isFinite)) return false;
  const level = deaLevel(signal.dea, signal.peakDea, highRatio), direction = signal.dif >= signal.dea ? 'bull' : 'bear';
  return (p.minuteDea === undefined || p.minuteDea === 'any' || p.minuteDea === level)
    && (p.minuteDif === undefined || p.minuteDif === 'any' || p.minuteDif === direction);
}

export function buildMinuteSignals(data: MinuteDataset, frames: Frame[], highWindow: number, minRatio: number, allStates = false): MinuteSignal[] {
  const members = new Map(frames.map((f) => [f.time, new Map(f.boards.gainers.map((o) => [o.symbol, o.rank]))]));
  const signals: MinuteSignal[] = [];
  const { start, end, warmupMinutes } = data.manifest.plan;
  for (const [symbol, bars] of data.candles) {
    const supportCandles = bars.map((bar) => ({ time: bar[0], open: bar[1], close: bar[4], low: bar[3] }));
    let fast = 0, slow = 0, dea = 0, segmentStart = 0;
    const deas: number[] = [];
    for (let i = 0; i < bars.length; i++) {
      const c = bars[i];
      if (i === 0 || c[0] !== bars[i - 1][0] + MINUTE) {
        fast = slow = c[4]; dea = 0; segmentStart = i;
      } else {
        fast += 2 / 13 * (c[4] - fast);
        slow += 2 / 27 * (c[4] - slow);
        dea += 2 / 10 * (fast - slow - dea);
      }
      deas.push(dea);
      const time = c[0] + MINUTE;
      if (time < start || time >= end || i - segmentStart + 1 < Math.max(warmupMinutes, ...SUPPORT_MA_PERIODS)) continue;
      // Hourly membership is known only from this hour's already-closed 24h window.
      const boardTime = Math.floor(time / HOUR) * HOUR;
      const rank = members.get(boardTime)?.get(symbol);
      if (rank == null) continue;
      const dif = fast - slow;
      const peakDea = Math.max(...deas.slice(i - highWindow + 1, i + 1));
      if (!allStates && !highBull(dif, dea, peakDea, minRatio)) continue;
      const supportMa = calculateSupportMaAt(supportCandles, i);
      if (supportMa !== null) continue;
      signals.push({ symbol, rank, boardTime, time, index: i, dif, dea, peakDea, deaPeakRatio: peakDea === 0 ? 0 : dea / peakDea, supportMa,
        streak: consecutiveStreakAt(supportCandles, i, MINUTE) });
    }
  }
  return signals.sort((a, b) => a.time - b.time || a.symbol.localeCompare(b.symbol));
}

export function backtestMinutes(data: MinuteDataset, signals: MinuteSignal[], p: GainersParameters,
  start: number, end: number, costBps: number, exitOffsets?: readonly number[]) {
  // GPU supplies the first exit/gap offset. -1 asks for a scalar replay when a
  // float32 comparison is too close to a threshold. Accounting stays float64.
  if (exitOffsets && (exitOffsets.length !== signals.length || exitOffsets.some((x) => !Number.isInteger(x) || x < -1 || x >= p.holdMinutes))) {
    throw new Error("GPU exit offsets do not match the signal/parameter batch");
  }
  const trades: MinuteTrade[] = [];
  const available = new Map<string, number>();
  let missing = 0, purged = 0;
  for (const [signalIndex, signal] of signals.entries()) {
    if (signal.time < start || signal.time >= end || !matchesMinuteEntry(signal, p.highRatio) ||
      (available.get(signal.symbol) ?? 0) > signal.time) continue;
    const deadline = signal.time + p.holdMinutes * MINUTE;
    if (deadline > end) { purged++; continue; }
    const bars = data.candles.get(signal.symbol)!;
    const first = bars[signal.index + 1];
    available.set(signal.symbol, deadline);
    if (!first || first[0] !== signal.time) { missing++; continue; }
    const entryPrice = first[1];
    const stop = entryPrice * (1 + p.stopLossPercent / 100);
    const target = entryPrice * (1 - p.takeProfitPercent / 100);
    for (let offset = Math.max(0, exitOffsets?.[signalIndex] ?? 0); offset < p.holdMinutes; offset++) {
      const c = bars[signal.index + 1 + offset];
      if (!c || c[0] !== signal.time + offset * MINUTE) { missing++; break; }
      let exitPrice: number | null = null;
      let reason: MinuteTrade["reason"] = "timeout";
      const ambiguous = c[1] < stop && c[1] > target && c[2] >= stop && c[3] <= target;
      if (c[1] >= stop) { exitPrice = c[1]; reason = "stop"; }
      else if (c[1] <= target) { exitPrice = c[1]; reason = "target"; }
      else if (c[2] >= stop) { exitPrice = stop; reason = "stop"; }
      else if (c[3] <= target) { exitPrice = target; reason = "target"; }
      else if (offset === p.holdMinutes - 1) exitPrice = c[4];
      if (exitPrice != null) {
        const exitTime = c[0] + MINUTE;
        // No additional cooldown: the next closed high+bullish signal can re-enter.
        available.set(signal.symbol, exitTime);
        trades.push({ symbol: signal.symbol, rank: signal.rank, boardTime: signal.boardTime,
          entryTime: signal.time, exitTime, entryPrice, exitPrice, reason, ambiguous,
          ...shortReturn(entryPrice, exitPrice, costBps), signal });
        break;
      }
    }
  }
  return { metrics: summarize(trades, missing, purged), trades };
}

export function runGainersStudy(hourly: Dataset, minute: MinuteDataset, frames: Frame[], options: GainersOptions, log = console.log): GainersStudy {
  validateGainersOptions(options);
  const signals = buildMinuteSignals(minute, frames, options.highWindow, Math.min(...options.grid.highRatio));
  const { start, end } = hourly.manifest;
  const duration = (end - start) / MINUTE;
  const trainEnd = start + Math.floor(duration * options.trainRatio) * MINUTE;
  const validationEnd = trainEnd + Math.floor(duration * options.validationRatio) * MINUTE;
  if (Math.min(trainEnd - start, validationEnd - trainEnd, end - validationEnd) < Math.max(...options.grid.holdMinutes) * MINUTE) throw new Error("每个数据分段需覆盖最大持有期");
  log(`1m DEA 高位 + DIF 多头 + 无 MA 支撑候选 ${signals.length} 条；开始 gainers 独立参数搜索`);
  const cost = options.feeBps + options.slippageBps;
  let seed = options.seed;
  const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
  const trials: MinuteTrial[] = [];
  const keys = Object.keys(options.grid) as (keyof GainersParameters)[];
  const seen = new Set<string>();
  const order = (a: MinuteTrial, b: MinuteTrial) => (b.train.meanNetPercent ?? -Infinity) - (a.train.meanNetPercent ?? -Infinity) || a.train.maxDrawdownPoints - b.train.maxDrawdownPoints || a.id.localeCompare(b.id);
  for (let round = 1; round <= options.rounds; round++) {
    const elites = trials.filter((t) => t.train.trades >= options.minTrades).sort(order).slice(0, 5);
    let added = 0;
    for (let attempt = 0; added < options.trialsPerRound && attempt < options.trialsPerRound * 200; attempt++) {
      const values = Object.fromEntries(keys.map((k) => [k, options.grid[k][Math.floor(random() * options.grid[k].length)]])) as unknown as GainersParameters;
      let p = values;
      if (elites.length && attempt % 4 !== 0) {
        p = { ...elites[Math.floor(random() * elites.length)].parameters };
        for (let i = 0; i < 2; i++) { const key = keys[Math.floor(random() * keys.length)]; p[key] = values[key]; }
      }
      if (p.takeProfitPercent / p.stopLossPercent < 3 - 1e-12) continue;
      const signature = JSON.stringify(p);
      if (seen.has(signature)) continue;
      seen.add(signature);
      const train = backtestMinutes(minute, signals, p, start, trainEnd, cost).metrics;
      trials.push({ id: `gainers-1m-r${round}-${++added}`, round, parameters: p, train, validation: null });
    }
    log(`gainers 1m 第 ${round}/${options.rounds} 轮：${added} 组新参数`);
    if (!added) break;
  }
  const shortlist = trials.filter((t) => t.train.trades >= options.minTrades).sort(order).slice(0, 5);
  for (const t of shortlist) t.validation = backtestMinutes(minute, signals, t.parameters, trainEnd, validationEnd, cost).metrics;
  const selected = shortlist.filter((t) => t.validation!.trades >= Math.max(1, Math.ceil(options.minTrades / 3))).sort((a, b) =>
    b.validation!.meanNetPercent! - a.validation!.meanNetPercent! || a.validation!.maxDrawdownPoints - b.validation!.maxDrawdownPoints || a.id.localeCompare(b.id))[0];
  let winner: GainersStudy["winner"] = null;
  if (selected) {
    const result = backtestMinutes(minute, signals, selected.parameters, validationEnd, end, cost);
    winner = { trialId: selected.id, parameters: selected.parameters, train: selected.train, validation: selected.validation!, test: result.metrics, testTrades: result.trades };
  }
  return { version: 1, strategy: "gainers-high-bull-no-ma-1m", createdAt: new Date().toISOString(), hourly: hourly.manifest,
    minute: minute.manifest, options, signalCount: signals.length, split: { start, trainEnd, validationEnd, end }, trials, winner };
}
