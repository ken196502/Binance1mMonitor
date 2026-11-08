import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHmac } from "node:crypto";
import { Response } from "undici";
import { BinanceTradingClient, TradingApiError, floorToStep, ceilToStep, type TradingRequest, type Params, type ExchangeOrder, type AlgoOrder } from "../../src/binance-trading.ts";
import { LiveTradingEngine, readLiveConfig, liveLeverageForHoldMinutes, type LiveConfig } from "../../src/live-trading.ts";
import { handleLiveTradingApi, authorizedLiveControl } from "../../src/live-trading-api.ts";
import type { PaperPosition } from "../../src/types.ts";

class Exchange {
  now = Date.now();
  wallet = 100;
  amount = 0;
  price = 10;
  hedge = false;
  multi = false;
  externalOrders: unknown[] = [];
  entryFraction = 1;
  timeoutEntry = false;
  rejectBeforeEntry = false;
  failProtection = false;
  timeoutClose = false;
  hideQueries = false;
  leverage = "3";
  marginType = "isolated";
  autoAdd = "false";
  minNotional = "5";
  orders = new Map<string, ExchangeOrder>();
  algos = new Map<string, AlgoOrder>();
  calls: { method: string; endpoint: string; params: Params }[] = [];
  beforeOrder?: (params: Params) => void;
  request: TradingRequest = async <T>(method: string, endpoint: string, params: Params = {}): Promise<T> => {
    this.calls.push({ method, endpoint, params });
    let result: unknown;
    if (endpoint === "/fapi/v3/account") result = { canTrade: true, totalWalletBalance: String(this.wallet), totalMarginBalance: String(this.wallet), availableBalance: String(this.wallet), assets: [{ asset: "USDT", walletBalance: String(this.wallet) }] };
    else if (endpoint === "/fapi/v1/positionSide/dual") result = { dualSidePosition: this.hedge };
    else if (endpoint === "/fapi/v1/multiAssetsMargin") result = { multiAssetsMargin: this.multi };
    else if (endpoint === "/fapi/v2/positionRisk") result = [{ symbol: params.symbol ?? "TESTUSDT", positionSide: "BOTH", positionAmt: String(this.amount), entryPrice: String(this.price), markPrice: String(this.price), leverage: this.leverage, marginType: this.marginType, isAutoAddMargin: this.autoAdd }];
    else if (endpoint === "/fapi/v1/openOrders") result = this.externalOrders;
    else if (endpoint === "/fapi/v1/openAlgoOrders") result = [...this.algos.values()];
    else if (endpoint === "/fapi/v1/exchangeInfo") result = { symbols: [{ symbol: "TESTUSDT", status: "TRADING", contractType: "PERPETUAL", quoteAsset: "USDT", marginAsset: "USDT", filters: [
      { filterType: "LOT_SIZE", stepSize: "0.01", minQty: "0.01", maxQty: "10000" },
      { filterType: "MARKET_LOT_SIZE", stepSize: "0.01", minQty: "0.01", maxQty: "10000" },
      { filterType: "PRICE_FILTER", tickSize: "0.01", minPrice: "0.01", maxPrice: "100000" },
      { filterType: "MIN_NOTIONAL", notional: this.minNotional },
    ] }] };
    else if (endpoint === "/fapi/v1/ticker/bookTicker") result = { bidPrice: String(this.price), askPrice: String(this.price), time: this.now };
    else if (endpoint === "/fapi/v1/marginType" || endpoint === "/fapi/v1/leverage") result = {};
    else if (endpoint === "/fapi/v1/order" && method === "POST") {
      this.beforeOrder?.(params);
      const entry = params.type === "LIMIT";
      if (entry && this.rejectBeforeEntry) throw new Error("unconfirmed");
      const q = Number(params.quantity) * (entry ? this.entryFraction : 1);
      if (entry) this.amount = params.side === "BUY" ? q : -q;
      else this.amount = Math.sign(this.amount) * Math.max(0, Math.abs(this.amount) - q);
      const order = { clientOrderId: String(params.newClientOrderId), status: entry && this.entryFraction < 1 ? "EXPIRED" : "FILLED", executedQty: String(q), avgPrice: String(this.price), cumQuote: String(q * this.price), orderId: this.orders.size + 1 };
      this.orders.set(order.clientOrderId, order); result = order;
      if (entry && this.timeoutEntry || !entry && this.timeoutClose) throw new Error("unconfirmed");
    } else if (endpoint === "/fapi/v1/order" && method === "GET") {
      result = this.orders.get(String(params.origClientOrderId));
      if (!result || this.hideQueries) throw new TradingApiError(-2013, 400);
    } else if (endpoint === "/fapi/v1/algoOrder" && method === "POST") {
      if (this.failProtection) throw new TradingApiError(-2021, 400);
      const algo = { clientAlgoId: String(params.clientAlgoId), symbol: String(params.symbol), algoStatus: "NEW", orderType: String(params.type), side: String(params.side), closePosition: params.closePosition === "true", triggerPrice: String(params.triggerPrice) };
      this.algos.set(algo.clientAlgoId, algo); result = algo;
    } else if (endpoint === "/fapi/v1/algoOrder" && method === "GET") {
      result = this.algos.get(String(params.clientAlgoId));
      if (!result) throw new TradingApiError(-2013, 400);
    } else if (endpoint === "/fapi/v1/algoOrder" && method === "DELETE") { this.algos.delete(String(params.clientAlgoId)); result = {}; }
    else throw new Error(`Unexpected mock endpoint ${method} ${endpoint}`);
    return result as T;
  };
  entries() { return this.calls.filter(c => c.method === "POST" && c.endpoint === "/fapi/v1/order" && c.params.type === "LIMIT"); }
  exits() { return this.calls.filter(c => c.method === "POST" && c.endpoint === "/fapi/v1/order" && c.params.type === "MARKET"); }
}

