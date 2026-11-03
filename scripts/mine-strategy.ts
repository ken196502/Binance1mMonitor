#!/usr/bin/env tsx
/**
 * 24h 涨幅榜 K 线量化统计与特征挖掘策略脚本 (Script 1/2)
 *
 * 核心量化框架：
 * 1. 标的池：24h 涨幅榜 Top 10 (dayChange >= 10%)
 * 2. 区间动能：X 分钟内区间涨跌幅达到 24h 涨幅 / ampDivisor 比例
 * 3. 均线形态：MA5/10/20/30/60 排列、回踩均线支撑、触碰均线压制、突破/跌破
 * 4. MACD 特征：近 15m/30m 绿柱比例、连绿动能衰竭、零轴与金叉/死叉判定
 * 5. 多周期持仓与两阶段阶梯退出 (TP1 / TP2 / 保本止损 / SL / 超时退出)
 *
 * 产出成果：
 * 1. 控制台输出 Top 10 多头与空头量化策略表现榜单；
 * 2. 生成详细的 Markdown 量化回测报告：reports/strategy-mining-report.md；
 * 3. 导出最优策略参数至标准化配置文件：data/mined-strategy.json（供 deploy-strategy 脚本直接使用）。
 *
 * 用法：
 *   npx tsx scripts/mine-strategy.ts           # 完整网格扫描 (168h 全量数据)
 *   npx tsx scripts/mine-strategy.ts --quick   # 快速扫描 (精选网格，秒级完成)
 */

import path from "node:path";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { loadDataset } from "../research/data.ts";
import { buildFrames } from "../research/backtest.ts";
import type { MinuteDataset } from "../research/gainers-types.ts";
import { wilsonInterval } from "../research/peak-rebound-backtest.ts";
import { computeMacd } from "../src/macd.ts";
import {
  analyzeMaAlignment,
  analyzeOhlcComparison,
  analyzeMacdStats,
  STATS_MA_PERIODS,
} from "../src/kline-stats.ts";
import type { ChartBar } from "../src/types.ts";
import type { PaperStrategyConfig } from "../src/paper-trading.ts";

const MINUTE = 60_000;

export async function loadAllMinutes(): Promise<MinuteDataset> {
  const dir1 = path.resolve("data/research/staged-1m-20261020-20261023");
  const dir2 = path.resolve("data/research/peak-rebound-1m-168h");
  const candles = new Map<string, any[]>();

  for (const dir of [dir1, dir2]) {
    try {
      const files = await readdir(dir);
      for (const f of files) {
        if (f.endsWith(".json.gz")) {
          const sym = f.replace(".json.gz", "");
          if (!candles.has(sym)) {
            const bytes = await readFile(path.join(dir, f));
            candles.set(sym, JSON.parse(gunzipSync(bytes).toString("utf8")));
          }
        }
      }
    } catch {}
  }
  return {
    manifest: {
      version: 1,
      interval: "1m",
      source: "Binance",
      fetchedAt: "",
      plan: {} as any,
      files: {},
    },
    candles,
  };
}

