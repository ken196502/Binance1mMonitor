// Binance USDM WebSocket trade streamer
// 实时订阅标的的 trade 数据流，在本地近实时合成/更新当前正在形成的 1m K 线
// 从而使 1m MACD 与 DIFF 指标保持实时更新，无需定时高频 REST 轮询请求 K 线，将 REST API 权重消耗降到最低。

import { WebSocket, ProxyAgent } from "undici";
import { PROXY, getBackoffStatus, onAnomalyRecovered } from "./binance.ts";
import type { Candle } from "./macd.ts";

export interface TradeTick {
  symbol: string;
  price: number;
  qty: number;
  time: number;
}

export type TradeListener = (tick: TradeTick) => void;

class BinanceWsManager {
  private ws: WebSocket | null = null;
  private subscribedSymbols = new Set<string>();
  private listeners: TradeListener[] = [];
  private isConnecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private nextSubId = 1;
  private isClosed = false;

  constructor() {
    onAnomalyRecovered(() => {
      if (!this.isClosed && (!this.ws || this.ws.readyState !== 1)) {
        console.info(`[binance-ws] 检测到接口已从异常中恢复，唤醒 WebSocket 重新连接`);
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.connect();
      }
    });
  }

  public onTrade(listener: TradeListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  public getSubscribedSymbols(): string[] {
    return Array.from(this.subscribedSymbols);
  }

  public setSymbols(symbols: string[]): void {
    const newSet = new Set(symbols.map((s) => s.toUpperCase()));
    const toSub: string[] = [];
    const toUnsub: string[] = [];

    for (const s of newSet) {
      if (!this.subscribedSymbols.has(s)) {
        toSub.push(s);
      }
    }
    for (const s of this.subscribedSymbols) {
      if (!newSet.has(s)) {
        toUnsub.push(s);
      }
    }

    if (toSub.length === 0 && toUnsub.length === 0) return;

    this.subscribedSymbols = newSet;

    if (!this.ws || this.ws.readyState !== 1) {
      this.connect();
      return;
    }

    if (toUnsub.length > 0) {
      this.send({
        method: "UNSUBSCRIBE",
        params: toUnsub.map((s) => `${s.toLowerCase()}@trade`),
        id: this.nextSubId++,
      });
    }

    if (toSub.length > 0) {
      this.send({
        method: "SUBSCRIBE",
        params: toSub.map((s) => `${s.toLowerCase()}@trade`),
        id: this.nextSubId++,
      });
    }
  }

  private connect(): void {
    if (this.isClosed || this.isConnecting || (this.ws && this.ws.readyState === 1)) return;

    this.isConnecting = true;

    try {
      const dispatcher = PROXY ? new ProxyAgent(PROXY) : undefined;
      const url = "wss://fstream.binance.com/ws";
      const ws = new WebSocket(url, { dispatcher });

      this.ws = ws;

      ws.addEventListener("open", () => {
        this.isConnecting = false;
        if (this.isClosed) {
          ws.close();
          return;
        }
        console.log(`[binance-ws] WebSocket 连接成功 (fstream.binance.com)`);

        if (this.subscribedSymbols.size > 0) {
          const params = Array.from(this.subscribedSymbols).map((s) => `${s.toLowerCase()}@trade`);
          this.send({
            method: "SUBSCRIBE",
            params,
            id: this.nextSubId++,
          });
          console.log(`[binance-ws] 已订阅 ${this.subscribedSymbols.size} 个标的实时成交流`);
        }

        // 心跳防断连
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === 1) {
            // undici WebSocket 不直接暴露 ping 方法，可发送无效查询或者依赖底层 keepalive
          }
        }, 30000);
        this.pingInterval.unref?.();
      });

      ws.addEventListener("message", (e) => {
        try {
          const d = JSON.parse(e.data);
          if (d.e === "trade") {
            const tick: TradeTick = {
              symbol: d.s,
              price: parseFloat(d.p),
              qty: parseFloat(d.q),
              time: Number(d.T),
            };
            // Binance 的 @trade 流会混入 p="0" / q="0" / X:"NA" 的无效成交（实测约 0.5%，
            // 多为强平/占位帧）。直接并入 K 线会把当根的 low/close 打成 0，而 0 之后
            // 再也涨不回来（tick.price < low 恒为 false），该根柱子永久损坏，
            // 还会把价格轴拉到 0、把 0 喂进 MACD/均线的告警计算。必须在源头丢弃。
            if (!isValidTick(tick)) return;
            for (const listener of this.listeners) {
              listener(tick);
            }
          }
        } catch {
          // 忽略非 JSON 帧
        }
      });

