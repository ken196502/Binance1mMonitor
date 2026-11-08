import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { BinanceTradingClient, TradingApiError, floorToStep, ceilToStep, symbolFilters, type TradingRequest, type SymbolRules, type ExchangeOrder, type ExchangePosition, type AlgoOrder } from "./binance-trading.ts";
import type { PaperPosition } from "./types.ts";
import type { LiveTrade, LiveTradingSummary } from "./live-trading-types.ts";

export const LIVE_HARD_CAP_USDT = 100;
/** Planned holding period, never the shrinking time left on an existing position. */
export function liveLeverageForHoldMinutes(minutes: number): 3 | 5 {
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("实盘计划持仓时长无效");
  return minutes <= 10 ? 5 : 3;
}
const TERMINAL = new Set(["FILLED", "CANCELED", "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED"]);
const id = (kind: string) => `b1m_${kind}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;

export interface LiveConfig {
  enabled: boolean;
  testnet: boolean;
  apiKey: string;
  apiSecret: string;
  controlToken: string;
  budgetUsdt: number;
  marginPercent: number;
  storageFile: string;
}

export function readLiveConfig(env: NodeJS.ProcessEnv = process.env): LiveConfig {
  const bool = (name: string) => {
    if (env[name] !== undefined && !["true", "false"].includes(env[name]!)) throw new Error(`${name} 只能是 true / false`);
    return env[name] === "true";
  };
  const config = {
    enabled: bool("LIVE_TRADING_ENABLED"), testnet: bool("LIVE_TRADING_TESTNET"),
    apiKey: env.BINANCE_API_KEY?.trim() ?? "", apiSecret: env.BINANCE_API_SECRET?.trim() ?? "",
    controlToken: env.LIVE_CONTROL_TOKEN?.trim() ?? "",
    budgetUsdt: Number(env.LIVE_MAX_CAPITAL_USDT ?? 10), marginPercent: Number(env.LIVE_MARGIN_PERCENT ?? 20),
    storageFile: path.resolve(env.DATA_DIR ?? "data", "live-trading.json"),
  };
  validateLiveLimits(config);
  return config;
}

function validateLiveLimits(c: LiveConfig) {
  if (!Number.isFinite(c.budgetUsdt) || c.budgetUsdt <= 0 || c.budgetUsdt > LIVE_HARD_CAP_USDT) throw new Error("实盘总资金限额必须 > 0 且 ≤ 100 USDT");
  if (!Number.isFinite(c.marginPercent) || c.marginPercent <= 0 || c.marginPercent > 20) throw new Error("实盘每笔保证金比例必须 > 0 且 ≤ 20%");
}

interface SavedState {
  version: 1;
  fingerprint: string;
  paused: boolean;
  haltReason: string | null;
  seenSignals: string[];
  active: LiveTrade | null;
  history: LiveTrade[];
}

interface Dependencies { request: TradingRequest; syncTime: () => Promise<void>; now?: () => number }

/** One serial execution lane and a durable intent before every order POST. */
export class LiveTradingEngine {
  private state: SavedState;
  private request: TradingRequest;
  private syncTime: () => Promise<void>;
  private now: () => number;
  private client?: BinanceTradingClient;
  private queue: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private running = false;
  private starting = false;
  private entryQueued = false;
  private tickQueued = false;
  private maintenanceQueued = false;
  private lockOwned = false;
  private brokenStorage = false;
  private wallet: number | null = null;
  private equity: number | null = null;
  private checkedAt: number | null = null;
  private lastTimeSync = 0;
  private rules = new Map<string, SymbolRules>();
  private tick: { symbol: string; price: number; time: number } | null = null;

  constructor(private config: LiveConfig, dependencies?: Dependencies) {
    validateLiveLimits(config);
    this.now = dependencies?.now ?? Date.now;
    if (dependencies) {
      this.request = dependencies.request;
      this.syncTime = dependencies.syncTime;
    } else {
      this.client = new BinanceTradingClient(config.apiKey, config.apiSecret, config.testnet);
      this.request = this.client.request;
      this.syncTime = () => this.client!.syncTime();
    }
    const fingerprint = createHash("sha256").update(`${config.testnet}:${config.apiKey}`).digest("hex");
    this.state = { version: 1, fingerprint, paused: false, haltReason: null, seenSignals: [], active: null, history: [] };
    if (fs.existsSync(config.storageFile)) {
      try {
        const saved = JSON.parse(fs.readFileSync(config.storageFile, "utf8")) as SavedState;
        this.validateState(saved);
        this.state = saved;
        // Preserve visible evidence of existing positions even if credentials are missing/wrong.
        // After a flat shutdown, removing the key may still show history without enabling trading.
        if (saved.fingerprint !== fingerprint && (config.enabled || config.apiKey || saved.active)) throw new Error("实盘状态属于另一 API key 或网络；请使用原配置恢复，或为独立账户设置独立 DATA_DIR");
      } catch (e) {
        this.brokenStorage = true;
        this.state.haltReason = e instanceof Error && e.message.startsWith("实盘状态属于") ? e.message : "实盘状态文件损坏，禁止自动建立空账户或覆盖原文件";
      }
    }
  }

  private validateState(s: SavedState) {
    if (s.version !== 1 || typeof s.fingerprint !== "string" || typeof s.paused !== "boolean" || !(s.haltReason === null || typeof s.haltReason === "string") || !Array.isArray(s.seenSignals) || !s.seenSignals.every(x => typeof x === "string") || !Array.isArray(s.history) || !(s.active === null || typeof s.active === "object")) throw new Error("状态格式错误");
    for (const t of [...s.history, ...(s.active ? [s.active] : [])]) {
      // Previously saved 1x positions retain their original leverage during recovery.
      t.leverage ??= 1;
      t.marginBudgetUsdt ??= Number(t.requestedQuantity) * Number(t.limitPrice) * 1.02 / t.leverage;
      if (!t || !/^[A-Z0-9]+USDT$/.test(t.symbol) || !["LONG", "SHORT"].includes(t.side) || !["ENTERING", "OPEN", "CLOSED"].includes(t.status) || !t.entryOrderId?.startsWith("b1m_") || !Array.isArray(t.stopIds) || !t.stopIds.every(x => typeof x === "string" && x.startsWith("b1m_")) || !Array.isArray(t.exits)) throw new Error("持仓格式错误");
      if (![1, 3, 5].includes(t.leverage) || !Number.isFinite(t.marginBudgetUsdt) || t.marginBudgetUsdt <= 0 || t.marginBudgetUsdt > LIVE_HARD_CAP_USDT) throw new Error("持仓保证金或杠杆无效");
      for (const n of [Number(t.requestedQuantity), Number(t.limitPrice), t.openedAt, t.timeoutAt, t.tp1Percent, t.tp2Percent, t.stopPercent]) if (!Number.isFinite(n) || n <= 0) throw new Error("持仓数值错误");
      for (const n of [t.entryPrice, t.initialQuantity, t.remainingQuantity, t.stopPrice]) if (!Number.isFinite(n) || n < 0) throw new Error("持仓数值错误");
      if (t.pendingClose && (!t.pendingClose.id.startsWith("b1m_") || !Number.isFinite(Number(t.pendingClose.quantity)) || Number(t.pendingClose.quantity) <= 0)) throw new Error("平仓意图错误");
    }
  }

  private save() {
    if (this.brokenStorage || !this.lockOwned) throw new Error("实盘状态不可写或未持有进程锁");
    const file = this.config.storageFile, temp = `${file}.${process.pid}.tmp`;
    let fd: number | undefined;
    try {
      fd = fs.openSync(temp, "w", 0o600);
      fs.writeFileSync(fd, JSON.stringify(this.state, null, 2));
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, file);
      const dir = fs.openSync(path.dirname(file), "r");
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } catch {
      this.brokenStorage = true;
      throw new Error("实盘状态落盘失败，停止发单；请检查磁盘并核对交易所持仓");
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  private acquireLock() {
    fs.mkdirSync(path.dirname(this.config.storageFile), { recursive: true });
    const lock = `${this.config.storageFile}.lock`;
    // Never steal a stale-looking lock: two contenders could otherwise both remove
    // each other's new lock. Normal shutdown releases it; crash recovery is explicit.
    let fd: number;
    try { fd = fs.openSync(lock, "wx", 0o600); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error("实盘状态已被进程锁定；确认旧实例停止后处理 .lock 文件，保留账本");
      throw e;
    }
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname() })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    this.lockOwned = true;
  }

  private halt(e: unknown) {
    this.state.haltReason = e instanceof Error ? e.message : "实盘执行异常";
    if (this.lockOwned && !this.brokenStorage) {
      try { this.save(); } catch (error) { this.state.haltReason = (error as Error).message; }
    }
  }
  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch(e => this.halt(e));
    return this.queue;
  }

  async start(poll = true) {
    if (this.running || this.starting || this.brokenStorage || (!this.config.enabled && !this.state.active)) return;
    this.starting = true;
    try {
      if (!this.config.apiKey || !this.config.apiSecret) throw new Error("请在 .env 配置 BINANCE_API_KEY / BINANCE_API_SECRET");
      if (this.config.enabled && this.config.controlToken.length < 32) throw new Error("LIVE_CONTROL_TOKEN 需至少 32 字符，用于保护实盘控制和策略修改");
      this.acquireLock();
      this.running = true;
      this.save();
      await this.enqueue(async () => {
        await this.syncTime();
        this.lastTimeSync = this.now();
        if (this.state.active) await this.reconcile();
        else await this.checkAccount();
      });
    } catch (e) { this.halt(e); }
    finally { this.starting = false; }
    if (this.running && poll) this.timer = setInterval(() => { void this.maintain(); }, 5000);
  }

  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    await this.queue;
    if (this.lockOwned) {
      fs.unlinkSync(`${this.config.storageFile}.lock`);
      this.lockOwned = false;
    }
    await this.client?.close();
  }

  summary(): LiveTradingSummary {
    const status = this.state.haltReason ? "halted" : this.starting ? "starting" : !this.config.enabled ? "disabled" : !this.running ? "starting" : this.state.paused ? "paused" : "ready";
    const nextMarginUsdt = this.orderMargin();
    return structuredClone({ enabled: this.config.enabled, configured: !!(this.config.apiKey && this.config.apiSecret && this.config.controlToken.length >= 32), testnet: this.config.testnet,
      status, reason: this.state.haltReason, budgetUsdt: this.config.budgetUsdt, marginPercent: this.config.marginPercent, nextMarginUsdt, nextNotionalUsdt: nextMarginUsdt * 3, nextMaxNotionalUsdt: nextMarginUsdt * 5,
      leverage: 3, shortHoldLeverage: 5, shortHoldMaxMinutes: 10, maxPositions: 1, walletUsdt: this.wallet, equityUsdt: this.equity, lastCheckedAt: this.checkedAt, activeTrade: this.state.active, recentTrades: this.state.history.slice(-20).reverse() });
  }
  private orderMargin() {
    const capital = Math.max(0, Math.min(this.config.budgetUsdt, this.wallet ?? this.config.budgetUsdt, this.equity ?? this.config.budgetUsdt));
    return Math.floor(capital * this.config.marginPercent / 100 * 1e8) / 1e8;
  }
  activeSymbols() { return this.state.active ? [this.state.active.symbol] : []; }
  /** Paper mutations can affect live signals, including while the live lane is paused. */
  protectsStrategyWrites() { return this.config.enabled || !!this.state.active || this.brokenStorage; }

  async control(action: "pause" | "resume" | "close") {
    if (!this.running || this.brokenStorage) throw new Error("实盘模块未就绪，请检查配置与状态后重启");
    return this.enqueue(async () => {
      if (action === "pause" || action === "close") {
        this.state.paused = true; this.save();
        if (action === "close" && this.state.active) {
          await this.reconcile();
          if (this.state.active?.status === "OPEN" && !this.state.active.pendingClose) await this.closeQuantity(this.state.active.remainingQuantity, "manual", false);
        }
      } else {
        if (!this.config.enabled) throw new Error("需在 .env 启用实盘并重启，网页不能启用实盘");
        await this.reconcile();
        if (this.state.active) throw new Error("恢复开仓前须结清当前持仓和未确认订单");
        await this.checkAccount();
        this.state.haltReason = null; this.state.paused = false; this.save();
      }
    });
  }

  private async getRules(symbol: string) {
    if (!this.rules.has(symbol)) {
      const data = await this.request<{ symbols: SymbolRules[] }>("GET", "/fapi/v1/exchangeInfo", {}, false);
      if (!Array.isArray(data.symbols)) throw new Error("交易所规则响应无效");
      for (const s of data.symbols) this.rules.set(s.symbol, s);
    }
    const rules = this.rules.get(symbol);
    if (!rules) throw new Error(`无交易规则: ${symbol}`);
    return symbolFilters(rules);
  }

  private async positions(symbol?: string) {
    const rows = await this.request<ExchangePosition[]>("GET", "/fapi/v2/positionRisk", symbol ? { symbol } : {});
    if (!Array.isArray(rows) || rows.some(p => !p.symbol || !Number.isFinite(Number(p.positionAmt)))) throw new Error("交易所持仓响应无效");
    return rows;
  }

  private async checkAccount() {
    const account = await this.request<{ canTrade: boolean; totalWalletBalance: string; totalMarginBalance: string; availableBalance: string; assets: { asset: string; walletBalance: string }[] }>("GET", "/fapi/v3/account");
    const mode = await this.request<{ dualSidePosition: boolean }>("GET", "/fapi/v1/positionSide/dual");
    const assetsMode = await this.request<{ multiAssetsMargin: boolean }>("GET", "/fapi/v1/multiAssetsMargin");
    const wallet = Number(account.totalWalletBalance), equity = Number(account.totalMarginBalance), available = Number(account.availableBalance);
    if (!account.canTrade || !Number.isFinite(wallet) || wallet < 0 || !Number.isFinite(equity) || !Number.isFinite(available) || available < 0 || !Array.isArray(account.assets)) throw new Error("合约账户不可交易或余额响应无效");
    this.wallet = wallet; this.equity = equity; this.checkedAt = this.now();
    if (mode.dualSidePosition !== false || assetsMode.multiAssetsMargin !== false) throw new Error("小额实盘只支持单向持仓、单资产模式；请在空仓时自行设置");
    if (account.assets.some(a => !Number.isFinite(Number(a.walletBalance)) || (a.asset !== "USDT" && Number(a.walletBalance) !== 0))) throw new Error("请使用仅有 USDT 的独立合约账户测试");
    if (wallet > this.config.budgetUsdt + 1e-8) throw new Error(`合约钱包超过 ${this.config.budgetUsdt} USDT 上限，请使用资金不超过该上限的独立账户`);
    const positions = await this.positions();
    const orders = await this.request<unknown[]>("GET", "/fapi/v1/openOrders");
    const algos = await this.request<AlgoOrder[]>("GET", "/fapi/v1/openAlgoOrders");
    if (positions.some(p => Number(p.positionAmt) !== 0) || !Array.isArray(orders) || orders.length || !Array.isArray(algos) || algos.length) throw new Error("账户存在其他持仓或挂单，禁止混用人工/其他程序的交易账户");
    return available;
  }

  /** Called only for newly created paper entries. Restored paper positions are never copied. */
  onSignal(signal: PaperPosition): Promise<void> {
    if (!this.running || this.starting || !this.config.enabled || this.state.paused || this.state.haltReason || this.state.active || this.entryQueued) return Promise.resolve();
    this.entryQueued = true;
    const copy = structuredClone(signal);
    return this.enqueue(async () => {
      try { await this.enter(copy); } finally { this.entryQueued = false; }
    });
  }

  private async enter(signal: PaperPosition) {
    if (!this.running || this.state.active || this.state.paused || this.state.haltReason || this.state.seenSignals.includes(signal.id)) return;
    if (this.now() - signal.entryTime > 15000 || signal.entryTime > this.now() + 2000 || signal.timeoutAt <= this.now()) return;
    if (!/^[A-Z0-9]+USDT$/.test(signal.symbol) || !["LONG", "SHORT"].includes(signal.side)) throw new Error("实盘信号无效");
    for (const n of [signal.entryPrice, signal.tp1Percent, signal.tp2Percent, signal.sl1Percent, signal.sl2Percent]) if (!Number.isFinite(n) || n <= 0) throw new Error("实盘信号价格或退出参数无效");
    if (Math.max(signal.tp1Percent, signal.tp2Percent, signal.sl1Percent, signal.sl2Percent) >= 100) throw new Error("实盘退出幅度须小于 100%");
    if (this.now() - this.lastTimeSync > 60_000) { await this.syncTime(); this.lastTimeSync = this.now(); }
    const available = await this.checkAccount();
    const { lot, market, price, minNotional } = await this.getRules(signal.symbol);
    const leverage = liveLeverageForHoldMinutes((signal.timeoutAt - signal.entryTime) / 60000);
    const marginBudget = Math.min(this.orderMargin(), available);
    const tranche = marginBudget * leverage;
    // Reserve 2% for execution drift and fees. Size is always rounded down; no minimum uplift.
    const quote = await this.request<{ bidPrice: string; askPrice: string; time: number }>("GET", "/fapi/v1/ticker/bookTicker", { symbol: signal.symbol }, false);
    const bid = Number(quote.bidPrice), ask = Number(quote.askPrice);
    if (!(bid > 0 && ask >= bid) || !Number.isFinite(ask) || !Number.isFinite(quote.time) || Math.abs(this.now() - quote.time) > 10000 || ask / bid > 1.005) throw new Error("实盘盘口过期、无效或价差过大");
    const reference = signal.side === "LONG" ? ask : bid;
    if (Math.abs(reference / signal.entryPrice - 1) > 0.005) throw new Error("实盘价格偏离信号超过 0.5%，跳过追单");
    const limit = signal.side === "LONG" ? floorToStep(ask * 1.002, price.tickSize!) : ceilToStep(bid * 0.998, price.tickSize!);
    const quantity = floorToStep(Math.min(tranche / 1.02 / Math.max(ask * 1.002, Number(limit)), Number(lot.maxQty), Number(market.maxQty)), lot.stepSize!);
    if (Number(quantity) < Math.max(Number(lot.minQty), Number(market.minQty)) || Number(quantity) * Math.min(Number(limit), bid) < minNotional) return;
    if (Number(quantity) * Math.max(ask, Number(limit)) / leverage > marginBudget || marginBudget > this.config.budgetUsdt || Number(limit) <= 0) throw new Error("实盘开仓额度越界");
    // These settings affect only the verified-flat symbol, never an existing position.
    try { await this.request("POST", "/fapi/v1/marginType", { symbol: signal.symbol, marginType: "ISOLATED" }); }
    catch (e) { if (!(e instanceof TradingApiError && e.code === -4046)) throw e; }
    await this.request("POST", "/fapi/v1/leverage", { symbol: signal.symbol, leverage });
    const settings = (await this.positions(signal.symbol)).find(p => p.positionSide === "BOTH");
    if (!settings || settings.marginType !== "isolated" || Number(settings.leverage) !== leverage || settings.isAutoAddMargin !== "false" || Number(settings.positionAmt) !== 0) throw new Error(`逐仓 / ${leverage} 倍 / 禁止自动追加保证金校验失败`);
    if (this.now() - signal.entryTime > 15000 || !this.running) return;
    this.state.seenSignals = [...this.state.seenSignals.slice(-999), signal.id];
    this.state.active = {
      id: id("trade"), signalId: signal.id, symbol: signal.symbol, side: signal.side, strategy: signal.signalLabel ?? signal.signalType ?? "策略信号",
      leverage, marginBudgetUsdt: marginBudget,
      status: "ENTERING", requestedQuantity: quantity, limitPrice: limit, entryOrderId: id("entry"), entryPrice: 0,
      initialQuantity: 0, remainingQuantity: 0, openedAt: this.now(), timeoutAt: signal.timeoutAt,
      tp1Percent: signal.tp1Percent, tp2Percent: signal.tp2Percent, stopPercent: Math.min(signal.sl1Percent, signal.sl2Percent),
      stopPrice: 0, firstTargetDone: false, moveToBreakeven: signal.moveSlToEntryAfterTp1 !== false, stopIds: [], exits: [],
    };
    this.save(); // Intent is durable before the request can reach Binance.
    try {
      await this.request<ExchangeOrder>("POST", "/fapi/v1/order", { symbol: signal.symbol, side: signal.side === "LONG" ? "BUY" : "SELL", positionSide: "BOTH", type: "LIMIT", timeInForce: "IOC", quantity, price: limit, newClientOrderId: this.state.active.entryOrderId, newOrderRespType: "RESULT" });
    } catch (e) { this.halt(e); }
    await this.reconcile();
  }

  onTick(tick: { symbol: string; price: number; time: number }) {
    if (!this.running || this.state.active?.symbol !== tick.symbol || !Number.isFinite(tick.price) || tick.price <= 0 || !Number.isFinite(tick.time) || Math.abs(this.now() - tick.time) > 10000) return;
    if (this.tick && tick.time < this.tick.time) return;
    this.tick = tick;
    if (this.tickQueued) return;
    this.tickQueued = true;
    void this.enqueue(async () => { try { await this.evaluateExit(); } finally { this.tickQueued = false; } });
  }

  maintain() {
    if (!this.running || this.starting || this.maintenanceQueued) return this.queue;
    this.maintenanceQueued = true;
    return this.enqueue(async () => {
      try {
        if (this.now() - this.lastTimeSync > 60_000) { await this.syncTime(); this.lastTimeSync = this.now(); }
        await this.reconcile();
        await this.evaluateExit();
      } finally { this.maintenanceQueued = false; }
    });
  }

  private async queryOrder(clientOrderId: string) {
    const order = await this.request<ExchangeOrder>("GET", "/fapi/v1/order", { symbol: this.state.active!.symbol, origClientOrderId: clientOrderId });
    if (order.clientOrderId !== clientOrderId || !Number.isFinite(Number(order.executedQty)) || Number(order.executedQty) < 0) throw new Error("订单对账响应无效");
    return order;
  }

  private async reconcile() {
    const t = this.state.active;
    if (!t || this.brokenStorage) return;
    if (t.status === "ENTERING") {
      const order = await this.queryOrder(t.entryOrderId);
      if (!TERMINAL.has(order.status)) {
        // Cancel a surprisingly still-open IOC; retain the intent until its terminal state is known.
        await this.request("DELETE", "/fapi/v1/order", { symbol: t.symbol, origClientOrderId: t.entryOrderId });
        return;
      }
      const qty = Number(order.executedQty), entry = Number(order.avgPrice) || Number(order.cumQuote) / qty;
      if (qty === 0) { await this.finish(); return; }
      if (!(entry > 0) || !Number.isFinite(entry) || qty > Number(t.requestedQuantity) + 1e-10) throw new Error("开仓成交数据无效");
      t.initialQuantity = qty; t.remainingQuantity = qty; t.entryPrice = entry; t.status = "OPEN";
      const { price } = await this.getRules(t.symbol);
      const stop = entry * (1 + (t.side === "LONG" ? -1 : 1) * t.stopPercent / 100);
      t.stopPrice = Number(t.side === "LONG" ? ceilToStep(stop, price.tickSize!) : floorToStep(stop, price.tickSize!));
      this.save();
      if (qty * entry / t.leverage > Math.min(t.marginBudgetUsdt, this.config.budgetUsdt) || this.now() >= t.timeoutAt) {
        this.halt(new Error("实际成交超过限额或信号已到期，立即只减仓退出"));
        await this.closeQuantity(qty, "entry-risk", false); return;
      }
      await this.protect();
      if (this.state.active !== t || t.pendingClose) return;
    }
    if (t.pendingClose) {
      const pending = t.pendingClose;
      const order = await this.queryOrder(pending.id);
      if (!TERMINAL.has(order.status)) return;
      const qty = Number(order.executedQty), price = Number(order.avgPrice) || Number(order.cumQuote) / qty;
      if (qty > Number(pending.quantity) + 1e-10 || (qty > 0 && (!Number.isFinite(price) || price <= 0))) throw new Error("平仓成交数据无效");
      if (qty > 0) {
        t.exits.push({ orderId: pending.id, quantity: qty, price, reason: pending.reason, time: this.now() });
        t.remainingQuantity = Math.max(0, t.remainingQuantity - qty);
        if (pending.firstTarget) t.firstTargetDone = true;
      }
      delete t.pendingClose;
      this.save();
      if (qty === 0) throw new Error("平仓订单未成交，请核对后重试只减仓退出");
    }
    const rows = await this.positions(t.symbol);
    const p = rows.find(p => p.positionSide === "BOTH");
    if (!p) throw new Error("缺少单向持仓对账数据");
    const amount = Number(p.positionAmt), qty = Math.abs(amount);
    this.checkedAt = this.now();
    if (qty === 0) { await this.finish(); return; }
    if ((amount > 0) !== (t.side === "LONG") || qty > t.remainingQuantity + 1e-9 || p.marginType !== "isolated" || Number(p.leverage) !== t.leverage || p.isAutoAddMargin !== "false") throw new Error("交易所持仓与本地记录或风控设置不符，禁止自动操作其他仓位");
    if (qty !== t.remainingQuantity) {
      const externalReduction = qty < t.remainingQuantity - 1e-9;
      t.remainingQuantity = qty; this.save();
      if (externalReduction) this.halt(new Error("检测到交易所止损或外部减仓，停止新开仓"));
    }
    const algos = await this.request<AlgoOrder[]>("GET", "/fapi/v1/openAlgoOrders", { symbol: t.symbol });
    if (!Array.isArray(algos)) throw new Error("保护单对账响应无效");
    const protectedNow = algos.some(a => t.stopIds.includes(a.clientAlgoId) && a.symbol === t.symbol && a.orderType === "STOP_MARKET" && a.closePosition === true && a.side === (t.side === "LONG" ? "SELL" : "BUY") && Number(a.triggerPrice) === t.stopPrice);
    if (!protectedNow) {
      this.halt(new Error("交易所止损单缺失，立即只减仓退出"));
      await this.closeQuantity(qty, "protection-missing", false); return;
    }
    if (t.firstTargetDone && t.moveToBreakeven) {
      const { price } = await this.getRules(t.symbol);
      const target = t.entryPrice * (t.side === "LONG" ? 1.002 : 0.998);
      const next = Number(t.side === "LONG" ? ceilToStep(target, price.tickSize!) : floorToStep(target, price.tickSize!));
      if ((t.side === "LONG" && next > t.stopPrice) || (t.side === "SHORT" && next < t.stopPrice)) {
        t.stopPrice = next; this.save(); await this.protect();
      }
    }
  }

  private async protect() {
    const t = this.state.active!;
    const previous = [...t.stopIds];
    const stopId = id("stop");
    t.stopIds.push(stopId); this.save();
    try {
      await this.request("POST", "/fapi/v1/algoOrder", { symbol: t.symbol, algoType: "CONDITIONAL", side: t.side === "LONG" ? "SELL" : "BUY", positionSide: "BOTH", type: "STOP_MARKET", triggerPrice: String(t.stopPrice), closePosition: "true", workingType: "MARK_PRICE", priceProtect: "false", clientAlgoId: stopId });
      // Confirm protection exists before considering the entry protected.
      const order = await this.request<AlgoOrder>("GET", "/fapi/v1/algoOrder", { clientAlgoId: stopId });
      if (order.clientAlgoId !== stopId || order.algoStatus !== "NEW") throw new Error("止损单未确认生效");
      // New protection first, then remove old protection (no unprotected replace window).
      for (const old of previous) await this.cancelStop(old);
      t.stopIds = [stopId]; this.save();
    } catch (e) {
      this.halt(e);
      await this.closeQuantity(t.remainingQuantity, "protection-failed", false);
    }
  }

  private async cancelStop(clientAlgoId: string) {
    try { await this.request("DELETE", "/fapi/v1/algoOrder", { clientAlgoId }); }
    catch (e) { if (!(e instanceof TradingApiError && [-2011, -2013].includes(e.code))) throw e; }
  }

  private async finish() {
    const t = this.state.active!;
    // Retain active state until every known conditional order is removed/confirmed absent.
    for (const stopId of t.stopIds) await this.cancelStop(stopId);
    t.status = "CLOSED"; t.remainingQuantity = 0; t.closedAt = this.now();
    this.state.history = [...this.state.history.slice(-199), t];
    this.state.active = null; this.tick = null; this.save();
  }

  private async evaluateExit() {
    const t = this.state.active;
    if (!t || t.status !== "OPEN" || t.pendingClose || this.brokenStorage) return;
    if (this.now() >= t.timeoutAt) { await this.closeQuantity(t.remainingQuantity, "timeout", false); return; }
    const tick = this.tick;
    if (!tick || tick.symbol !== t.symbol || this.now() - tick.time > 10000 || tick.time < t.openedAt) return;
    const ret = (tick.price / t.entryPrice - 1) * (t.side === "LONG" ? 100 : -100);
    if ((t.side === "LONG" && tick.price <= t.stopPrice) || (t.side === "SHORT" && tick.price >= t.stopPrice)) {
      await this.closeQuantity(t.remainingQuantity, "stop", false);
    } else if (ret >= t.tp2Percent) {
      await this.closeQuantity(t.remainingQuantity, "tp2", false);
    } else if (!t.firstTargetDone && ret >= t.tp1Percent) {
      const { lot, market } = await this.getRules(t.symbol);
      const step = Number(market.stepSize) > 0 ? market.stepSize! : lot.stepSize!;
      const half = Number(floorToStep(t.initialQuantity / 2, step));
      const min = Math.max(Number(lot.minQty), Number(market.minQty));
      const quantity = half >= min && t.remainingQuantity - half >= min ? half : t.remainingQuantity;
      await this.closeQuantity(quantity, quantity === t.remainingQuantity ? "tp1-full-small-lot" : "tp1", true);
    }
  }

  private async closeQuantity(quantity: number, reason: string, firstTarget: boolean) {
    const t = this.state.active;
    if (!t || t.status !== "OPEN" || t.pendingClose) return;
    const { lot, market } = await this.getRules(t.symbol);
    const p = (await this.positions(t.symbol)).find(p => p.positionSide === "BOTH");
    if (!p || !Number.isFinite(Number(p.positionAmt))) throw new Error("平仓前对账失败");
    const actual = Math.abs(Number(p.positionAmt));
    if (actual === 0) { await this.finish(); return; }
    if ((Number(p.positionAmt) > 0) !== (t.side === "LONG") || actual > t.remainingQuantity + 1e-9) throw new Error("平仓前检测到外部持仓变化，禁止误平仓");
    // Full exits use the exchange quantity, not a floating-point subtraction of past fills.
    const closingAll = quantity >= t.remainingQuantity - 1e-9;
    const q = floorToStep(closingAll ? actual : Math.min(quantity, actual), Number(market.stepSize) > 0 ? market.stepSize! : lot.stepSize!);
    if (Number(q) <= 0 || Number(q) > Number(market.maxQty)) throw new Error("平仓数量不符合交易所规则");
    const closeId = id("exit");
    t.pendingClose = { id: closeId, quantity: q, reason, firstTarget }; this.save();
    // Never retry POST, even for transport errors. The next reconciliation queries closeId.
    await this.request("POST", "/fapi/v1/order", { symbol: t.symbol, side: t.side === "LONG" ? "SELL" : "BUY", positionSide: "BOTH", type: "MARKET", quantity: q, reduceOnly: "true", newClientOrderId: closeId, newOrderRespType: "RESULT" });
  }
}
