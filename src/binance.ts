// Binance USDT-margined (u本位) FUTURES market-data client.
// Endpoints live on fapi.binance.com — which is blocked in some regions and has
// no public mirror (unlike spot). Routing through a local HTTP proxy is required
// there: set HTTPS_PROXY (e.g. http://127.0.0.1:7890) and EnvHttpProxyAgent will
// apply it to every fetch below. With no proxy env vars set it is a no-op.

import { EnvHttpProxyAgent, ProxyAgent, setGlobalDispatcher } from "undici";
import type { Candle } from "./macd.ts";

// Proxy routing for Node's global fetch, resolved in priority order:
//   1. PROXY (or BINANCE_PROXY) — app-specific, always forced when set.
//   2. Standard HTTP_PROXY / HTTPS_PROXY / NO_PROXY env vars.
//   3. No proxy at all (direct).
// fapi.binance.com is blocked in some regions and has no public mirror (unlike
// spot), so PROXY is usually required there — e.g. PROXY=http://127.0.0.1:7890.
const PROXY = process.env.PROXY ?? process.env.BINANCE_PROXY ?? "";
if (PROXY) {
  setGlobalDispatcher(new ProxyAgent(PROXY));
} else {
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

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

/** fetch() wrapper that retries once on FALLBACK_BASE (if configured) on a network error. */
async function binanceFetch(path: string): Promise<Response> {
  try {
    return await fetch(`${BASE}${path}`);
  } catch (e) {
    if (!FALLBACK_BASE || FALLBACK_BASE === BASE || !isNetworkError(e)) throw e;
    return fetch(`${FALLBACK_BASE}${path}`);
  }
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
  volume: Ticker24h[];
}

export function pickTops(tickers: Ticker24h[], n = 10): TickerTops {
  const gainers = [...tickers].sort((a, b) => b.priceChangePercent - a.priceChangePercent).slice(0, n);
  const losers = [...tickers].sort((a, b) => a.priceChangePercent - b.priceChangePercent).slice(0, n);
  const volume = [...tickers].sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, n);
  return { gainers, losers, volume };
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
