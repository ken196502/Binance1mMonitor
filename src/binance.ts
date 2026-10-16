// Binance USDT-margined (u本位) FUTURES market-data client.
// Endpoints live on fapi.binance.com — which is blocked in some regions and has
// no public mirror (unlike spot). Routing through a local HTTP proxy is required
// there: set HTTPS_PROXY (e.g. http://127.0.0.1:7890) and EnvHttpProxyAgent will
// apply it to every fetch below. With no proxy env vars set it is a no-op.

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {
    // ignore if .env does not exist
  }
}

import {
  fetch as undiciFetch,
  EnvHttpProxyAgent,
  ProxyAgent,
  type Dispatcher,
  type Response as UndiciResponse,
} from "undici";
import type { Candle } from "./macd.ts";
import { sendTelegramMessage, telegramConfigured, escapeHtml } from "./telegram.ts";

// Proxy routing for Binance requests:
export const PROXY =
  process.env.PROXY ??
  process.env.BINANCE_PROXY ??
  process.env.HTTPS_PROXY ??
  process.env.https_proxy ??
  process.env.HTTP_PROXY ??
  process.env.http_proxy ??
  "";

if (PROXY) {
  if (!process.env.HTTPS_PROXY) process.env.HTTPS_PROXY = PROXY;
  if (!process.env.https_proxy) process.env.https_proxy = PROXY;
  if (!process.env.HTTP_PROXY) process.env.HTTP_PROXY = PROXY;
  if (!process.env.http_proxy) process.env.http_proxy = PROXY;
}

const dispatcher: Dispatcher = new EnvHttpProxyAgent();

// fapi.binance.com is the only official USDM futures host. Override with
// BINANCE_BASE if you need a custom endpoint. FALLBACK_BASE defaults to empty
// because Binance publishes no futures mirror; set it only if you run your own.
function getBase(): string {
  return process.env.BINANCE_BASE ?? "https://fapi.binance.com";
}
function getFallbackBase(): string {
  return process.env.FALLBACK_BASE ?? "";
}

export interface Ticker24h {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  quoteVolume: number;
}

/**
 * USDM perpetual filter: keep only `*USDT` perpetual contracts.
 * - Delivery (quarterly) contracts carry a `_YYMMDD` suffix (e.g. BTCUSDT_240329) → drop.
 * - Coin-margined (COINM) symbols are `*USD_PERP` / `*USD_YYMMDD` → never match `USDT$`.
 * Futures have no leveraged tokens and no fiat/stable bases, so the spot-era
 * UP/DOWN/BULL/BEAR and stable-coin filters are unnecessary here.
 */
function isUsdtPerp(symbol: string): boolean {
  if (!symbol.endsWith("USDT")) return false;
  if (symbol.includes("_")) return false; // delivery contract
  return true;
}

// A fetch is considered a network-level failure (worth retrying on the fallback)
// when it never completed — i.e. the request itself threw, rather than returning
// a normal HTTP error like 429/451. We do NOT retry on HTTP errors, since those
// are real API responses the caller wants to see.
function isNetworkError(e: unknown): boolean {
  if (!(e instanceof TypeError)) return false; // undici fetch failures are TypeError("fetch failed")
  const code = (e as any)?.cause?.code;
  return (
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "ETIMEDOUT"
  );
}

/** Timestamp in ms until which we must back off due to 418 IP ban, 429 rate limit, or proactive backoff. */
let backoffUntil = 0;
let backoffReason = "";
let lastUsedWeight1m = 0;
let lastHttpStatus = 200;

/** 记录异常状态（418 / 451）是否已经告警过，避免每分钟检测到同样错误重复告警 */
const statusAlerted = new Map<number, boolean>();

let anomalyRecoveryListener: (() => void) | null = null;

export function onAnomalyRecovered(listener: () => void): void {
  anomalyRecoveryListener = listener;
}

export function triggerAnomalyRecoveredForTest(): void {
  anomalyRecoveryListener?.();
}

export function getStatusAlertedForTest(): Map<number, boolean> {
  return statusAlerted;
}

export function resetStatusAlertedForTest(): void {
  statusAlerted.clear();
}

export function clearStatusAlerted(): void {
  statusAlerted.clear();
}

export function setBackoffUntilForTest(ts: number): void {
  backoffUntil = ts;
}

