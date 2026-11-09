#!/usr/bin/env tsx
/**
 * 行情归档 → 前置特征统计 → 多空形态参数挖掘 → 共用二阶段组合回测。
 * 输出带特征版本、数据内容哈希及验证/留出结果的可远程应用参数。
 */

import path from "node:path";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { loadDataset } from "../research/data.ts";
import { buildFrames } from "../research/backtest.ts";
import type { Frame } from "../research/types.ts";
import type { MinuteDataset } from "../research/gainers-types.ts";
import { wilsonInterval } from "../research/peak-rebound-backtest.ts";
import {
  computeFeatureVector,
  evaluateFeatureSpec,
  FEATURE_VERSION,
  type FeatureVector,
  type KlineStatsStrategySpec,
} from "../src/features.ts";
import { type Candle } from "../src/macd.ts";
import type { Ticker24h } from "../src/binance.ts";
import type { KlineStatsStrategyLiveConfig } from "../src/types.ts";
import type { PaperStrategyConfig } from "../src/paper-trading.ts";

import { replayStrategies } from "../research/strategy-replay.ts";
export { calcTradeReturn } from "../src/trading-core.ts";
import { sendTelegramMessage, telegramConfigured, escapeHtml } from "../src/telegram.ts";

const MINUTE = 60_000;

/** Merge archived arrays and live JSONL by symbol/time; later sources override overlaps. */
export async function loadAllMinutes(dirs = [
  path.resolve("data/research/peak-rebound-1m-168h"),
  path.resolve("data/research/staged-1m-20261020-20261023"),
  path.resolve("data/research/live-1m"),
]): Promise<{ dataset: MinuteDataset; datasetHash: string }> {
  const merged = new Map<string, Map<number, Candle>>();
  for (const dir of dirs) {
    let files: string[];
    try { files = (await readdir(dir)).sort(); } catch (error: any) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const file of files) {
      if (!/\.json(?:l|\.gz)?$/.test(file)) continue;
      const symbol = file.replace(/\.json(?:l|\.gz)?$/, "").split("-")[0];
      if (!/^[A-Z0-9]+$/.test(symbol)) continue;
      const bytes = await readFile(path.join(dir, file));
      const contents = file.endsWith(".gz") ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
      let raw: any[];
      if (file.endsWith(".jsonl")) {
        const lines = contents.split("\n");
        raw = [];
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          try { raw.push(JSON.parse(lines[i])); } catch (error) {
            // The live writer may be appending the final line as we read it.
            if (i !== lines.length - 1) throw new Error(`损坏的行情文件 ${file}:${i + 1}`);
          }
        }
      } else {
        raw = JSON.parse(contents);
      }
      if (!Array.isArray(raw)) continue;
      const byTime = merged.get(symbol) ?? new Map<number, Candle>();
      for (const bar of normalizeToCandles(raw)) {
        if (![bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)) continue;
        if (bar.time <= 0 || Math.min(bar.open, bar.low, bar.close) <= 0 || bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close)) continue;
        byTime.set(bar.time, bar);
      }
      if (byTime.size) merged.set(symbol, byTime);
    }
  }
  const candles: MinuteDataset["candles"] = new Map();
  const hash = createHash("sha256");
  for (const symbol of [...merged.keys()].sort()) {
    const list = [...merged.get(symbol)!.values()].sort((a, b) => a.time - b.time);
    const rows: import("../research/types.ts").Bar[] = list.map(b => [b.time, b.open, b.high, b.low, b.close, b.volume, 0]);
    candles.set(symbol, rows);
    hash.update(symbol + JSON.stringify(rows));
  }
  return {
    dataset: { manifest: { version: 1, interval: "1m", source: "Binance", fetchedAt: new Date().toISOString(), plan: {} as any, files: {} }, candles },
    datasetHash: hash.digest("hex").slice(0, 16),
  };
}

export interface MiningStrategyCandidate extends KlineStatsStrategySpec {
  id: string;
  name: string;
  side: "LONG" | "SHORT";
  intervalWindow: number;
  ampDivisor: number;
  maRequirement: string;
  macdRequirement: string;
  holdMinutes: number;
  tp1Percent: number;
  tp2Percent: number;
  stopLossPercent: number;
  cooldownMinutes?: number;
  topN?: number;
  minDayChange?: number;
}

export interface TradeRecord {
  symbol: string;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  netPercent: number;
  isWin: boolean;
  reason: string;
  st1Done: boolean;
}

export interface StrategyPeriodMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  pf: number;
  totalNet: number;
  avgNet: number;
  tp1Hits: number;
  tp2Hits: number;
  slHits: number;
  timeouts: number;
  maxDrawdown: number;
  wilsonLow: number;
  expectedReturnLowerBound: number;
}

export interface ComprehensiveStrategyResult {
  candidate: MiningStrategyCandidate;
  trainMetrics: StrategyPeriodMetrics;
  valMetrics: StrategyPeriodMetrics;
  holdoutMetrics: StrategyPeriodMetrics;
  walkForwardMetrics: {
    folds: Array<{ fold: number; trades: number; winRate: number; pf: number; netPercent: number }>;
    positiveFolds: number;
    totalFolds: number;
  };
  neighborScore: number;
  compositeScore: number;
  meetsDeploymentThreshold: boolean;
}

/**
 * 将原始 K 线数组规范化转换为 Candle[]
 */
function normalizeToCandles(rawBars: any[]): Candle[] {
  return rawBars.filter(b => b && typeof b === "object").map(b => {
    const values = Array.isArray(b) ? b : [b.time, b.open, b.high, b.low, b.close, b.volume];
    return { time: Number(values[0]), open: Number(values[1]), high: Number(values[2]), low: Number(values[3]), close: Number(values[4]), volume: Number(values[5] ?? 0) };
  });
}

/**
 * 核心单策略周期回测引擎 (D6 撮合保守化 + D7 参数透传 + D8 统计修复)
 */
