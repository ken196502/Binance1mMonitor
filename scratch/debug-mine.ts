import path from "node:path";
import { loadDataset } from "../research/data.ts";
import { buildFrames } from "../research/backtest.ts";
import { loadAllMinutes, simulateStrategyOnPeriod, buildMinuteFramesMap } from "../scripts/mine-strategy.ts";
import type { Candle } from "../src/macd.ts";
import { compileFeatureSpec, evaluateRules } from "../src/strategy-rules.ts";
import { computeFeatureVector } from "../src/features.ts";

function normalizeToCandles(rawBars: any[]): Candle[] {
  return rawBars.filter(b => b && typeof b === "object").map(b => {
    const values = Array.isArray(b) ? b : [b.time, b.open, b.high, b.low, b.close, b.volume];
    return { time: Number(values[0]), open: Number(values[1]), high: Number(values[2]), low: Number(values[3]), close: Number(values[4]), volume: Number(values[5] ?? 0) };
  });
}

async function test() {
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

  console.log("Total sorted times:", allTimesSorted.length);
  console.log("Start time:", new Date(allTimesSorted[0]).toISOString());
  console.log("End time:", new Date(allTimesSorted.at(-1)!).toISOString());

  // Test SHORT candidates with various candle requirements
  const specBase = {
    side: "SHORT" as const,
    intervalWindow: 15,
    ampDivisor: 8,
    maRequirement: "MA10_CLOSE_BELOW",
    macdRequirement: "DIF_HIGH_LEVEL",
    candleRequirement: "NONE",
    holdMinutes: 15,
    tp1Percent: 2.5,
    tp2Percent: 5.0,
    stopLossPercent: 3.5,
    cooldownMinutes: 20,
    topN: 10,
    minDayChange: 10,
  };

  const duration = allTimesSorted.at(-1)! - allTimesSorted[0];
  const trainEnd = allTimesSorted[0] + Math.floor(duration * 0.60);
  const trainRange = { start: allTimesSorted[0], end: trainEnd };

  const timeIndices = new Map<string, Map<number, number>>();
  for (const [sym, list] of candlesMap) {
    const tMap = new Map<number, number>();
    for (let idx = 0; idx < list.length; idx++) {
      tMap.set(list[idx].time, idx);
    }
    timeIndices.set(sym, tMap);
  }

  // Let's test different combinations
  const maOptions = ["MA10_BREAKDOWN", "MA20_BREAKDOWN", "MA20_RESIST", "MA10_CLOSE_BELOW"];
  const macdOptions = ["DIF_HIGH_LEVEL", "HIST_WEAKENING", "DEATH_CROSS_RECENT"];
  const candleOptions = ["UPPER_SHADOW_PINBAR", "BEARISH_BAR", "NONE"];

  for (const ma of maOptions) {
    for (const macd of macdOptions) {
      for (const candle of candleOptions) {
        const cand = { ...specBase, id: `test_${ma}_${macd}_${candle}`, maRequirement: ma, macdRequirement: macd, candleRequirement: candle };
        const res = await simulateStrategyOnPeriod(candlesMap, timeIndices, allTimesSorted, framesMap, cand, trainRange);
        console.log(`[CHECK] ${ma} | ${macd} | ${candle}: trades=${res.metrics.trades}, winRate=${res.metrics.winRate.toFixed(1)}%, PF=${Number.isFinite(res.metrics.pf) ? res.metrics.pf.toFixed(2) : "inf"}, Net=${res.metrics.totalNet.toFixed(1)}%`);
      }
    }
  }
}

test().catch(console.error);
