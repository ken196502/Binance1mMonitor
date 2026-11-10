import path from "node:path";
import { loadDataset } from "../research/data.ts";
import { buildFrames } from "../research/backtest.ts";
import { loadAllMinutes, simulateStrategyOnPeriod, buildMinuteFramesMap } from "../scripts/mine-strategy.ts";
import type { Candle } from "../src/macd.ts";

function normalizeToCandles(rawBars: any[]): Candle[] {
  return rawBars.filter(b => b && typeof b === "object").map(b => {
    const values = Array.isArray(b) ? b : [b.time, b.open, b.high, b.low, b.close, b.volume];
    return { time: Number(values[0]), open: Number(values[1]), high: Number(values[2]), low: Number(values[3]), close: Number(values[4]), volume: Number(values[5] ?? 0) };
  });
}

async function testExits() {
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

  // Test SHORT with various combinations of TP/SL/Hold and stricter conditions
  const shortConfigs = [
    // 1. Tighter TP1 (1.5%), SL (2.5%), Hold 30m
    {
      id: "short_tight_tp",
      side: "SHORT" as const,
      intervalWindow: 15,
      ampDivisor: 8,
      maRequirement: "MA20_RESIST",
      macdRequirement: "HIST_WEAKENING",
      candleRequirement: "UPPER_SHADOW_PINBAR",
      holdMinutes: 30,
      tp1Percent: 1.5,
      tp2Percent: 3.5,
      stopLossPercent: 2.5,
      cooldownMinutes: 20,
      topN: 10,
      minDayChange: 10,
    },
    // 2. MA10_CLOSE_BELOW + DIF_HIGH_LEVEL + UPPER_SHADOW_PINBAR, TP 1.5%, SL 2.0%
    {
      id: "short_ma10cb_difhigh",
      side: "SHORT" as const,
      intervalWindow: 15,
      ampDivisor: 8,
      maRequirement: "MA10_CLOSE_BELOW",
      macdRequirement: "DIF_HIGH_LEVEL",
      candleRequirement: "UPPER_SHADOW_PINBAR",
      holdMinutes: 30,
      tp1Percent: 1.5,
      tp2Percent: 3.5,
      stopLossPercent: 2.0,
      cooldownMinutes: 20,
      topN: 10,
      minDayChange: 10,
    },
    // 3. MA_BEARISH_STACK + DEATH_CROSS_RECENT + BEARISH_BAR
    {
      id: "short_bear_stack",
      side: "SHORT" as const,
      intervalWindow: 15,
      ampDivisor: 8,
      maRequirement: "MA_BEARISH_STACK",
      macdRequirement: "DEATH_CROSS_RECENT",
      candleRequirement: "BEARISH_BAR",
      holdMinutes: 30,
      tp1Percent: 1.5,
      tp2Percent: 3.5,
      stopLossPercent: 2.0,
      cooldownMinutes: 20,
      topN: 10,
      minDayChange: 10,
    },
    // 4. MA60_RESIST + HIST_WEAKENING + UPPER_SHADOW_PINBAR
    {
      id: "short_ma60_resist",
      side: "SHORT" as const,
      intervalWindow: 15,
      ampDivisor: 8,
      maRequirement: "MA60_RESIST",
      macdRequirement: "HIST_WEAKENING",
      candleRequirement: "UPPER_SHADOW_PINBAR",
      holdMinutes: 30,
      tp1Percent: 2.0,
      tp2Percent: 4.0,
      stopLossPercent: 2.5,
      cooldownMinutes: 20,
      topN: 10,
      minDayChange: 10,
    },
    // 5. LONG: MA_BULLISH_STACK + HIST_EXPANDING + BULLISH_BAR
    {
      id: "long_bull_stack",
      side: "LONG" as const,
      intervalWindow: 15,
      ampDivisor: 8,
      maRequirement: "MA_BULLISH_STACK",
      macdRequirement: "HIST_EXPANDING",
      candleRequirement: "BULLISH_BAR",
      holdMinutes: 30,
      tp1Percent: 2.0,
      tp2Percent: 4.0,
      stopLossPercent: 2.5,
      cooldownMinutes: 20,
      topN: 10,
      minDayChange: 10,
    },
    // 6. LONG: MA10_SUPPORT + DIF_LOW_LEVEL + LOWER_SHADOW_HAMMER, hold 30m, TP 2.0%, SL 2.0%
    {
      id: "long_ma10_hammer",
      side: "LONG" as const,
      intervalWindow: 15,
      ampDivisor: 8,
      maRequirement: "MA10_SUPPORT",
      macdRequirement: "DIF_LOW_LEVEL",
      candleRequirement: "LOWER_SHADOW_HAMMER",
      holdMinutes: 30,
      tp1Percent: 2.0,
      tp2Percent: 4.0,
      stopLossPercent: 2.0,
      cooldownMinutes: 20,
      topN: 10,
      minDayChange: 10,
    },
  ];

  for (const c of shortConfigs) {
    const res = await simulateStrategyOnPeriod(candlesMap, timeIndices, allTimesSorted, framesMap, c, trainRange);
    console.log(`[TEST] ${c.id}: trades=${res.metrics.trades}, winRate=${res.metrics.winRate.toFixed(1)}%, PF=${Number.isFinite(res.metrics.pf) ? res.metrics.pf.toFixed(2) : "inf"}, Net=${res.metrics.totalNet.toFixed(1)}%`);
  }
}

testExits().catch(console.error);