export function calcTradeReturn(
  side: "LONG" | "SHORT",
  entryPrice: number,
  exitPrice: number,
  costs = { takerFeeBps: 5, slippageBps: 2 }
) {
  const grossPercent =
    side === "LONG"
      ? ((exitPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - exitPrice) / entryPrice) * 100;

  const entryFeePercent = costs.takerFeeBps / 100;
  const exitFeePercent = (costs.takerFeeBps / 100) * (exitPrice / entryPrice);
  const slippagePercent = (costs.slippageBps / 100) * (1 + exitPrice / entryPrice);
  const netPercent = grossPercent - entryFeePercent - exitFeePercent - slippagePercent;
  return { grossPercent, netPercent };
}

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export interface MiningStrategyCandidate {
  id: string;
  name: string;
  side: "LONG" | "SHORT";
  // 特征条件
  intervalWindow: number; // 冲高/回撤统计窗口 (如 5m, 10m, 15m)
  ampDivisor: number;     // 达到 24h涨幅 / ampDivisor 比例
  maRequirement:
    | "MA10_SUPPORT"      // 回踩 MA10 支撑 (low <= ma10 && close > ma10)
    | "MA20_SUPPORT"      // 回踩 MA20 支撑 (low <= ma20 && close > ma20)
    | "MA60_SUPPORT"      // 回踩 MA60 支撑 (low <= ma60 && close > ma60)
    | "MA_BULLISH_STACK"  // 多头排列 (MA5 > MA10 > MA20)
    | "MA60_RESIST"       // 触碰 MA60 压制 (high >= ma60 && close < ma60)
    | "MA20_RESIST"       // 触碰 MA20 压制 (high >= ma20 && close < ma20)
    | "MA10_BREAKDOWN"    // 跌破 MA10 (open >= ma10 && close < ma10)
    | "NONE";
  macdRequirement:
    | "GREEN_RATIO_15_70" // 近15根绿柱 >= 70% 且金叉
    | "GREEN_RATIO_30_70" // 近30根绿柱 >= 70%
    | "GREEN_RATIO_30_80" // 近30根绿柱 >= 80%
    | "GREEN_STREAK_3"    // 连绿 >= 3 根
    | "HIST_WEAKENING"    // 绿柱缩短或翻红
    | "NONE";
  // 退出与持仓
  holdMinutes: number;
  tp1Percent: number;
  tp2Percent: number;
  stopLossPercent: number;
  cooldownMinutes?: number;
}

export interface StrategyResult {
  candidate: MiningStrategyCandidate;
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
}

