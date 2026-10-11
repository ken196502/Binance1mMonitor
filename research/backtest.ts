import { weekStart } from "./data.ts";
import { BOARDS, HOUR, type Board, type Dataset, type Frame, type Metrics, type Observation, type Parameters, type Trade } from "./types.ts";

/** Rebuild each historical board from trailing 24 CLOSED hourly candles. */
export function buildFrames(dataset: Dataset, topN: number, stepHours: number): Frame[] {
  const { start, end } = dataset.manifest;
  const step = stepHours * HOUR;
  const frames: Frame[] = Array.from({ length: Math.ceil((end - start) / step) }, (_, i) => ({
    time: start + i * step, eligibleSymbols: 0, boards: { gainers: [], losers: [], volume: [] },
  }));
  for (const [symbol, bars] of dataset.candles) {
    if (!dataset.manifest.symbols.includes(symbol)) throw new Error(`${symbol} 不属于回测池`);
    const byTime = new Map(bars.map((c, i) => [c[0], i]));
    const quotePrefix = [0];
    const volumes = [0];
    const deas: number[] = [];
    let fast = 0, slow = 0, dea = 0, previousDif = 0, previousDea = 0, streak = 0, segmentStart = 0;
    for (let i = 0; i < bars.length; i++) {
      const c = bars[i];
      const gap = i === 0 || c[0] !== bars[i - 1][0] + HOUR;
      previousDif = fast - slow;
      previousDea = dea;
      if (gap) { fast = slow = c[4]; dea = 0; segmentStart = i; streak = 0; }
      else { fast += 2 / 13 * (c[4] - fast); slow += 2 / 27 * (c[4] - slow); dea += 2 / 10 * (fast - slow - dea); }
      deas.push(dea);
      quotePrefix.push(quotePrefix[i] + c[6]);
      volumes.push(volumes[i] + c[5]);
      streak = c[4] < c[1] ? streak + 1 : 0;
      const time = c[0] + HOUR;
      if (time < start || time >= end || (time - start) % step !== 0 || i - segmentStart < 23) continue;
      const quoteVolume = quotePrefix[i + 1] - quotePrefix[i + 1 - 24];
      if (quoteVolume <= 0) continue;
      const frame = frames[(time - start) / step];
      frame.eligibleSymbols++;
      const weekIndex = byTime.get(weekStart(c[0]));
      const meanVolume = (volumes[i] - volumes[i - 20]) / 20;
      const ready = i - segmentStart >= 99;
      const peak = Math.max(...deas.slice(Math.max(segmentStart, i - 99), i + 1));
      const observation: Observation = {
        symbol, rank: 0, index: i, time,
        dayChange: (c[4] / bars[i + 1 - 24][1] - 1) * 100,
        quoteVolume,
        weekChange: weekIndex == null ? null : (c[4] / bars[weekIndex][1] - 1) * 100,
        bearish: ready && fast - slow < dea,
        freshCross: ready && previousDif >= previousDea && fast - slow < dea,
        deaPeakRatio: dea > 0 && peak > 0 ? dea / peak : 0,
        streak, volumeRatio: meanVolume > 0 ? c[5] / meanVolume : 0,
        change5h: (c[4] / bars[i - 5][4] - 1) * 100,
        breaksLow: c[4] < Math.min(...bars.slice(i - 5, i).map((b) => b[3])),
      };
      for (const board of BOARDS) {
        const rows = frame.boards[board];
        rows.push({ ...observation });
        rows.sort((a, b) => (board === "volume" ? b.quoteVolume - a.quoteVolume : board === "gainers" ? b.dayChange - a.dayChange : a.dayChange - b.dayChange) || a.symbol.localeCompare(b.symbol));
        if (rows.length > topN) rows.pop();
      }
    }
  }
  for (const frame of frames) for (const board of BOARDS) frame.boards[board].forEach((o, i) => { o.rank = i + 1; });
  return frames;
}

export function matches(o: Observation, board: Board, p: Parameters): boolean {
  if (!o.bearish || o.streak < p.minStreak || o.volumeRatio < p.volumeRatio) return false;
  if (p.weekFilter && (o.weekChange == null || (board === "gainers" ? o.weekChange <= 0 : o.weekChange >= 0))) return false;
  if (board === "gainers") return o.dayChange > 0 && o.dayChange >= p.dayMovePercent && o.freshCross && o.deaPeakRatio >= p.highRatio;
  if (board === "losers") return o.dayChange < 0 && o.dayChange <= -p.dayMovePercent && o.breaksLow && o.change5h < 0;
  return o.quoteVolume >= 1e8 && o.change5h < 0;
}

