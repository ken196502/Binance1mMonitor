// Local HTTP server: serves a dashboard at / and JSON status at /api/status.
// The status is refreshed on a short TTL so the page can poll without hammering Binance.

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fetch24hTickers, pickTops, fetch1mCandles, fetchWeeklyOpen, type Ticker24h, type TickerTops } from "./binance.ts";
import { analyzeMacd, consecutiveStreak } from "./macd.ts";
import { TelegramAlerter } from "./alert.ts";
import { telegramConfigured } from "./telegram.ts";
import type { Row, Status } from "./types.ts";

// Directory the built React frontend is emitted to (web/dist). In dev you run
// Vite separately (npm run dev:web), so this dir may not exist — the server
// then returns a hint instead of the SPA shell.
const WEB_DIST = path.join(process.cwd(), "web", "dist");

const PORT = process.env.PORT ? Number(process.env.PORT) : 4111;
const TOP_N = Number(process.env.TOP_N ?? 10);
const REFRESH_TTL_MS = Number(process.env.REFRESH_TTL_MS ?? 20_000); // cache the snapshot for ~20s
const KLINE_LIMIT = Number(process.env.KLINE_LIMIT ?? 100);
// "High position" = current DEA is at/near the highest DEA in the window.
const HIGH_RATIO = Number(process.env.HIGH_RATIO ?? 0.8); // within 80% of the window peak
const HIGH_WINDOW = Number(process.env.HIGH_WINDOW ?? 100); // observation window in 1m bars

// Telegram alert: 当三个榜单任意一个出现 ≥ TG_ALERT_MIN 个「DEA高位 + DIFF多头」时发出通知。
// 首次命中时通知，持续命中期间不因数量变化而重复播报。
const alerter = new TelegramAlerter();

let cache: { at: number; promise: Promise<Status> } | null = null;

async function buildRows(group: Ticker24h[]): Promise<Row[]> {
  const rows: Row[] = [];
  const queue = [...group];
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const t = queue.shift()!;
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
        rows.push({
          ...t,
          state: sig?.state ?? "n/a",
          alert: sig?.alert ?? false,
          bullish: sig ? !sig.deathCross : null,
          high: sig ? sig.highPosition : null,
          dea: sig?.dea ?? null,
          deaLevel,
          weekChangePercent,
          streakCount: streak.count,
          streakDir: streak.direction,
        });
      } catch {
        rows.push({
          ...t,
          state: "err",
          alert: false,
          bullish: null,
          high: null,
          dea: null,
          deaLevel: null,
          weekChangePercent: null,
          streakCount: 0,
          streakDir: null,
        });
      }
    }
  });
  await Promise.all(workers);
  // Preserve the original ranking order.
  const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
  return group.map((t) => bySymbol.get(t.symbol)!).filter(Boolean);
}

async function refresh(): Promise<Status> {
  const base = process.env.BINANCE_BASE ?? "https://fapi.binance.com";
  const tickers = await fetch24hTickers();
  const tops: TickerTops = pickTops(tickers, TOP_N);
  const [gainers, losers, volume] = await Promise.all([
    buildRows(tops.gainers),
    buildRows(tops.losers),
    buildRows(tops.volume),
  ]);
  // Telegram alert runs only on fresh snapshots (not cached polls).
  const { summary: highBull } = await alerter.check({ gainers, losers, volume });
  if (highBull.triggered) {
    const details = [
      highBull.gainers.triggered ? `涨幅榜(${highBull.gainers.count})` : "",
      highBull.losers.triggered ? `跌幅榜(${highBull.losers.count})` : "",
      highBull.volume.triggered ? `成交额榜(${highBull.volume.count})` : "",
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
    gainers,
    losers,
    volume,
  };
}

async function getStatus(): Promise<Status> {
  const now = Date.now();
  if (cache && now - cache.at < REFRESH_TTL_MS) return cache.promise;
  const promise = refresh().catch((e: unknown): Status => ({
    at: new Date().toISOString(),
    base: process.env.BINANCE_BASE ?? "https://fapi.binance.com",
    topN: TOP_N,
    highRatio: HIGH_RATIO,
    highWindow: HIGH_WINDOW,
    gainers: [],
    losers: [],
    volume: [],
    error: e instanceof Error ? e.message : String(e),
  }));
  cache = { at: now, promise };
  return promise;
}

// Background polling loop: keeps checking and alerting even if no browser client is connected.
let isPolling = false;
async function pollLoop() {
  if (isPolling) return;
  isPolling = true;
  try {
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