/**
 * 格式化币安封禁时间戳。
 * 币安返回的时间戳通常为 10 位秒级 Unix 时间戳（如 1729000000），直接传入 new Date 会被误作为毫秒而显示为 1970 年。
 * 此处自动兼容秒级（<1e11）与毫秒级（>=1e11）时间戳，转为东八区北京时间。
 */
export function formatBannedUntil(msg: string): string {
  return msg.replace(/\bbanned until (\d{10,13})\b/i, (match, digits) => {
    const rawTs = Number(digits);
    if (!Number.isFinite(rawTs) || rawTs <= 0) return match;
    const untilMs = rawTs < 1e11 ? rawTs * 1000 : rawTs;
    const dateStr = new Date(untilMs).toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    return `banned until ${dateStr} (${digits})`;
  });
}

/** 触发 451 或 418 异常时做一次 TG 告警（已告警则不重复告警） */
export async function notifyStatusAnomaly(status: number, detail: string): Promise<void> {
  if (statusAlerted.get(status)) {
    return;
  }
  statusAlerted.set(status, true);

  const statusName =
    status === 418
      ? "IP被封禁 (418 I'm a teapot)"
      : status === 451
        ? "地区法律限制/不可访问 (451 Unavailable For Legal Reasons)"
        : `异常状态 ${status}`;

  const timeStr = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  const formattedDetail = formatBannedUntil(detail);
  const text = [
    `🚨 <b>Binance 接口异常告警 (HTTP ${status})</b>`,
    "",
    `• <b>状态说明</b>: ${statusName}`,
    `• <b>发生时间</b>: ${timeStr}`,
    `• <b>详细信息</b>: <code>${escapeHtml(formattedDetail.slice(0, 300))}</code>`,
    "",
    `⚠️ <i>同类异常已记录，持续遇到该错误不会重复刷屏。</i>`,
  ].join("\n");

  console.error(`[binance-alert] 触发异常状态 ${status} 告警: ${formattedDetail}`);
  if (telegramConfigured()) {
    const res = await sendTelegramMessage(text);
    if (!res.ok) {
      console.warn(`[binance-alert] 发送 TG 异常告警失败: ${res.error}`);
    }
  }
}

// Binance USDM 单 IP 限额 2400 weight/min。
// 设定主动避让阈值（默认 1800，预留 600 安全缓冲区）。当已用权重 >= 阈值时主动暂停请求直至下一分钟窗口重置。
const PROACTIVE_BACKOFF_WEIGHT = Number(process.env.PROACTIVE_BACKOFF_WEIGHT ?? 1800);

export function is429Active(): boolean {
  const active = Date.now() < backoffUntil;
  return active && (lastHttpStatus === 429 || backoffReason.includes("429"));
}

export function getLastHttpStatus(): number {
  return lastHttpStatus;
}

export function setLastHttpStatusForTest(status: number): void {
  lastHttpStatus = status;
}

export async function waitForBackoffClear(maxWaitMs = 120_000): Promise<boolean> {
  const now = Date.now();
  if (now >= backoffUntil) return true;
  const waitMs = Math.min(Math.max(10, backoffUntil - now + 500), maxWaitMs);
  console.log(`[binance] 等待避让/限频冷静期结束，等待 ${Math.ceil(waitMs / 1000)} 秒...`);
  await new Promise((r) => setTimeout(r, waitMs));
  return Date.now() >= backoffUntil;
}

export function getBackoffStatus(): {
  active: boolean;
  backoffUntil: number;
  reason: string;
  usedWeight1m: number;
  is429: boolean;
  lastHttpStatus: number;
} {
  const active = Date.now() < backoffUntil;
  return {
    active,
    backoffUntil,
    reason: backoffReason,
    usedWeight1m: lastUsedWeight1m,
    is429: active && (lastHttpStatus === 429 || backoffReason.includes("429")),
    lastHttpStatus,
  };
}

export function resetBackoffForTest(): void {
  backoffUntil = 0;
  backoffReason = "";
  lastUsedWeight1m = 0;
  lastHttpStatus = 200;
  statusAlerted.clear();
}

const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
};

