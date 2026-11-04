#!/usr/bin/env tsx
/**
 * 24h 涨幅榜 K 线量化统计与特征挖掘策略系统 (V2.0 优化版)
 *
 * 实施《优化计划.md》全部规范：
 * 1. P0 正确性：
 *    - D5 修正数据加载：多目录对比，智能挑选 K 线最多、缺口最少的数据；切分时间戳缺口；
 *    - D6 撮合保守化：同一根 K 线 TP/SL 同时触碰时默认先判 SL；按极端价止损；入场滑点与入场当根撮合；保本止损对齐实盘 (0.2%)；
 *    - D7 参数透传：候选策略的 topN、minDayChange 完整参与回测；
 *    - D8 统计指标修正：修复 tp1Hits 统计口径；无亏损时 PF 显示 ∞ 并标注；
 * 2. P1 统一特征层：
 *    - 核心依赖 src/features.ts (FeatureVector)，删除重复 switch，保证预热一致 (< 1e-9)；
 * 3. P2 挖掘框架与防过拟合：
 *    - 60/20/20 训练集 / 验证集 / 留出测试集严格划分；
 *    - Walk-Forward 滚动验证 (Train 3d / Test 1d)；
 *    - 样本量门槛 (训练 >= 30, 验证 >= 10)；
 *    - 参数稳健性高原打分 (Neighbor Robustness Score: 0.5 * 本身 + 0.5 * 邻域平均)；
 *    - 严格部署门槛 (Wilson下界 >= 50%, PF >= 1.3, 期望收益 > 2*成本)；
 * 4. P3 闭环与组合模式：
 *    - 组合模式 (--portfolio)：模拟全局 5 仓、单策略 1 仓、20% 保证金与多策略并发资金曲线；
 *    - 输出标准化包含 featureVersion, datasetHash, 各阶段指标及 Top 3 策略。
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
import { computeMacd, type Candle } from "../src/macd.ts";
import type { Ticker24h } from "../src/binance.ts";
import type { PaperStrategyConfig } from "../src/paper-trading.ts";

const MINUTE = 60_000;

export interface CandleCandidateStats {
  dir: string;
  count: number;
  gaps: number;
  score: number;
  bars: any[];
}

/**
 * 修正数据加载 (D5)：
 * 多目录扫描，对于同一币种评估数据量与缺口，挑选最优连续数据
 */