export async function runSimulation(
  minuteData: MinuteDataset,
  frames: any[],
  strategy: MiningStrategyCandidate,
  precomputedMap: Map<string, { bars: ChartBar[]; closes: number[]; highs: number[]; lows: number[]; opens: number[] }>
): Promise<StrategyResult> {
  const gainerBoards = new Map<number, Map<string, { rank: number; dayChange: number }>>();
  for (const frame of frames) {
    const gMap = new Map<string, { rank: number; dayChange: number }>();
    for (const obs of frame.boards.gainers) {
      gMap.set(obs.symbol, { rank: obs.rank, dayChange: obs.dayChange });
    }
    gainerBoards.set(frame.time, gMap);
  }

  const allTimeSet = new Set<number>();
  for (const [, bars] of minuteData.candles) {
    for (const b of bars) allTimeSet.add(b[0]);
  }
  const allTimesSorted = Array.from(allTimeSet).sort((a, b) => a - b);

  const timeIndices = new Map<string, Map<number, number>>();
  for (const [sym, data] of precomputedMap) {
    const tMap = new Map<number, number>();
    for (let idx = 0; idx < data.bars.length; idx++) {
      tMap.set(data.bars[idx].time, idx);
    }
    timeIndices.set(sym, tMap);
  }

  interface SimPos {
    symbol: string;
    entryTime: number;
    entryPrice: number;
    tp1Price: number;
    tp2Price: number;
    slPrice: number;
    st1Done: boolean;
    st2Done: boolean;
    netPnlPercent: number;
    holdDeadline: number;
    reason?: string;
  }

  const activePositions: SimPos[] = [];
  const closedTrades: { netPercent: number; isWin: boolean; reason: string }[] = [];
  const cooldownMap = new Map<string, number>();
  const cooldownMs = (strategy.cooldownMinutes ?? 20) * MINUTE;

  let currentBoard: Map<string, { rank: number; dayChange: number }> = new Map();

  for (const nowTime of allTimesSorted) {
    if (gainerBoards.has(nowTime)) {
      currentBoard = gainerBoards.get(nowTime)!;
    }

    // 1. 处理持仓退出
    for (let pIdx = activePositions.length - 1; pIdx >= 0; pIdx--) {
      const pos = activePositions[pIdx];
      const data = precomputedMap.get(pos.symbol);
      const tMap = timeIndices.get(pos.symbol);
      if (!data || !tMap) continue;
      const curIdx = tMap.get(nowTime);
      if (curIdx === undefined) continue;

      const bar = data.bars[curIdx];
      const isLong = strategy.side === "LONG";

      // 阶段 1: 止盈 50%
      if (!pos.st1Done) {
        const hitTp1 = isLong ? bar.high >= pos.tp1Price : bar.low <= pos.tp1Price;
        if (hitTp1) {
          const ret = calcTradeReturn(strategy.side, pos.entryPrice, pos.tp1Price);
          pos.netPnlPercent += ret.netPercent * 0.5;
          pos.st1Done = true;
          // TP1 命中后可将止损上移到保本
          pos.slPrice = pos.entryPrice;
        }
      }

      // 止损判定
      const hitSl = isLong ? bar.low <= pos.slPrice : bar.high >= pos.slPrice;
      if (hitSl) {
        const ret = calcTradeReturn(strategy.side, pos.entryPrice, pos.slPrice);
        const weight = pos.st1Done ? 0.5 : 1.0;
        pos.netPnlPercent += ret.netPercent * weight;
        closedTrades.push({
          netPercent: pos.netPnlPercent,
          isWin: pos.netPnlPercent > 0,
          reason: "SL",
        });
        cooldownMap.set(pos.symbol, nowTime + cooldownMs);
        activePositions.splice(pIdx, 1);
        continue;
      }

      // 阶段 2: 目标止盈
      if (pos.st1Done && !pos.st2Done) {
        const hitTp2 = isLong ? bar.high >= pos.tp2Price : bar.low <= pos.tp2Price;
        if (hitTp2) {
          const ret = calcTradeReturn(strategy.side, pos.entryPrice, pos.tp2Price);
          pos.netPnlPercent += ret.netPercent * 0.5;
          pos.st2Done = true;
          closedTrades.push({
            netPercent: pos.netPnlPercent,
            isWin: pos.netPnlPercent > 0,
            reason: "TP2",
          });
          cooldownMap.set(pos.symbol, nowTime + cooldownMs);
          activePositions.splice(pIdx, 1);
          continue;
        }
      }

      // 超时退出
      if (nowTime >= pos.holdDeadline) {
        const exitPrice = bar.close;
        const ret = calcTradeReturn(strategy.side, pos.entryPrice, exitPrice);
        const weight = pos.st1Done ? 0.5 : 1.0;
        pos.netPnlPercent += ret.netPercent * weight;
        closedTrades.push({
          netPercent: pos.netPnlPercent,
          isWin: pos.netPnlPercent > 0,
          reason: pos.st1Done ? "TP1_TIMEOUT" : "TIMEOUT",
        });
        cooldownMap.set(pos.symbol, nowTime + cooldownMs);
        activePositions.splice(pIdx, 1);
        continue;
      }
    }

    // 2. 检查开仓入场
    for (const [sym, boardInfo] of currentBoard) {
      if (boardInfo.rank > 10 || boardInfo.dayChange < 10) continue;
      if (activePositions.some((p) => p.symbol === sym)) continue;
      if ((cooldownMap.get(sym) ?? 0) > nowTime) continue;

      const data = precomputedMap.get(sym);
      const tMap = timeIndices.get(sym);
      if (!data || !tMap) continue;
      const curIdx = tMap.get(nowTime);
      if (curIdx === undefined || curIdx < 65 || curIdx >= data.bars.length - 1) continue;

      const targetIdx = curIdx - 1; // 上一根已收盘 K 线
      const closedBar = data.bars[targetIdx];

      // 特征 A: 区间涨幅 / 24h 涨幅比例
      const wStart = Math.max(0, targetIdx - strategy.intervalWindow + 1);
      let minLow = Infinity;
      let maxHigh = -Infinity;
      for (let k = wStart; k <= targetIdx; k++) {
        if (data.lows[k] < minLow) minLow = data.lows[k];
        if (data.highs[k] > maxHigh) maxHigh = data.highs[k];
      }
      if (minLow <= 0 || maxHigh <= 0) continue;

      const risePercent = ((closedBar.high - minLow) / minLow) * 100;
      const requiredRise = boardInfo.dayChange / strategy.ampDivisor;
      if (risePercent < requiredRise) continue;

      // 特征 B: 均线排列与支撑/压制判定
      const maAlignment = analyzeMaAlignment(data.bars, targetIdx);
      const ohlc = analyzeOhlcComparison(data.bars, targetIdx);

      let maPass = true;
      switch (strategy.maRequirement) {
        case "MA10_SUPPORT":
          maPass = ohlc.supports.includes(10);
          break;
        case "MA20_SUPPORT":
          maPass = ohlc.supports.includes(20);
          break;
        case "MA60_SUPPORT":
          maPass = ohlc.supports.includes(60);
          break;
        case "MA_BULLISH_STACK":
          maPass =
            maAlignment.type === "bullish_full" ||
            maAlignment.type === "bullish_short";
          break;
        case "MA60_RESIST":
          maPass = ohlc.resistances.includes(60);
          break;
        case "MA20_RESIST":
          maPass = ohlc.resistances.includes(20);
          break;
        case "MA10_BREAKDOWN":
          maPass = closedBar.open >= (closedBar.ma["10"] ?? 0) && closedBar.close < (closedBar.ma["10"] ?? 0);
          break;
        case "NONE":
          maPass = true;
          break;
      }
      if (!maPass) continue;

      // 特征 C: MACD 绿柱比例判定
      const macd = analyzeMacdStats(data.bars, targetIdx);
      let macdPass = true;
      switch (strategy.macdRequirement) {
        case "GREEN_RATIO_15_70":
          macdPass = macd.greenBarRatio15 >= 0.7 && macd.isBullishCross;
          break;
        case "GREEN_RATIO_30_70":
          macdPass = macd.greenBarRatio30 >= 0.7;
          break;
        case "GREEN_RATIO_30_80":
          macdPass = macd.greenBarRatio30 >= 0.8;
          break;
        case "GREEN_STREAK_3":
          macdPass = macd.greenStreak >= 3;
          break;
        case "HIST_WEAKENING":
          const prevHist = targetIdx > 0 ? data.bars[targetIdx - 1].hist : 0;
          macdPass = prevHist > 0 && (closedBar.hist < prevHist || closedBar.hist <= 0);
          break;
        case "NONE":
          macdPass = true;
          break;
      }
      if (!macdPass) continue;

      // 达成触发！次根开盘价成交
      const nextOpen = data.bars[curIdx].open;
      const entryPrice = nextOpen > 0 ? nextOpen : closedBar.close;

      const isLong = strategy.side === "LONG";
      const tp1Price = isLong
        ? entryPrice * (1 + strategy.tp1Percent / 100)
        : entryPrice * (1 - strategy.tp1Percent / 100);
      const tp2Price = isLong
        ? entryPrice * (1 + strategy.tp2Percent / 100)
        : entryPrice * (1 - strategy.tp2Percent / 100);
      const slPrice = isLong
        ? entryPrice * (1 - strategy.stopLossPercent / 100)
        : entryPrice * (1 + strategy.stopLossPercent / 100);

      activePositions.push({
        symbol: sym,
        entryTime: nowTime,
        entryPrice,
        tp1Price,
        tp2Price,
        slPrice,
        st1Done: false,
        st2Done: false,
        netPnlPercent: 0,
        holdDeadline: nowTime + strategy.holdMinutes * MINUTE,
      });
    }
  }

  // 结算统计
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
  const pf = totalLoss > 0 ? totalGain / totalLoss : totalGain > 0 ? 99.9 : 0;
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

  return {
    candidate: strategy,
    trades: totalTrades,
    wins,
    losses,
    winRate,
    pf,
    totalNet,
    avgNet,
    tp1Hits: closedTrades.filter((t) => t.reason === "TP2").length,
    tp2Hits: closedTrades.filter((t) => t.reason === "TP2").length,
    slHits: closedTrades.filter((t) => t.reason === "SL").length,
    timeouts: closedTrades.filter((t) => t.reason.includes("TIMEOUT")).length,
    maxDrawdown,
    wilsonLow,
  };
}

