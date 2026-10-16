// "无支撑 + 5m DIFF中 + (1m中+连阳 / 1m低+连阴) + 现价<近1500根最高价*0.96 + 现价<整点第一分钟最低*0.9" 监控告警
//
// 判定规则（必须同时满足以下所有条件）：
//   1. 现价必须严格小于近 1500 根最高价的 96%（row.lastPrice < row.max1500 * 0.96）
//   2. 现价必须严格小于最近一个整点第一分钟的最低价的 90%（row.lastPrice < row.hourFirstLow * 0.9）
//   3. 无支撑 (!row.supportMa)
//   4. 5m DIFF为中 (diff5mLevel === 'mid')
//   5. 非置顶币种需满足 60D 涨幅 > 0 (row.change60d === 'up')
//   6. 满足以下任意一组形态：
//      - 1m DIFF为中 且 连阳 (diff1mLevel === 'mid' && streakDir === 'up' && streakCount >= 2)
//      - 1m DIFF为低 且 连阴 (diff1mLevel === 'low' && streakDir === 'down' && streakCount >= 2)
//
// 告警逻辑：
//   - 两个榜（24h涨幅榜、跌幅榜），任意榜出现 ≥ TG_ALERT_MIN (默认 3) 个满足条件的币种时进入关注。
//   - 每个榜记录上次播报时的币种列表 JSON。
//   - 每次检测比对各榜：只要某个榜「达标且币种与上次存的 JSON 不同」，就播报该榜，并更新该榜存的 JSON。
//   - 每次只播报达标的榜，其他榜不播报；榜币没变绝不重复播报。

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
  losers: Row[];
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