export async function simulateStrategyOnPeriod(
  candlesMap: Map<string, Candle[]>,
  timeIndices: Map<string, Map<number, number>>,
  allTimesSorted: number[],
  framesMap: Map<number, Map<string, { rank: number; dayChange: number; high24h?: number; low24h?: number }>>,
  strategy: MiningStrategyCandidate,
  timeRange: { start: number; end: number },
  options: { intrabarMode?: "conservative" | "optimistic"; fvCache?: Map<string, FeatureVector | null> } = {}
): Promise<{ metrics: StrategyPeriodMetrics; trades: TradeRecord[] }> {
  const result = replayStrategies(candlesMap, timeIndices, allTimesSorted, framesMap, [strategy], timeRange, options);
  const closedTrades = result.trades;

  // D8 统计指标结算与修正
  const totalTrades = closedTrades.length;
  const wins = closedTrades.filter((t) => t.isWin).length;
  const losses = totalTrades - wins;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

  const totalGain = closedTrades
    .filter((t) => t.netPercent > 0)
    .reduce((s, t) => s + t.netPercent, 0);
  const totalLoss = Math.abs(
    closedTrades
      .filter((t) => t.netPercent < 0)
      .reduce((s, t) => s + t.netPercent, 0)
  );

  const pf = totalLoss > 0 ? totalGain / totalLoss : totalGain > 0 ? Infinity : 0;
  const totalNet = closedTrades.reduce((s, t) => s + t.netPercent, 0);
  const avgNet = totalTrades > 0 ? totalNet / totalTrades : 0;

  let peak = 0;
  let maxDrawdown = 0;
  let cum = 0;
  for (const t of closedTrades) {
    cum += t.netPercent;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const ci = wilsonInterval(wins, totalTrades);
  const wilsonLow = ci ? ci[0] : 0;

  // 置信区间下界作为期望收益估计
  const variance =
    totalTrades > 1
      ? closedTrades.reduce((s, t) => s + Math.pow(t.netPercent - avgNet, 2), 0) / (totalTrades - 1)
      : 0;
  const std = Math.sqrt(variance);
  const expectedReturnLowerBound =
    totalTrades > 0 ? avgNet - 1.96 * (std / Math.sqrt(totalTrades)) : -999;

  // D8: tp1Hits 统计所有达成 TP1 的笔数
  const tp1Hits = closedTrades.filter((t) => t.st1Done || t.reason === "TP2").length;
  const tp2Hits = closedTrades.filter((t) => t.reason === "TP2").length;
  const slHits = closedTrades.filter((t) => t.reason === "SL").length;
  const timeouts = closedTrades.filter((t) => t.reason.includes("TIMEOUT")).length;

  return {
    metrics: {
      trades: totalTrades,
      wins,
      losses,
      winRate,
      pf,
      totalNet,
      avgNet,
      tp1Hits,
      tp2Hits,
      slHits,
      timeouts,
      maxDrawdown,
      wilsonLow,
      expectedReturnLowerBound,
    },
    trades: closedTrades,
  };
}

/**
 * 3.2 组合模式：模拟全局 5 仓、单策略 1 仓并发回放
 */
export async function runPortfolioSimulation(
  candlesMap: Map<string, Candle[]>,
  timeIndices: Map<string, Map<number, number>>,
  allTimesSorted: number[],
  framesMap: Map<number, Map<string, { rank: number; dayChange: number; high24h?: number; low24h?: number }>>,
  strategies: MiningStrategyCandidate[],
  timeRange: { start: number; end: number },
  options: {
    maxPositions?: number;
    marginPercent?: number;
    leverage?: number;
  } = {}
) {
  return replayStrategies(candlesMap, timeIndices, allTimesSorted, framesMap, strategies, timeRange, options);
}

/**
 * D3: 构建逐分钟 24h 涨跌幅与榜单快照 (Minute-level rolling 24h rank & stats)
 * - 对拥有 1m 数据的币种，滚动 1440 根精准计算逐分钟 dayChange、high24h、low24h
 * - 对仅有 1h 数据的币种，沿用当时已知的小时快照，禁止使用未来小时插值
 * - 每分钟对全市场币种按最新 dayChange 降序排序，产出精准 rank <= topN
 */
export function buildMinuteFramesMap(
  hourlyFrames: Frame[],
  candlesMap: Map<string, Candle[]>,
  allTimesSorted: number[]
): Map<number, Map<string, { rank: number; dayChange: number; high24h?: number; low24h?: number }>> {
  const result = new Map<number, Map<string, { rank: number; dayChange: number; high24h?: number; low24h?: number }>>();
  if (allTimesSorted.length === 0) return result;

  const DAY_MS = 24 * 60 * 60 * 1000;

  // 1. 预先计算 1m 币种的逐分钟 24h 统计 (dayChange, high24h, low24h)
  const minuteStats1m = new Map<string, { dayChange: number; high24h: number; low24h: number }>();

  for (const [sym, bars] of candlesMap.entries()) {
    if (bars.length === 0) continue;

    let left = 0;
    const maxDeque: number[] = [];
    const minDeque: number[] = [];

    for (let i = 0; i < bars.length; i++) {
      const curBar = bars[i];
      const curTime = curBar.time;
      const targetPastTime = curTime + MINUTE - DAY_MS;

      while (left < i && bars[left].time < targetPastTime) {
        left++;
      }

      while (maxDeque.length > 0 && maxDeque[0] < left) {
        maxDeque.shift();
      }
      while (maxDeque.length > 0 && bars[maxDeque[maxDeque.length - 1]].high <= curBar.high) {
        maxDeque.pop();
      }
      maxDeque.push(i);

      while (minDeque.length > 0 && minDeque[0] < left) {
        minDeque.shift();
      }
      while (minDeque.length > 0 && bars[minDeque[minDeque.length - 1]].low >= curBar.low) {
        minDeque.pop();
      }
      minDeque.push(i);

      const baseBar = bars[left];
      const basePrice = baseBar.open > 0 ? baseBar.open : baseBar.close;
      const dayChange = basePrice > 0 ? ((curBar.close - basePrice) / basePrice) * 100 : 0;
      const high24h = bars[maxDeque[0]].high;
      const low24h = bars[minDeque[0]].low;

      if (curTime + MINUTE - bars[0].time >= DAY_MS) {
        minuteStats1m.set(`${sym}:${curTime + MINUTE}`, { dayChange, high24h, low24h });
      }
    }
  }

  // 2. 建立小时帧快速索引
  const hourlyTimeMap = new Map<number, Frame>();
  for (const f of hourlyFrames) {
    hourlyTimeMap.set(f.time, f);
  }
  const hourlyTimes = Array.from(hourlyTimeMap.keys()).sort((a, b) => a - b);

  // 3. 逐分钟构建全市场快照
  let hIdx = 0;
  for (const nowTime of allTimesSorted) {
    while (hIdx < hourlyTimes.length - 1 && hourlyTimes[hIdx + 1] <= nowTime) {
      hIdx++;
    }
    const hPrevTime = hourlyTimes[hIdx] ?? 0;
    const hPrevFrame = hPrevTime <= nowTime ? hourlyTimeMap.get(hPrevTime) : undefined;

    const symbolScores: Array<{
      symbol: string;
      dayChange: number;
      high24h?: number;
      low24h?: number;
    }> = [];

    const seenSymbols = new Set<string>();

    for (const sym of candlesMap.keys()) {
      const stat = minuteStats1m.get(`${sym}:${nowTime}`);
      if (stat) {
        seenSymbols.add(sym);
        symbolScores.push({
          symbol: sym,
          dayChange: stat.dayChange,
          high24h: stat.high24h,
          low24h: stat.low24h,
        });
      }
    }

    if (hPrevFrame) {
      for (const g of hPrevFrame.boards.gainers) {
        if (seenSymbols.has(g.symbol)) continue;
        symbolScores.push({ symbol: g.symbol, dayChange: g.dayChange });
        seenSymbols.add(g.symbol);
      }
    }

    symbolScores.sort((a, b) => b.dayChange - a.dayChange);

    const boardMap = new Map<string, { rank: number; dayChange: number; high24h?: number; low24h?: number }>();
    const topLimit = Math.min(symbolScores.length, 30);
    for (let r = 0; r < topLimit; r++) {
      const item = symbolScores[r];
      boardMap.set(item.symbol, {
        rank: r + 1,
        dayChange: item.dayChange,
        high24h: item.high24h,
        low24h: item.low24h,
      });
    }

    result.set(nowTime, boardMap);
  }

  return result;
}

export interface PrecursorStatsResult {
  totalSurgeEvents: number;
  totalDropEvents: number;
  longPrecursors: {
    ma10SupportPct: number;
    ma20SupportPct: number;
    ma60SupportPct: number;
    bullStackPct: number;
    freshBullPct: number;       // 刚成多头起爆占比 (近3根刚刚交叉发散)
    sustainedBullPct: number;   // 持续3根稳固多头占比
    greenRatioMedian: number;
    greenRatioP75: number;
    greenRatioMean: number;
    goldenCrossPct: number;
    preAmpMedian: number;
  };
  shortPrecursors: {
    ma60ResistPct: number;
    ma20ResistPct: number;
    ma10BreakdownPct: number;
    bearStackPct: number;
    freshBearPct: number;       // 刚成空头破位占比 (近3根刚刚死叉破位)
    sustainedBearPct: number;   // 持续3根弱势空头占比
    histWeakeningPct: number;
    topDivergencePct: number;
    greenRatioMedian: number;
    priorSurgeAmpMedian: number;
  };
}

/**
 * 阶段 0: 前兆特征分布统计与客观规律挖掘 (无未来函数因果提取)
 *
 * 核心逻辑:
 * 1. 扫描历史行情，提取走出“达标大振幅 (>= 24h / 10)”的事件样本
 * 2. 对每一个达标样本，回溯统计其【启动前一段区间 (Precursor Window)】的客观特征：
 *    - 前区间 MA 支撑状态 (MA10/20/60 支撑比例)
 *    - 前区间均线排列 (多头/空头排列占比)
 *    - 前区间 MACD 绿柱比例分布 (25分位数, 中位数, 75分位数, 均值)
 *    - 前区间 MACD 金叉/死叉状态
 *    - 前区间 蓄势振幅分布 (是否处于低波动整理)
 */
export function minePrecursorFeatureDistributions(
  candlesMap: Map<string, Candle[]>,
  timeIndices: Map<string, Map<number, number>>,
  allTimesSorted: number[],
  framesMap: Map<number, Map<string, { rank: number; dayChange: number; high24h?: number; low24h?: number }>>,
  timeRange: { start: number; end: number },
  windowMinutes = 15,
  ampDivisor = 10,
): PrecursorStatsResult {
  const longSamples: Array<{
    ma10Support: boolean;
    ma20Support: boolean;
    ma60Support: boolean;
    bullStack: boolean;
    freshBull: boolean;
    sustainedBull: boolean;
    greenRatio: number;
    goldenCross: boolean;
    preAmp: number;
    forwardSurge: number;
  }> = [];

  const shortSamples: Array<{
    ma60Resist: boolean;
    ma20Resist: boolean;
    ma10Breakdown: boolean;
    bearStack: boolean;
    freshBear: boolean;
    sustainedBear: boolean;
    histWeakening: boolean;
    topDivergence: boolean;
    greenRatio: number;
    priorSurgeAmp: number;
    forwardDrop: number;
  }> = [];

  // 遍历训练集时间点进行抽样检测
  for (let tIdx = 0; tIdx < allTimesSorted.length; tIdx += 3) {
    const nowTime = allTimesSorted[tIdx];
    if (nowTime < timeRange.start) continue;
    if (nowTime > timeRange.end) break;

    const board = framesMap.get(nowTime);
    if (!board) continue;

    for (const [sym, boardInfo] of board) {
      if (boardInfo.rank > 10 || boardInfo.dayChange < 10) continue;

      const candleList = candlesMap.get(sym);
      const tMap = timeIndices.get(sym);
      if (!candleList || !tMap) continue;
      const curIdx = tMap.get(nowTime);
      if (curIdx === undefined || curIdx < windowMinutes + 35 || curIdx >= candleList.length - windowMinutes) continue;

      const future = candleList.slice(curIdx, curIdx + windowMinutes);
      if (future.length !== windowMinutes || future.at(-1)!.time + MINUTE > timeRange.end) continue;
      const history = candleList.slice(curIdx - windowMinutes, curIdx);
      const combined = [...history, ...future];
      if (combined.some((bar, i) => i > 0 && bar.time - combined[i - 1].time !== MINUTE)) continue;
      const start = future[0].open;
      if (start <= 0) continue;
      const forwardSurge = Math.max(0, (Math.max(...future.map(b => b.high)) / start - 1) * 100);
      const forwardDrop = Math.max(0, (1 - Math.min(...future.map(b => b.low)) / start) * 100);
      const threshold = Math.abs(boardInfo.dayChange) / ampDivisor;
      const fv = computeFeatureVector(candleList, {
        symbol: sym, lastPrice: candleList[curIdx - 1].close, priceChangePercent: boardInfo.dayChange,
        quoteVolume: 0, highPrice: boardInfo.high24h, lowPrice: boardInfo.low24h,
      }, curIdx - 1, { rank: boardInfo.rank });
      if (!fv) continue;
      const low = Math.min(...history.map(b => b.low));
      const preAmp = low > 0 ? (Math.max(...history.map(b => b.high)) / low - 1) * 100 : 0;
      const greenRatio = fv.greenRatio[windowMinutes] ?? fv.greenRatio[15] ?? 0;
      if (forwardSurge >= threshold) {
        longSamples.push({
          ma10Support: fv.ma[10]?.support ?? false, ma20Support: fv.ma[20]?.support ?? false,
          ma60Support: fv.ma[60]?.support ?? false,
          bullStack: fv.stack === "bull_full" || fv.stack === "bull_short",
          freshBull: fv.stack3Bars === "fresh_bull", sustainedBull: fv.stack3Bars === "sustained_bull",
          greenRatio, goldenCross: fv.goldenCrossAgo <= 3, preAmp, forwardSurge,
        });
      }
      if (forwardDrop >= threshold) {
        shortSamples.push({
          ma60Resist: fv.ma[60]?.resist ?? false, ma20Resist: fv.ma[20]?.resist ?? false,
          ma10Breakdown: fv.ma[10]?.breakdown ?? false,
          bearStack: fv.stack === "bear_full" || fv.stack === "bear_short",
          freshBear: fv.stack3Bars === "fresh_bear", sustainedBear: fv.stack3Bars === "sustained_bear",
          histWeakening: fv.histSlope < 0 || fv.hist <= 0, topDivergence: fv.topDivergence === true,
          greenRatio, priorSurgeAmp: fv.surge[windowMinutes] ?? preAmp, forwardDrop,
        });
      }
    }
  }

  const calcMedian = (arr: number[]) => {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const calcP75 = (arr: number[]) => {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.75)];
  };
  const calcMean = (arr: number[]) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

  const lCount = Math.max(1, longSamples.length);
  const sCount = Math.max(1, shortSamples.length);

  const lGreen = longSamples.map((s) => s.greenRatio);
  const lAmp = longSamples.map((s) => s.preAmp);
  const sGreen = shortSamples.map((s) => s.greenRatio);
  const sSurge = shortSamples.map((s) => s.priorSurgeAmp);

  return {
    totalSurgeEvents: longSamples.length,
    totalDropEvents: shortSamples.length,
    longPrecursors: {
      ma10SupportPct: (longSamples.filter((s) => s.ma10Support).length / lCount) * 100,
      ma20SupportPct: (longSamples.filter((s) => s.ma20Support).length / lCount) * 100,
      ma60SupportPct: (longSamples.filter((s) => s.ma60Support).length / lCount) * 100,
      bullStackPct: (longSamples.filter((s) => s.bullStack).length / lCount) * 100,
      freshBullPct: (longSamples.filter((s) => s.freshBull).length / lCount) * 100,
      sustainedBullPct: (longSamples.filter((s) => s.sustainedBull).length / lCount) * 100,
      greenRatioMedian: calcMedian(lGreen) * 100,
      greenRatioP75: calcP75(lGreen) * 100,
      greenRatioMean: calcMean(lGreen) * 100,
      goldenCrossPct: (longSamples.filter((s) => s.goldenCross).length / lCount) * 100,
      preAmpMedian: calcMedian(lAmp),
    },
    shortPrecursors: {
      ma60ResistPct: (shortSamples.filter((s) => s.ma60Resist).length / sCount) * 100,
      ma20ResistPct: (shortSamples.filter((s) => s.ma20Resist).length / sCount) * 100,
      ma10BreakdownPct: (shortSamples.filter((s) => s.ma10Breakdown).length / sCount) * 100,
      bearStackPct: (shortSamples.filter((s) => s.bearStack).length / sCount) * 100,
      freshBearPct: (shortSamples.filter((s) => s.freshBear).length / sCount) * 100,
      sustainedBearPct: (shortSamples.filter((s) => s.sustainedBear).length / sCount) * 100,
      histWeakeningPct: (shortSamples.filter((s) => s.histWeakening).length / sCount) * 100,
      topDivergencePct: (shortSamples.filter((s) => s.topDivergence).length / sCount) * 100,
      greenRatioMedian: calcMedian(sGreen) * 100,
      priorSurgeAmpMedian: calcMedian(sSurge),
    },
  };
}

