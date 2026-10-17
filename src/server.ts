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
  fetch60dTrend,
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
  calculateSupportMa,
  update5mFrom1m,
  calculateMaxHour,
  calculateHourFirstClose,
  calculateHourFirstLow,
  type Candle,
} from "./macd.ts";
import { TelegramAlerter } from "./alert.ts";
import { telegramConfigured } from "./telegram.ts";
import { enrichRankChanges, type BoardSnapshot } from "./rank.ts";
import { wsManager, applyTradeToCandles } from "./ws.ts";
import type { Row, Status } from "./types.ts";

// Directory the built React frontend is emitted to (web/dist). In dev you run
// Vite separately (npm run dev:web), so this dir may not exist — the server
// then returns a hint instead of the SPA shell.
const WEB_DIST = path.join(process.cwd(), "web", "dist");

const PORT = process.env.PORT ? Number(process.env.PORT) : 4111;
const TOP_N = Number(process.env.TOP_N ?? 10);
const REFRESH_TTL_MS = Number(process.env.REFRESH_TTL_MS ?? 60_000); // 默认 60s 刷新一次，对齐 1m K 线收盘周期并防止 API 超频
const KLINE_LIMIT = Number(process.env.KLINE_LIMIT ?? 100);
const KLINE_INIT_LIMIT = Number(process.env.KLINE_INIT_LIMIT ?? 1500); // 冷启动拉取 1500 根
const KLINE_ROLLING_LIMIT = Number(process.env.KLINE_ROLLING_LIMIT ?? 1500); // 滚动存储 1500 根 1m K 线
// "High position" = current DEA/DIFF is at/near the highest value in the window.
const HIGH_RATIO = Number(process.env.HIGH_RATIO ?? 0.8); // within 80% of the window peak
const HIGH_WINDOW = Number(process.env.HIGH_WINDOW ?? 100); // observation window in bars

// 跌幅榜保护配置：优先保证涨幅榜，在涨幅榜完成后、权重充裕时对跌幅榜实施平滑同步
const LOSER_REST_WEIGHT_THRESHOLD = Number(process.env.LOSER_REST_WEIGHT_THRESHOLD ?? 1400); // 已用权重>=1400时跌幅榜暂停发起 REST
const LOSER_MAX_COLD_STARTS_PER_ROUND = Number(process.env.LOSER_MAX_COLD_STARTS_PER_ROUND ?? 10); // 涨幅榜完成后，跌幅榜每轮最多冷启动标的数
const LOSER_KLINE_LIMIT = Number(process.env.LOSER_KLINE_LIMIT ?? 1500); // 跌幅榜冷启动拉取 K 线数（默认 1500，保障 1m/5m DIFF 及 MA120/max1500 完整计算）

// Telegram alert: 当三个榜单任意一个出现 ≥ TG_ALERT_MIN 个「无支撑 + 1m DIFF>0 + 5m DIFF<0」时发出通知。
// 首次命中时通知，持续命中期间不因数量变化而重复播报。
const alerter = new TelegramAlerter();

let cache: { at: number; promise: Promise<Status> } | null = null;

export interface SymbolCandleCache {
  candles1m: Candle[];
  candles5m: Candle[];
  initialized: boolean;
}

const candleCache = new Map<string, SymbolCandleCache>();

// 从 418/451 异常恢复后，对缺乏有效 K 线（<35 根）或因封禁断流数据已过期的标的标记重置冷启动
// 避免因旧缓存断流导致指标异常，同时平缓重新同步
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

