// "连阳且涨幅达到阈值(24h涨幅/10) + 无任何MA支撑 + 近30根1mMACD绿柱>80%" 监控告警（仅播报24h涨幅榜）
//
// 判定规则（必须同时满足以下所有条件）：
//   1. 连阳且涨幅达到阈值（streakDir === 'up' && streakCount >= STREAK_MIN_COUNT && streakGainPercent >= priceChangePercent / 10）
//   2. 无任何MA支撑 (!row.supportMa)
//   3. 近30根1m MACD绿柱占比 > 80% (greenBarRatio30 > 0.8)
//
// 告警逻辑：
//   - 仅监控24h涨幅榜，当满足条件的币种数 ≥ TG_ALERT_MIN (默认 3) 时播报。
//   - 记录上次播报时的币种列表 JSON，币种没变绝不重复播报（防骚扰）。
//   - 播报字段：币种、24h涨幅、连阳数、连阳涨幅、1m30upR。

import type { Row, BoardAlertInfo, HighBullSummary, AlertSymbolItem } from "./types.ts";
import { sendTelegramMessage, telegramConfigured, type TelegramSendResult } from "./telegram.ts";
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

function getDashboardUrl(): string {
  return (process.env.DASHBOARD_URL ?? "https://macd.reluv.xyz").trim().replace(/\/+$/, "");
}

export function formatAlertMessage(params: {
  min: number;
  boards: { info: BoardAlertInfo; icon: string }[];
  pinned?: AlertSymbolItem[];
}): string {
  const { min, boards, pinned } = params;

  const header = `🚨 <b>24h涨幅榜告警：连阳涨幅≥24h涨幅/10 + 无MA支撑 + 近30根1mMACD绿柱&gt;80%</b>（触发阈值 ≥ ${min}）`;
  const dashboardUrl = getDashboardUrl();

  let pinnedBlock = "";
  if (pinned && pinned.length > 0) {
    const list = pinned
      .map((item) => {
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
        return `• 📌 <a href="https://www.binance.com/zh-CN/futures/${item.symbol}"><b>${item.symbol}</b></a> 24h: ${change24h} | 连阳数: ${item.streakCount} | 连阳涨幅: ${streakGainStr} | 1m30upR: ${ratioDetail}`;
      })
      .join("\n");
    pinnedBlock = `📌 <b>置顶标的</b>：\n${list}`;
  }

  const formatBoard = (b: BoardAlertInfo, icon: string) => {
    const items: AlertSymbolItem[] =
      b.items && b.items.length > 0
        ? b.items
        : b.symbols.map((s) => ({
            symbol: s,
            streakCount: 0,
            streakDir: null,
            rank: null,
            rankChange: null,
            rankDelta: null,
            isDropped: false,
          }));

    // 若已在置顶标的展示，则榜单中不重复列出
    const unpinnedItems = pinned && pinned.length > 0
      ? items.filter((item) => !pinned.some((p) => p.symbol === item.symbol))
      : items;

    const count = unpinnedItems.length;
    let line = `${icon} <b>${b.name}</b>：<b>${count}</b> 个`;

    if (unpinnedItems.length > 0) {
      const symList = unpinnedItems
        .map(formatAlertItem)
        .join("\n");
      return `${line}\n${symList}`;
    }
    return line;
  };

  const body = boards.map((b) => formatBoard(b.info, b.icon)).join("\n\n");
  const footer = dashboardUrl ? `🔗 <a href="${dashboardUrl}">点击查看监控面板</a>` : "";

  return [header, pinnedBlock, body, footer].filter(Boolean).join("\n\n");
}

export class TelegramAlerter {
  /** 涨幅榜上次成功播报时的币种列表（null 表示尚未播报过或已清空） */
  private savedGainers: string[] | null = null;

  /** 获取当前榜单存的 JSON 数据副本 */
  getSavedBoards(): Record<BoardKey, string[] | null> {
    return {
      gainers: this.savedGainers ? [...this.savedGainers] : null,
      losers: null,
    };
  }

