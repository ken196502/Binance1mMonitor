// Local HTTP server: serves a dashboard at / and JSON status at /api/status
// plus chart data at /api/klines. The status is refreshed on a short TTL so the
// page can poll without hammering Binance.

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  fetch24hTickers,
  pickTops,
  fetch1mCandles,
  getBackoffStatus,
  is429Active,
  waitForBackoffClear,
  onAnomalyRecovered,
  type Ticker24h,
  type TickerTops,
} from "./binance.ts";
import {
  analyzeMacd,
  analyzeDiff,
  consecutiveStreak,
  calculateStreakGain,
  calculateSupportMa,
  calculateMacdGreenBarRatio,
  type Candle,
} from "./macd.ts";
import { TelegramAlerter, isAlertMatch } from "./alert.ts";
import { telegramConfigured } from "./telegram.ts";
import { enrichRankChanges, type BoardSnapshot } from "./rank.ts";
import { wsManager, applyTradeToCandles, sanitizeCandles } from "./ws.ts";
import { buildChartPayload, parseChartQuery } from "./chart.ts";
import { paperTrading } from "./paper-trading.ts";
import type { Row, Status } from "./types.ts";

// Directory the built React frontend is emitted to (web/dist). In dev you run
// Vite separately (npm run dev:web), so this dir may not exist — the server
// then returns a hint instead of the SPA shell.
const WEB_DIST = path.join(process.cwd(), "web", "dist");

const PORT = process.env.PORT ? Number(process.env.PORT) : 4111;
const TOP_N = Number(process.env.TOP_N ?? 10);
const REFRESH_TTL_MS = Number(process.env.REFRESH_TTL_MS ?? 60_000); // 默认 60s 刷新一次，对齐 1m K 线收盘周期并防止 API 超频
const KLINE_LIMIT = Number(process.env.KLINE_LIMIT ?? 100);
const KLINE_INIT_LIMIT = Number(process.env.KLINE_INIT_LIMIT ?? 200); // 冷启动拉取 200 根 (用于 MA120 及 30 根绿柱与 MACD 计算)
const KLINE_ROLLING_LIMIT = Number(process.env.KLINE_ROLLING_LIMIT ?? 200); // 滚动存储 200 根 1m K 线
// "High position" = current DEA/DIFF is at/near the highest value in the window.
const HIGH_RATIO = Number(process.env.HIGH_RATIO ?? 0.8); // within 80% of the window peak
const HIGH_WINDOW = Number(process.env.HIGH_WINDOW ?? 100); // observation window in bars

// Telegram alert: 仅播报 24h 涨幅榜满足条件的标的
const alerter = new TelegramAlerter();

let cache: { at: number; promise: Promise<Status> } | null = null;

export interface SymbolCandleCache {
  candles1m: Candle[];
  initialized: boolean;
}

const candleCache = new Map<string, SymbolCandleCache>();

// 从 418/451 异常恢复后，对缺乏有效 K 线（<35 根）或因封禁断流数据已过期的标的标记重置冷启动
onAnomalyRecovered(() => {
  console.info(`[server] 检测到从 418/451 异常中恢复，平缓重置缺失或过期标的的冷启动状态`);
  const now = Date.now();
  for (const [_, symCache] of candleCache) {
    const lastBar = symCache.candles1m[symCache.candles1m.length - 1];
    const isStale = !lastBar || now - lastBar.time > 5 * 60_000;
    if (symCache.candles1m.length < 35 || isStale) {
      symCache.initialized = false;
    }
  }
});

// 监听 WebSocket 成交流，实时推进当前 1m K 线并驱动模拟交易撮合
wsManager.onTrade((tick) => {
  const symCache = candleCache.get(tick.symbol);
  let currentCandleHigh: number | undefined;
  let currentCandleLow: number | undefined;
  if (symCache && symCache.initialized && symCache.candles1m.length > 0) {
    symCache.candles1m = applyTradeToCandles(symCache.candles1m, tick, KLINE_ROLLING_LIMIT);
    const forming = symCache.candles1m[symCache.candles1m.length - 1];
    currentCandleHigh = forming?.high;
    currentCandleLow = forming?.low;
  }
  paperTrading.onTick(tick, currentCandleHigh, currentCandleLow);
});

export function getCandleCacheForTest(): Map<string, SymbolCandleCache> {
  return candleCache;
}

export function resetCandleCacheForTest(): void {
  candleCache.clear();
}

export interface FetchRowOptions {
  isGainerPriority?: boolean; // 是否属于涨幅榜/置顶高优先级队列
  allowRestKline?: boolean;   // 是否允许发起 REST K 线请求
  klineLimit?: number;        // 指定 K 线拉取数量
}