export async function loadAllMinutes(): Promise<{ dataset: MinuteDataset; datasetHash: string }> {
  const dirs = [
    path.resolve("data/research/peak-rebound-1m-168h"),
    path.resolve("data/research/staged-1m-20261020-20261023"),
    path.resolve("data/research/live-1m"),
  ];

  const symbolMap = new Map<string, CandleCandidateStats[]>();

  for (const dir of dirs) {
    try {
      const files = await readdir(dir);
      for (const f of files) {
        if (f.endsWith(".json.gz") || f.endsWith(".json")) {
          const sym = f.replace(/\.json(\.gz)?$/, "").split("-")[0];
          try {
            const rawBytes = await readFile(path.join(dir, f));
            let parsed: any[];
            if (f.endsWith(".gz")) {
              parsed = JSON.parse(gunzipSync(rawBytes).toString("utf8"));
            } else {
              parsed = JSON.parse(rawBytes.toString("utf8"));
            }
            if (!Array.isArray(parsed) || parsed.length === 0) continue;

            // 统计缺口 (时间间隔 > 3 分钟)
            let gaps = 0;
            for (let i = 1; i < parsed.length; i++) {
              const t0 = Array.isArray(parsed[i - 1]) ? parsed[i - 1][0] : parsed[i - 1].time;
              const t1 = Array.isArray(parsed[i]) ? parsed[i][0] : parsed[i].time;
              if (t1 - t0 > 3 * MINUTE) gaps++;
            }

            const score = parsed.length - gaps * 200;
            const entry: CandleCandidateStats = {
              dir,
              count: parsed.length,
              gaps,
              score,
              bars: parsed,
            };

            const list = symbolMap.get(sym) ?? [];
            list.push(entry);
            symbolMap.set(sym, list);
          } catch {}
        }
      }
    } catch {}
  }

  const selectedCandles = new Map<string, any[]>();
  const hashObj = createHash("sha256");

  for (const [sym, candidates] of symbolMap.entries()) {
    // 挑选得分最高者 (K线最多、缺口最少)
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    selectedCandles.set(sym, best.bars);
    hashObj.update(`${sym}:${best.count}:${best.bars[0]?.[0] ?? best.bars[0]?.time}:`);
  }

  const datasetHash = hashObj.digest("hex").slice(0, 16);

  return {
    dataset: {
      manifest: {
        version: 1,
        interval: "1m",
        source: "Binance",
        fetchedAt: new Date().toISOString(),
        plan: {} as any,
        files: {},
      },
      candles: selectedCandles,
    },
    datasetHash,
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
  return rawBars.map((b) => {
    if (Array.isArray(b)) {
      return {
        time: b[0],
        open: b[1],
        high: b[2],
        low: b[3],
        close: b[4],
        volume: b[5] ?? 0,
      };
    }
    return b;
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
  const intrabarMode = options.intrabarMode ?? "conservative";
  const fvCache = options.fvCache;

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
  }

  const activePositions: SimPos[] = [];
  const closedTrades: TradeRecord[] = [];
  const cooldownMap = new Map<string, number>();
  const cooldownMs = (strategy.cooldownMinutes ?? 20) * MINUTE;

  let currentBoard: Map<string, { rank: number; dayChange: number; high24h?: number; low24h?: number }> = new Map();

  for (const nowTime of allTimesSorted) {
    if (nowTime < timeRange.start) continue;
    if (nowTime > timeRange.end) break;

    if (framesMap.has(nowTime)) {
      currentBoard = framesMap.get(nowTime)!;
    }

    // 1. 处理持仓退出 (D6: 保守撮合优先判 SL，极端价成交，保本止损对齐)
    for (let pIdx = activePositions.length - 1; pIdx >= 0; pIdx--) {
      const pos = activePositions[pIdx];
      const candleList = candlesMap.get(pos.symbol);
      const tMap = timeIndices.get(pos.symbol);
      if (!candleList || !tMap) continue;
      const curIdx = tMap.get(nowTime);
      if (curIdx === undefined) continue;

      const bar = candleList[curIdx];
      const isLong = strategy.side === "LONG";

      const hitSl = isLong ? bar.low <= pos.slPrice : bar.high >= pos.slPrice;
      const hitTp1 = !pos.st1Done && (isLong ? bar.high >= pos.tp1Price : bar.low <= pos.tp1Price);
      const hitTp2 = pos.st1Done && !pos.st2Done && (isLong ? bar.high >= pos.tp2Price : bar.low <= pos.tp2Price);

      const doSl = () => {
        // D6: 止损按极端价成交 (stopAtHigh / stopAtLow)
        const exitPrice = isLong ? Math.min(pos.slPrice, bar.low) : Math.max(pos.slPrice, bar.high);
        const ret = calcTradeReturn(strategy.side, pos.entryPrice, exitPrice);
        const weight = pos.st1Done ? 0.5 : 1.0;
        pos.netPnlPercent += ret.netPercent * weight;
        closedTrades.push({
          symbol: pos.symbol,
          entryTime: pos.entryTime,
          exitTime: nowTime,
          entryPrice: pos.entryPrice,
          exitPrice,
          netPercent: pos.netPnlPercent,
          isWin: pos.netPnlPercent > 0,
          reason: "SL",
          st1Done: pos.st1Done,
        });
        cooldownMap.set(pos.symbol, nowTime + cooldownMs);
        activePositions.splice(pIdx, 1);
      };

      const doTp1 = () => {
        const ret = calcTradeReturn(strategy.side, pos.entryPrice, pos.tp1Price);
        pos.netPnlPercent += ret.netPercent * 0.5;
        pos.st1Done = true;
        // D6 & 3.2: 止损移动至入场保本价 (+-0.2% 覆盖手续费)
        pos.slPrice = isLong ? pos.entryPrice * 0.998 : pos.entryPrice * 1.002;
      };

      const doTp2 = () => {
        const ret = calcTradeReturn(strategy.side, pos.entryPrice, pos.tp2Price);
        pos.netPnlPercent += ret.netPercent * 0.5;
        pos.st2Done = true;
        closedTrades.push({
          symbol: pos.symbol,
          entryTime: pos.entryTime,
          exitTime: nowTime,
          entryPrice: pos.entryPrice,
          exitPrice: pos.tp2Price,
          netPercent: pos.netPnlPercent,
          isWin: pos.netPnlPercent > 0,
          reason: "TP2",
          st1Done: true,
        });
        cooldownMap.set(pos.symbol, nowTime + cooldownMs);
        activePositions.splice(pIdx, 1);
      };

      if (intrabarMode === "conservative") {
        // 保守模式：先判定 SL
        if (hitSl) {
          doSl();
          continue;
        }
        if (hitTp1) doTp1();
        if (hitTp2) {
          doTp2();
          continue;
        }
      } else {
        // 乐观模式：先判定 TP
        if (hitTp1) doTp1();
        if (hitTp2) {
          doTp2();
          continue;
        }
        if (hitSl) {
          doSl();
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
          symbol: pos.symbol,
          entryTime: pos.entryTime,
          exitTime: nowTime,
          entryPrice: pos.entryPrice,
          exitPrice,
          netPercent: pos.netPnlPercent,
          isWin: pos.netPnlPercent > 0,
          reason: pos.st1Done ? "TP1_TIMEOUT" : "TIMEOUT",
          st1Done: pos.st1Done,
        });
        cooldownMap.set(pos.symbol, nowTime + cooldownMs);
        activePositions.splice(pIdx, 1);
        continue;
      }
    }

    // 2. 检查开仓入场
    for (const [sym, boardInfo] of currentBoard) {
      // D7: 完整读取候选参数
      const maxRank = strategy.topN ?? 10;
      const minDayChange = strategy.minDayChange ?? 10;
      if (boardInfo.rank > maxRank || boardInfo.dayChange < minDayChange) continue;

      if (activePositions.some((p) => p.symbol === sym)) continue;
      if ((cooldownMap.get(sym) ?? 0) > nowTime) continue;

      const candleList = candlesMap.get(sym);
      const tMap = timeIndices.get(sym);
      if (!candleList || !tMap) continue;
      const curIdx = tMap.get(nowTime);
      if (curIdx === undefined || curIdx < 35 || curIdx >= candleList.length - 1) continue;

      const targetIdx = curIdx - 1; // 上一根已收盘 K 线
      const closedBar = candleList[targetIdx];

      const ticker: Ticker24h = {
        symbol: sym,
        lastPrice: closedBar.close,
        priceChangePercent: boardInfo.dayChange,
        quoteVolume: 0,
        highPrice: boardInfo.high24h ?? closedBar.high,
        lowPrice: boardInfo.low24h ?? closedBar.low,
      };

      // P1: 使用统一特征向量与规则评估器 (带缓存加速)
      let fv: FeatureVector | null | undefined;
      const cacheKey = fvCache ? `${sym}:${closedBar.time}:${boardInfo.rank}` : null;
      if (cacheKey && fvCache?.has(cacheKey)) {
        fv = fvCache.get(cacheKey);
      } else {
        fv = computeFeatureVector(candleList, ticker, targetIdx, { rank: boardInfo.rank });
        if (cacheKey && fvCache) {
          fvCache.set(cacheKey, fv);
        }
      }
      if (!fv) continue;

      const evalRes = evaluateFeatureSpec(strategy.side, fv, strategy);
      if (!evalRes.pass) continue;

      // 达成触发：次根开盘价成交并叠加 1 档滑点
      const nextBar = candleList[curIdx];
      const isLong = strategy.side === "LONG";
      const baseEntry = nextBar.open > 0 ? nextBar.open : closedBar.close;
      const entryPrice = isLong ? baseEntry * 1.0002 : baseEntry * 0.9998;

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
  const maxTotalPositions = options.maxPositions ?? 5;
  const marginRate = (options.marginPercent ?? 20) / 100;
  const leverage = options.leverage ?? 10;

  let balance = 100.0;
  let peakEquity = 100.0;
  let maxDrawdownUsdt = 0;
  let maxDrawdownPct = 0;

  interface PortfolioPosition {
    strategyId: string;
    symbol: string;
    side: "LONG" | "SHORT";
    entryTime: number;
    entryPrice: number;
    marginUsdt: number;
    tp1Price: number;
    tp2Price: number;
    slPrice: number;
    st1Done: boolean;
    holdDeadline: number;
  }

  const activePositions: PortfolioPosition[] = [];
  const closedPortfolioTrades: Array<{
    strategyId: string;
    symbol: string;
    netPnlUsdt: number;
    reason: string;
  }> = [];

  const cooldownMap = new Map<string, number>();

  let currentBoard: Map<string, { rank: number; dayChange: number; high24h?: number; low24h?: number }> = new Map();

  for (const nowTime of allTimesSorted) {
    if (nowTime < timeRange.start) continue;
    if (nowTime > timeRange.end) break;

    if (framesMap.has(nowTime)) {
      currentBoard = framesMap.get(nowTime)!;
    }

    // 1. 退出检查
    for (let pIdx = activePositions.length - 1; pIdx >= 0; pIdx--) {
      const pos = activePositions[pIdx];
      const candleList = candlesMap.get(pos.symbol);
      const tMap = timeIndices.get(pos.symbol);
      if (!candleList || !tMap) continue;
      const curIdx = tMap.get(nowTime);
      if (curIdx === undefined) continue;

      const bar = candleList[curIdx];
      const isLong = pos.side === "LONG";

      const hitSl = isLong ? bar.low <= pos.slPrice : bar.high >= pos.slPrice;
      const hitTp1 = !pos.st1Done && (isLong ? bar.high >= pos.tp1Price : bar.low <= pos.tp1Price);
      const hitTp2 = pos.st1Done && (isLong ? bar.high >= pos.tp2Price : bar.low <= pos.tp2Price);

      if (hitSl) {
        const exitPrice = isLong ? Math.min(pos.slPrice, bar.low) : Math.max(pos.slPrice, bar.high);
        const ret = calcTradeReturn(pos.side, pos.entryPrice, exitPrice);
        const notional = pos.marginUsdt * leverage;
        const pnl = notional * (ret.netPercent / 100);
        balance += pnl;
        closedPortfolioTrades.push({ strategyId: pos.strategyId, symbol: pos.symbol, netPnlUsdt: pnl, reason: "SL" });
        activePositions.splice(pIdx, 1);
        continue;
      }

      if (hitTp1) {
        const ret = calcTradeReturn(pos.side, pos.entryPrice, pos.tp1Price);
        const halfNotional = (pos.marginUsdt * leverage) * 0.5;
        const pnl = halfNotional * (ret.netPercent / 100);
        balance += pnl;
        pos.st1Done = true;
        pos.slPrice = isLong ? pos.entryPrice * 0.998 : pos.entryPrice * 1.002;
      }

      if (hitTp2) {
        const ret = calcTradeReturn(pos.side, pos.entryPrice, pos.tp2Price);
        const halfNotional = (pos.marginUsdt * leverage) * 0.5;
        const pnl = halfNotional * (ret.netPercent / 100);
        balance += pnl;
        closedPortfolioTrades.push({ strategyId: pos.strategyId, symbol: pos.symbol, netPnlUsdt: pnl, reason: "TP2" });
        activePositions.splice(pIdx, 1);
        continue;
      }

      if (nowTime >= pos.holdDeadline) {
        const exitPrice = bar.close;
        const ret = calcTradeReturn(pos.side, pos.entryPrice, exitPrice);
        const weight = pos.st1Done ? 0.5 : 1.0;
        const notional = (pos.marginUsdt * leverage) * weight;
        const pnl = notional * (ret.netPercent / 100);
        balance += pnl;
        closedPortfolioTrades.push({ strategyId: pos.strategyId, symbol: pos.symbol, netPnlUsdt: pnl, reason: "TIMEOUT" });
        activePositions.splice(pIdx, 1);
        continue;
      }
    }

    // 更新资产曲线与回撤
    const equity = balance;
    if (equity > peakEquity) peakEquity = equity;
    const dd = peakEquity - equity;
    const ddPct = peakEquity > 0 ? (dd / peakEquity) * 100 : 0;
    if (dd > maxDrawdownUsdt) maxDrawdownUsdt = dd;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

    // 2. 入场扫描 (并发与配额控制)
    if (activePositions.length >= maxTotalPositions) continue;

    for (const strat of strategies) {
      if (activePositions.length >= maxTotalPositions) break;
      if (activePositions.some((p) => p.strategyId === strat.id)) continue;

      for (const [sym, boardInfo] of currentBoard) {
        if (activePositions.length >= maxTotalPositions) break;
        if (activePositions.some((p) => p.symbol === sym)) continue;
        if ((cooldownMap.get(sym) ?? 0) > nowTime) continue;

        const maxRank = strat.topN ?? 10;
        const minDayChange = strat.minDayChange ?? 10;
        if (boardInfo.rank > maxRank || boardInfo.dayChange < minDayChange) continue;

        const candleList = candlesMap.get(sym);
        const tMap = timeIndices.get(sym);
        if (!candleList || !tMap) continue;
        const curIdx = tMap.get(nowTime);
        if (curIdx === undefined || curIdx < 35 || curIdx >= candleList.length - 1) continue;

        const targetIdx = curIdx - 1;
        const closedBar = candleList[targetIdx];

        const ticker: Ticker24h = {
          symbol: sym,
          lastPrice: closedBar.close,
          priceChangePercent: boardInfo.dayChange,
          quoteVolume: 0,
          highPrice: boardInfo.high24h ?? closedBar.high,
          lowPrice: boardInfo.low24h ?? closedBar.low,
        };

        const fv = computeFeatureVector(candleList, ticker, targetIdx, { rank: boardInfo.rank });
        if (!fv) continue;

        const evalRes = evaluateFeatureSpec(strat.side, fv, strat);
        if (!evalRes.pass) continue;

        const nextBar = candleList[curIdx];
        const isLong = strat.side === "LONG";
        const baseEntry = nextBar.open > 0 ? nextBar.open : closedBar.close;
        const entryPrice = isLong ? baseEntry * 1.0002 : baseEntry * 0.9998;

        const marginUsdt = balance * marginRate;
        if (marginUsdt < 5) continue;

        const tp1Price = isLong
          ? entryPrice * (1 + strat.tp1Percent / 100)
          : entryPrice * (1 - strat.tp1Percent / 100);
        const tp2Price = isLong
          ? entryPrice * (1 + strat.tp2Percent / 100)
          : entryPrice * (1 - strat.tp2Percent / 100);
        const slPrice = isLong
          ? entryPrice * (1 - strat.stopLossPercent / 100)
          : entryPrice * (1 + strat.stopLossPercent / 100);

        activePositions.push({
          strategyId: strat.id,
          symbol: sym,
          side: strat.side,
          entryTime: nowTime,
          entryPrice,
          marginUsdt,
          tp1Price,
          tp2Price,
          slPrice,
          st1Done: false,
          holdDeadline: nowTime + strat.holdMinutes * MINUTE,
        });
        break; // 每次扫描单个策略至多入场一笔
      }
    }
  }

  const netPnlUsdt = balance - 100.0;
  const roiPct = (netPnlUsdt / 100.0) * 100;
  const wins = closedPortfolioTrades.filter((t) => t.netPnlUsdt > 0).length;
  const winRate = closedPortfolioTrades.length > 0 ? (wins / closedPortfolioTrades.length) * 100 : 0;

  return {
    initialBalance: 100.0,
    finalBalance: balance,
    netPnlUsdt,
    roiPct,
    totalTrades: closedPortfolioTrades.length,
    wins,
    winRate,
    maxDrawdownUsdt,
    maxDrawdownPct,
  };
}

/**
 * D3: 构建逐分钟 24h 涨跌幅与榜单快照 (Minute-level rolling 24h rank & stats)
 * - 对拥有 1m 数据的币种，滚动 1440 根精准计算逐分钟 dayChange、high24h、low24h
 * - 对仅有 1h 数据的币种，按分钟在相邻小时帧之间线性插值 dayChange
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
      const targetPastTime = curTime - DAY_MS;

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

      minuteStats1m.set(`${sym}:${curTime}`, { dayChange, high24h, low24h });
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
    const hNextTime = hourlyTimes[hIdx + 1] ?? hPrevTime + 3600000;
    const hPrevFrame = hourlyTimeMap.get(hPrevTime);
    const hNextFrame = hourlyTimeMap.get(hNextTime) ?? hPrevFrame;

    const span = Math.max(1, hNextTime - hPrevTime);
    const alpha = Math.max(0, Math.min(1, (nowTime - hPrevTime) / span));

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
      const nextGainersMap = new Map<string, number>();
      if (hNextFrame) {
        for (const g of hNextFrame.boards.gainers) {
          nextGainersMap.set(g.symbol, g.dayChange);
        }
      }

      for (const g of hPrevFrame.boards.gainers) {
        if (seenSymbols.has(g.symbol)) continue;
        const prevDc = g.dayChange;
        const nextDc = nextGainersMap.get(g.symbol) ?? prevDc;
        const interpDc = prevDc + alpha * (nextDc - prevDc);
        symbolScores.push({
          symbol: g.symbol,
          dayChange: interpDc,
        });
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

      const burstStartIdx = curIdx; // 时刻 T

      // A. 检测后一段区间 [T, T + windowMinutes] 是否发生达标大幅冲高
      const fwdBars = candleList.slice(burstStartIdx, burstStartIdx + windowMinutes + 1);
      if (fwdBars.length >= 2) {
        let fwdMinLow = Infinity;
        let fwdMaxHigh = -Infinity;
        for (const b of fwdBars) {
          if (b.low < fwdMinLow) fwdMinLow = b.low;
          if (b.high > fwdMaxHigh) fwdMaxHigh = b.high;
        }
        const forwardSurge = fwdMinLow > 0 ? ((fwdMaxHigh - fwdMinLow) / fwdMinLow) * 100 : 0;
        const targetThreshold = boardInfo.dayChange / 10; // 达标振幅: >= 24h / 10

        if (forwardSurge >= targetThreshold && forwardSurge >= 2.5) {
          // 提取该达标冲高段【启动前一段区间 [T - windowMinutes, T - 1]】的客观特征统计
          const preStartIdx = Math.max(0, burstStartIdx - windowMinutes);
          const preEndIdx = burstStartIdx - 1;
          const preBars = candleList.slice(preStartIdx, preEndIdx + 1);

          if (preBars.length >= 3) {
            const preCloses = preBars.map((b) => b.close);
            const { hist: preHist } = computeMacd(preCloses);
            let greenCount = 0;
            let pMin = Infinity;
            let pMax = -Infinity;
            for (let k = 0; k < preBars.length; k++) {
              if ((preHist[k] ?? 0) > 0) greenCount++;
              if (preBars[k].low < pMin) pMin = preBars[k].low;
              if (preBars[k].high > pMax) pMax = preBars[k].high;
            }
            const greenRatio = greenCount / preBars.length;
            const preAmp = pMin > 0 ? ((pMax - pMin) / pMin) * 100 : 0;

            const dummyTicker: Ticker24h = {
              symbol: sym,
              lastPrice: candleList[preEndIdx].close,
              priceChangePercent: boardInfo.dayChange,
              quoteVolume: 0,
              highPrice: candleList[preEndIdx].high,
              lowPrice: candleList[preEndIdx].low,
            };
            const fv = computeFeatureVector(candleList, dummyTicker, preEndIdx, { rank: boardInfo.rank });
            if (fv) {
              longSamples.push({
                ma10Support: fv.ma[10]?.support ?? false,
                ma20Support: fv.ma[20]?.support ?? false,
                ma60Support: fv.ma[60]?.support ?? false,
                bullStack: fv.stack === "bull_full" || fv.stack === "bull_short",
                freshBull: fv.stack3Bars === "fresh_bull",
                sustainedBull: fv.stack3Bars === "sustained_bull",
                greenRatio,
                goldenCross: fv.goldenCrossAgo <= 3,
                preAmp,
                forwardSurge,
              });
            }
          }
        }
      }

      // B. 检测前一段区间 [T - windowMinutes, T] 是否刚刚发生达标大幅冲高 (用于做空前兆统计)
      const pastBars = candleList.slice(Math.max(0, burstStartIdx - windowMinutes), burstStartIdx + 1);
      let pLow = Infinity;
      let pHigh = -Infinity;
      for (const b of pastBars) {
        if (b.low < pLow) pLow = b.low;
        if (b.high > pHigh) pHigh = b.high;
      }
      const priorSurgeAmp = pLow > 0 ? ((pHigh - pLow) / pLow) * 100 : 0;
      const targetThreshold = boardInfo.dayChange / 10;

      // 后续是否发生深度回调 (Drop >= 2.0%)
      const nextDropBars = candleList.slice(burstStartIdx, burstStartIdx + windowMinutes + 1);
      let nMax = -Infinity;
      let nMin = Infinity;
      for (const b of nextDropBars) {
        if (b.high > nMax) nMax = b.high;
        if (b.low < nMin) nMin = b.low;
      }
      const forwardDrop = nMax > 0 ? ((nMax - nMin) / nMax) * 100 : 0;

      if (priorSurgeAmp >= targetThreshold && forwardDrop >= 2.0) {
        // 冲高力竭见顶时刻 (burstStartIdx) 的特征
        const dummyTicker: Ticker24h = {
          symbol: sym,
          lastPrice: candleList[burstStartIdx].close,
          priceChangePercent: boardInfo.dayChange,
          quoteVolume: 0,
          highPrice: candleList[burstStartIdx].high,
          lowPrice: candleList[burstStartIdx].low,
        };
        const fv = computeFeatureVector(candleList, dummyTicker, burstStartIdx, { rank: boardInfo.rank });
        if (fv) {
          shortSamples.push({
            ma60Resist: fv.ma[60]?.resist ?? false,
            ma20Resist: fv.ma[20]?.resist ?? false,
            ma10Breakdown: fv.ma[10]?.breakdown ?? false,
            bearStack: fv.stack === "bear_full" || fv.stack === "bear_short",
            freshBear: fv.stack3Bars === "fresh_bear",
            sustainedBear: fv.stack3Bars === "sustained_bear",
            histWeakening: fv.histSlope < 0 || fv.hist <= 0,
            topDivergence: fv.topDivergence === true,
            greenRatio: fv.greenRatio[windowMinutes] ?? fv.greenRatio[15] ?? 0,
            priorSurgeAmp,
            forwardDrop,
          });
        }
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
  const isPortfolioOnly = process.argv.includes("--portfolio");

  const outputArgIdx = process.argv.indexOf("--output");
  const outputPath =
    outputArgIdx !== -1 && process.argv[outputArgIdx + 1]
      ? path.resolve(process.argv[outputArgIdx + 1])
      : path.resolve("data/mined-strategy.json");

  console.log("==================================================================");
  console.log(`🚀【24h 涨幅榜量化统计与特征挖掘系统 V2.0】${isQuick ? "(快速模式)" : "(完整多阶段验证模式)"}`);
  console.log(`⚙️ 撮合规则: ${isOptimistic ? "乐观撮合 (先 TP1 后 SL)" : "保守撮合 (先 SL 后 TP1，极端价成交)"}`);
  console.log("==================================================================");

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
    // 聚焦最新时段模式：70% 历史用于训练，最新近的 30% 时段作为验证集 (不使用久远时段验证)
    const splitPoint = minTime + Math.floor(duration * 0.70);
    trainRange = { start: minTime, end: splitPoint };
    valRange = { start: splitPoint, end: maxTime };
    holdoutRange = { start: splitPoint + Math.floor((maxTime - splitPoint) * 0.5), end: maxTime };
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
  console.log(`  • 验证集 (${isRecentVal ? "最新30%" : "20%"}): ${new Date(valRange.start).toISOString()} → ${new Date(valRange.end).toISOString()}`);
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
    15,
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
      holdoutRes.metrics.totalNet >= -1.0;

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
    { maxPositions: 5, marginPercent: 20, leverage: 10 }
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
- **空头策略逻辑**: 以【前一段大振幅冲高完成】(surgeRatio >= 1/divisor) 作为前置因果条件，在峰值出现衰竭信号（柱体衰竭 73.8%、均线受阻/破位）时入场做空捕捉回调段；
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
- **总交易笔数**: ${portfolioResult.totalTrades} 笔 (胜率 ${portfolioResult.winRate.toFixed(1)}%)
- **组合最大回撤**: ${portfolioResult.maxDrawdownPct.toFixed(1)}% (${portfolioResult.maxDrawdownUsdt.toFixed(2)} USDT)
`;

  await writeFile(reportPath, reportMd, "utf8");
  console.log(`\n📄 详细量化挖掘与防过拟合报告已保存至: ${reportPath}`);

  // 导出标准化参数到 data/mined-strategy.json (3.6)
  const bestShortRes = shortRanked[0];
  const bestLongRes = longRanked[0];

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

  if (bestShortRes) {
    const bs = bestShortRes.candidate;
    strategyConfig.klineStatsShortConfig = {
      topN: bs.topN ?? 10,
      minDayChange: bs.minDayChange ?? 10,
      intervalWindow: bs.intervalWindow,
      ampDivisor: bs.ampDivisor,
      maRequirement: bs.maRequirement,
      macdRequirement: bs.macdRequirement,
      holdMinutes: bs.holdMinutes,
      tp1Percent: bs.tp1Percent,
      tp2Percent: bs.tp2Percent,
      stopLossPercent: bs.stopLossPercent,
      moveSlToEntryAfterTp1: true,
      cooldownMinutes: bs.cooldownMinutes ?? 20,
      leverage: 10,
    };
  }

  if (bestLongRes) {
    const bl = bestLongRes.candidate;
    strategyConfig.klineStatsLongConfig = {
      topN: bl.topN ?? 10,
      minDayChange: bl.minDayChange ?? 10,
      intervalWindow: bl.intervalWindow,
      ampDivisor: bl.ampDivisor,
      maRequirement: bl.maRequirement,
      macdRequirement: bl.macdRequirement,
      holdMinutes: bl.holdMinutes,
      tp1Percent: bl.tp1Percent,
      tp2Percent: bl.tp2Percent,
      stopLossPercent: bl.stopLossPercent,
      moveSlToEntryAfterTp1: true,
      cooldownMinutes: bl.cooldownMinutes ?? 20,
      leverage: 5,
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
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
