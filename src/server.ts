// Local HTTP server: serves a dashboard at / and JSON status at /api/status.
// The status is refreshed on a short TTL so the page can poll without hammering Binance.

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  fetch24hTickers,
  pickTops,
  fetch1mCandles,
  fetchWeeklyOpen,
  getBackoffStatus,
  type Ticker24h,
  type TickerTops,
} from "./binance.ts";
import { analyzeMacd, consecutiveStreak, calculateSupportMa } from "./macd.ts";
import { TelegramAlerter } from "./alert.ts";
import { telegramConfigured } from "./telegram.ts";
import { enrichRankChanges, type BoardSnapshot } from "./rank.ts";
import type { Row, Status } from "./types.ts";

// Directory the built React frontend is emitted to (web/dist). In dev you run
// Vite separately (npm run dev:web), so this dir may not exist — the server
// then returns a hint instead of the SPA shell.
const WEB_DIST = path.join(process.cwd(), "web", "dist");

const PORT = process.env.PORT ? Number(process.env.PORT) : 4111;
const TOP_N = Number(process.env.TOP_N ?? 10);
const REFRESH_TTL_MS = Number(process.env.REFRESH_TTL_MS ?? 60_000); // 默认 60s 刷新一次，对齐 1m K 线收盘周期并防止 API 超频
const KLINE_LIMIT = Number(process.env.KLINE_LIMIT ?? 100);
// "High position" = current DEA is at/near the highest DEA in the window.
const HIGH_RATIO = Number(process.env.HIGH_RATIO ?? 0.8); // within 80% of the window peak
const HIGH_WINDOW = Number(process.env.HIGH_WINDOW ?? 100); // observation window in 1m bars

// Telegram alert: 当三个榜单任意一个出现 ≥ TG_ALERT_MIN 个「DEA高位 + DIFF多头」时发出通知。
// 首次命中时通知，持续命中期间不因数量变化而重复播报。
const alerter = new TelegramAlerter();

let cache: { at: number; promise: Promise<Status> } | null = null;

/**
 * 并发拉取单币种的指标（1m K 线与周 K 开盘价），并发数适度控制以防瞬时尖峰。
 */
async function fetchRowData(t: Ticker24h): Promise<Row> {
  try {
    const [candles, weekOpen] = await Promise.all([
      fetch1mCandles(t.symbol, KLINE_LIMIT),
      fetchWeeklyOpen(t.symbol),
    ]);
    const sig = analyzeMacd(candles.map((c) => c.close), {
      highRatio: HIGH_RATIO,
      highWindow: HIGH_WINDOW,
    });
    const streak = consecutiveStreak(candles);
    const supportMa = calculateSupportMa(candles);
    const deaLevel =
      sig == null
        ? null
        : sig.highPosition
          ? "high"
          : sig.dea >= 0
            ? "mid"
            : "low";
    const weekChangePercent =
      weekOpen != null && weekOpen > 0
        ? ((t.lastPrice - weekOpen) / weekOpen) * 100
        : null;
    return {
      ...t,
      state: sig?.state ?? "n/a",
      alert: sig?.alert ?? false,
      bullish: sig ? !sig.deathCross : null,
      high: sig ? sig.highPosition : null,
      dea: sig?.dea ?? null,
      deaLevel,
      weekChangePercent,
      supportMa,
      streakCount: streak.count,
      streakDir: streak.direction,
    };
  } catch (e) {
    if (getBackoffStatus().active) {
      throw e;
    }
    return {
      ...t,
      state: "err",
      alert: false,
      bullish: null,
      high: null,
      dea: null,
      deaLevel: null,
      weekChangePercent: null,
      supportMa: null,
      streakCount: 0,
      streakDir: null,
    };
  }
}

const PINNED_SYMBOLS = ["BTCUSDT", "SOLUSDT"];

let lastSnapshot: BoardSnapshot | null = null;

export function getLastSnapshotForTest(): BoardSnapshot | null {
  return lastSnapshot;
}

export function resetSnapshotForTest(): void {
  lastSnapshot = null;
}

/**
 * 对涨跌幅榜、置顶币种及跌出前十币种做全局去重，避免相同币种重复向币安发起 K 线请求。
 */
