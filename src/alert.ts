// 24h 涨幅榜告警逻辑已彻底移除，仅保留模拟交易播报。
// 保留特征与指标辅助判定方法供分析或回测使用。

import type { Row, AlertSymbolItem } from "./types.ts";
import { isAlertMatch } from './alert-rule.ts';
export { isAlertMatch } from './alert-rule.ts';

export type BoardKey = "gainers" | "losers";

export const PINNED_SYMBOLS = ["BTCUSDT", "SOLUSDT"];

export interface BoardCounts {
  gainers: number;
  losers: number;
  volume?: number;
}

export interface AlertInput {
  gainers: Row[];
  losers?: Row[];
  volume?: Row[];
  pinned?: Row[];
}

/** 格式化连阳/连阴文案（≥2 才算连续，如 2连阳、3连阴；1 根不叫“连”，返回空字符串） */
export function formatStreak(count: number, dir: "up" | "down" | null, diff1mLevel?: "high" | "mid" | "low" | null): string {
  if (!dir || count < 2) return "";
  const name = dir === "up" ? "阳" : "阴";
  const levelSuffix = diff1mLevel ? ` 1m${diff1mLevel}` : "";
  return `${count}连${name}${levelSuffix}`;
}

/** 格式化单行标的展示文案（包含：币种、24h涨幅、连阳数、连阳涨幅、1m30upR） */
export function formatAlertItem(item: AlertSymbolItem): string {
  const change24h = item.priceChangePercent != null
    ? (item.priceChangePercent >= 0 ? `+${item.priceChangePercent.toFixed(2)}%` : `${item.priceChangePercent.toFixed(2)}%`)
    : "-";
  const streakGainStr = item.streakGainPercent != null
    ? (item.streakGainPercent >= 0 ? `+${item.streakGainPercent.toFixed(2)}%` : `${item.streakGainPercent.toFixed(2)}%`)
    : "-";
  const ratioStr = item.greenBarRatio30 != null
    ? `${(item.greenBarRatio30 * 100).toFixed(1)}%`
    : "-";
  const ratioDetail = item.greenBarCount30 != null
    ? `${item.greenBarCount30}/30 (${ratioStr})`
    : ratioStr;

  let rankTag = "";
  if (item.isDropped) {
    rankTag = " [跌出前十↓]";
  } else if (item.rank != null && item.rankChange === "up") {
    rankTag = item.rankDelta ? ` [#${item.rank} ↑+${item.rankDelta}]` : ` [#${item.rank} ↑]`;
  } else if (item.rank != null && item.rankChange === "down") {
    rankTag = item.rankDelta ? ` [#${item.rank} ↓${item.rankDelta}]` : ` [#${item.rank} ↓]`;
  } else if (item.rank != null) {
    rankTag = ` [#${item.rank}]`;
  }

  return `• <a href="https://www.binance.com/zh-CN/futures/${item.symbol}"><b>${item.symbol}</b></a> 24h: ${change24h} | 连阳数: ${item.streakCount} | 连阳涨幅: ${streakGainStr} | 1m30upR: ${ratioDetail}${rankTag}`;
}

/** 筛选满足「连阳且涨幅达到阈值 + 无任何MA支撑 + 近30根1mMACD绿柱>80%」的币种及指标详情 */
export function pickHighBullItems(rows: Row[], pinnedSymbols: Set<string> = new Set()): AlertSymbolItem[] {
  const hit = new Set<string>();
  const items: AlertSymbolItem[] = [];
  for (const r of rows) {
    const isPinned = pinnedSymbols.has(r.symbol);
    if (isAlertMatch(r, isPinned) && !hit.has(r.symbol)) {
      hit.add(r.symbol);
      items.push({
        symbol: r.symbol,
        priceChangePercent: r.priceChangePercent,
        streakCount: r.streakCount ?? 0,
        streakDir: r.streakDir ?? null,
        streakGainPercent: r.streakGainPercent ?? null,
        greenBarRatio30: r.greenBarRatio30 ?? null,
        greenBarCount30: r.greenBarCount30 ?? null,
        supportMa: r.supportMa ?? null,
        rank: r.rank ?? null,
        rankChange: r.rankChange ?? null,
        rankDelta: r.rankDelta ?? null,
        isDropped: r.isDropped ?? false,
      });
    }
  }
  return items;
}

/** 筛选满足告警条件的币种列表（保留原榜单顺序并去重） */
export function pickHighBull(rows: Row[]): string[] {
  return pickHighBullItems(rows).map((i) => i.symbol);
}

// 兼容老方法签名
export function pickHighBear(groups: Row[][]): string[] {
  const hit = new Set<string>();
  for (const rows of groups) {
    for (const r of rows) {
      if (isAlertMatch(r, false)) {
        hit.add(r.symbol);
      }
    }
  }
  return [...hit].sort();
}

/** 比对两个币种列表是否完全一致（不考虑排序差异） */
export function isSameSymbols(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((val, idx) => val === sb[idx]);
}