/** fetch() wrapper that handles rate limiting, bans, proactive backoff, and fallback base retry. */
async function binanceFetch(path: string): Promise<UndiciResponse> {
  const now = Date.now();
  if (now < backoffUntil) {
    const remainSec = Math.ceil((backoffUntil - now) / 1000);
    throw new Error(`Binance 限频/避让冷静期中 (${backoffReason})，剩余 ${remainSec} 秒，已暂停请求`);
  }

  let r: UndiciResponse;
  try {
    const base = getBase();
    r = await undiciFetch(`${base}${path}`, {
      dispatcher,
      headers: DEFAULT_HEADERS,
    });
  } catch (e) {
    const base = getBase();
    const fallback = getFallbackBase();
    if (!fallback || fallback === base || !isNetworkError(e)) throw e;
    r = await undiciFetch(`${fallback}${path}`, {
      dispatcher,
      headers: DEFAULT_HEADERS,
    });
  }

  // 1. 检查并记录当前 1 分钟权重占用，实施主动避让（Proactive Backoff 防 429）
  const usedWeightHeader = r.headers.get("x-mbx-used-weight-1m");
  if (usedWeightHeader) {
    const usedWeight = parseInt(usedWeightHeader, 10);
    if (Number.isFinite(usedWeight) && usedWeight > 0) {
      lastUsedWeight1m = usedWeight;
      // 若已用权重达到安全预警线（如 1800 / 2400），主动进入避让冷静期直到下一分钟窗口重置
      if (usedWeight >= PROACTIVE_BACKOFF_WEIGHT && Date.now() >= backoffUntil) {
        const secIntoMinute = Math.floor(Date.now() / 1000) % 60;
        const waitSec = Math.max(5, 60 - secIntoMinute + 1);
        backoffUntil = Date.now() + waitSec * 1000;
        backoffReason = `主动避让防429：当前1分钟已用权重 ${usedWeight}/2400 已达安全阈值 ${PROACTIVE_BACKOFF_WEIGHT}`;
        console.warn(
          `[binance] ⚠️ 主动避让防429：当前1分钟已用权重达到 ${usedWeight}/2400 (阈值 ${PROACTIVE_BACKOFF_WEIGHT})，主动暂停请求 ${waitSec} 秒至窗口重置`,
        );
      }
    }
  }

  // 2. 被动兜底：若仍收到 418/429/451，严格按照币安给出的冷静时间强制避让并触发告警
  if (r.status === 418 || r.status === 429 || r.status === 451) {
    lastHttpStatus = r.status;
    const retryAfter = Number(r.headers.get("retry-after") ?? 60);
    let waitSec = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60;
    let detailMsg = `HTTP ${r.status}`;
    try {
      const errBody = (await r.json()) as any;
      if (errBody?.msg) {
        const originalMsg = errBody.msg;
        const match = /banned until (\d+)/i.exec(originalMsg);
        if (match) {
          const rawTs = Number(match[1]);
          if (Number.isFinite(rawTs) && rawTs > 0) {
            const untilMs = rawTs < 1e11 ? rawTs * 1000 : rawTs;
            if (untilMs > Date.now()) {
              waitSec = Math.ceil((untilMs - Date.now()) / 1000);
            }
          }
          detailMsg = formatBannedUntil(originalMsg);
        } else {
          detailMsg = originalMsg;
        }
      }
    } catch {
      // ignore json parse error
    }

    // 针对 418 (IP被封) 和 451 (地区法律限制)，触发单次 TG 告警（已告警则不重复）
    if (r.status === 418 || r.status === 451) {
      void notifyStatusAnomaly(r.status, detailMsg);
    }

    // 限制单次避让上限（默认最多等待 300s），避免因币安返回长时间戳导致程序过长时间被彻底锁死
    // 但必须预留足够冷静期，避免在封禁未结束前过早重试导致封禁被币安再次顺延
    const maxBackoffSec = Number(process.env.MAX_BACKOFF_SECONDS ?? 300);
    const actualWaitSec = Math.min(waitSec, maxBackoffSec);
    backoffUntil = Date.now() + actualWaitSec * 1000;
    backoffReason = `HTTP ${r.status}: ${detailMsg}`;
    throw new Error(`Binance 触发限频/封禁/受限 (${backoffReason})，避让等待 ${actualWaitSec} 秒后重试`);
  }

  // 3. 正常响应时（r.ok）：若此前曾记录过 418 / 451 异常告警状态，说明已解封恢复，清空告警状态并触发恢复通知
  if (r.ok) {
    lastHttpStatus = r.status;
    if (statusAlerted.size > 0) {
      console.info(`[binance] 接口已解封恢复正常 (HTTP ${r.status})，清空 418/451 告警标记并重置 K 线冷启动状态`);
      statusAlerted.clear();
      try {
        anomalyRecoveryListener?.();
      } catch (err) {
        console.warn(`[binance] 异常恢复回调执行出错:`, err);
      }
    }
  }

  return r;
}