export function shortReturn(entry: number, exit: number, costBpsPerSide: number) {
  const grossPercent = (entry - exit) / entry * 100;
  return { grossPercent, netPercent: grossPercent - costBpsPerSide / 100 * (1 + exit / entry) };
}

export function summarize(trades: readonly Pick<Trade, "exitTime" | "netPercent">[], missing = 0, purged = 0): Metrics {
  let sum = 0, peak = 0, drawdown = 0, profit = 0, loss = 0;
  const atExit = new Map<number, number>();
  for (const t of trades) {
    atExit.set(t.exitTime, (atExit.get(t.exitTime) ?? 0) + t.netPercent);
    if (t.netPercent > 0) profit += t.netPercent;
    else loss -= t.netPercent;
  }
  for (const [, result] of [...atExit].sort(([a], [b]) => a - b)) {
    sum += result; peak = Math.max(peak, sum); drawdown = Math.max(drawdown, peak - sum);
  }
  const wins = trades.filter((t) => t.netPercent > 0).length;
  return {
    trades: trades.length, missing, purged, wins,
    winRate: trades.length ? wins / trades.length * 100 : null,
    meanNetPercent: trades.length ? sum / trades.length : null,
    sumNetPercent: sum, profitFactor: loss > 0 ? profit / loss : null, lossPercent: loss,
    worstTradePercent: trades.length ? trades.reduce((worst, t) => Math.min(worst, t.netPercent), Infinity) : null,
    maxDrawdownPoints: drawdown,
  };
}

export function backtest(dataset: Dataset, frames: Frame[], board: Board, parameters: Parameters,
  start: number, end: number, costBpsPerSide: number): { metrics: Metrics; trades: Trade[] } {
  const trades: Trade[] = [];
  const available = new Map<string, number>();
  let missing = 0, purged = 0;
  for (const frame of frames) {
    if (frame.time < start || frame.time >= end) continue;
    for (const o of frame.boards[board]) {
      if (!matches(o, board, parameters) || (available.get(o.symbol) ?? 0) > frame.time) continue;
      const deadline = frame.time + parameters.holdHours * HOUR;
      // Purge by maximum holding period BEFORE examining exits: no split-boundary leakage.
      if (deadline > end) { purged++; continue; }
      const bars = dataset.candles.get(o.symbol)!;
      const first = bars[o.index + 1];
      available.set(o.symbol, deadline);
      if (!first || first[0] !== frame.time) { missing++; continue; }
      const entryPrice = first[1];
      const stop = parameters.stopLossPercent > 0 ? entryPrice * (1 + parameters.stopLossPercent / 100) : Infinity;
      const target = parameters.takeProfitPercent > 0 ? entryPrice * (1 - parameters.takeProfitPercent / 100) : -Infinity;
      for (let minute = 0; minute < parameters.holdHours; minute++) {
        const c = bars[o.index + 1 + minute];
        if (!c || c[0] !== frame.time + minute * HOUR) { missing++; break; }
        let exitPrice: number | null = null;
        let reason: Trade["reason"] = "timeout";
        // Opening gaps happen first. If both intrabar limits touch, assume stop first.
        if (c[1] >= stop) { exitPrice = c[1]; reason = "stop"; }
        else if (c[1] <= target) { exitPrice = c[1]; reason = "target"; }
        else if (c[2] >= stop) { exitPrice = stop; reason = "stop"; }
        else if (c[3] <= target) { exitPrice = target; reason = "target"; }
        else if (minute === parameters.holdHours - 1) exitPrice = c[4];
        if (exitPrice != null) {
          const exitTime = c[0] + HOUR;
          available.set(o.symbol, exitTime);
          trades.push({ board, symbol: o.symbol, rank: o.rank,
            signalTime: frame.time - HOUR, entryTime: frame.time, exitTime, entryPrice, exitPrice, reason,
            ...shortReturn(entryPrice, exitPrice, costBpsPerSide), observation: o });
          break;
        }
      }
    }
  }
  return { metrics: summarize(trades, missing, purged), trades };
}