  /** 获取最近一次通知状态统计 */
  getLastNotifiedCounts(): BoardCounts | null {
    if (!this.savedGainers) {
      return null;
    }
    return {
      gainers: this.savedGainers.length,
      losers: 0,
    };
  }

  /** 重置状态 */
  resetState(): void {
    this.savedGainers = null;
  }

  async check(
    input: AlertInput | Row[][],
  ): Promise<{ summary: HighBullSummary; sent?: TelegramSendResult }> {
    const min = Number(process.env.TG_ALERT_MIN ?? 3);

    let gainersRows: Row[];
    let pinnedRows: Row[] = [];

    const PINNED_SYMBOLS = ["BTCUSDT", "SOLUSDT"];

    if (Array.isArray(input)) {
      gainersRows = input[0] ?? [];
    } else {
      gainersRows = input.gainers ?? [];
      pinnedRows = input.pinned ?? [];
    }

    // 若未显式传入 pinned，从榜单数据中查找置顶标的
    if (pinnedRows.length === 0) {
      const seen = new Set<string>();
      for (const sym of PINNED_SYMBOLS) {
        const r = gainersRows.find((row) => row.symbol === sym);
        if (r && !seen.has(r.symbol)) {
          seen.add(r.symbol);
          pinnedRows.push(r);
        }
      }
    }

    const pinnedItems: AlertSymbolItem[] = pinnedRows.map((r) => ({
      symbol: r.symbol,
      priceChangePercent: r.priceChangePercent,
      streakCount: r.streakCount ?? 0,
      streakDir: r.streakDir ?? null,
      streakGainPercent: r.streakGainPercent ?? null,
      greenBarRatio30: r.greenBarRatio30 ?? null,
      greenBarCount30: r.greenBarCount30 ?? null,
    }));

    // 涨幅榜排除置顶标的，确保不把置顶标的算进涨幅榜的播报和计数中
    const pinnedSymbols = new Set(PINNED_SYMBOLS);
    for (const r of pinnedRows) {
      pinnedSymbols.add(r.symbol);
    }
    const isPinned = (r: Row) => Boolean(r.isPinned) || pinnedSymbols.has(r.symbol);

    const cleanGainersRows = gainersRows.filter((r) => !isPinned(r));
    const gainersItems = pickHighBullItems(cleanGainersRows, pinnedSymbols);

    const boardInfo: BoardAlertInfo = {
      name: "↑↑涨幅榜(24h)↑↑",
      count: gainersItems.length,
      symbols: gainersItems.map((i) => i.symbol),
      items: gainersItems,
      triggered: gainersItems.length >= min,
    };

    const summary: HighBullSummary = {
      min,
      triggered: boardInfo.triggered,
      gainers: boardInfo,
    };

    // 当榜单数量归 0 时清空存储的币种，待下轮达标时可重新报
    if (boardInfo.count === 0) {
      this.savedGainers = null;
    }

    // 筛选「达标 (count >= min) 且 与上次存的币种不同」
    if (!boardInfo.triggered) {
      return { summary };
    }

    if (this.savedGainers !== null && isSameSymbols(boardInfo.symbols, this.savedGainers)) {
      return { summary }; // 币种未变，防骚扰不重发
    }

    // 播报涨幅榜，每条播报附带固定的置顶标的（BTC、SOL）
    const message = formatAlertMessage({
      min,
      boards: [{ info: boardInfo, icon: "📈" }],
      pinned: pinnedItems,
    });

    const sent = await this.deliver(message);
    if (sent.ok) {
      this.savedGainers = [...boardInfo.symbols].sort();
    }

    return { summary, sent };
  }

  private async deliver(text: string): Promise<TelegramSendResult> {
    if (!telegramConfigured()) {
      console.warn(
        `[tg-alert] 未发送：TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 未配置。命中条件但无法通知！`,
      );
      return { ok: false, error: "not configured" };
    }
    const res = await sendTelegramMessage(text);
    if (!res.ok) {
      console.error(`[tg-alert] 发送失败: ${res.error}`);
    } else {
      console.log(`[tg-alert] Telegram 通知已成功发送`);
    }
    return res;
  }
}

