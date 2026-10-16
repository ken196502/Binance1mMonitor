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

    // 若当前处于 418/429 避让冷静期，绝不强行发起连接，避免连接风暴加剧 IP 封禁
    const backoff = getBackoffStatus();
    if (backoff.active) {
      console.warn(`[binance-ws] 检测到 Binance 处于避让期 (${backoff.reason})，暂缓 WebSocket 连接`);
      this.scheduleReconnect();
      return;
    }

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

    const backoff = getBackoffStatus();
    let delay = 5000;
    if (backoff.active) {
      const waitMs = Math.max(5000, backoff.backoffUntil - Date.now() + 1000);
      delay = waitMs;
      console.warn(
        `[binance-ws] 检测到处于限频/封禁冷静期 (${backoff.reason})，延迟 ${Math.ceil(delay / 1000)} 秒后再尝试重连 WebSocket...`,
      );
    }

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
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

/**
 * 实时将 trade 成交更新并入当前标的的 1m K 线序列中。
 * 如果当前时间戳属于上一根 K 线的下一分钟，则自动新起一根 1m K 线，并修剪最大容量。
 */
export function applyTradeToCandles(candles: Candle[], tick: TradeTick, maxBars = 100): Candle[] {
  if (candles.length === 0) return candles;

  const currentMinute = Math.floor(tick.time / 60000) * 60000;
  const lastBar = candles[candles.length - 1];

  if (lastBar.time === currentMinute) {
    // 仍在当前分钟柱内：实时更新 high, low, close, volume
    lastBar.close = tick.price;
    if (tick.price > lastBar.high) lastBar.high = tick.price;
    if (tick.price < lastBar.low) lastBar.low = tick.price;
    lastBar.volume += tick.qty;
    return candles;
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
    const updated = [...candles, newBar];
    return updated.length > maxBars ? updated.slice(-maxBars) : updated;
  }

  return candles;
}
