import path from "node:path";
import { loadDataset } from "../research/data.ts";
import { buildFrames } from "../research/backtest.ts";
import { loadAllMinutes, simulateStrategyOnPeriod, buildMinuteFramesMap } from "../scripts/mine-strategy.ts";
import {
  streakPreset, hourlyPreset, deepReboundPreset, reboundPreset, wBottomPreset
} from "../src/strategy-presets.ts";
import type { Candle } from "../src/macd.ts";

function normalizeToCandles(rawBars: any[]): Candle[] {
  return rawBars.filter(b => b && typeof b === "object").map(b => {
    const values = Array.isArray(b) ? b : [b.time, b.open, b.high, b.low, b.close, b.volume];
    return { time: Number(values[0]), open: Number(values[1]), high: Number(values[2]), low: Number(values[3]), close: Number(values[4]), volume: Number(values[5] ?? 0) };
  });
}

async function testPresets() {
  const hourly = await loadDataset(path.resolve("data/research/hourly-168h"));
  const frames = buildFrames(hourly, 30, 1);
  const { dataset: minuteData } = await loadAllMinutes();
  const candlesMap = new Map<string, Candle[]>();
  for (const [sym, rawBars] of minuteData.candles) {
    candlesMap.set(sym, normalizeToCandles(rawBars));
  }
  const allTimeSet = new Set<number>();
  for (const [sym, list] of candlesMap) {
    for (const b of list) allTimeSet.add(b.time);
  }
  const allTimesSorted = Array.from(allTimeSet).sort((a, b) => a - b);
  const framesMap = buildMinuteFramesMap(frames, candlesMap, allTimesSorted);

  const timeIndices = new Map<string, Map<number, number>>();
  for (const [sym, list] of candlesMap) {
    const tMap = new Map<number, number>();
    for (let idx = 0; idx < list.length; idx++) {
      tMap.set(list[idx].time, idx);
    }
    timeIndices.set(sym, tMap);
  }

  const duration = allTimesSorted.at(-1)! - allTimesSorted[0];
  const trainEnd = allTimesSorted[0] + Math.floor(duration * 0.60);
  const trainRange = { start: allTimesSorted[0], end: trainEnd };

  const presets = [
    streakPreset(),
    hourlyPreset(),
    deepReboundPreset(),
    reboundPreset(),
    wBottomPreset(),
  ];

  for (const p of presets) {
    const res = await simulateStrategyOnPeriod(candlesMap, timeIndices, allTimesSorted, framesMap, p as any, trainRange);
    console.log(`[PRESET] ${p.label} (${p.side}): trades=${res.metrics.trades}, winRate=${res.metrics.winRate.toFixed(1)}%, PF=${Number.isFinite(res.metrics.pf) ? res.metrics.pf.toFixed(2) : "inf"}, Net=${res.metrics.totalNet.toFixed(1)}%`);
  }
}

testPresets().catch(console.error);