// 监听 WebSocket 成交流，实时推进并合成当前分钟 K 线及 5m K 线（滚动维护 1500 根）
wsManager.onTrade((tick) => {
  const symCache = candleCache.get(tick.symbol);
  if (symCache && symCache.initialized && symCache.candles1m.length > 0) {
    symCache.candles1m = applyTradeToCandles(symCache.candles1m, tick, KLINE_ROLLING_LIMIT);
    symCache.candles5m = update5mFrom1m(symCache.candles5m, symCache.candles1m, 300);
  }
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
  klineLimit?: number;        // 指定 K 线拉取数量（冷启动默认 1500，滚动为 100）
  allowTrendFetch?: boolean;  // 是否允许发起周K和60D日K
}

export interface FetchRowResult {
  row: Row;
  didRest: boolean;
}

/**
 * 并发/串行拉取单币种指标：
 * 1. 优先保证涨幅榜：置顶标的与涨幅榜首先完成冷启动，随后在安全权重内平滑同步跌幅榜；
 * 2. 完成初始化后，后续滚动存储 1500 根，优先依赖 WebSocket 实时成交流就地更新 K 线；
 * 3. 精确记录是否发生实际网络 REST 请求，为调用方平滑限速提供依据，彻底防止突发触发 418。
 */
async function fetchRowData(t: Ticker24h, options: FetchRowOptions = {}): Promise<FetchRowResult> {
  const {
    isGainerPriority = true,
    allowRestKline = true,
    klineLimit,
    allowTrendFetch = true,
  } = options;
  let didRest = false;

  try {
    let symCache = candleCache.get(t.symbol);
    if (!symCache) {
      symCache = {
        candles1m: [],
        candles5m: [],
        initialized: false,
      };
      candleCache.set(t.symbol, symCache);
    }

    const isFirstRun = !symCache.initialized;
    // 如果已经完成冷启动且本地 K 线充足，跳过 REST K 线请求，优先使用 WS 实时维持的 K 线
    const needRestKline = allowRestKline && (isFirstRun || symCache.candles1m.length < 35);
    const defaultInitLimit = isGainerPriority ? KLINE_INIT_LIMIT : LOSER_KLINE_LIMIT;
    const fetchLimit = klineLimit ?? (isFirstRun ? defaultInitLimit : KLINE_LIMIT);

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

    // 周K与60日趋势：优先保障涨幅榜，处于避让期或受限时绝不发起请求，彻底防止并发冲刺触发 418
    let weekOpen: number | null = null;
    let change60d: "up" | "down" | null = null;
    if (allowTrendFetch && !getBackoffStatus().active) {
      weekOpen = await fetchWeeklyOpen(t.symbol).catch(() => null);
    }
    if (allowTrendFetch && !getBackoffStatus().active) {
      change60d = await fetch60dTrend(t.symbol, isGainerPriority).catch(() => null);
    }

    // 1m 保存：每次更新保存，若偶发网络异常则回退使用已保存的 1m 序列
    if (candles1mRes.length > 0) {
      symCache.candles1m = candles1mRes;
    }
    const candles = symCache.candles1m;

    // 首次拉取成功（获得足够 K 线）时完成初始化并由 1500 根 1m 直接合成 5m
    if (isFirstRun && candles.length >= 35) {
      symCache.candles5m = update5mFrom1m([], candles, 300);
      symCache.initialized = true;
      console.log(`[kline] ${t.symbol} 首次启动成功同步 ${candles.length} 根 1m K 线，合成 ${symCache.candles5m.length} 根 5m K 线`);
    } else if (symCache.initialized && candles.length > 0) {
      // 后续轮询用增量的 1m 更新 5m
      symCache.candles5m = update5mFrom1m(symCache.candles5m, candles, 300);
    }
    const candles5m = symCache.candles5m;

    const sig = analyzeMacd(candles.map((c) => c.close), {
      highRatio: HIGH_RATIO,
      highWindow: HIGH_WINDOW,
    });
    const diff1mSig = analyzeDiff(candles.map((c) => c.close), {
      highRatio: HIGH_RATIO,
      highWindow: HIGH_WINDOW,
    });
    const diff5mSig =
      candles5m.length >= 35
        ? analyzeDiff(candles5m.map((c) => c.close), {
            highRatio: HIGH_RATIO,
            highWindow: HIGH_WINDOW,
          })
        : null;
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

    // 计算近 1500 根 1m K 线的最高价
    let max1500: number | null = null;
    if (candles.length > 0) {
      const start = Math.max(0, candles.length - 1500);
      let maxH = -Infinity;
      for (let i = start; i < candles.length; i++) {
        if (candles[i].high > maxH) {
          maxH = candles[i].high;
        }
      }
      if (Number.isFinite(maxH)) {
        max1500 = maxH;
      }
    }

    // 计算最近一个整点到当前的最高价
    const maxHour = calculateMaxHour(candles, t.lastPrice);
    // 计算最近一个整点第一分钟的收盘价与最低价
    const hourFirstClose = calculateHourFirstClose(candles);
    const hourFirstLow = calculateHourFirstLow(candles);

    return {
      row: {
        ...t,
        state: sig?.state ?? "n/a",
        alert: sig?.alert ?? false,
        bullish: sig ? !sig.deathCross : null,
        high: sig ? sig.highPosition : null,
        dea: sig?.dea ?? null,
        deaLevel,
        diff1m: diff1mSig?.dif ?? null,
        diff1mLevel: diff1mSig?.level ?? null,
        diff5m: diff5mSig?.dif ?? null,
        diff5mLevel: diff5mSig?.level ?? null,
        diff15m: diff5mSig?.dif ?? null,
        diff15mLevel: diff5mSig?.level ?? null,
        weekChangePercent,
        change60d,
        supportMa,
        streakCount: streak.count,
        streakDir: streak.direction,
        max1500,
        maxHour,
        hourFirstClose,
        hourFirstLow,
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
        diff5m: null,
        diff5mLevel: null,
        diff15m: null,
        diff15mLevel: null,
        weekChangePercent: null,
        change60d: null,
        supportMa: null,
        streakCount: 0,
        streakDir: null,
        max1500: null,
        maxHour: null,
        hourFirstClose: null,
        hourFirstLow: null,
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
 * 优先级与两阶段同步设计：
 * 1. 确保涨幅榜获取完成 K 线同步（包含置顶标的 BTC/SOL 与 24h 涨幅榜标的）；
 * 2. 如果检测到 429 就立即停止 K 线同步，并立即开始 WebSocket 订阅已同步标的；
 * 3. 等到没 429 了（冷静期结束），才继续同步跌幅榜；
 * 4. 跌幅榜同步完成后，再重新订阅全部标的。
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
  // 分组策略：
  // 1. 涨幅榜组：置顶标的 (BTC/SOL) + 24h 涨幅榜标的 (Gainers) + 掉出涨幅榜标的 (droppedGainers)
  // 2. 跌幅榜组：24h 跌幅榜标的 (Losers) + 掉出跌幅榜标的 (droppedLosers)
  const gainerMap = new Map<string, Ticker24h>();
  for (const t of [...pinnedTickers, ...tops.gainers, ...droppedGainerTickers]) {
    if (!gainerMap.has(t.symbol)) {
      gainerMap.set(t.symbol, t);
    }
  }

  const loserMap = new Map<string, Ticker24h>();
  for (const t of [...tops.losers, ...droppedLoserTickers]) {
    if (!gainerMap.has(t.symbol) && !loserMap.has(t.symbol)) {
      loserMap.set(t.symbol, t);
    }
  }

  const gainersQueue = Array.from(gainerMap.values());
  const losersQueue = Array.from(loserMap.values());

  const resultMap = new Map<string, Row>();
  const syncedSymbols = new Set<string>();

  // 阶段 1：先确保涨幅榜获取完成 K 线同步（绝对最高优先级）
  let gainer429Detected = false;
  for (let i = 0; i < gainersQueue.length; i++) {
    const item = gainersQueue[i];
    if (getBackoffStatus().active) {
      console.warn(`[binance] 429/418 避让生效，立即停止涨幅榜 K 线同步 (已完成 ${resultMap.size}/${gainersQueue.length})`);
      gainer429Detected = true;
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
        allowTrendFetch: true,
      });
      resultMap.set(item.symbol, res.row);
      syncedSymbols.add(item.symbol);
      didRest = res.didRest;
    } catch (e) {
      if (getBackoffStatus().active) {
        console.warn(`[binance] 同步涨幅榜标的 ${item.symbol} 时检测到 429/418 限频，立即停止同步: ${(e as any)?.message ?? e}`);
        gainer429Detected = true;
        break;
      }
    }

    // 平滑请求节奏防突发：实际发起了 REST 请求平滑 200~500ms，纯本地计算仅需 20ms
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

  // 区分短暂 429 与严重封禁 (418)：
  // 仅在短暂 429 限频且冷静期极短（<= 5 秒）时，才尝试等待解除后补齐未完成标的；
  // 若是 418 IP 封禁或长期避让，绝不在循环中长时间阻塞，立即跳过后续 REST 请求以保证服务正常响应
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
            allowTrendFetch: true,
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

  // 阶段 3：涨幅榜已完全同步；在当前未处于避让期且权重未超标的前提下对跌幅榜进行平滑同步
  if (!getBackoffStatus().active) {
    let loserColdStarts = 0;

    for (let i = 0; i < losersQueue.length; i++) {
      const item = losersQueue[i];
      if (resultMap.has(item.symbol)) continue;

      if (getBackoffStatus().active) {
        console.warn(`[binance] 同步跌幅榜期间检测到 429/418 限频，立即停止后续标的同步`);
        break;
      }

      const currentUsedWeight = getBackoffStatus().usedWeight1m;
      const allowLoserRest = currentUsedWeight < LOSER_REST_WEIGHT_THRESHOLD;

      const symCache = candleCache.get(item.symbol);
      const isColdStart = !symCache || !symCache.initialized || symCache.candles1m.length < 35;
      const canDoColdStart = allowLoserRest && isColdStart && loserColdStarts < LOSER_MAX_COLD_STARTS_PER_ROUND;

      const allowRestKline = canDoColdStart;
      const allowTrendFetch = allowLoserRest;
      if (canDoColdStart) {
        loserColdStarts++;
      }

      let didRest = false;
      try {
        const res = await fetchRowData(item, {
          isGainerPriority: false,
          allowRestKline,
          klineLimit: isColdStart ? LOSER_KLINE_LIMIT : KLINE_LIMIT,
          allowTrendFetch,
        });
        resultMap.set(item.symbol, res.row);
        syncedSymbols.add(item.symbol);
        didRest = res.didRest;
      } catch (e) {
        if (getBackoffStatus().active) {
          console.warn(`[binance] 同步跌幅榜标的 ${item.symbol} 遇到限频/封禁，立即停止同步: ${(e as any)?.message ?? e}`);
          break;
        }
      }

      if (i < losersQueue.length - 1 && !getBackoffStatus().active) {
        const used = getBackoffStatus().usedWeight1m;
        const delay = !didRest ? 20 : used >= 1400 ? 500 : used >= 1000 ? 300 : 200;
        if (delay > 0) {
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
  }

  // 阶段 4：跌幅榜同步完成，重新订阅全部
  const allSymbols = [
    ...pinnedTickers.map((t) => t.symbol),
    ...tops.gainers.map((t) => t.symbol),
    ...tops.losers.map((t) => t.symbol),
  ];
  wsManager.setSymbols(allSymbols);
  console.log(`[binance-ws] 全部标的同步完毕，重新订阅全部标的 (${allSymbols.length} 个)`);

  // 对于未拉取到的标的，使用 fallback 默认空行填充，确保前端不报错且涨幅榜正常展示
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
        diff5m: null,
        diff5mLevel: null,
        diff15m: null,
        diff15mLevel: null,
        weekChangePercent: null,
        change60d: null,
        supportMa: null,
        streakCount: 0,
        streakDir: null,
        max1500: null,
        maxHour: null,
        hourFirstClose: null,
        hourFirstLow: null,
      }
    );
  };

  return {
    pinned: pinnedTickers.map(getRowOrFallback),
    gainers: tops.gainers.map(getRowOrFallback),
    losers: tops.losers.map(getRowOrFallback),
    droppedGainers: droppedGainerTickers.map(getRowOrFallback),
    droppedLosers: droppedLoserTickers.map(getRowOrFallback),
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

  // 动态同步 WebSocket 订阅列表：确保置顶与各榜单币种全部在 WS 监听中，享受实时成交更新
  const allSymbols = [
    ...pinned.map((r) => r.symbol),
    ...gainers.map((r) => r.symbol),
    ...losers.map((r) => r.symbol),
  ];
  wsManager.setSymbols(allSymbols);

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

  // Telegram alert runs only on fresh snapshots (not cached polls)，每条播报固定包含置顶标的，涨跌幅榜不计入置顶标的
  const { summary: highBull } = await alerter.check({
    gainers: [...rankedGainers.rankedTop, ...rankedGainers.rankedDropped],
    losers: [...rankedLosers.rankedTop, ...rankedLosers.rankedDropped],
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

export { server };