export async function main() {
  const isQuick = process.argv.includes("--quick");
  const outputArgIdx = process.argv.indexOf("--output");
  const outputPath =
    outputArgIdx !== -1 && process.argv[outputArgIdx + 1]
      ? path.resolve(process.argv[outputArgIdx + 1])
      : path.resolve("data/mined-strategy.json");

  console.log("==================================================================");
  console.log(`🚀【24h 涨幅榜量化统计与特征挖掘系统】${isQuick ? "(快速模式)" : "(全量网格扫描)"}`);
  console.log("==================================================================");
  console.log("正在载入历史行情数据与 24h 榜单快照 (168 小时)...");

  const hourly = await loadDataset(path.resolve("data/research/hourly-168h"));
  const frames = buildFrames(hourly, 10, 1);
  const minuteData = await loadAllMinutes();
  console.log(`行情数据载入完成！标的数: ${minuteData.candles.size}，快照帧数: ${frames.length}`);

  console.log("正在预计算各币种 1m 指标 (MA5/10/20/30/60 与 MACD)...");
  const precomputedMap = new Map<string, {
    bars: ChartBar[];
    closes: number[];
    highs: number[];
    lows: number[];
    opens: number[];
  }>();

  for (const [sym, rawBars] of minuteData.candles) {
    const closes = rawBars.map((b) => b[4]);
    const opens = rawBars.map((b) => b[1]);
    const highs = rawBars.map((b) => b[2]);
    const lows = rawBars.map((b) => b[3]);

    const maSeries = new Map<number, (number | null)[]>(
      STATS_MA_PERIODS.map((p) => [p, sma(closes, p)])
    );
    const { dif, dea, hist } = computeMacd(closes);

    const bars: ChartBar[] = rawBars.map((b, i) => {
      const ma: Record<string, number | null> = {};
      for (const p of STATS_MA_PERIODS) {
        ma[String(p)] = maSeries.get(p)?.[i] ?? null;
      }
      return {
        time: b[0],
        open: b[1],
        high: b[2],
        low: b[3],
        close: b[4],
        volume: b[5],
        ma,
        dif: dif[i],
        dea: dea[i],
        hist: hist[i],
      };
    });

    precomputedMap.set(sym, { bars, closes, highs, lows, opens });
  }
  console.log("指标预计算完成！生成策略参数网格...");

  // 生成待挖掘的多头与空头策略候选集
  const candidates: MiningStrategyCandidate[] = [];

  const longWindows = isQuick ? [5] : [5, 10, 15];
  const longDivs = isQuick ? [8, 10] : [8, 10, 12];
  const longMaReqs = isQuick
    ? (["MA10_SUPPORT", "MA20_SUPPORT"] as const)
    : (["MA10_SUPPORT", "MA20_SUPPORT", "MA_BULLISH_STACK"] as const);
  const longMacdReqs = isQuick
    ? (["GREEN_RATIO_15_70", "GREEN_RATIO_30_70"] as const)
    : (["GREEN_RATIO_15_70", "GREEN_RATIO_30_70", "GREEN_RATIO_30_80"] as const);
  const longHolds = isQuick ? [30] : [15, 30, 45];

  for (const window of longWindows) {
    for (const div of longDivs) {
      for (const maReq of longMaReqs) {
        for (const macdReq of longMacdReqs) {
          for (const hold of longHolds) {
            candidates.push({
              id: `LONG_W${window}_D${div}_${maReq}_${macdReq}_H${hold}`,
              name: `多头: ${window}m冲高(24h/${div}) + ${maReq.replace("_", "")} + ${macdReq} + 持仓${hold}m`,
              side: "LONG",
              intervalWindow: window,
              ampDivisor: div,
              maRequirement: maReq,
              macdRequirement: macdReq,
              holdMinutes: hold,
              tp1Percent: 2.5,
              tp2Percent: 5.5,
              stopLossPercent: 3.5,
              cooldownMinutes: 20,
            });
          }
        }
      }
    }
  }

  const shortWindows = isQuick ? [5] : [5, 10, 15];
  const shortDivs = isQuick ? [8, 10] : [8, 10, 12];
  const shortMaReqs = isQuick
    ? (["MA10_BREAKDOWN", "MA60_RESIST"] as const)
    : (["MA60_RESIST", "MA20_RESIST", "MA10_BREAKDOWN"] as const);
  const shortMacdReqs = isQuick
    ? (["GREEN_RATIO_30_80", "HIST_WEAKENING"] as const)
    : (["GREEN_STREAK_3", "HIST_WEAKENING", "GREEN_RATIO_30_80"] as const);
  const shortHolds = isQuick ? [45] : [15, 30, 45];

  for (const window of shortWindows) {
    for (const div of shortDivs) {
      for (const maReq of shortMaReqs) {
        for (const macdReq of shortMacdReqs) {
          for (const hold of shortHolds) {
            candidates.push({
              id: `SHORT_W${window}_D${div}_${maReq}_${macdReq}_H${hold}`,
              name: `空头: ${window}m冲高(24h/${div}) + ${maReq.replace("_", "")} + ${macdReq} + 持仓${hold}m`,
              side: "SHORT",
              intervalWindow: window,
              ampDivisor: div,
              maRequirement: maReq,
              macdRequirement: macdReq,
              holdMinutes: hold,
              tp1Percent: 3.0,
              tp2Percent: 7.0,
              stopLossPercent: 5.0,
              cooldownMinutes: 20,
            });
          }
        }
      }
    }
  }

  console.log(`候选策略网格: ${candidates.length} 组参数组合，正在逐一回测挖掘...`);

  const results: StrategyResult[] = [];
  let evaluated = 0;
  const minTrades = isQuick ? 5 : 10;

  for (const cand of candidates) {
    const res = await runSimulation(minuteData, frames, cand, precomputedMap);
    if (res.trades >= minTrades) {
      results.push(res);
    }
    evaluated++;
    if (evaluated % (isQuick ? 10 : 50) === 0 || evaluated === candidates.length) {
      process.stdout.write(`已挖掘评估 ${evaluated}/${candidates.length} 组策略...\r`);
    }
  }
  console.log(`\n挖掘扫描完成！有效样本量 (交易笔数 >= ${minTrades}) 的候选策略数: ${results.length}`);

  // 按综合评分排序（Wilson 95% 置信下界 * 盈亏比 PF）
  const longResults = results
    .filter((r) => r.candidate.side === "LONG")
    .sort((a, b) => b.wilsonLow * b.pf - a.wilsonLow * a.pf);

  const shortResults = results
    .filter((r) => r.candidate.side === "SHORT")
    .sort((a, b) => b.wilsonLow * b.pf - a.wilsonLow * a.pf);

  console.log("\n==================================================================");
  console.log("🏆【挖掘结果榜单：TOP 10 多头策略 (顺势冲高 + 均线支撑 + MACD绿柱)】");
  console.log("==================================================================");
  console.log("| 排名 | 策略名称 | 交易 | 胜率 | PF | 累计净收益 | 平均每笔 | 最大回撤 | Wilson下界 |");
  console.log("|------|----------|------|------|-----|------------|----------|----------|------------|");

  const topLong = longResults.slice(0, 10);
  topLong.forEach((r, idx) => {
    console.log(
      `| ${(idx + 1).toString().padEnd(4)} ` +
      `| ${r.candidate.name.padEnd(42)} ` +
      `| ${String(r.trades).padStart(4)} ` +
      `| ${r.winRate.toFixed(1).padStart(5)}% ` +
      `| ${r.pf.toFixed(2).padStart(4)} ` +
      `| ${(r.totalNet >= 0 ? "+" : "") + r.totalNet.toFixed(1) + "%"} ` +
      `| ${(r.avgNet >= 0 ? "+" : "") + r.avgNet.toFixed(2) + "%"} ` +
      `| ${r.maxDrawdown.toFixed(1) + "%"} ` +
      `| ${r.wilsonLow.toFixed(1) + "%"} |`
    );
  });

  console.log("\n==================================================================");
  console.log("🏆【挖掘结果榜单：TOP 10 空头策略 (冲高受阻 + 均线压制 + MACD衰竭)】");
  console.log("==================================================================");
  console.log("| 排名 | 策略名称 | 交易 | 胜率 | PF | 累计净收益 | 平均每笔 | 最大回撤 | Wilson下界 |");
  console.log("|------|----------|------|------|-----|------------|----------|----------|------------|");

  const topShort = shortResults.slice(0, 10);
  topShort.forEach((r, idx) => {
    console.log(
      `| ${(idx + 1).toString().padEnd(4)} ` +
      `| ${r.candidate.name.padEnd(42)} ` +
      `| ${String(r.trades).padStart(4)} ` +
      `| ${r.winRate.toFixed(1).padStart(5)}% ` +
      `| ${r.pf.toFixed(2).padStart(4)} ` +
      `| ${(r.totalNet >= 0 ? "+" : "") + r.totalNet.toFixed(1) + "%"} ` +
      `| ${(r.avgNet >= 0 ? "+" : "") + r.avgNet.toFixed(2) + "%"} ` +
      `| ${r.maxDrawdown.toFixed(1) + "%"} ` +
      `| ${r.wilsonLow.toFixed(1) + "%"} |`
    );
  });

  // 保存研究报告到 reports/
  await mkdir(path.resolve("reports"), { recursive: true });
  const reportPath = path.resolve("reports/strategy-mining-report.md");

  const reportMd = `# 24h 涨幅榜 K 线量化统计与特征策略挖掘报告

## 一、研究背景与量化框架
本研究针对币安 24h 涨幅榜（Top 10，24h 涨幅 >= 10%）的 1m 行情数据，提取并综合验证了三大维度的量化特征：
1. **区间涨跌幅 / 24h 涨幅比例**：$W$ 分钟内涨跌幅达到 $24h 涨幅 / ampDivisor$；
2. **均线排列与支撑/压制**：MA5/10/20/30/60 多头/空头排列，K 线回踩 MA10/20/60 支撑，触碰 MA20/60 压制，或跌破 MA10；
3. **MACD 绿柱比例与动能**：近 15m/30m 绿柱占比，连绿根数与动能衰竭转弱。

回测覆盖 168 小时行情，扣除 Taker 手续费（5 bps）与滑点（2 bps）。

---

## 二、Top 10 多头挖掘策略 (顺势冲高 + 均线支撑 + MACD绿柱多头)

| 排名 | 策略配置 | 交易笔数 | 胜率 | 盈亏比 (PF) | 累计净收益 | 平均单笔 | 最大回撤 | Wilson 95% 置信下界 |
|:---:|:---------|:--------:|:----:|:-----------:|:----------:|:--------:|:--------:|:-------------------:|
${topLong
  .map(
    (r, i) =>
      `| ${i + 1} | ${r.candidate.name} | ${r.trades} | ${r.winRate.toFixed(1)}% | ${r.pf.toFixed(2)} | ${r.totalNet >= 0 ? "+" : ""}${r.totalNet.toFixed(1)}% | ${r.avgNet >= 0 ? "+" : ""}${r.avgNet.toFixed(2)}% | ${r.maxDrawdown.toFixed(1)}% | ${r.wilsonLow.toFixed(1)}% |`
  )
  .join("\n")}

---

## 三、Top 10 空头挖掘策略 (冲高受阻 + 均线压制 + MACD动能衰竭)

| 排名 | 策略配置 | 交易笔数 | 胜率 | 盈亏比 (PF) | 累计净收益 | 平均单笔 | 最大回撤 | Wilson 95% 置信下界 |
|:---:|:---------|:--------:|:----:|:-----------:|:----------:|:--------:|:--------:|:-------------------:|
${topShort
  .map(
    (r, i) =>
      `| ${i + 1} | ${r.candidate.name} | ${r.trades} | ${r.winRate.toFixed(1)}% | ${r.pf.toFixed(2)} | ${r.totalNet >= 0 ? "+" : ""}${r.totalNet.toFixed(1)}% | ${r.avgNet >= 0 ? "+" : ""}${r.avgNet.toFixed(2)}% | ${r.maxDrawdown.toFixed(1)}% | ${r.wilsonLow.toFixed(1)}% |`
  )
  .join("\n")}
`;

  await writeFile(reportPath, reportMd, "utf8");
  console.log(`\n📄 策略挖掘分析报告已成功保存至: ${reportPath}`);

  // 构建最优策略参数配置结构，并保存至 data/mined-strategy.json
  const bestShort = topShort[0]?.candidate;
  const bestLong = topLong[0]?.candidate;

  const strategyConfig: Partial<PaperStrategyConfig> = {
    marginPercent: 20,
    maxPositions: 5,
    maxPositionsPerStrategy: 1,
    enableStreak: true,
    enableRebound: true,
    enableDeepRebound: true,
    enableHourlySuppression: true,
    enableLongs: true,
    enableWBottomDivergence: true,
    enableKlineStatsShort: true,
    enableKlineStatsLong: true,
    klineStatsLeverage: 10,
    streakLeverage: 10,
    trendLeverage: 3,
    longLeverage: 5,
  };

  if (bestShort) {
    strategyConfig.klineStatsShortConfig = {
      topN: 10,
      minDayChange: 10,
      intervalWindow: bestShort.intervalWindow,
      ampDivisor: bestShort.ampDivisor,
      maRequirement: bestShort.maRequirement,
      macdRequirement: bestShort.macdRequirement,
      holdMinutes: bestShort.holdMinutes,
      tp1Percent: bestShort.tp1Percent,
      tp2Percent: bestShort.tp2Percent,
      stopLossPercent: bestShort.stopLossPercent,
      moveSlToEntryAfterTp1: true,
      cooldownMinutes: bestShort.cooldownMinutes ?? 20,
      leverage: 10,
    };
  }

  if (bestLong) {
    strategyConfig.klineStatsLongConfig = {
      topN: 10,
      minDayChange: 10,
      intervalWindow: bestLong.intervalWindow,
      ampDivisor: bestLong.ampDivisor,
      maRequirement: bestLong.maRequirement,
      macdRequirement: bestLong.macdRequirement,
      holdMinutes: bestLong.holdMinutes,
      tp1Percent: bestLong.tp1Percent,
      tp2Percent: bestLong.tp2Percent,
      stopLossPercent: bestLong.stopLossPercent,
      moveSlToEntryAfterTp1: true,
      cooldownMinutes: bestLong.cooldownMinutes ?? 20,
      leverage: 5,
    };
  }

  const exportPayload = {
    updatedAt: new Date().toISOString(),
    source: "kline-stats-strategy-miner",
    summary: {
      bestShort: topShort[0]
        ? {
            name: topShort[0].candidate.name,
            trades: topShort[0].trades,
            winRate: topShort[0].winRate,
            pf: topShort[0].pf,
            totalNet: topShort[0].totalNet,
            maxDrawdown: topShort[0].maxDrawdown,
            wilsonLow: topShort[0].wilsonLow,
          }
        : null,
      bestLong: topLong[0]
        ? {
            name: topLong[0].candidate.name,
            trades: topLong[0].trades,
            winRate: topLong[0].winRate,
            pf: topLong[0].pf,
            totalNet: topLong[0].totalNet,
            maxDrawdown: topLong[0].maxDrawdown,
            wilsonLow: topLong[0].wilsonLow,
          }
        : null,
    },
    strategyConfig,
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(exportPayload, null, 2), "utf8");

  console.log(`\n💾 最优量化策略配置已导出保存至: ${outputPath}`);
  console.log("==================================================================");
  console.log("🎯 下一步指引：将最优策略热更新部署至远端服务");
  console.log("   npm run deploy:strategy -- --url http://<远端IP>:4111");
  console.log("   # 或者查看远端运行配置快照：");
  console.log("   npm run deploy:strategy -- --url http://<远端IP>:4111 --get");
  console.log("==================================================================");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