export async function main() {
  const isQuick = process.argv.includes("--quick");
  const isOptimistic = process.argv.includes("--intrabar=optimistic");
  const readPositive = (flag: string, fallback: number) => {
    const index = process.argv.indexOf(flag);
    const value = index < 0 ? fallback : Number(process.argv[index + 1]);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} 必须是正数`);
    return value;
  };
  const precursorWindow = readPositive("--window", 15);
  const precursorDivisor = readPositive("--divisor", 10);
  if (![3, 5, 10, 15, 30, 60].includes(precursorWindow)) throw new Error("--window 支持 3/5/10/15/30/60 分钟");

  const outputArgIdx = process.argv.indexOf("--output");
  const outputPath =
    outputArgIdx !== -1 && process.argv[outputArgIdx + 1]
      ? path.resolve(process.argv[outputArgIdx + 1])
      : path.resolve("data/mined-strategy.json");

  console.log("==================================================================");
  console.log(`🚀【24h 涨幅榜量化统计与特征挖掘系统 V2.0】${isQuick ? "(快速模式)" : "(完整多阶段验证模式)"}`);
  console.log(`⚙️ 撮合规则: ${isOptimistic ? "乐观撮合 (先 TP1 后 SL)" : "保守撮合 (先 SL 后 TP1，极端价成交)"}`);
  console.log("==================================================================");

  if (telegramConfigured()) {
    const msg = [
      `🧠 <b>[量化模型] 开始运行全量历史策略挖掘与参数训练</b>`,
      `• <b>运行模式</b>: ${isQuick ? "快速模式 (--quick)" : "完整多阶段验证模式"} (${isOptimistic ? "乐观撮合" : "保守撮合"})`,
      `• <b>前置窗口</b>: ${precursorWindow}m (振幅除数: ${precursorDivisor})`,
      `• <b>目标输出</b>: <code>${outputPath}</code>`,
      `• <b>开始时间</b>: ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })} (UTC+8)`,
    ].join("\n");
    await sendTelegramMessage(msg);
  }

  console.log("正在载入历史行情数据与 24h 榜单快照...");
  const hourly = await loadDataset(path.resolve("data/research/hourly-168h"));
  const frames = buildFrames(hourly, 30, 1);
  const { dataset: minuteData, datasetHash } = await loadAllMinutes();

  console.log(`✅ 行情数据载入完毕！覆盖币种: ${minuteData.candles.size}，小时帧数: ${frames.length}`);
  console.log(`🔑 数据集完整性哈希 (DatasetHash): ${datasetHash}`);

  // 规范化 K 线数据
  const candlesMap = new Map<string, Candle[]>();
  let minTime = Infinity;
  let maxTime = -Infinity;

  for (const [sym, rawBars] of minuteData.candles) {
    const list = normalizeToCandles(rawBars);
    candlesMap.set(sym, list);
    if (list.length > 0) {
      if (list[0].time < minTime) minTime = list[0].time;
      if (list[list.length - 1].time > maxTime) maxTime = list[list.length - 1].time;
    }
  }

  // 整理所有时间戳序列与时间索引
  const allTimeSet = new Set<number>();
  const timeIndices = new Map<string, Map<number, number>>();
  for (const [sym, list] of candlesMap) {
    const tMap = new Map<number, number>();
    for (let idx = 0; idx < list.length; idx++) {
      const t = list[idx].time;
      allTimeSet.add(t);
      tMap.set(t, idx);
    }
    timeIndices.set(sym, tMap);
  }
  const allTimesSorted = Array.from(allTimeSet).sort((a, b) => a - b);
  if (allTimesSorted.length === 0) throw new Error("没有可用于挖掘的 1m 行情数据");
  maxTime += MINUTE;

  // 构建逐分钟 24h 涨跌幅与榜单快照 (D3: 滚动 1440 根与逐分钟全市场排名)
  console.log("正在构建逐分钟 24h 涨跌幅与榜单快照 (D3: 滚动 1440 根与逐分钟全市场排名)...");
  const framesMap = buildMinuteFramesMap(frames, candlesMap, allTimesSorted);
  console.log(`✅ 逐分钟榜单快照构建完毕！覆盖 ${framesMap.size} 个分钟时序快照`);

  // 3.4 时间切分 (支持标准三段切分与 --val-recent 最新验证集模式)
  const isRecentVal = process.argv.includes("--val-recent");
  const duration = maxTime - minTime;
  let trainRange: { start: number; end: number };
  let valRange: { start: number; end: number };
  let holdoutRange: { start: number; end: number };

  if (isRecentVal) {
    // 聚焦最新时段模式：70% 历史用于训练，剩余 30% 平分为互不重叠的验证集与留出集 (不使用久远时段验证)
    const splitPoint = minTime + Math.floor(duration * 0.70);
    trainRange = { start: minTime, end: splitPoint };
    const holdoutStart = splitPoint + Math.floor((maxTime - splitPoint) * 0.5);
    valRange = { start: splitPoint, end: holdoutStart };
    holdoutRange = { start: holdoutStart, end: maxTime };
  } else {
    // 标准三段式：60% 训练集, 20% 验证集, 20% 留出集
    const trainEnd = minTime + Math.floor(duration * 0.60);
    const valEnd = minTime + Math.floor(duration * 0.80);
    trainRange = { start: minTime, end: trainEnd };
    valRange = { start: trainEnd, end: valEnd };
    holdoutRange = { start: valEnd, end: maxTime };
  }

  console.log(`\n📊 数据集时间序列切分 (${isRecentVal ? "聚焦最新时段验证模式 --val-recent" : "标准三段式切分"}):`);
  console.log(`  • 训练集 (${isRecentVal ? "70%" : "60%"}): ${new Date(trainRange.start).toISOString()} → ${new Date(trainRange.end).toISOString()}`);
  console.log(`  • 验证集 (${isRecentVal ? "中间15%" : "20%"}): ${new Date(valRange.start).toISOString()} → ${new Date(valRange.end).toISOString()}`);
  console.log(`  • 留出集 (${isRecentVal ? "最新15%" : "20%"}): ${new Date(holdoutRange.start).toISOString()} → ${new Date(holdoutRange.end).toISOString()}`);

  console.log("\n==================================================================");
  console.log("📊 阶段 0: 前兆特征分布统计与客观规律挖掘 (因果前驱特征提取)");
  console.log("==================================================================");
  console.log("正在扫描历史达标大振幅样本，并回溯统计其【启动前一段区间】的客观特征分布...");
  const precursorStats = minePrecursorFeatureDistributions(
    candlesMap,
    timeIndices,
    allTimesSorted,
    framesMap,
    trainRange,
    precursorWindow,
    precursorDivisor,
  );

  console.log(`\n【多头起爆前兆特征统计】(挖掘样本量: ${precursorStats.totalSurgeEvents} 个达标冲高段)`);
  console.log(`  • 前区间 MA20 支撑生效比例: ${precursorStats.longPrecursors.ma20SupportPct.toFixed(1)}%`);
  console.log(`  • 前区间 MA10 支撑生效比例: ${precursorStats.longPrecursors.ma10SupportPct.toFixed(1)}%`);
  console.log(`  • 前区间均线多头排列占比: ${precursorStats.longPrecursors.bullStackPct.toFixed(1)}%`);
  console.log(`  • 前区间【3根1mK动态比对】刚成多头起爆: ${precursorStats.longPrecursors.freshBullPct.toFixed(1)}% | 持续3根稳固多头: ${precursorStats.longPrecursors.sustainedBullPct.toFixed(1)}%`);
  console.log(`  • 前区间 MACD 绿柱比例: 均值 ${precursorStats.longPrecursors.greenRatioMean.toFixed(1)}% | 中位数 ${precursorStats.longPrecursors.greenRatioMedian.toFixed(1)}% | P75: ${precursorStats.longPrecursors.greenRatioP75.toFixed(1)}%`);
  console.log(`  • 前区间黄金交叉 (近3根): ${precursorStats.longPrecursors.goldenCrossPct.toFixed(1)}%`);
  console.log(`  • 前区间蓄势振幅 (低波整理): 中位数 ${precursorStats.longPrecursors.preAmpMedian.toFixed(2)}%`);

  console.log(`\n【空头冲高力竭前兆特征统计】(挖掘样本量: ${precursorStats.totalDropEvents} 个达标回撤段)`);
  console.log(`  • 冲高触碰 MA60 压制受阻: ${precursorStats.shortPrecursors.ma60ResistPct.toFixed(1)}%`);
  console.log(`  • 冲高触碰 MA20 压制受阻: ${precursorStats.shortPrecursors.ma20ResistPct.toFixed(1)}%`);
  console.log(`  • 冲高跌破 MA10 (破位): ${precursorStats.shortPrecursors.ma10BreakdownPct.toFixed(1)}%`);
  console.log(`  • 见顶【3根1mK动态比对】刚成空头破位: ${precursorStats.shortPrecursors.freshBearPct.toFixed(1)}% | 持续3根弱势空头: ${precursorStats.shortPrecursors.sustainedBearPct.toFixed(1)}%`);
  console.log(`  • 冲高柱体衰竭 (HistSlope < 0): ${precursorStats.shortPrecursors.histWeakeningPct.toFixed(1)}%`);
  console.log(`  • 冲高顶背离: ${precursorStats.shortPrecursors.topDivergencePct.toFixed(1)}%`);
  console.log(`  • 冲高段振幅中位数: ${precursorStats.shortPrecursors.priorSurgeAmpMedian.toFixed(2)}%`);
  console.log("==================================================================\n");

  // 4 个 Walk-Forward 滚动窗口 (Train 3d / Test 1d)
  const stepMs = Math.floor(duration / 5);
  const wfFolds: Array<{ trainRange: { start: number; end: number }; testRange: { start: number; end: number } }> = [];
  for (let f = 0; f < 4; f++) {
    const fStart = minTime + f * stepMs;
    const fTrainEnd = fStart + stepMs * 2;
    const fTestEnd = fTrainEnd + stepMs;
    if (fTestEnd <= maxTime) {
      wfFolds.push({
        trainRange: { start: fStart, end: fTrainEnd },
        testRange: { start: fTrainEnd, end: fTestEnd },
      });
    }
  }

  // 生成待挖掘的多头与空头策略候选集 (因果前驱分流: 多头蓄势起爆 / 空头冲高力竭)
  const candidates: MiningStrategyCandidate[] = [];

  const longWindows = isQuick ? [5] : [5, 10, 15];
  const longDivs = isQuick ? [6, 8] : [6, 8, 10];
  const longMaReqs = isQuick
    ? (["MA10_SUPPORT", "MA20_SUPPORT"] as const)
    : (["MA10_SUPPORT", "MA20_SUPPORT", "MA_BULLISH_STACK", "MA_FRESH_BULL", "MA10_BREAKOUT"] as const);
  const longMacdReqs = isQuick
    ? (["GREEN_RATIO_15_50", "GOLDEN_CROSS_RECENT", "HIST_EXPANDING"] as const)
    : (["GREEN_RATIO_15_50", "GREEN_RATIO_20_50", "GOLDEN_CROSS_RECENT", "TF5M_CONFIRM", "HIST_EXPANDING"] as const);
  const longHolds = isQuick ? [20, 30] : [15, 20, 30, 45];

  for (const window of longWindows) {
    for (const div of longDivs) {
      for (const maReq of longMaReqs) {
        for (const macdReq of longMacdReqs) {
          for (const hold of longHolds) {
            candidates.push({
              id: `LONG_W${window}_D${div}_${maReq}_${macdReq}_H${hold}`,
              name: `多头起爆: ${window}m蓄势(<24h/${div}) + ${maReq.replace("_", "")} + ${macdReq} + 持仓${hold}m`,
              side: "LONG",
              leverage: 3,
              intervalWindow: window,
              ampDivisor: div,
              maRequirement: maReq,
              macdRequirement: macdReq,
              holdMinutes: hold,
              tp1Percent: 2.5,
              tp2Percent: 5.0,
              stopLossPercent: 3.0,
              cooldownMinutes: 20,
              topN: 10,
              minDayChange: 10,
            });
          }
        }
      }
    }
  }

  const shortWindows = isQuick ? [3, 5] : [3, 5, 10];
  const shortDivs = isQuick ? [8, 10] : [8, 10, 12];
  const shortMaReqs = isQuick
    ? (["MA10_BREAKDOWN", "MA60_RESIST"] as const)
    : (["MA60_RESIST", "MA20_RESIST", "MA10_BREAKDOWN", "MA_BEARISH_STACK"] as const);
  const shortMacdReqs = isQuick
    ? (["GREEN_RATIO_30_80", "HIST_WEAKENING", "DEATH_CROSS_RECENT"] as const)
    : (["GREEN_RATIO_15_70", "GREEN_RATIO_30_80", "HIST_WEAKENING", "DEATH_CROSS_RECENT", "TF5M_CONFIRM", "TOP_DIVERGENCE"] as const);
  const shortHolds = isQuick ? [15, 25] : [15, 20, 30, 45];

  for (const window of shortWindows) {
    for (const div of shortDivs) {
      for (const maReq of shortMaReqs) {
        for (const macdReq of shortMacdReqs) {
          for (const hold of shortHolds) {
            candidates.push({
              id: `SHORT_W${window}_D${div}_${maReq}_${macdReq}_H${hold}`,
              name: `空头摸顶: ${window}m冲高(>=24h/${div}) + ${maReq.replace("_", "")} + ${macdReq} + 持仓${hold}m`,
              side: "SHORT",
              leverage: 3,
              intervalWindow: window,
              ampDivisor: div,
              maRequirement: maReq,
              macdRequirement: macdReq,
              holdMinutes: hold,
              tp1Percent: 2.5,
              tp2Percent: 5.0,
              stopLossPercent: 3.5,
              cooldownMinutes: 20,
              topN: 10,
              minDayChange: 10,
            });
          }
        }
      }
    }
  }

  console.log(`\n🔍 生成候选策略网格: ${candidates.length} 组组合`);
  console.log("🚀 阶段 1/3: 训练集初步筛选 (Train Set Filter)...");

  const minTrainTrades = isQuick ? 5 : 15;
  const minValTrades = isQuick ? 3 : 5;

  const fvCache = new Map<string, FeatureVector | null>();
  const trainQualified: Array<{ candidate: MiningStrategyCandidate; trainMetrics: StrategyPeriodMetrics }> = [];
  let evalCount = 0;

  for (const cand of candidates) {
    evalCount++;
    const res = await simulateStrategyOnPeriod(
      candlesMap,
      timeIndices,
      allTimesSorted,
      framesMap,
      cand,
      trainRange,
      { intrabarMode: isOptimistic ? "optimistic" : "conservative", fvCache }
    );
    if (res.metrics.trades >= minTrainTrades && res.metrics.winRate >= 50 && (res.metrics.pf >= 0.95 || !Number.isFinite(res.metrics.pf))) {
      trainQualified.push({ candidate: cand, trainMetrics: res.metrics });
    }
    if (evalCount % 50 === 0 || evalCount === candidates.length) {
      process.stdout.write(`训练集评估进度: ${evalCount}/${candidates.length}...\r`);
    }
  }

  console.log(`\n✅ 训练集初筛完成！入围候选策略数: ${trainQualified.length}/${candidates.length}`);

  // 阶段 2: 验证集评估、参数稳健性 (Neighbor Score) 与留出集测试
  console.log("\n🚀 阶段 2/3: 验证集、Walk-Forward 与留出测试集严格校验...");

  const comprehensiveResults: ComprehensiveStrategyResult[] = [];
  const valMetricsMap = new Map<string, StrategyPeriodMetrics>();

  // 先统一计算验证集指标
  for (const tq of trainQualified) {
    const valRes = await simulateStrategyOnPeriod(
      candlesMap,
      timeIndices,
      allTimesSorted,
      framesMap,
      tq.candidate,
      valRange,
      { intrabarMode: isOptimistic ? "optimistic" : "conservative", fvCache }
    );
    valMetricsMap.set(tq.candidate.id, valRes.metrics);
  }

  for (const tq of trainQualified) {
    const valMetrics = valMetricsMap.get(tq.candidate.id)!;
    if (valMetrics.trades < minValTrades) continue;

    // 参数稳健性计算 (邻域得分)
    const neighbors = trainQualified.filter(
      (other) =>
        other.candidate.side === tq.candidate.side &&
        Math.abs(other.candidate.intervalWindow - tq.candidate.intervalWindow) <= 2 &&
        Math.abs(other.candidate.ampDivisor - tq.candidate.ampDivisor) <= 2
    );

    let neighborSum = 0;
    let neighborCount = 0;
    for (const n of neighbors) {
      const nVal = valMetricsMap.get(n.candidate.id);
      if (nVal && nVal.trades > 0) {
        neighborSum += nVal.wilsonLow * (Number.isFinite(nVal.pf) ? nVal.pf : 3.0);
        neighborCount++;
      }
    }
    const neighborScore = neighborCount > 0 ? neighborSum / neighborCount : 0;
    const ownScore = valMetrics.wilsonLow * (Number.isFinite(valMetrics.pf) ? valMetrics.pf : 3.0);
    const compositeScore = 0.5 * ownScore + 0.5 * neighborScore;

    // 留出测试集
    const holdoutRes = await simulateStrategyOnPeriod(
      candlesMap,
      timeIndices,
      allTimesSorted,
      framesMap,
      tq.candidate,
      holdoutRange,
      { intrabarMode: isOptimistic ? "optimistic" : "conservative", fvCache }
    );

    // Walk-Forward 测试
    const wfFoldsResults: Array<{ fold: number; trades: number; winRate: number; pf: number; netPercent: number }> = [];
    let positiveFolds = 0;
    for (let f = 0; f < wfFolds.length; f++) {
      const fold = wfFolds[f];
      const wfRes = await simulateStrategyOnPeriod(
        candlesMap,
        timeIndices,
        allTimesSorted,
        framesMap,
        tq.candidate,
        fold.testRange,
        { intrabarMode: isOptimistic ? "optimistic" : "conservative", fvCache }
      );
      if (wfRes.metrics.totalNet > 0) positiveFolds++;
      wfFoldsResults.push({
        fold: f + 1,
        trades: wfRes.metrics.trades,
        winRate: wfRes.metrics.winRate,
        pf: wfRes.metrics.pf,
        netPercent: wfRes.metrics.totalNet,
      });
    }

    // 部署门槛检查 (3.4)
    const meetsDeploymentThreshold =
      valMetrics.wilsonLow >= 48 &&
      (valMetrics.pf >= 1.25 || !Number.isFinite(valMetrics.pf)) &&
      valMetrics.avgNet >= 0.15 &&
      holdoutRes.metrics.totalNet >= 0;

    comprehensiveResults.push({
      candidate: tq.candidate,
      trainMetrics: tq.trainMetrics,
      valMetrics,
      holdoutMetrics: holdoutRes.metrics,
      walkForwardMetrics: {
        folds: wfFoldsResults,
        positiveFolds,
        totalFolds: wfFolds.length,
      },
      neighborScore,
      compositeScore,
      meetsDeploymentThreshold,
    });
  }

  // 排序
  const longRanked = comprehensiveResults
    .filter((r) => r.candidate.side === "LONG")
    .sort((a, b) => b.compositeScore - a.compositeScore);

  const shortRanked = comprehensiveResults
    .filter((r) => r.candidate.side === "SHORT")
    .sort((a, b) => b.compositeScore - a.compositeScore);

  console.log("\n==================================================================");
  console.log("🏆【最优多头策略挖掘排名 TOP 5 (综合高原得分排序)】");
  console.log("==================================================================");
  console.log("| 排名 | 策略名称 | 验证交易 | 验证胜率 | 验证PF | 验证净利 | 留出净利 | WF正向率 | 门槛通过 |");
  console.log("|------|----------|----------|----------|--------|----------|----------|----------|----------|");

  longRanked.slice(0, 5).forEach((r, idx) => {
    const pfStr = Number.isFinite(r.valMetrics.pf) ? r.valMetrics.pf.toFixed(2) : "∞";
    console.log(
      `| ${(idx + 1).toString().padEnd(4)} ` +
      `| ${r.candidate.name.padEnd(42)} ` +
      `| ${String(r.valMetrics.trades).padStart(8)} ` +
      `| ${r.valMetrics.winRate.toFixed(1).padStart(7)}% ` +
      `| ${pfStr.padStart(6)} ` +
      `| ${(r.valMetrics.totalNet >= 0 ? "+" : "") + r.valMetrics.totalNet.toFixed(1) + "%"} ` +
      `| ${(r.holdoutMetrics.totalNet >= 0 ? "+" : "") + r.holdoutMetrics.totalNet.toFixed(1) + "%"} ` +
      `| ${r.walkForwardMetrics.positiveFolds}/${r.walkForwardMetrics.totalFolds} ` +
      `| ${r.meetsDeploymentThreshold ? "✅ 是" : "❌ 否"} |`
    );
  });

  console.log("\n==================================================================");
  console.log("🏆【最优空头策略挖掘排名 TOP 5 (综合高原得分排序)】");
  console.log("==================================================================");
  console.log("| 排名 | 策略名称 | 验证交易 | 验证胜率 | 验证PF | 验证净利 | 留出净利 | WF正向率 | 门槛通过 |");
  console.log("|------|----------|----------|----------|--------|----------|----------|----------|----------|");

  shortRanked.slice(0, 5).forEach((r, idx) => {
    const pfStr = Number.isFinite(r.valMetrics.pf) ? r.valMetrics.pf.toFixed(2) : "∞";
    console.log(
      `| ${(idx + 1).toString().padEnd(4)} ` +
      `| ${r.candidate.name.padEnd(42)} ` +
      `| ${String(r.valMetrics.trades).padStart(8)} ` +
      `| ${r.valMetrics.winRate.toFixed(1).padStart(7)}% ` +
      `| ${pfStr.padStart(6)} ` +
      `| ${(r.valMetrics.totalNet >= 0 ? "+" : "") + r.valMetrics.totalNet.toFixed(1) + "%"} ` +
      `| ${(r.holdoutMetrics.totalNet >= 0 ? "+" : "") + r.holdoutMetrics.totalNet.toFixed(1) + "%"} ` +
      `| ${r.walkForwardMetrics.positiveFolds}/${r.walkForwardMetrics.totalFolds} ` +
      `| ${r.meetsDeploymentThreshold ? "✅ 是" : "❌ 否"} |`
    );
  });

  // 阶段 3: 组合模式回测 (Portfolio Simulation)
  console.log("\n🚀 阶段 3/3: 组合模式并发与资金回撤模拟 (Portfolio Mode)...");
  const topStrats = [
    ...(shortRanked[0] ? [shortRanked[0].candidate] : []),
    ...(longRanked[0] ? [longRanked[0].candidate] : []),
  ];

  const portfolioResult = await runPortfolioSimulation(
    candlesMap,
    timeIndices,
    allTimesSorted,
    framesMap,
    topStrats,
    { start: minTime, end: maxTime },
    { maxPositions: 5, marginPercent: 20, leverage: 3 }
  );

  console.log(`✅ 组合回放完成: 初始 100 USDT → 终值 ${portfolioResult.finalBalance.toFixed(2)} USDT (净收益 +${portfolioResult.roiPct.toFixed(1)}%) | 交易 ${portfolioResult.totalTrades} 笔 (胜率 ${portfolioResult.winRate.toFixed(1)}%) | 最大回撤 ${portfolioResult.maxDrawdownPct.toFixed(1)}%`);

  // 保存详尽 Markdown 报告
  await mkdir(path.resolve("reports"), { recursive: true });
  const reportPath = path.resolve("reports/strategy-mining-report.md");

  const reportMd = `# 24h 涨幅榜量化统计与特征挖掘报告 (V2.0 优化版)