let cachedCryptoSymbols: Set<string> | null = null;
let cryptoSymbolsExpiresAt = 0;

/**
 * 获取币安纯 Crypto 永续合约标的集合（每小时刷新一次 exchangeInfo）。
 * 过滤掉美股 ETF、股票期货等 TRADIFI_PERPETUAL / EQUITY / COMMODITY / FX 标的。
 */
export async function getCryptoPerpSymbols(): Promise<Set<string>> {
  const now = Date.now();
  if (cachedCryptoSymbols && now < cryptoSymbolsExpiresAt) {
    return cachedCryptoSymbols;
  }
  // 1. 若当前处于 418/429 避让冷静期，只要已有缓存，坚决沿用已有缓存，绝不发 REST 请求
  if (cachedCryptoSymbols && getBackoffStatus().active) {
    return cachedCryptoSymbols;
  }
  // 2. 跨日避峰：在 UTC 00:00 结算窗口且已有缓存时，避免发起 exchangeInfo 请求
  if (cachedCryptoSymbols && isUtcMidnightPeak(now)) {
    return cachedCryptoSymbols;
  }

  try {
    const r = await binanceFetch(`/fapi/v1/exchangeInfo`);
    if (r.ok) {
      const data = (await r.json()) as any;
      if (Array.isArray(data?.symbols)) {
        const set = new Set<string>();
        for (const s of data.symbols) {
          // 只保留属于加密货币（COIN 或 INDEX）的标准 PERPETUAL 合约，且为 TRADING 状态
          const isPerp = s.contractType === "PERPETUAL";
          const isCrypto = s.underlyingType === "COIN" || s.underlyingType === "INDEX";
          const isTrading = s.status === "TRADING";
          if (isPerp && isCrypto && isTrading && s.symbol.endsWith("USDT") && !s.symbol.includes("_")) {
            set.add(s.symbol);
          }
        }
        if (set.size > 0) {
          cachedCryptoSymbols = set;
          // 缓存 1 小时，外加 0~15 分钟随机抖动，避免每次在整整一小时同一秒固定过期造成与新进榜冷启动重叠
          const jitter = Math.floor(Math.random() * 15 * 60 * 1000);
          cryptoSymbolsExpiresAt = now + 60 * 60 * 1000 + jitter;
          console.log(`[binance] 成功更新纯 Crypto 永续合约白名单，共 ${set.size} 个标的（已排除美股/ETF等 TradFi 合约，缓存至 ${new Date(cryptoSymbolsExpiresAt).toLocaleTimeString()}）`);
          return set;
        }
      }
    }
  } catch (e) {
    console.warn(`[binance] 获取 exchangeInfo 失败，回退使用已有缓存或基础过滤:`, (e as any)?.message ?? e);
    // 失败后顺延 5 分钟重试，避免死循环高频重试
    if (cachedCryptoSymbols) {
      cryptoSymbolsExpiresAt = now + 5 * 60 * 1000;
    }
  }

  return cachedCryptoSymbols ?? new Set<string>();
}

export function setCachedCryptoSymbolsForTest(symbols: Set<string> | null): void {
  cachedCryptoSymbols = symbols;
  cryptoSymbolsExpiresAt = symbols ? Date.now() + 3600000 : 0;
}

export async function fetch24hTickers(): Promise<Ticker24h[]> {
  const r = await binanceFetch(`/fapi/v1/ticker/24hr`);
  if (!r.ok) throw new Error(`24hr ticker failed: HTTP ${r.status}`);
  const cryptoSymbols = await getCryptoPerpSymbols();
  const data = (await r.json()) as any[];
  return data
    .filter((d) => {
      if (!isUsdtPerp(d.symbol)) return false;
      // 若白名单已加载，则严格只保留纯 Crypto 标的
      if (cryptoSymbols.size > 0) {
        return cryptoSymbols.has(d.symbol);
      }
      return true;
    })
    .map((d) => ({
      symbol: d.symbol,
      lastPrice: parseFloat(d.lastPrice),
      priceChangePercent: parseFloat(d.priceChangePercent),
      quoteVolume: parseFloat(d.quoteVolume),
    }));
}

export interface TickerTops {
  gainers: Ticker24h[];
  losers: Ticker24h[];
  volume?: Ticker24h[];
}

