import { createHmac } from "node:crypto";
import { fetch, EnvHttpProxyAgent, ProxyAgent, type Dispatcher } from "undici";
import { recoverBinanceProxy } from "./proxyNode.ts";

export type Params = Record<string, string | number | boolean>;
export type TradingRequest = <T>(method: "GET" | "POST" | "DELETE", path: string, params?: Params, signed?: boolean) => Promise<T>;

export class TradingApiError extends Error {
  constructor(public code: number, public status: number) {
    // Do not echo URLs, request bodies, signatures or exchange-provided messages.
    super(`Binance 交易接口错误 (HTTP ${status}, code ${code})`);
  }
}

/** Fixed signing hosts; shared proxy recovery, with no automatic mutation retries. */
export class BinanceTradingClient {
  private offset = 0;
  private dispatcher: Dispatcher | undefined;
  private retryAfter = 0;
  readonly base: string;
  constructor(private key: string, private secret: string, testnet = false, private transport = fetch, private recoverProxy = recoverBinanceProxy) {
    this.base = testnet ? "https://demo-fapi.binance.com" : "https://fapi.binance.com";
  }
  request: TradingRequest = <T>(method: "GET" | "POST" | "DELETE", path: string, params: Params = {}, signed = true) => this.perform<T>(method, path, params, signed, false);
  private async perform<T>(method: "GET" | "POST" | "DELETE", path: string, params: Params, signed: boolean, retried: boolean): Promise<T> {
    if (Date.now() < this.retryAfter) throw new Error("交易接口 429 冷静期中，切线后仍等待 Retry-After 再对账");
    if (!/^\/fapi\/v[123]\/[A-Za-z]+(?:\/[A-Za-z]+)?$/.test(path)) throw new Error("非法交易接口路径");
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) query.set(key, String(value));
    if (signed) {
      if (!this.key || !this.secret) throw new Error("实盘 API key / secret 未配置");
      query.set("recvWindow", "5000");
      query.set("timestamp", String(Date.now() + this.offset));
      query.set("signature", createHmac("sha256", this.secret).update(query.toString()).digest("hex"));
    }
    if (!this.dispatcher) {
      const proxy = process.env.PROXY ?? process.env.BINANCE_PROXY;
      this.dispatcher = proxy ? new ProxyAgent(proxy) : new EnvHttpProxyAgent();
    }
    let response;
    try {
      response = await this.transport(`${this.base}${path}${method === "POST" ? "" : `?${query}`}`, {
        method, dispatcher: this.dispatcher, redirect: "error", signal: AbortSignal.timeout(8000),
        headers: { ...(signed ? { "X-MBX-APIKEY": this.key } : {}), "Content-Type": "application/x-www-form-urlencoded" },
        ...(method === "POST" ? { body: query.toString() } : {}),
      });
    } catch {
      throw new Error("交易请求未确认（网络异常或超时），须先对账；不会自动重发订单");
    }
    let data: unknown;
    try { data = await response.json(); } catch {
      if (response.ok) throw new Error("交易接口响应无法解析，须先对账");
      data = null; // 451 often returns HTML: the HTTP status must still trigger recovery.
    }
    if (response.status === 429 || response.status === 451) {
      if (response.status === 429) {
        const header = response.headers.get("retry-after");
        const seconds = header === null ? 60 : Number(header);
        this.retryAfter = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Math.max(60000, Date.parse(header ?? "") - Date.now()) || 60000);
      }
      const node = await this.recoverProxy(response.status, `${this.base}/fapi/v1/ping`, this.dispatcher).catch(() => null);
      // A read-only 451 request may retry once with a new timestamp/signature.
      // POST/DELETE always return the original error to the durable order reconciler.
      if (node && response.status === 451 && method === "GET" && !retried) {
        await this.dispatcher?.destroy(); this.dispatcher = undefined;
        return this.perform<T>(method, path, params, signed, true);
      }
    }
    if (!response.ok || (typeof (data as { code?: unknown })?.code === "number" && (data as { code: number }).code < 0)) {
      throw new TradingApiError(Number((data as { code?: number })?.code ?? 0), response.status);
    }
    return data as T;
  }
  async syncTime() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const start = Date.now();
      const { serverTime } = await this.request<{ serverTime: number }>("GET", "/fapi/v1/time", {}, false);
      const end = Date.now();
      if (!Number.isFinite(serverTime)) throw new Error("交易所时钟无效");
      // A 451 retry may include many seconds of proxy probing. That duration is
      // not the time request's RTT and must never become the signing clock offset.
      if (end - start > 1500 && attempt < 2) continue;
      if (end - start > 5000) throw new Error("交易所时钟同步延迟过高，暂停签名交易");
      this.offset = Math.round(serverTime - (start + end) / 2);
      return;
    }
  }
  async close() { await this.dispatcher?.close(); }
}