function signal(ex: Exchange, side: "LONG" | "SHORT" = "LONG"): PaperPosition {
  return { id: `TESTUSDT-${ex.now}`, symbol: "TESTUSDT", side, entryTime: ex.now, entryPrice: 10, timeoutAt: ex.now + 15 * 60000, tp1Percent: 3, tp2Percent: 7, sl1Percent: 5, sl2Percent: 7, moveSlToEntryAfterTp1: true } as PaperPosition;
}

async function setup(t: test.TestContext, overrides: Partial<LiveConfig> = {}, exchange = new Exchange()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-trading-"));
  const config: LiveConfig = { enabled: true, testnet: true, apiKey: "fake-key", apiSecret: "fake-secret", controlToken: "a".repeat(32), budgetUsdt: 100, marginPercent: 20, storageFile: path.join(dir, "live.json"), ...overrides };
  const dependencies = { request: exchange.request, syncTime: async () => {}, now: () => exchange.now };
  const engine = new LiveTradingEngine(config, dependencies);
  t.after(async () => { await engine.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await engine.start(false);
  return { engine, exchange, config, dependencies, dir };
}

test("live config: disabled and blank by default; hard cap, NaN and invalid switches rejected", () => {
  const config = readLiveConfig({});
  assert.equal(config.enabled, false); assert.equal(config.apiKey, ""); assert.equal(config.apiSecret, "");
  assert.equal(config.budgetUsdt, 10); assert.equal(config.marginPercent, 20);
  for (const value of ["101", "Infinity", "NaN", "0", "-1", ""]) assert.throws(() => readLiveConfig({ LIVE_MAX_CAPITAL_USDT: value }));
  assert.throws(() => readLiveConfig({ LIVE_MARGIN_PERCENT: "21" }));
  assert.throws(() => readLiveConfig({ LIVE_TRADING_ENABLED: "yes" }));
});

test("decimal lot rounding never increases quantity and supports non-power-of-ten steps", () => {
  assert.equal(floorToStep(1.239999, "0.01000000"), "1.23000000");
  assert.equal(floorToStep(0.009999999, "0.01"), "0.00");
  assert.equal(floorToStep(3.49, "0.25"), "3.25");
  assert.equal(ceilToStep(3.26, "0.25"), "3.50");
  assert.throws(() => floorToStep(NaN, "0.01"));
});

test("disabled / missing credentials make zero exchange calls", async t => {
  const a = await setup(t, { enabled: false });
  await a.engine.onSignal(signal(a.exchange)); assert.equal(a.exchange.calls.length, 0);
  const b = await setup(t, { apiKey: "", apiSecret: "" });
  await b.engine.onSignal(signal(b.exchange)); assert.equal(b.exchange.calls.length, 0); assert.equal(b.engine.summary().status, "halted");
});

test("funding cap and account isolation reject unsafe accounts before any POST", async t => {
  for (const mode of ["balance", "hedge", "multi", "positions", "orders", "auto-add", "leverage"] as const) {
    const ex = new Exchange();
    if (mode === "balance") ex.wallet = 100.01;
    if (mode === "hedge") ex.hedge = true;
    if (mode === "multi") ex.multi = true;
    if (mode === "positions") ex.amount = 1;
    if (mode === "orders") ex.externalOrders = [{}];
    if (mode === "auto-add") ex.autoAdd = "true";
    if (mode === "leverage") ex.leverage = "10";
    const { engine } = await setup(t, {}, ex);
    await engine.onSignal(signal(ex));
    assert.equal(ex.entries().length, 0, mode); assert.equal(engine.summary().status, "halted", mode);
  }
});

test("new entry: durable intent, 20% margin at 3x, IOC, confirmed exchange protection and no duplicate signal", async t => {
  const { engine, exchange: ex, config } = await setup(t);
  ex.beforeOrder = p => {
    const saved = JSON.parse(fs.readFileSync(config.storageFile, "utf8"));
    assert.equal(saved.active.entryOrderId, p.newClientOrderId);
    assert.equal(saved.active.status, "ENTERING");
  };
  await Promise.all([engine.onSignal(signal(ex)), engine.onSignal(signal(ex)), engine.onSignal(signal(ex))]);
  assert.equal(ex.entries().length, 1);
  const entry = ex.entries()[0].params;
  assert.equal(entry.timeInForce, "IOC"); assert.equal(entry.side, "BUY");
  assert.ok(Number(entry.quantity) * Number(entry.price) < 60);
  assert.equal(engine.summary().activeTrade?.entryPrice, 10);
  assert.equal(ex.algos.size, 1);
  assert.equal([...ex.algos.values()][0].triggerPrice, "9.5");
  const saved = fs.readFileSync(config.storageFile, "utf8");
  assert.ok(!saved.includes(config.apiKey)); assert.ok(!saved.includes(config.apiSecret)); assert.ok(!JSON.stringify(engine.summary()).includes(config.controlToken));
});

test("minimum notional skips rather than rounds up; stale signals never order", async t => {
  const ex = new Exchange(); ex.minNotional = "100";
  const { engine } = await setup(t, {}, ex);
  await engine.onSignal(signal(ex)); assert.equal(ex.entries().length, 0);
  const s = signal(ex); s.entryTime -= 20000;
  await engine.onSignal(s); assert.equal(ex.entries().length, 0);
});

test("first trial uses 10 USDT total, 20% margin, and a 3x entry below 6 USDT", async t => {
  const ex = new Exchange(); ex.wallet = 10;
  const { engine } = await setup(t, { budgetUsdt: 10, marginPercent: 20 }, ex);
  await engine.onSignal(signal(ex));
  assert.equal(ex.entries().length, 1);
  assert.ok(Number(ex.entries()[0].params.quantity) * Number(ex.entries()[0].params.price) <= 6 / 1.02);
  assert.equal(engine.summary().budgetUsdt, 10);
  const tooLarge = new Exchange(); tooLarge.wallet = 10.01;
  const other = await setup(t, { budgetUsdt: 10, marginPercent: 20 }, tooLarge);
  await other.engine.onSignal(signal(tooLarge));
  assert.equal(tooLarge.entries().length, 0);
});

test("leverage follows planned duration: up to 10 minutes 5x, longer 3x; margin stays 20%", async t => {
  assert.equal(liveLeverageForHoldMinutes(10), 5);
  assert.equal(liveLeverageForHoldMinutes(5), 5);
  assert.equal(liveLeverageForHoldMinutes(10.01), 3);
  assert.equal(liveLeverageForHoldMinutes(45), 3);
  assert.throws(() => liveLeverageForHoldMinutes(NaN));
  const ex = new Exchange(); ex.wallet = 10; ex.leverage = "5";
  const { engine } = await setup(t, { budgetUsdt: 10, marginPercent: 20 }, ex);
  const s = signal(ex); s.timeoutAt = s.entryTime + 10 * 60000;
  await engine.onSignal(s);
  assert.equal(ex.entries().length, 1);
  assert.equal(ex.calls.find(c => c.endpoint === "/fapi/v1/leverage")?.params.leverage, 5);
  const trade = engine.summary().activeTrade!;
  assert.equal(trade.leverage, 5); assert.equal(trade.marginBudgetUsdt, 2);
  assert.ok(trade.initialQuantity * trade.entryPrice <= 10 / 1.02);
});

test("losses reduce the 20% margin allocation instead of retaining a fixed dollar size", async t => {
  const ex = new Exchange(); ex.wallet = 9;
  const { engine } = await setup(t, { budgetUsdt: 10, marginPercent: 20 }, ex);
  await engine.onSignal(signal(ex));
  assert.equal(engine.summary().activeTrade?.marginBudgetUsdt, 1.8);
  assert.ok(engine.summary().activeTrade!.initialQuantity * 10 / 3 <= 1.8);
});

test("partial entry uses actual quantity and actual price", async t => {
  const { engine, exchange: ex } = await setup(t);
  ex.entryFraction = 0.5;
  await engine.onSignal(signal(ex, "SHORT"));
  const active = engine.summary().activeTrade!;
  assert.equal(active.initialQuantity, Number(ex.entries()[0].params.quantity) / 2);
  assert.equal(active.stopPrice, 10.5); assert.equal(ex.entries()[0].params.side, "SELL");
});

test("entry response loss resolves by client ID without a second POST", async t => {
  const { engine, exchange: ex } = await setup(t); ex.timeoutEntry = true;
  await engine.onSignal(signal(ex)); await engine.maintain();
  assert.equal(ex.entries().length, 1); assert.equal(engine.summary().activeTrade?.status, "OPEN");
  assert.equal(ex.algos.size, 1); assert.equal(engine.summary().status, "halted");
});

test("unknown entry survives restart and retains reservation without resubmission", async t => {
  const { engine, exchange: ex, config, dependencies } = await setup(t); ex.timeoutEntry = true; ex.hideQueries = true;
  await engine.onSignal(signal(ex));
  assert.equal(engine.summary().activeTrade?.status, "ENTERING");
  await engine.stop();
  const restarted = new LiveTradingEngine(config, dependencies);
  try {
    await restarted.start(false); await restarted.onSignal(signal(ex)); assert.equal(ex.entries().length, 1);
    ex.hideQueries = false; await restarted.maintain();
    assert.equal(restarted.summary().activeTrade?.status, "OPEN"); assert.equal(ex.algos.size, 1);
  } finally { await restarted.stop(); }
});

test("missing/rejected exchange stop immediately submits only a reduce-only exit", async t => {
  const { engine, exchange: ex } = await setup(t); ex.failProtection = true;
  await engine.onSignal(signal(ex));
  assert.equal(ex.exits().length, 1); assert.equal(ex.exits()[0].params.reduceOnly, "true");
  await engine.maintain(); assert.equal(engine.summary().activeTrade, null); assert.equal(engine.summary().status, "halted");
});

test("TP1 closes half then protects remainder at breakeven; timeout closes remainder", async t => {
  const { engine, exchange: ex } = await setup(t);
  await engine.onSignal(signal(ex));
  const initial = engine.summary().activeTrade!.initialQuantity;
  ex.price = 10.4;
  engine.onTick({ symbol: "TESTUSDT", price: ex.price, time: ex.now }); await engine.maintain();
  assert.equal(ex.exits().length, 1);
  assert.equal(Number(ex.exits()[0].params.quantity), Number(floorToStep(initial / 2, "0.01")));
  assert.equal(engine.summary().activeTrade?.firstTargetDone, true);
  assert.ok(engine.summary().activeTrade!.stopPrice >= 10.02);
  assert.equal(ex.algos.size, 1);
  ex.now += 15 * 60000 + 1000;
  await engine.maintain(); await engine.maintain();
  assert.equal(engine.summary().activeTrade, null);
  assert.equal(ex.exits().length, 2); assert.ok(ex.exits().every(c => c.params.reduceOnly === "true"));
  assert.equal(ex.algos.size, 0);
});

test("exit response loss never repeats the close; paused mode still manages exits", async t => {
  const { engine, exchange: ex } = await setup(t);
  await engine.onSignal(signal(ex, "SHORT")); await engine.control("pause"); ex.timeoutClose = true;
  ex.price = 9;
  engine.onTick({ symbol: "TESTUSDT", price: 9, time: ex.now }); await engine.maintain(); await engine.maintain();
  assert.equal(ex.exits().length, 1); assert.equal(engine.summary().activeTrade, null); assert.equal(Math.abs(ex.amount), 0);
});

test("full close uses exchange lot quantity even when local subtraction is slightly smaller", async t => {
  const { engine, exchange: ex, config, dependencies } = await setup(t);
  await engine.onSignal(signal(ex)); await engine.stop();
  const saved = JSON.parse(fs.readFileSync(config.storageFile, "utf8"));
  saved.active.remainingQuantity = ex.amount - 1e-12;
  fs.writeFileSync(config.storageFile, JSON.stringify(saved));
  const restarted = new LiveTradingEngine(config, dependencies);
  try {
    await restarted.start(false); await restarted.control("close"); await restarted.maintain();
    assert.equal(restarted.summary().activeTrade, null);
    assert.equal(Math.abs(ex.amount), 0);
    assert.equal(ex.exits()[0].params.quantity, ex.entries()[0].params.quantity);
  } finally { await restarted.stop(); }
});

test("disabled after restart still reconciles and closes existing position on timeout", async t => {
  const { engine, exchange: ex, config, dependencies } = await setup(t);
  await engine.onSignal(signal(ex)); await engine.stop(); ex.now += 15 * 60000 + 1000;
  const restarted = new LiveTradingEngine({ ...config, enabled: false }, dependencies);
  try {
    await restarted.start(false); await restarted.maintain(); await restarted.maintain();
    assert.equal(restarted.summary().activeTrade, null); assert.equal(ex.exits().length, 1); assert.equal(ex.entries().length, 1);
  } finally { await restarted.stop(); }
});

test("corrupt state and another process lock fail closed without overwriting evidence", async t => {
  const { engine, exchange: ex, config, dependencies } = await setup(t);
  const second = new LiveTradingEngine(config, dependencies);
  await second.start(false); assert.equal(second.summary().status, "halted"); await second.stop();
  await engine.stop(); fs.writeFileSync(config.storageFile, "{bad json");
  const corrupt = new LiveTradingEngine(config, dependencies);
  await corrupt.start(false); await corrupt.onSignal(signal(ex));
  assert.equal(corrupt.summary().status, "halted"); assert.equal(fs.readFileSync(config.storageFile, "utf8"), "{bad json");
  await corrupt.stop();
});

test("missing credentials retain visibility of an unresolved position without touching exchange", async t => {
  const { engine, exchange: ex, config, dependencies } = await setup(t);
  await engine.onSignal(signal(ex)); await engine.stop();
  const calls = ex.calls.length;
  const restarted = new LiveTradingEngine({ ...config, enabled: false, apiKey: "", apiSecret: "" }, dependencies);
  await restarted.start(false);
  assert.equal(restarted.summary().status, "halted");
  assert.equal(restarted.summary().activeTrade?.symbol, "TESTUSDT");
  assert.equal(ex.calls.length, calls);
  await restarted.stop();
});

test("signing uses the exact transmitted body, fixed host, and redacts exchange errors", async () => {
  let count = 0;
  const client = new BinanceTradingClient("test-key", "test-secret", true, (async (url, options) => {
    count++;
    assert.ok(String(url).startsWith("https://demo-fapi.binance.com/fapi/"));
    assert.equal(options?.redirect, "error");
    const body = String(options?.body), query = new URLSearchParams(body);
    const signature = query.get("signature"); query.delete("signature");
    assert.equal(signature, createHmac("sha256", "test-secret").update(query.toString()).digest("hex"));
    assert.equal((options?.headers as Record<string, string>)["X-MBX-APIKEY"], "test-key");
    return new Response(JSON.stringify({ code: -2010, msg: "secret=test-secret" }), { status: 400 });
  }) as typeof import("undici").fetch);
  try {
    await assert.rejects(client.request("POST", "/fapi/v1/order", { symbol: "TESTUSDT" }), e => e instanceof TradingApiError && !e.message.includes("test-secret"));
    assert.equal(count, 1);
  } finally { await client.close(); }
});

test("451 HTML on an order rotates the proxy without repeating the order", async () => {
  let orders = 0, rotations = 0;
  const client = new BinanceTradingClient("key", "secret", true,
    (async () => { orders++; return new Response('<html>restricted</html>', { status: 451 }); }) as typeof import('undici').fetch,
    async (status, probe) => { assert.equal(status, 451); assert.equal(probe, 'https://demo-fapi.binance.com/fapi/v1/ping'); rotations++; return 'JP'; });
  try {
    await assert.rejects(client.request('POST', '/fapi/v1/order', { symbol: 'TESTUSDT' }), e => e instanceof TradingApiError && e.status === 451);
    assert.equal(orders, 1); assert.equal(rotations, 1);
  } finally { await client.close(); }
});

test("429 switches proxy but respects Retry-After and never replays a mutation", async () => {
  let calls = 0, rotations = 0;
  const client = new BinanceTradingClient("key", "secret", true,
    (async () => { calls++; return new Response(JSON.stringify({ code: -1003 }), { status: 429, headers: { 'Retry-After': '60' } }); }) as typeof import('undici').fetch,
    async status => { assert.equal(status, 429); rotations++; return 'SG'; });
  try {
    await assert.rejects(client.request('POST', '/fapi/v1/order', { symbol: 'TESTUSDT' }));
    await assert.rejects(client.request('GET', '/fapi/v1/order', { symbol: 'TESTUSDT' }), /429/);
    assert.equal(calls, 1); assert.equal(rotations, 1);
  } finally { await client.close(); }
});

test("read-only 451 request can retry once after verified proxy recovery", async () => {
  let calls = 0;
  const client = new BinanceTradingClient("key", "secret", true,
    (async () => { calls++; return calls === 1 ? new Response('restricted', { status: 451 }) : new Response(JSON.stringify({ serverTime: Date.now() })); }) as typeof import('undici').fetch,
    async () => 'JP');
  try { await client.syncTime(); assert.equal(calls, 2); }
  finally { await client.close(); }
});

test("slow proxy recovery is excluded from the signing clock offset", async t => {
  let now = 1800000000000, calls = 0;
  t.mock.method(Date, 'now', () => now);
  const client = new BinanceTradingClient('key', 'secret', true, (async url => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/time')) {
      if (++calls === 1) now += 20000;
      return new Response(JSON.stringify({ serverTime: now }));
    }
    assert.equal(Number(parsed.searchParams.get('timestamp')), now);
    return new Response('{}');
  }) as typeof import('undici').fetch);
  try {
    await client.syncTime(); assert.equal(calls, 2);
    await client.request('GET', '/fapi/v3/account');
  } finally { await client.close(); }
});

test("live HTTP control rejects GET, absent/wrong tokens; authorized pause is durable", async t => {
  const { engine, config } = await setup(t);
  assert.equal(authorizedLiveControl(undefined, config.controlToken), false);
  assert.equal(authorizedLiveControl("Bearer nope", config.controlToken), false);
  const server = http.createServer((req, res) => { void handleLiveTradingApi(req, res, new URL(req.url!, "http://local").pathname, engine, config.controlToken, () => engine.summary()); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.equal((await fetch(`${url}/api/live-trading/pause`)).status, 405);
  assert.equal((await fetch(`${url}/api/live-trading/pause`, { method: "POST" })).status, 401);
  assert.equal((await fetch(`${url}/api/live-trading/pause`, { method: "POST", headers: { Authorization: `Bearer ${config.controlToken}` } })).status, 200);
  assert.equal(engine.summary().status, "paused");
  assert.equal(JSON.parse(fs.readFileSync(config.storageFile, "utf8")).paused, true);
});
