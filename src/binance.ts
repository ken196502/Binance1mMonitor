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

// Proxy routing for Binance requests:
const PROXY =
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
const BASE = process.env.BINANCE_BASE ?? "https://fapi.binance.com";
const FALLBACK_BASE = process.env.FALLBACK_BASE ?? "";

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

/** Timestamp in ms until which we must back off due to 418 IP ban or 429 rate limit. */
let backoffUntil = 0;
let backoffReason = "";

export function getBackoffStatus(): { active: boolean; backoffUntil: number; reason: string } {
  return {
    active: Date.now() < backoffUntil,
    backoffUntil,
    reason: backoffReason,
  };
}

const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
};

/** fetch() wrapper that handles rate limiting, bans, and fallback base retry. */
async function binanceFetch(path: string): Promise<UndiciResponse> {
  const now = Date.now();
  if (now < backoffUntil) {
    const remainSec = Math.ceil((backoffUntil - now) / 1000);
    throw new Error(`Binance 限频/封禁冷静期中 (${backoffReason})，剩余 ${remainSec} 秒，已暂停请求`);
  }

  let r: UndiciResponse;
  try {
    r = await undiciFetch(`${BASE}${path}`, {
      dispatcher,
      headers: DEFAULT_HEADERS,
    });
  } catch (e) {
    if (!FALLBACK_BASE || FALLBACK_BASE === BASE || !isNetworkError(e)) throw e;
    r = await undiciFetch(`${FALLBACK_BASE}${path}`, {
      dispatcher,
      headers: DEFAULT_HEADERS,
    });
  }

  if (r.status === 418 || r.status === 429) {
    const retryAfter = Number(r.headers.get("retry-after") ?? 60);
    let waitSec = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60;
    let detailMsg = `HTTP ${r.status}`;
    try {
      const errBody = (await r.json()) as any;
      if (errBody?.msg) {
        detailMsg = errBody.msg;
        const match = /banned until (\d+)/i.exec(errBody.msg);
        if (match) {
          const untilTs = Number(match[1]);
          if (untilTs > Date.now()) {
            waitSec = Math.ceil((untilTs - Date.now()) / 1000);
          }
        }
      }
    } catch {
      // ignore json parse error
    }
    // 限制单次避让上限（默认最多等待 300s），避免因币安返回长时间戳导致程序过长时间被彻底锁死
    // 但必须预留足够冷静期，避免在封禁未结束前过早重试导致封禁被币安再次顺延
    const maxBackoffSec = Number(process.env.MAX_BACKOFF_SECONDS ?? 300);
    const actualWaitSec = Math.min(waitSec, maxBackoffSec);
    backoffUntil = Date.now() + actualWaitSec * 1000;
    backoffReason = `HTTP ${r.status}: ${detailMsg}`;
    throw new Error(`Binance 触发限频/封禁 (${backoffReason})，避让等待 ${actualWaitSec} 秒后重试`);
  }

  return r;
}

export async function fetch24hTickers(): Promise<Ticker24h[]> {
  const r = await binanceFetch(`/fapi/v1/ticker/24hr`);
  if (!r.ok) throw new Error(`24hr ticker failed: HTTP ${r.status}`);
  const data = (await r.json()) as any[];
  return data
    .filter((d) => isUsdtPerp(d.symbol))
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

export async function fetch1mCandles(symbol: string, limit = 100): Promise<Candle[]> {
  const r = await binanceFetch(`/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=${limit}`);
  if (!r.ok) throw new Error(`klines ${symbol} failed: HTTP ${r.status}`);
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

const weeklyOpenCache = new Map<string, { open: number; closeTime: number }>();

/** 获取当前周 K 线的开盘价（按周缓存直至该根周 K 收盘，开盘价全周不变） */
export async function fetchWeeklyOpen(symbol: string): Promise<number | null> {
  const cached = weeklyOpenCache.get(symbol);
  if (cached && Date.now() < cached.closeTime) {
    return cached.open;
  }
  try {
    const r = await binanceFetch(`/fapi/v1/klines?symbol=${symbol}&interval=1w&limit=1`);
    if (!r.ok) return cached ? cached.open : null;
    const data = (await r.json()) as any[];
    if (!data || data.length === 0) return null;
    const open = parseFloat(data[0][1]);
    const closeTime = Number(data[0][6]);
    weeklyOpenCache.set(symbol, { open, closeTime });
    return open;
  } catch {
    return cached ? cached.open : null;
  }
}