async function buildBoards(
  tops: TickerTops,
  pinnedTickers: Ticker24h[] = [],
  droppedGainerTickers: Ticker24h[] = [],
  droppedLoserTickers: Ticker24h[] = [],
): Promise<{
  gainers: Row[];
  losers: Row[];
  pinned: Row[];
  droppedGainers: Row[];
  droppedLosers: Row[];
}> {
  // 收集置顶币种与所有榜单的唯一币种并保留最新行情
  const uniqueTickers = new Map<string, Ticker24h>();
  for (const t of [
    ...pinnedTickers,
    ...tops.gainers,
    ...tops.losers,
    ...droppedGainerTickers,
    ...droppedLoserTickers,
  ]) {
    if (!uniqueTickers.has(t.symbol)) {
      uniqueTickers.set(t.symbol, t);
    }
  }

  const queue = Array.from(uniqueTickers.values());
  const resultMap = new Map<string, Row>();
  // 限制 2 个并发 worker，并在批次间增加平滑微小间隔（60ms），平缓打散请求，避免突发瞬时尖峰引发 418/429
  const workers = Array.from({ length: 2 }, async () => {
    while (queue.length) {
      if (getBackoffStatus().active) break;
      const item = queue.shift()!;
      const row = await fetchRowData(item);
      resultMap.set(item.symbol, row);
      if (queue.length > 0) {
        await new Promise((r) => setTimeout(r, 60));
      }
    }
  });
  await Promise.all(workers);

  if (getBackoffStatus().active) {
    throw new Error(getBackoffStatus().reason || "Binance 触发限频/封禁");
  }

  return {
    pinned: pinnedTickers.map((t) => resultMap.get(t.symbol)!).filter(Boolean),
    gainers: tops.gainers.map((t) => resultMap.get(t.symbol)!).filter(Boolean),
    losers: tops.losers.map((t) => resultMap.get(t.symbol)!).filter(Boolean),
    droppedGainers: droppedGainerTickers.map((t) => resultMap.get(t.symbol)!).filter(Boolean),
    droppedLosers: droppedLoserTickers.map((t) => resultMap.get(t.symbol)!).filter(Boolean),
  };
}

async function refresh(): Promise<Status> {
  const base = process.env.BINANCE_BASE ?? "https://fapi.binance.com";
  const tickers = await fetch24hTickers();
  const tickerMap = new Map(tickers.map((t) => [t.symbol, t]));
  const pinnedTickers = PINNED_SYMBOLS
    .map((sym) => tickerMap.get(sym))
    .filter(Boolean) as Ticker24h[];

  // 榜单选取 TOP_N（排除置顶的 BTC 和 SOL，避免列表重复）
  const unpinnedTickers = tickers.filter((t) => !PINNED_SYMBOLS.includes(t.symbol));
  const tops: TickerTops = pickTops(unpinnedTickers, TOP_N);

  // 找出跌出前十的标的（上期在 Top 10，但当前不在自然 Top 10 中）
  const prevGainers = lastSnapshot?.gainers ?? null;
  const prevLosers = lastSnapshot?.losers ?? null;

  const currGainerSymbols = new Set(tops.gainers.map((t) => t.symbol));
  const currLoserSymbols = new Set(tops.losers.map((t) => t.symbol));

  const droppedGainerSymbols = prevGainers
    ? prevGainers.filter((s) => !currGainerSymbols.has(s))
    : [];
  const droppedLoserSymbols = prevLosers
    ? prevLosers.filter((s) => !currLoserSymbols.has(s))
    : [];

  const droppedGainerTickers = droppedGainerSymbols
    .map((s) => tickerMap.get(s))
    .filter(Boolean) as Ticker24h[];
  const droppedLoserTickers = droppedLoserSymbols
    .map((s) => tickerMap.get(s))
    .filter(Boolean) as Ticker24h[];

  const { gainers, losers, pinned, droppedGainers, droppedLosers } = await buildBoards(
    tops,
    pinnedTickers,
    droppedGainerTickers,
    droppedLoserTickers,
  );

  // 计算排名对比与位移标记
  const rankedGainers = enrichRankChanges(gainers, droppedGainers, prevGainers);
  const rankedLosers = enrichRankChanges(losers, droppedLosers, prevLosers);

  const markedPinned: Row[] = pinned.map((p) => ({
    ...p,
    rank: null,
    prevRank: null,
    rankChange: null,
    rankDelta: null,
    isDropped: false,
    isPinned: true,
  }));

  // 涨幅榜和跌幅榜第 1、2 行均置顶插入 BTC 和 SOL，当前前十在中间，跌出前十的追加在列表尾部
  const fullGainers = [...markedPinned, ...rankedGainers.rankedTop, ...rankedGainers.rankedDropped];
  const fullLosers = [...markedPinned, ...rankedLosers.rankedTop, ...rankedLosers.rankedDropped];

  // 更新 Top 10 快照（保存当前最新的自然 Top 10）
  lastSnapshot = {
    gainers: tops.gainers.map((t) => t.symbol),
    losers: tops.losers.map((t) => t.symbol),
  };

  // Telegram alert runs only on fresh snapshots (not cached polls)，每条播报固定包含置顶标的
  const { summary: highBull } = await alerter.check({
    gainers: fullGainers,
    losers: fullLosers,
    pinned: markedPinned,
  });
  if (highBull.triggered) {
    const details = [
      highBull.gainers.triggered ? `涨幅榜(${highBull.gainers.count})` : "",
      highBull.losers.triggered ? `跌幅榜(${highBull.losers.count})` : "",
    ].filter(Boolean).join(", ");
    console.log(`[tg-alert] 命中阈值(≥${highBull.min}): ${details}`);
  }
  return {
    at: new Date().toISOString(),
    base,
    topN: TOP_N,
    highRatio: HIGH_RATIO,
    highWindow: HIGH_WINDOW,
    highBull,
    highBear: highBull,
    gainers: fullGainers,
    losers: fullLosers,
    volume: [],
  };
}