/** 筛选满足「无支撑+1mDIFF中+5mDIFF中+连阳 或 无支撑+1mDIFF低+5mDIFF中+连阴」的币种及连数详情（保留原榜单顺序并去重，非置顶需 60D 涨幅 > 0） */
export function pickHighBullItems(rows: Row[], pinnedSymbols: Set<string> = new Set()): AlertSymbolItem[] {
  const hit = new Set<string>();
  const items: AlertSymbolItem[] = [];
  for (const r of rows) {
    const isPinned = pinnedSymbols.has(r.symbol);
    if (isAlertMatch(r, isPinned) && !hit.has(r.symbol)) {
      hit.add(r.symbol);
      items.push({
        symbol: r.symbol,
        streakCount: r.streakCount ?? 0,
        streakDir: r.streakDir ?? null,
        diff1mLevel: r.diff1mLevel ?? null,
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

// 兼容老方法签名（不支持 60D 涨幅过滤，默认为非置顶币种）
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

  const header = `🚨 <b>无支撑 + 5m DIFF中 + (1m中+连阳 / 1m低+连阴) 告警</b>（现价&lt;1500根高点96% | 现价&lt;整点第一分钟最低90% | 触发阈值 ≥ ${min}）`;
  const dashboardUrl = getDashboardUrl();

  let pinnedBlock = "";
  if (pinned && pinned.length > 0) {
    const list = pinned
      .map((item) => {
        const streak = formatStreak(item.streakCount, item.streakDir, item.diff1mLevel);
        const streakSuffix = streak ? ` (${streak})` : "";
        return `• 📌 <a href="https://www.binance.com/zh-CN/futures/${item.symbol}"><b>${item.symbol}</b></a>${streakSuffix}`;
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
        .map((item) => {
          const streak = formatStreak(item.streakCount, item.streakDir, item.diff1mLevel);
          const streakSuffix = streak ? ` (${streak})` : "";
          let rankTag = "";
          if (item.isDropped) {
            rankTag = " [跌出前十↓]";
          } else if (item.rank != null && item.rankChange === "up") {
            rankTag = item.rankDelta ? ` [#${item.rank} ↑+${item.rankDelta}]` : ` [#${item.rank} ↑]`;
          } else if (item.rank != null && item.rankChange === "down") {
            rankTag = item.rankDelta ? ` [#${item.rank} ↓${item.rankDelta}]` : ` [#${item.rank} ↓]`;
          }
          return `• <a href="https://www.binance.com/zh-CN/futures/${item.symbol}"><b>${item.symbol}</b></a>${streakSuffix}${rankTag}`;
        })
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
  /** 每个榜上次成功播报时的币种列表 JSON（null 表示尚未播报过或已清空） */
  private savedBoards: Record<BoardKey, string[] | null> = {
    gainers: null,
    losers: null,
  };

  /** 获取当前榜单存的 JSON 数据副本 */
  getSavedBoards(): Record<BoardKey, string[] | null> {
    return JSON.parse(JSON.stringify(this.savedBoards));
  }

  /** 获取最近一次通知状态统计（兼容接口） */
  getLastNotifiedCounts(): BoardCounts | null {
    if (!this.savedBoards.gainers && !this.savedBoards.losers) {
      return null;
    }
    return {
      gainers: this.savedBoards.gainers?.length ?? 0,
      losers: this.savedBoards.losers?.length ?? 0,
    };
  }

  /** 重置所有榜单存储的 JSON */
  resetState(): void {
    this.savedBoards = {
      gainers: null,
      losers: null,
    };
  }

  async check(
    input: AlertInput | Row[][],
  ): Promise<{ summary: HighBullSummary; sent?: TelegramSendResult }> {
    const min = Number(process.env.TG_ALERT_MIN ?? 3);

    let gainersRows: Row[];
    let losersRows: Row[];
    let pinnedRows: Row[] = [];

    const PINNED_SYMBOLS = ["BTCUSDT", "SOLUSDT"];

    if (Array.isArray(input)) {
      gainersRows = input[0] ?? [];
      losersRows = input[1] ?? [];
    } else {
      gainersRows = input.gainers ?? [];
      losersRows = input.losers ?? [];
      pinnedRows = input.pinned ?? [];
    }

    // 若未显式传入 pinned，从榜单数据中查找置顶标的
    if (pinnedRows.length === 0) {
      const allRows = [...gainersRows, ...losersRows];
      const seen = new Set<string>();
      for (const sym of PINNED_SYMBOLS) {
        const r = allRows.find((row) => row.symbol === sym);
        if (r && !seen.has(r.symbol)) {
          seen.add(r.symbol);
          pinnedRows.push(r);
        }
      }
    }

    const pinnedItems: AlertSymbolItem[] = pinnedRows.map((r) => ({
      symbol: r.symbol,
      streakCount: r.streakCount ?? 0,
      streakDir: r.streakDir ?? null,
    }));

    // 涨幅榜和跌幅榜排除置顶标的，确保不把置顶标的算进涨跌榜的播报和计数中
    const pinnedSymbols = new Set(PINNED_SYMBOLS);
    for (const r of pinnedRows) {
      pinnedSymbols.add(r.symbol);
    }
    const isPinned = (r: Row) => Boolean(r.isPinned) || pinnedSymbols.has(r.symbol);

    const cleanGainersRows = gainersRows.filter((r) => !isPinned(r));
    const cleanLosersRows = losersRows.filter((r) => !isPinned(r));

    const gainersItems = pickHighBullItems(cleanGainersRows, pinnedSymbols);
    const losersItems = pickHighBullItems(cleanLosersRows, pinnedSymbols);

    const boards: { key: BoardKey; info: BoardAlertInfo; icon: string }[] = [
      {
        key: "gainers",
        icon: "📈",
        info: {
          name: "↑↑涨幅榜(24h)↑↑",
          count: gainersItems.length,
          symbols: gainersItems.map((i) => i.symbol),
          items: gainersItems,
          triggered: gainersItems.length >= min,
        },
      },
      {
        key: "losers",
        icon: "📉",
        info: {
          name: "↘︎↘︎跌幅榜(24h)↘︎↘︎",
          count: losersItems.length,
          symbols: losersItems.map((i) => i.symbol),
          items: losersItems,
          triggered: losersItems.length >= min,
        },
      },
    ];

    const summary: HighBullSummary = {
      min,
      triggered: boards.some((b) => b.info.triggered),
      gainers: boards[0].info,
      losers: boards[1].info,
    };

    // 当榜单数量归 0 时清空对应存储的 json，待下轮达标时可重新报
    for (const b of boards) {
      if (b.info.count === 0) {
        this.savedBoards[b.key] = null;
      }
    }

    // 核心逻辑：比对每个榜，筛选「达标 (count >= min) 且 与上次存的 JSON 币种不同」的榜
    const boardsToAlert = boards.filter((b) => {
      if (!b.info.triggered) return false;
      const last = this.savedBoards[b.key];
      if (last === null) return true; // 首次达标
      return !isSameSymbols(b.info.symbols, last); // 达标且与存的 json 不同
    });

    // 如果没有任何榜「达标且不同」，不播报
    if (boardsToAlert.length === 0) {
      return { summary };
    }

    // 每次只播报达标且有更新的榜，每条播报均附带固定的置顶标的（BTC、SOL）
    const message = formatAlertMessage({
      min,
      boards: boardsToAlert.map((b) => ({ info: b.info, icon: b.icon })),
      pinned: pinnedItems,
    });

    const sent = await this.deliver(message);
    if (sent.ok) {
      // 播报成功，更新对应榜存储的 JSON
      for (const b of boardsToAlert) {
        this.savedBoards[b.key] = [...b.info.symbols].sort();
      }
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