export function pickTops(tickers: Ticker24h[], n = 10): TickerTops {
  const gainers = [...tickers].sort((a, b) => b.priceChangePercent - a.priceChangePercent).slice(0, n);
  const losers = [...tickers].sort((a, b) => a.priceChangePercent - b.priceChangePercent).slice(0, n);
  return { gainers, losers, volume: [] };
}

export async function fetchCandles(symbol: string, interval = "1m", limit = 100): Promise<Candle[]> {
  const r = await binanceFetch(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if (!r.ok) throw new Error(`klines ${symbol} (${interval}) failed: HTTP ${r.status}`);
  const data = (await r.json()) as any[];
  return data.map((d) => ({
    time: d[0],
    open: +d[1],
    high: +d[2],
    low: +d[3],
    close: +d[4],
    volume: +d[5],
  }));
}

export async function fetch1mCandles(symbol: string, limit = 100): Promise<Candle[]> {
  return fetchCandles(symbol, "1m", limit);
}

export async function fetch5mCandles(symbol: string, limit = 100): Promise<Candle[]> {
  return fetchCandles(symbol, "5m", limit);
}

export async function fetch15mCandles(symbol: string, limit = 100): Promise<Candle[]> {
  return fetchCandles(symbol, "15m", limit);
}

const weeklyOpenCache = new Map<string, { open: number; closeTime: number; retryAfter?: number }>();

/** 获取当前周 K 线的开盘价（按周缓存直至该根周 K 收盘，开盘价全周不变） */
export async function fetchWeeklyOpen(symbol: string): Promise<number | null> {
  const now = Date.now();
  const cached = weeklyOpenCache.get(symbol);
  if (cached && now < cached.closeTime) {
    return cached.open;
  }
  if (cached?.retryAfter && now < cached.retryAfter) {
    return cached.open;
  }
  // 跨日避峰：在 UTC 00:00 结算窗口且已有缓存时，避免发起周K请求
  if (cached && isUtcMidnightPeak(now)) {
    return cached.open;
  }
  try {
    const r = await binanceFetch(`/fapi/v1/klines?symbol=${symbol}&interval=1w&limit=1`);
    if (!r.ok) {
      if (cached) weeklyOpenCache.set(symbol, { ...cached, retryAfter: now + 5 * 60 * 1000 });
      return cached ? cached.open : null;
    }
    const data = (await r.json()) as any[];
    if (!data || data.length === 0) {
      if (cached) weeklyOpenCache.set(symbol, { ...cached, retryAfter: now + 5 * 60 * 1000 });
      return cached ? cached.open : null;
    }
    const open = parseFloat(data[0][1]);
    const closeTime = Number(data[0][6]);
    weeklyOpenCache.set(symbol, { open, closeTime });
    return open;
  } catch {
    if (cached) {
      weeklyOpenCache.set(symbol, { ...cached, retryAfter: now + 5 * 60 * 1000 });
    }
    return cached ? cached.open : null;
  }
}

interface Trend60dCache {
  trend: "up" | "down" | null;
  nextUtcMidnight: number;
}

const trend60dCache = new Map<string, Trend60dCache>();

export function getTrend60dCacheForTest(): Map<string, Trend60dCache> {
  return trend60dCache;
}

export function resetTrend60dCacheForTest(): void {
  trend60dCache.clear();
}

/**
 * 判断当前时间是否处于 UTC 00:00 跨日结算高峰期（23:59:00 ~ 00:02:00 UTC，即北京时间 07:59 ~ 08:02）。
 * 此时币安正在执行日K收盘结算与资金费率交割，WAF 防火墙处于全天最严限频阶段。
 */
export function isUtcMidnightPeak(nowMs: number = Date.now()): boolean {
  const msInDay = nowMs % 86400000;
  // 86400000 ms/day. 23:59:00 是 86340000ms，00:02:00 是 120000ms
  return msInDay >= 86340000 || msInDay <= 120000;
}

/**
 * 根据标的名称生成确定性的哈希抖动（毫秒），用于将缓存过期时间打散在 0~45 分钟之间，避免全量标的在同一毫秒惊群失效。
 */
export function getSymbolJitter(symbol: string, maxJitterMs = 45 * 60 * 1000): number {
  let hash = 0;
  for (let i = 0; i < symbol.length; i++) {
    hash = ((hash << 5) - hash + symbol.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % maxJitterMs;
}

let trend60dBudgetMinute = 0;
let trend60dCountInMinute = 0;

export function canFetchTrend60d(nowMs: number = Date.now()): boolean {
  const currentMinute = Math.floor(nowMs / 60000);
  if (currentMinute !== trend60dBudgetMinute) {
    trend60dBudgetMinute = currentMinute;
    trend60dCountInMinute = 0;
  }
  // 每分钟最多允许 2 个标的请求 60D 日K，严格将请求均匀打散至全天各分钟
  return trend60dCountInMinute < 2;
}

export function recordTrend60dFetch(): void {
  trend60dCountInMinute++;
}

export function resetTrend60dQuotaForTest(): void {
  trend60dBudgetMinute = 0;
  trend60dCountInMinute = 0;
}

export function getNextUtcMidnight(nowMs: number = Date.now()): number {
  const now = new Date(nowMs);
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
}

/**
 * 拉取已收盘61日K线，计算60日涨跌趋势。
 * 针对 UTC 0点跨日进行全面防封保护：
 * 1. 跨日避峰：在 UTC 00:00 结算高峰期（07:59 ~ 08:02），沿用旧缓存，暂缓向币安发起日K请求；
 * 2. 缓存打散：为各币种施加 0~45 分钟哈希抖动，彻底杜绝所有币种在 00:00:00 同时过期；
 * 3. 频控预算：每分钟最多发起 2 个标的的日K请求，其余标的顺延至下一分钟，消除瞬时突发；
 * 4. 故障保护：若请求失败，顺延 5 分钟重试并沿用旧缓存，防止死循环重复冲刺导致 418。
 */
export async function fetch60dTrend(symbol: string): Promise<"up" | "down" | null> {
  const now = Date.now();
  const cached = trend60dCache.get(symbol);

  // 1. 如果缓存尚未过期，直接返回
  if (cached && now < cached.nextUtcMidnight) {
    return cached.trend;
  }

  // 2. 跨日避峰：在 UTC 00:00 结算高峰期（北京时间 07:59 ~ 08:02），若已有缓存则继续沿用
  if (cached && isUtcMidnightPeak(now)) {
    return cached.trend;
  }

  // 3. 频控预算：如果本分钟日K请求配额已满，已有缓存优先沿用，推迟至下一分钟刷新
  if (cached && !canFetchTrend60d(now)) {
    return cached.trend;
  }

  try {
    recordTrend60dFetch();
    // 请求 62 根日K：包含当前未收盘日K和前 61 根已收盘日K
    const r = await binanceFetch(`/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=62`);
    if (!r.ok) {
      if (cached) cached.nextUtcMidnight = now + 5 * 60 * 1000;
      return cached ? cached.trend : null;
    }
    const data = (await r.json()) as any[];
    if (!data || !Array.isArray(data) || data.length === 0) {
      if (cached) cached.nextUtcMidnight = now + 5 * 60 * 1000;
      return cached ? cached.trend : null;
    }

    // 过滤掉当前尚未收盘的日K
    const closedBars = data.filter((bar) => Number(bar[6]) <= now);
    if (closedBars.length < 2) {
      if (cached) cached.nextUtcMidnight = now + 5 * 60 * 1000;
      return cached ? cached.trend : null;
    }

    // 最新收盘日K (昨天)
    const latestClosed = closedBars[closedBars.length - 1];
    const latestClose = parseFloat(latestClosed[4]);

    // 60天前的日K（若历史数据不足61根已收盘日K，则与最早可用的一根对比）
    const startIndex = Math.max(0, closedBars.length - 1 - 60);
    const baseClosed = closedBars[startIndex];
    const baseClose = parseFloat(baseClosed[4]);

    let trend: "up" | "down" | null = null;
    if (latestClose > baseClose) {
      trend = "up";
    } else if (latestClose < baseClose) {
      trend = "down";
    }

    // 成功获取后：下一次过期时间设为下一个 UTC 跨日 + 避峰时间(2分钟) + 标的哈希抖动(0~45分钟)
    const baseMidnight = getNextUtcMidnight(now);
    const jitter = getSymbolJitter(symbol, 45 * 60 * 1000);
    const nextUtcMidnight = baseMidnight + 120000 + jitter;
    trend60dCache.set(symbol, { trend, nextUtcMidnight });
    return trend;
  } catch {
    if (cached) {
      cached.nextUtcMidnight = now + 5 * 60 * 1000;
    }
    return cached ? cached.trend : null;
  }
}