async function getStatus(): Promise<Status> {
  const now = Date.now();
  if (cache && now - cache.at < REFRESH_TTL_MS) return cache.promise;
  const promise = refresh().catch((e: unknown): Status => {
    const errorMsg = e instanceof Error ? e.message : String(e);
    return {
      at: new Date().toISOString(),
      base: process.env.BINANCE_BASE ?? "https://fapi.binance.com",
      topN: TOP_N,
      highRatio: HIGH_RATIO,
      highWindow: HIGH_WINDOW,
      gainers: [],
      losers: [],
      volume: [],
      error: errorMsg,
    };
  });
  cache = { at: now, promise };
  return promise;
}

// Background polling loop: keeps checking and alerting even if no browser client is connected.
let isPolling = false;
async function pollLoop() {
  if (isPolling) return;
  isPolling = true;
  try {
    const backoff = getBackoffStatus();
    if (backoff.active) {
      const waitSec = Math.ceil((backoff.backoffUntil - Date.now()) / 1000);
      console.warn(`[monitor] 处于避让期，跳过轮询（剩余 ${waitSec}s）：${backoff.reason}`);
      return;
    }
    await getStatus();
  } catch (e) {
    console.error("[monitor] 轮询异常:", e instanceof Error ? e.message : String(e));
  } finally {
    isPolling = false;
  }
}

// MIME types for the static assets Vite emits. Anything not listed falls back
// to application/octet-stream.
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

const DIST_HINT =
  "前端未构建：请先运行 `npm run build`（或开发时用 `npm run dev:web` 起 Vite 开 :5173）。";

// Cache the SPA shell so we don't read it from disk on every request. It only
// changes across `npm run build`, and in dev the Vite server hosts the page
// itself (this path returns the hint instead).
let indexHtml: string | null | undefined;

async function getIndex(): Promise<string | null> {
  if (indexHtml !== undefined) return indexHtml;
  try {
    indexHtml = await readFile(path.join(WEB_DIST, "index.html"), "utf8");
  } catch {
    indexHtml = null; // web/dist not built yet
  }
  return indexHtml;
}

// Serve a static file from web/dist. Returns false when the file is missing so
// the caller can fall back to the SPA shell (history-router client routes).
async function serveStatic(reqUrl: string, res: http.ServerResponse): Promise<boolean> {
  const u = new URL(reqUrl, "http://x");
  const rel = decodeURIComponent(u.pathname.slice(1)); // drop leading "/"
  if (!rel || rel.includes("..")) return false;
  const file = path.join(WEB_DIST, rel);
  if (!file.startsWith(WEB_DIST)) return false; // stay within dist
  try {
    const buf = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/api/status") {
    try {
      const status = await getStatus();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(status));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return;
  }
  const reqUrl = req.url ?? "/";
  const u = new URL(reqUrl, `http://${req.headers.host ?? "localhost"}`);

  if (u.pathname.startsWith("/go/") || (u.pathname === "/go" && u.searchParams.has("symbol"))) {
    let symbol = "";
    if (u.pathname.startsWith("/go/")) {
      symbol = u.pathname.slice(4).split("/")[0].trim().toUpperCase();
    } else {
      symbol = (u.searchParams.get("symbol") ?? "").trim().toUpperCase();
    }
    symbol = symbol.replace(/[^A-Z0-9_]/g, "");
    if (symbol) {
      res.writeHead(302, { Location: `https://www.binance.com/zh-CN/futures/${symbol}` });
      res.end();
      return;
    }
  }

  // Static asset? Try web/dist first; if missing, fall back to the SPA shell so
  // client-side routes resolve. When the frontend isn't built, return a hint.
  if (reqUrl !== "/" && (await serveStatic(reqUrl, res))) return;
  const html = await getIndex();
  if (html == null) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(DIST_HINT);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});

server.listen(PORT, () => {
  const proxy = process.env.PROXY ?? process.env.BINANCE_PROXY ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? "(direct)";
  console.log(`Binance 1m MACD monitor (u本位合约) → http://localhost:${PORT}`);
  console.log(
    `base=${process.env.BINANCE_BASE ?? "https://fapi.binance.com"}  proxy=${proxy}  topN=${TOP_N}  ttl=${REFRESH_TTL_MS}ms  highRatio=${HIGH_RATIO}  highWindow=${HIGH_WINDOW}m`,
  );
  console.log(`前端: 开发用 \`npm run dev\`（Vite 开 :5173）；生产先 \`npm run build\` 再 \`npm start\`，由后端托管 web/dist`);
  console.log(
    `Telegram: ${telegramConfigured() ? "已配置" : "未配置（TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 缺失，命中不会推送）"}  阈值 TG_ALERT_MIN=${process.env.TG_ALERT_MIN ?? 3}  恢复通知 TG_SEND_RECOVERY=${process.env.TG_SEND_RECOVERY ?? "true"}`,
  );

  // 启动后台定时轮询检测
  pollLoop();
  setInterval(pollLoop, REFRESH_TTL_MS);
});