export interface ExchangeOrder {
  clientOrderId: string;
  status: string;
  executedQty: string;
  avgPrice: string;
  cumQuote: string;
  orderId: number;
}
export interface ExchangePosition {
  symbol: string;
  positionSide: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  leverage: string;
  marginType: string;
  isAutoAddMargin: string;
}
export interface AlgoOrder {
  clientAlgoId: string;
  symbol: string;
  algoStatus: string;
  orderType: string;
  side: string;
  closePosition: boolean;
  triggerPrice: string;
}
export interface SymbolRules {
  symbol: string;
  status: string;
  contractType: string;
  quoteAsset: string;
  marginAsset: string;
  filters: { filterType: string; stepSize?: string; minQty?: string; maxQty?: string; tickSize?: string; minPrice?: string; maxPrice?: string; notional?: string; minNotional?: string }[];
}

/** Decimal integer arithmetic: never round a quantity upward through a lot boundary. */
export function floorToStep(value: number, step: string): string {
  if (!Number.isFinite(value) || value < 0 || !/^\d+(\.\d+)?$/.test(step) || Number(step) <= 0) throw new Error("无效的交易精度");
  const decimals = (step.split(".")[1] ?? "").length;
  if (decimals > 12) throw new Error("不支持的交易精度");
  const scale = 10n ** BigInt(decimals);
  const stepUnits = BigInt(step.replace(".", ""));
  // toFixed may round at the last decimal; remove that increment if above the original value.
  let units = BigInt(value.toFixed(decimals).replace(".", ""));
  if (Number(units) / Number(scale) > value) units--;
  units = units / stepUnits * stepUnits;
  const digits = units.toString().padStart(decimals + 1, "0");
  return decimals ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}` : digits;
}

export function ceilToStep(value: number, step: string): string {
  const floor = floorToStep(value, step);
  if (Number(floor) >= value) return floor;
  const decimals = (step.split(".")[1] ?? "").length;
  return (Number(floor) + Number(step)).toFixed(decimals);
}

export function symbolFilters(rules: SymbolRules) {
  if (rules.status !== "TRADING" || rules.contractType !== "PERPETUAL" || rules.quoteAsset !== "USDT" || rules.marginAsset !== "USDT") throw new Error("仅允许可交易的 USDT 永续合约");
  const lot = rules.filters.find(f => f.filterType === "LOT_SIZE");
  const market = rules.filters.find(f => f.filterType === "MARKET_LOT_SIZE");
  const price = rules.filters.find(f => f.filterType === "PRICE_FILTER");
  const notional = rules.filters.find(f => f.filterType === "MIN_NOTIONAL" || f.filterType === "NOTIONAL");
  if (!lot?.stepSize || !price?.tickSize || !notional || !market) throw new Error("交易所规则不完整");
  for (const n of [lot.stepSize, lot.minQty, lot.maxQty, price.tickSize, market.minQty, market.maxQty, notional.notional ?? notional.minNotional]) {
    if (!Number.isFinite(Number(n)) || Number(n) <= 0) throw new Error("交易所规则无效");
  }
  return { lot, market, price, minNotional: Number(notional.notional ?? notional.minNotional) };
}