## 一、量化框架与防过拟合约束
- **特征版本**: \`${FEATURE_VERSION}\` (源自 \`src/features.ts\`)
- **数据集哈希**: \`${datasetHash}\` (覆盖标的数: ${minuteData.candles.size})
- **时间切分机制**:
  - 训练集 (60%): ${new Date(trainRange.start).toISOString()} ~ ${new Date(trainRange.end).toISOString()}
  - 验证集 (20%): ${new Date(valRange.start).toISOString()} ~ ${new Date(valRange.end).toISOString()}
  - 留出集 (20%): ${new Date(holdoutRange.start).toISOString()} ~ ${new Date(holdoutRange.end).toISOString()}
- **撮合保守化**: ${isOptimistic ? "乐观撮合" : "保守撮合 (SL优先判定，极端价滑点撮合，保本0.2%)"}

---

## 二、阶段 0: 前兆特征分布统计与客观规律挖掘 (因果前驱特征提取)
在实施策略回测与验证前，系统对全量样本进行时间序列切分，回溯统计【爆发前一段区间】与【见顶回撤前】的客观前驱特征分布：

### 1. 多头起爆前兆特征分布 (达标冲高样本量: ${precursorStats.totalSurgeEvents} 个)
- **前区间 MA20 支撑生效比例**: \`${precursorStats.longPrecursors.ma20SupportPct.toFixed(1)}%\`
- **前区间 MA10 支撑生效比例**: \`${precursorStats.longPrecursors.ma10SupportPct.toFixed(1)}%\`
- **前区间均线多头排列占比**: \`${precursorStats.longPrecursors.bullStackPct.toFixed(1)}%\`
- **前区间【3根1mK动态比对】刚成多头起爆**: \`${precursorStats.longPrecursors.freshBullPct.toFixed(1)}%\` | **持续3根稳固多头**: \`${precursorStats.longPrecursors.sustainedBullPct.toFixed(1)}%\`
- **前区间 MACD 绿柱比例**: 均值 \`${precursorStats.longPrecursors.greenRatioMean.toFixed(1)}%\` | 中位数 \`${precursorStats.longPrecursors.greenRatioMedian.toFixed(1)}%\` | P75: \`${precursorStats.longPrecursors.greenRatioP75.toFixed(1)}%\`
- **前区间黄金交叉 (近3根)**: \`${precursorStats.longPrecursors.goldenCrossPct.toFixed(1)}%\`
- **前区间蓄势振幅 (低波整理)**: 中位数 \`${precursorStats.longPrecursors.preAmpMedian.toFixed(2)}%\`

### 2. 空头冲高力竭前兆特征分布 (达标回撤样本量: ${precursorStats.totalDropEvents} 个)
- **冲高触碰 MA60 压制受阻**: \`${precursorStats.shortPrecursors.ma60ResistPct.toFixed(1)}%\`
- **冲高触碰 MA20 压制受阻**: \`${precursorStats.shortPrecursors.ma20ResistPct.toFixed(1)}%\`
- **冲高跌破 MA10 (破位)**: \`${precursorStats.shortPrecursors.ma10BreakdownPct.toFixed(1)}%\`
- **见顶【3根1mK动态比对】刚成空头破位**: \`${precursorStats.shortPrecursors.freshBearPct.toFixed(1)}%\` | **持续3根弱势空头**: \`${precursorStats.shortPrecursors.sustainedBearPct.toFixed(1)}%\`
- **冲高柱体衰竭 (HistSlope < 0)**: \`${precursorStats.shortPrecursors.histWeakeningPct.toFixed(1)}%\`
- **冲高顶背离**: \`${precursorStats.shortPrecursors.topDivergencePct.toFixed(1)}%\`
- **冲高段振幅中位数**: \`${precursorStats.shortPrecursors.priorSurgeAmpMedian.toFixed(2)}%\`

### 3. 量化因果推论
- **空头策略逻辑**: 以【前一段大振幅冲高完成】(surgeRatio >= 1/divisor) 作为前置因果条件，在峰值出现衰竭信号（柱体衰竭、均线受阻/破位）时入场做空捕捉回调段；
- **多头策略逻辑**: 以【前区间蓄势整理】(surgeRatio <= 1/divisor) 作为前置因果条件，在低波振幅中依托均线支撑（MA20/MA10 支撑）与健康 MACD（绿柱比例 > 50-70% / 金叉）起爆点入场，严防爆发段完成后追高。

---

## 三、最优多头候选策略排名 (TOP 5)

| 排名 | 策略名称 | 训练笔数/胜率/PF | 验证笔数/胜率/PF | 留出净收益 | WF正向率 | 门槛通过 |
|:---:|:---------|:----------------:|:----------------:|:----------:|:--------:|:--------:|
${longRanked
  .slice(0, 5)
  .map(
    (r, idx) =>
      `| ${idx + 1} | ${r.candidate.name} | ${r.trainMetrics.trades}笔 / ${r.trainMetrics.winRate.toFixed(1)}% / ${Number.isFinite(r.trainMetrics.pf) ? r.trainMetrics.pf.toFixed(2) : "∞"} | ${r.valMetrics.trades}笔 / ${r.valMetrics.winRate.toFixed(1)}% / ${Number.isFinite(r.valMetrics.pf) ? r.valMetrics.pf.toFixed(2) : "∞"} | ${r.holdoutMetrics.totalNet >= 0 ? "+" : ""}${r.holdoutMetrics.totalNet.toFixed(1)}% | ${r.walkForwardMetrics.positiveFolds}/${r.walkForwardMetrics.totalFolds} | ${r.meetsDeploymentThreshold ? "✅" : "❌"} |`
  )
  .join("\n")}

---

## 四、最优空头候选策略排名 (TOP 5)

| 排名 | 策略名称 | 训练笔数/胜率/PF | 验证笔数/胜率/PF | 留出净收益 | WF正向率 | 门槛通过 |
|:---:|:---------|:----------------:|:----------------:|:----------:|:--------:|:--------:|
${shortRanked
  .slice(0, 5)
  .map(
    (r, idx) =>
      `| ${idx + 1} | ${r.candidate.name} | ${r.trainMetrics.trades}笔 / ${r.trainMetrics.winRate.toFixed(1)}% / ${Number.isFinite(r.trainMetrics.pf) ? r.trainMetrics.pf.toFixed(2) : "∞"} | ${r.valMetrics.trades}笔 / ${r.valMetrics.winRate.toFixed(1)}% / ${Number.isFinite(r.valMetrics.pf) ? r.valMetrics.pf.toFixed(2) : "∞"} | ${r.holdoutMetrics.totalNet >= 0 ? "+" : ""}${r.holdoutMetrics.totalNet.toFixed(1)}% | ${r.walkForwardMetrics.positiveFolds}/${r.walkForwardMetrics.totalFolds} | ${r.meetsDeploymentThreshold ? "✅" : "❌"} |`
  )
  .join("\n")}

---

## 五、组合模式并发表现 (Portfolio Mode)
- **初始本金**: 100 USDT
- **最终本金**: ${portfolioResult.finalBalance.toFixed(2)} USDT (净收益 +${portfolioResult.roiPct.toFixed(1)}%)
- **总交易笔数**: ${portfolioResult.totalTrades} 笔
- **做多胜率**: ${portfolioResult.bySide.LONG.winRate.toFixed(1)}% (${portfolioResult.bySide.LONG.totalTrades} 笔)
- **做空胜率**: ${portfolioResult.bySide.SHORT.winRate.toFixed(1)}% (${portfolioResult.bySide.SHORT.totalTrades} 笔)
- **组合最大回撤**: ${portfolioResult.maxDrawdownPct.toFixed(1)}% (${portfolioResult.maxDrawdownUsdt.toFixed(2)} USDT)
`;

  await writeFile(reportPath, reportMd, "utf8");
  console.log(`\n📄 详细量化挖掘与防过拟合报告已保存至: ${reportPath}`);

  // 导出标准化参数到 data/mined-strategy.json (3.6)
  const bestShortRes = shortRanked[0];
  const bestLongRes = longRanked[0];

  const shortMeetsThreshold = !!bestShortRes && (bestShortRes.meetsDeploymentThreshold ?? false);
  const longMeetsThreshold = !!bestLongRes && (bestLongRes.meetsDeploymentThreshold ?? false);

  const strategyConfig: Partial<PaperStrategyConfig> = {
    marginPercent: 20, maxPositions: 5, maxPositionsPerStrategy: 1,
    enableLongs: longMeetsThreshold,
    enableKlineStatsShort: shortMeetsThreshold,
    enableKlineStatsLong: longMeetsThreshold,
  };

  if (bestShortRes) {
    const bs = bestShortRes.candidate;
    strategyConfig.klineStatsShortConfig = {
      topN: bs.topN ?? 10,
      minDayChange: bs.minDayChange ?? 10,
      intervalWindow: bs.intervalWindow,
      ampDivisor: bs.ampDivisor,
      maRequirement: bs.maRequirement as KlineStatsStrategyLiveConfig["maRequirement"],
      macdRequirement: bs.macdRequirement as KlineStatsStrategyLiveConfig["macdRequirement"],
      holdMinutes: bs.holdMinutes,
      tp1Percent: bs.tp1Percent,
      tp2Percent: bs.tp2Percent,
      stopLossPercent: bs.stopLossPercent,
      moveSlToEntryAfterTp1: true,
      cooldownMinutes: bs.cooldownMinutes ?? 20,
      leverage: 3,
    };
  }

  if (bestLongRes) {
    const bl = bestLongRes.candidate;
    strategyConfig.klineStatsLongConfig = {
      topN: bl.topN ?? 10,
      minDayChange: bl.minDayChange ?? 10,
      intervalWindow: bl.intervalWindow,
      ampDivisor: bl.ampDivisor,
      maRequirement: bl.maRequirement as KlineStatsStrategyLiveConfig["maRequirement"],
      macdRequirement: bl.macdRequirement as KlineStatsStrategyLiveConfig["macdRequirement"],
      holdMinutes: bl.holdMinutes,
      tp1Percent: bl.tp1Percent,
      tp2Percent: bl.tp2Percent,
      stopLossPercent: bl.stopLossPercent,
      moveSlToEntryAfterTp1: true,
      cooldownMinutes: bl.cooldownMinutes ?? 20,
      leverage: 3,
    };
  }

  const exportPayload = {
    updatedAt: new Date().toISOString(),
    featureVersion: FEATURE_VERSION,
    datasetHash,
    trials: candidates.length,
    meetsDeploymentThreshold:
      (bestShortRes?.meetsDeploymentThreshold ?? false) && (bestLongRes?.meetsDeploymentThreshold ?? false),
    summary: {
      bestShort: bestShortRes
        ? {
            name: bestShortRes.candidate.name,
            trainTrades: bestShortRes.trainMetrics.trades,
            trainWinRate: bestShortRes.trainMetrics.winRate,
            valTrades: bestShortRes.valMetrics.trades,
            valWinRate: bestShortRes.valMetrics.winRate,
            valPf: Number.isFinite(bestShortRes.valMetrics.pf) ? bestShortRes.valMetrics.pf : null,
            valWilsonLow: bestShortRes.valMetrics.wilsonLow,
            holdoutNet: bestShortRes.holdoutMetrics.totalNet,
            neighborScore: bestShortRes.neighborScore,
            compositeScore: bestShortRes.compositeScore,
            meetsDeploymentThreshold: bestShortRes.meetsDeploymentThreshold,
          }
        : null,
      bestLong: bestLongRes
        ? {
            name: bestLongRes.candidate.name,
            trainTrades: bestLongRes.trainMetrics.trades,
            trainWinRate: bestLongRes.trainMetrics.winRate,
            valTrades: bestLongRes.valMetrics.trades,
            valWinRate: bestLongRes.valMetrics.winRate,
            valPf: Number.isFinite(bestLongRes.valMetrics.pf) ? bestLongRes.valMetrics.pf : null,
            valWilsonLow: bestLongRes.valMetrics.wilsonLow,
            holdoutNet: bestLongRes.holdoutMetrics.totalNet,
            neighborScore: bestLongRes.neighborScore,
            compositeScore: bestLongRes.compositeScore,
            meetsDeploymentThreshold: bestLongRes.meetsDeploymentThreshold,
          }
        : null,
      portfolio: {
        roiPct: portfolioResult.roiPct,
        trades: portfolioResult.totalTrades,
        winRate: portfolioResult.winRate,
        bySide: portfolioResult.bySide,
        maxDrawdownPct: portfolioResult.maxDrawdownPct,
      },
    },
    top3Short: shortRanked.slice(0, 3).map((r) => ({
      name: r.candidate.name,
      valWinRate: r.valMetrics.winRate,
      compositeScore: r.compositeScore,
    })),
    top3Long: longRanked.slice(0, 3).map((r) => ({
      name: r.candidate.name,
      valWinRate: r.valMetrics.winRate,
      compositeScore: r.compositeScore,
    })),
    strategyConfig,
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(exportPayload, null, 2), "utf8");

  console.log(`\n💾 最优量化策略配置已导出保存至: ${outputPath}`);
  console.log("==================================================================");
  console.log("🎯 下一步：执行部署校验与热更新");
  console.log("   npm run deploy:strategy -- --url http://127.0.0.1:4111");
  console.log("==================================================================");

  if (telegramConfigured()) {
    const lines = [
      `✅ <b>[量化模型] 离线策略挖掘与参数训练完成！</b>`,
      `• <b>输出配置</b>: <code>${outputPath}</code>`,
      `• <b>回测总表现</b>: 最终净资产 <b>${portfolioResult.finalBalance.toFixed(2)} USDT</b> (+${portfolioResult.roiPct.toFixed(1)}%) | 胜率 <b>${portfolioResult.winRate.toFixed(1)}%</b> (${portfolioResult.totalTrades}笔)`,
    ];
    if (bestShortRes) {
      lines.push(`• <b>最优空头</b>: ${escapeHtml(bestShortRes.candidate.name)} (验证胜率 ${bestShortRes.valMetrics.winRate.toFixed(1)}%, PF ${Number.isFinite(bestShortRes.valMetrics.pf) ? bestShortRes.valMetrics.pf.toFixed(2) : "∞"}) [${bestShortRes.meetsDeploymentThreshold ? "达标 ✅" : "未达标 ❌"}]`);
    }
    if (bestLongRes) {
      lines.push(`• <b>最优多头</b>: ${escapeHtml(bestLongRes.candidate.name)} (验证胜率 ${bestLongRes.valMetrics.winRate.toFixed(1)}%, PF ${Number.isFinite(bestLongRes.valMetrics.pf) ? bestLongRes.valMetrics.pf.toFixed(2) : "∞"}) [${bestLongRes.meetsDeploymentThreshold ? "达标 ✅" : "未达标 ❌"}]`);
    }
    lines.push(`• <b>下一步</b>: 可通过 <code>npm run deploy:strategy</code> 一键热部署至实盘/模拟服务。`);
    await sendTelegramMessage(lines.join("\n"));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