      ws.addEventListener("close", (e) => {
        this.isConnecting = false;
        this.ws = null;
        if (this.pingInterval) clearInterval(this.pingInterval);
        if (this.isClosed) return;
        console.warn(`[binance-ws] 连接关闭 (code: ${e.code}, reason: ${e.reason})，准备排队重连...`);
        this.scheduleReconnect();
      });

      ws.addEventListener("error", (e) => {
        this.isConnecting = false;
        console.warn(`[binance-ws] 连接异常:`, (e as any)?.message ?? e);
      });
    } catch (err) {
      this.isConnecting = false;
      this.scheduleReconnect();
    }
  }

  private send(data: unknown): void {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private scheduleReconnect(): void {
    if (this.isClosed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, 5000);
  }

  public close(): void {
    this.isClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.subscribedSymbols.clear();
  }
}

export const wsManager = new BinanceWsManager();

/** 合法成交：价格必须为正有限数（Binance 会混发 p="0" 的占位帧），时间同理 */
export function isValidTick(tick: TradeTick): boolean {
  return (
    Number.isFinite(tick.price) && tick.price > 0 &&
    Number.isFinite(tick.time) && tick.time > 0 &&
    Number.isFinite(tick.qty) && tick.qty >= 0
  );
}

/**
 * 修复已被无效成交污染的 K 线：
 * - low/high 明显不成立（<=0 或超出 open/close 区间）→ 按 open/close 夹回合法区间；
 * - 整根都是 0（open/high/low/close 全为 0）→ 直接丢弃，避免 0 进入 EMA/均线计算。
 * 逐根就地修复，就地丢弃则原地移除（保持时间序列不被压缩错位）。
 */
export function sanitizeCandles(candles: Candle[]): Candle[] {
  let changed = false;
  const out: Candle[] = [];
  for (const c of candles) {
    const o = c.open, h = c.high, cl = c.close;
    // open/high/close 是 K 线的骨架：任一失效这根柱子就没意义了（EMA/MACD 也依赖 close），
    // 直接丢弃。只有 low 坏掉时不必丢——它可以由 open/close 夹回合法区间。
    if (![o, h, cl].every((v) => Number.isFinite(v) && v > 0)) {
      changed = true;
      continue;
    }
    // low<=0 或明显越界 → 退化为 min(open, close)；high 同理兜底
    const fixedHigh = Math.max(Number.isFinite(h) ? h : 0, o, cl);
    const fixedLow = Math.min(Number.isFinite(c.low) && c.low > 0 ? c.low : Infinity, o, cl);
    if (fixedHigh !== h || fixedLow !== c.low) changed = true;
    out.push({ ...c, high: fixedHigh, low: fixedLow });
  }
  return changed ? out : candles;
}

/**
 * 实时将 trade 成交更新并入当前标的的 1m K 线序列中。
 * 如果当前时间戳属于上一根 K 线的下一分钟，则自动新起一根 1m K 线，并修剪最大容量。
 * 无效成交（p="0" 占位帧）一律忽略：它们会把 low/close 打成 0 并永久污染该根柱子。
 */
export function applyTradeToCandles(candles: Candle[], tick: TradeTick, maxBars = 100): Candle[] {
  if (candles.length === 0) return candles;
  if (!isValidTick(tick)) return candles;

  // 先把历史遗留的污染柱子修好，避免坏数据一直留在缓存里影响 MACD/均线与图表
  const clean = sanitizeCandles(candles);

  const currentMinute = Math.floor(tick.time / 60000) * 60000;
  const lastBar = clean[clean.length - 1];
  if (!lastBar) return clean;

  if (lastBar.time === currentMinute) {
    // 仍在当前分钟柱内：实时更新 high, low, close, volume
    lastBar.close = tick.price;
    if (tick.price > lastBar.high) lastBar.high = tick.price;
    if (tick.price < lastBar.low) lastBar.low = tick.price;
    lastBar.volume += tick.qty;
    return clean;
  } else if (currentMinute > lastBar.time) {
    // 新增一分钟柱
    const newBar: Candle = {
      time: currentMinute,
      open: tick.price,
      high: tick.price,
      low: tick.price,
      close: tick.price,
      volume: tick.qty,
    };
    const updated = [...clean, newBar];
    return updated.length > maxBars ? updated.slice(-maxBars) : updated;
  }

  return clean;
}