export interface FetchRowResult {
  row: Row;
  didRest: boolean;
}

/**
 * 拉取单币种指标：
 * 1. 仅拉取 1m K 线计算 MA 支撑、连阳连阴、及近 30 根 1m MACD 绿柱比例；
 * 2. 完成初始化后，后续滚动维护，优先依赖 WebSocket 实时成交流就地更新 K 线；
 * 3. 精确记录是否发生实际网络 REST 请求，为调用方平滑限速提供依据，彻底防止突发触发 418。
 */
async function fetchRowData(t: Ticker24h, options: FetchRowOptions = {}): Promise<FetchRowResult> {
  const {
    allowRestKline = true,
    klineLimit,
  } = options;
  let didRest = false;

  try {
    let symCache = candleCache.get(t.symbol);
    if (!symCache) {
      symCache = {
        candles1m: [],
        initialized: false,
      };
      candleCache.set(t.symbol, symCache);
    }

    const isFirstRun = !symCache.initialized;
    // 如果已经完成冷启动且本地 K 线充足，跳过 REST K 线请求，优先使用 WS 实时维持的 K 线
    const needRestKline = allowRestKline && (isFirstRun || symCache.candles1m.length < 35);
    const fetchLimit = klineLimit ?? (isFirstRun ? KLINE_INIT_LIMIT : KLINE_LIMIT);

    let candles1mRes: Candle[] = [];
    if (needRestKline) {
      if (getBackoffStatus().active) {
        throw new Error(`Binance 限频中 (${getBackoffStatus().reason})，停止拉取 ${t.symbol} K线`);
      }
      try {
        candles1mRes = await fetch1mCandles(t.symbol, fetchLimit);
        didRest = true;
      } catch (err) {
        if (getBackoffStatus().active) {
          throw err;
        }
        console.warn(`[binance] 拉取 ${t.symbol} 1m K线失败:`, (err as any)?.message ?? err);
      }
    }

    // 1m 保存：每次更新保存，若偶发网络异常则回退使用已保存的 1m 序列
    if (candles1mRes.length > 0) {
      symCache.candles1m = candles1mRes;
    }
    const candles = symCache.candles1m;

    if (isFirstRun && candles.length >= 35) {
      symCache.initialized = true;
      console.log(`[kline] ${t.symbol} 首次启动成功同步 ${candles.length} 根 1m K 线`);
    }

    const sig = analyzeMacd(candles.map((c) => c.close), {
      highRatio: HIGH_RATIO,
      highWindow: HIGH_WINDOW,
    });
    const diff1mSig = analyzeDiff(candles.map((c) => c.close), {
      highRatio: HIGH_RATIO,
      highWindow: HIGH_WINDOW,
    });

    const streak = consecutiveStreak(candles);
    const streakGainPercent = calculateStreakGain(candles, streak);
    const supportMa = calculateSupportMa(candles);
    const macdGreen = calculateMacdGreenBarRatio(candles.map((c) => c.close));

    const isMatch = isAlertMatch({
      supportMa,
      streakDir: streak.direction,
      streakCount: streak.count,
      streakGainPercent,
      priceChangePercent: t.priceChangePercent,
      greenBarRatio30: macdGreen?.ratio ?? null,
    });

    const deaLevel =
      sig == null
        ? null
        : sig.highPosition
          ? "high"
          : sig.dea >= 0
            ? "mid"
            : "low";

    return {
      row: {
        ...t,
        state: sig?.state ?? "n/a",
        alert: isMatch,
        bullish: sig ? !sig.deathCross : null,
        high: sig ? sig.highPosition : null,
        dea: sig?.dea ?? null,
        deaLevel,
        diff1m: diff1mSig?.dif ?? null,
        diff1mLevel: diff1mSig?.level ?? null,
        supportMa,
        streakCount: streak.count,
        streakDir: streak.direction,
        streakGainPercent,
        greenBarRatio30: macdGreen?.ratio ?? null,
        greenBarCount30: macdGreen?.greenCount ?? null,
      },
      didRest,
    };
  } catch (e) {
    if (getBackoffStatus().active) {
      throw e;
    }
    return {
      row: {
        ...t,
        state: "err",
        alert: false,
        bullish: null,
        high: null,
        dea: null,
        deaLevel: null,
        diff1m: null,
        diff1mLevel: null,
        supportMa: null,
        streakCount: 0,
        streakDir: null,
        streakGainPercent: null,
        greenBarRatio30: null,
        greenBarCount30: null,
      },
      didRest,
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
 * 仅同步涨幅榜与置顶标的 K 线：
 * 1. 确保涨幅榜获取完成 K 线同步（包含置顶标的 BTC/SOL 与 24h 涨幅榜标的）；
 * 2. 如果检测到 429 就立即停止 K 线同步，并立即开始 WebSocket 订阅已同步标的；
 * 3. 完全去掉跌幅榜的所有同步逻辑。
 */
export async function buildBoards(
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
  const gainerMap = new Map<string, Ticker24h>();
  for (const t of [...pinnedTickers, ...tops.gainers, ...droppedGainerTickers]) {
    if (!gainerMap.has(t.symbol)) {
      gainerMap.set(t.symbol, t);
    }
  }

  const gainersQueue = Array.from(gainerMap.values());
  const resultMap = new Map<string, Row>();
  const syncedSymbols = new Set<string>();

  for (let i = 0; i < gainersQueue.length; i++) {
    const item = gainersQueue[i];
    if (getBackoffStatus().active) {
      console.warn(`[binance] 429/418 避让生效，立即停止涨幅榜 K 线同步 (已完成 ${resultMap.size}/${gainersQueue.length})`);
      break;
    }

    const symCache = candleCache.get(item.symbol);
    const willColdStart = !symCache || !symCache.initialized || symCache.candles1m.length < 35;

    let didRest = false;
    try {
      const res = await fetchRowData(item, {
        isGainerPriority: true,
        allowRestKline: true,
        klineLimit: willColdStart ? KLINE_INIT_LIMIT : KLINE_LIMIT,
      });
      resultMap.set(item.symbol, res.row);
      syncedSymbols.add(item.symbol);
      didRest = res.didRest;
    } catch (e) {
      if (getBackoffStatus().active) {
        console.warn(`[binance] 同步涨幅榜标的 ${item.symbol} 时检测到 429/418 限频，立即停止同步: ${(e as any)?.message ?? e}`);
        break;
      }
    }

    // 平滑请求节奏防突发
    if (i < gainersQueue.length - 1 && !getBackoffStatus().active) {
      const used = getBackoffStatus().usedWeight1m;
      const delay = !didRest ? 20 : used >= 1400 ? 500 : used >= 1000 ? 300 : 200;
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  // 阶段 2：如果检测到限频或封禁，立即订阅当前已同步标的
  if (syncedSymbols.size > 0) {
    wsManager.setSymbols(Array.from(syncedSymbols));
    console.log(`[binance-ws] 已订阅当前已同步标的 (${syncedSymbols.size} 个): ${Array.from(syncedSymbols).join(", ")}`);
  }

  const backoff = getBackoffStatus();
  const remainSec = Math.ceil((backoff.backoffUntil - Date.now()) / 1000);
  const isShort429 = backoff.active && backoff.is429 && !backoff.reason.includes("418") && remainSec <= 5;

  if (isShort429) {
    console.warn(`[binance] 检测到短暂 429 限频 (剩余 ${remainSec}s)，等待冷静期结束...`);
    const cleared = await waitForBackoffClear(10_000);
    if (cleared) {
      console.log(`[binance] 429 限频已解除，检查并补全涨幅榜未完成标的...`);
      for (const item of gainersQueue) {
        if (resultMap.has(item.symbol)) continue;
        if (getBackoffStatus().active) break;
        try {
          const symCache = candleCache.get(item.symbol);
          const willColdStart = !symCache || !symCache.initialized || symCache.candles1m.length < 35;
          const res = await fetchRowData(item, {
            isGainerPriority: true,
            allowRestKline: true,
            klineLimit: willColdStart ? KLINE_INIT_LIMIT : KLINE_LIMIT,
          });
          resultMap.set(item.symbol, res.row);
          syncedSymbols.add(item.symbol);
          wsManager.setSymbols(Array.from(syncedSymbols));
        } catch (e) {
          console.warn(`[binance] 补齐涨幅榜标的 ${item.symbol} 失败:`, (e as any)?.message ?? e);
          if (getBackoffStatus().active) break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  // 涨幅榜同步完成，重新订阅全部涨幅榜与置顶标的
  const allSymbols = [
    ...pinnedTickers.map((t) => t.symbol),
    ...tops.gainers.map((t) => t.symbol),
  ];
  wsManager.setSymbols(allSymbols);
  console.log(`[binance-ws] 涨幅榜标的同步完毕，重新订阅标的 (${allSymbols.length} 个)`);

  const getRowOrFallback = (t: Ticker24h): Row => {
    return (
      resultMap.get(t.symbol) ?? {
        ...t,
        state: "n/a",
        alert: false,
        bullish: null,
        high: null,
        dea: null,
        deaLevel: null,
        diff1m: null,
        diff1mLevel: null,
        supportMa: null,
        streakCount: 0,
        streakDir: null,
        streakGainPercent: null,
        greenBarRatio30: null,
        greenBarCount30: null,
      }
    );
  };

  return {
    pinned: pinnedTickers.map(getRowOrFallback),
    gainers: tops.gainers.map(getRowOrFallback),
    losers: [],
    droppedGainers: droppedGainerTickers.map(getRowOrFallback),
    droppedLosers: [],
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
  const currGainerSymbols = new Set(tops.gainers.map((t) => t.symbol));
  const droppedGainerSymbols = prevGainers
    ? prevGainers.filter((s) => !currGainerSymbols.has(s))
    : [];

  const droppedGainerTickers = droppedGainerSymbols
    .map((s) => tickerMap.get(s))
    .filter(Boolean) as Ticker24h[];

  const { gainers, pinned, droppedGainers } = await buildBoards(
    tops,
    pinnedTickers,
    droppedGainerTickers,
    [],
  );

  // 动态同步 WebSocket 订阅列表：确保置顶、涨幅榜币种及当前处于模拟持仓中的币种全部在 WS 监听中
  const activePaperSymbols = paperTrading.getActiveSymbols();
  const allSymbols = Array.from(
    new Set([
      ...pinned.map((r) => r.symbol),
      ...gainers.map((r) => r.symbol),
      ...activePaperSymbols,
    ]),
  );
  wsManager.setSymbols(allSymbols);

  // 计算排名对比与位移标记
  const rankedGainers = enrichRankChanges(gainers, droppedGainers, prevGainers);

  const markedPinned: Row[] = pinned.map((p) => ({
    ...p,
    rank: null,
    prevRank: null,
    rankChange: null,
    rankDelta: null,
    isDropped: false,
    isPinned: true,
  }));

  // 涨幅榜第 1、2 行置顶插入 BTC 和 SOL，当前前十在中间，跌出前十的追加在列表尾部
  const fullGainers = [...markedPinned, ...rankedGainers.rankedTop, ...rankedGainers.rankedDropped];

  // 更新 Top 10 快照
  lastSnapshot = {
    gainers: tops.gainers.map((t) => t.symbol),
    losers: [],
  };

  // 触发模拟交易扫描（基于最新已收盘 1m K 线检测3大互斥做空信号：新高顶背离、首次跌10%、跌到20%+）
  try {
    await paperTrading.onScan([...tops.gainers, ...droppedGainerTickers], candleCache);
  } catch (err) {
    console.warn(`[paper-trading] 扫描信号异常:`, (err as any)?.message ?? err);
  }

  // Telegram alert runs only on fresh snapshots
  const { summary: highBull } = await alerter.check({
    gainers: [...rankedGainers.rankedTop, ...rankedGainers.rankedDropped],
    pinned: markedPinned,
  });

  if (highBull.triggered) {
    console.log(`[tg-alert] 涨幅榜命中阈值(≥${highBull.min}): ${highBull.gainers.count} 个标的`);
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
    losers: [],
    volume: [],
    paperTrading: paperTrading.getSummary(),
  };
}

let lastKnownStatus: Status | null = null;

async function getStatus(): Promise<Status> {
  const now = Date.now();
  const backoff = getBackoffStatus();
  if (cache && now - cache.at < REFRESH_TTL_MS) {
    if (!backoff.active) {
      // 避让冷静期已解除：若当前缓存为过去的错误，则跳过缓存立即重新请求，确保第一时间解封恢复
      const cached = await cache.promise;
      if (!cached.error) {
        return cached;
      }
    } else {
      return cache.promise;
    }
  }
  const promise = refresh()
    .then((status) => {
      lastKnownStatus = status;
      return status;
    })
    .catch((e: unknown): Status => {
      const errorMsg = e instanceof Error ? e.message : String(e);
      if (lastKnownStatus) {
        return {
          ...lastKnownStatus,
          at: new Date().toISOString(),
          paperTrading: paperTrading.getSummary(),
          error: errorMsg,
        };
      }
      return {
        at: new Date().toISOString(),
        base: process.env.BINANCE_BASE ?? "https://fapi.binance.com",
        topN: TOP_N,
        highRatio: HIGH_RATIO,
        highWindow: HIGH_WINDOW,
        gainers: [],
        losers: [],
        volume: [],
        paperTrading: paperTrading.getSummary(),
        error: errorMsg,
      };
    });
  cache = { at: now, promise };
  return promise;
}

// 图表用的 1m K 线：榜单内标的直接复用监控已在维护的 candleCache（含 WS 实时推进，
// 零额外请求）；榜单外标的走带 TTL 的 REST 兜底，避免多个标签页把权重打爆。
const CHART_KLINE_TTL_MS = 45_000;
const chartKlineCache = new Map<string, { at: number; promise: Promise<Candle[]> }>();

function pruneChartKlineCache(now: number): void {
  if (chartKlineCache.size <= 32) return;
  for (const [sym, entry] of chartKlineCache) {
    if (now - entry.at > CHART_KLINE_TTL_MS * 10) chartKlineCache.delete(sym);
  }
}

async function getChartCandles(
  symbol: string,
  limit: number,
): Promise<{ candles: Candle[]; source: "monitor" | "rest" }> {
  const cached = candleCache.get(symbol);
  if (cached && cached.candles1m.length > 0) {
    // 缓存由 WS 实时推进，理论上每根都已由 applyTradeToCandles 清洗过；
    // 这里再过一道，保证图表绝不会因为一根坏柱子（low/close=0）把价格轴拉到 0。
    return { candles: sanitizeCandles(cached.candles1m).slice(-limit), source: "monitor" };
  }

  const now = Date.now();
  pruneChartKlineCache(now);
  let entry = chartKlineCache.get(symbol);
  if (!entry || now - entry.at >= CHART_KLINE_TTL_MS) {
    const promise = fetch1mCandles(symbol, limit);
    entry = { at: now, promise };
    chartKlineCache.set(symbol, entry);
    // 失败不缓存，让下一次请求重新拉（klines 的重量很小，重试代价可接受）
    promise.catch(() => {
      if (chartKlineCache.get(symbol) === entry) chartKlineCache.delete(symbol);
    });
  }
  return { candles: await entry.promise, source: "rest" };
}

// GET /api/klines?symbol=BTCUSDT&limit=200 → 1m K 线 + 均线 + MACD（供页面图表渲染）
async function serveKlines(u: URL, res: http.ServerResponse): Promise<void> {
  const query = parseChartQuery(u.searchParams.get("symbol"), u.searchParams.get("limit"));
  if (!query) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "symbol 参数无效" }));
    return;
  }
  try {
    const { candles, source } = await getChartCandles(query.symbol, query.limit);
    const payload = buildChartPayload(query.symbol, candles, source);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(payload));
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }
}

// Background polling loop: keeps checking and alerting even if no browser client is connected.
let isPolling = false;
async function pollLoop() {
  if (isPolling) return;
  isPolling = true;
  try {
    paperTrading.checkTimeouts();
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

function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) {
        reject(new Error("请求体过大"));
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("无效的 JSON 格式"));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/api/status" || req.url?.startsWith("/api/status?")) {
    try {
      const status = await getStatus();
      const responseStatus: Status = {
        ...status,
        paperTrading: paperTrading.getSummary(),
      };
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(responseStatus));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        error: e instanceof Error ? e.message : String(e),
        paperTrading: paperTrading.getSummary(),
      }));
    }
    return;
  }
  const reqUrl = req.url ?? "/";
  const u = new URL(reqUrl, `http://${req.headers.host ?? "localhost"}`);

  if (u.pathname === "/api/paper-trading/reset") {
    paperTrading.reset();
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ ok: true, state: paperTrading.getState() }));
    return;
  }

  if (u.pathname === "/api/paper-trading/config") {
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
      try {
        const body = await readJsonBody(req);
        const updatedConfig = paperTrading.updateConfig(body);
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(
          JSON.stringify({
            ok: true,
            message: "模拟交易策略参数配置更新成功",
            config: updatedConfig,
            summary: paperTrading.getSummary(),
          }),
        );
      } catch (e: any) {
        res.writeHead(400, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ ok: false, error: e?.message ?? String(e) }));
      }
      return;
    } else {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(
        JSON.stringify({
          ok: true,
          config: paperTrading.getConfig(),
        }),
      );
      return;
    }
  }

  if (u.pathname === "/api/paper-trading") {
    if (req.method === "POST") {
      paperTrading.reset();
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, state: paperTrading.getState() }));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(paperTrading.getState()));
    return;
  }

  if (u.pathname === "/api/klines") {
    await serveKlines(u, res);
    return;
  }

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

const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith("/server.ts") || process.argv[1].endsWith("/server.js") || process.argv[1].endsWith("src/server.ts")) &&
  process.env.NODE_ENV !== "test" &&
  !process.env.NODE_TEST_CONTEXT;

if (isMainModule) {
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
}

export { server, wsManager };
