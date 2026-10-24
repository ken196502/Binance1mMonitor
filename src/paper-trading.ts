// Paper Trading Engine for Binance 1m Top-Gainers Short Strategy
// Implements the ultra-high win rate strategy (100.0% historical win rate, 7 wins 0 losses, PF: ∞)
// Features: 10x leverage, 10 USDT margin, 100 USDT initial capital,
// 30m amplitude >= 24h gain / 12, upper shadow 0.5%~30%, 2-stage dynamic exit.

import fs from "node:fs";
import path from "node:path";
import {
  consecutiveStreakAt,
  calculateSupportMaAt,
  computeMacd,
  type Candle,
} from "./macd.ts";
import { sendTelegramMessage } from "./telegram.ts";
import type {
  PaperAccount,
  PaperPosition,
  PaperPendingOrder,
  PaperExit,
  PaperExitReason,
  PaperTradingStats,
  PaperTradingState,
  PaperTradingSummary,
} from "./types.ts";
import type { Ticker24h } from "./binance.ts";
import type { TradeTick } from "./ws.ts";

export interface PaperStrategyConfig {
  topN: number;
  supportMaPeriods: readonly number[];
  ampDivisor: number; // 30m振幅 >= 24h / ampDivisor (默认 12)
  minStreakCount: number;
  minUpperShadowRatio?: number; // 过滤光头阳线 (默认 0.005 即 >= 0.5%)
  maxUpperShadowRatio: number;  // 默认 0.30 即 < 30%
  greenWindow: number;
  minGreenRatio: number; // strictly > minGreenRatio (e.g. > 0.70 means >= 22 of 30)
  minConsecutiveGreenBars: number;
  holdMinutes: number;
  exitX: number;
  exitN: number;
  exitM: number;
  firstCloseFraction: number;
  initialBalanceUsdt: number; // 启动资金 100 USDT
  leverage: number;           // 10x 杠杆
  marginUsdt: number;         // 10 USDT 单笔保证金 (名义本金 100 USDT)
  takerFeeBps: number;
  slippageBps: number;
  limitDivisor: number; // 挂单上浮幅度分母 N: 挂单上浮 = dayChangePercent / limitDivisor (默认 100)
  limitExpireMinutes: number; // 挂单有效期分钟数 (默认 3 分钟)
  storageFile?: string | null;
}

const DATA_DIR = path.join(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "paper-trading.json");

export const PAPER_DEFAULT_CONFIG: PaperStrategyConfig = {
  topN: 10,
  supportMaPeriods: [3, 7, 15],
  ampDivisor: 12, // 30 分钟振幅 >= 24h 涨幅 / 12
  minStreakCount: 2,
  minUpperShadowRatio: 0.005, // 上影线 >= 0.5% 柱体 (排除光头大阳线陷阱)
  maxUpperShadowRatio: 0.30,  // 上影线 < 30% 柱体
  greenWindow: 30,
  minGreenRatio: 0.70,
  minConsecutiveGreenBars: 7,
  holdMinutes: 15,
  exitX: 50,
  exitN: 1.5,
  exitM: 3.0,
  firstCloseFraction: 0.5,
  initialBalanceUsdt: Number(process.env.PAPER_INITIAL_BALANCE ?? 100),
  leverage: Number(process.env.PAPER_LEVERAGE ?? 10),
  marginUsdt: Number(process.env.PAPER_MARGIN_USDT ?? 10),
  takerFeeBps: 5,   // 0.05%
  slippageBps: 2,   // 0.02%
  limitDivisor: Number(process.env.PAPER_LIMIT_N ?? 100), // 默认 N = 100
  limitExpireMinutes: Number(process.env.PAPER_LIMIT_EXPIRE_MINUTES ?? 3), // 默认 3 分钟
  storageFile: STATE_FILE,
};

export interface SignalMatchDetails {
  candle: Candle;
  streakCount: number;
  amp30Percent: number;
  upperShadowRatio: number;
  greenRatio: number;
  consecutiveGreenBars: number;
}

export function checkPaperSignal(
  symbol: string,
  dayChangePercent: number,
  candles: Candle[],
  config: PaperStrategyConfig = PAPER_DEFAULT_CONFIG,
): SignalMatchDetails | null {
  if (dayChangePercent <= 0) return null;
  // Candles array ends with forming bar, targetIndex is the latest closed candle
  const targetIndex = candles.length - 2;
  const minRequiredBars = Math.max(35, config.greenWindow + 5, ...config.supportMaPeriods);
  if (targetIndex < minRequiredBars - 1) return null;

  const candle = candles[targetIndex];
  if (!candle || candle.close <= 0 || candle.open <= 0) return null;

  // 1. 至少连续 minStreakCount 根阳线 (默认 >= 2 连阳)
  const streak = consecutiveStreakAt(candles, targetIndex);
  if (streak.direction !== "up" || streak.count < config.minStreakCount) return null;

  // 2. 30 分钟振幅 >= 24h 涨幅 / ampDivisor (默认 8)
  const window30 = candles.slice(targetIndex - 30 + 1, targetIndex + 1);
  const maxHigh = Math.max(...window30.map((c) => c.high));
  const minLow = Math.min(...window30.map((c) => c.low));
  if (minLow <= 0) return null;
  const amp30Percent = ((maxHigh - minLow) / minLow) * 100;
  if (amp30Percent < dayChangePercent / config.ampDivisor) {
    return null;
  }

  // 3. 均线 MA[3, 7, 15] 均无支撑
  const supportMa = calculateSupportMaAt(candles, targetIndex, config.supportMaPeriods);
  if (supportMa != null) return null;

  // 4. 最后一根阳线上影线介于 0.5% 与 30% 之间 (实体坚挺且顶部遇阻回落，排除光头大阳线陷阱)
  const body = candle.close - candle.open;
  const upperShadow = Math.max(0, candle.high - candle.close);
  const upperShadowRatio = body > 0 ? upperShadow / body : 0;
  const minShadow = config.minUpperShadowRatio ?? 0.005;
  if (upperShadowRatio < minShadow || upperShadowRatio >= config.maxUpperShadowRatio) return null;

  // 5. 近 30 根已收盘 1m MACD 绿柱占比严格 > 70%
  const { hist } = computeMacd(candles.map((c) => c.close));
  if (hist.length <= targetIndex) return null;

  const greenStart = targetIndex - config.greenWindow + 1;
  if (greenStart < 0) return null;
  let greenCount = 0;
  for (let i = greenStart; i <= targetIndex; i++) {
    if (hist[i] > 0) greenCount++;
  }
  const greenRatio = greenCount / config.greenWindow;
  if (greenRatio <= config.minGreenRatio) return null;

  // 6. 末尾连续 >= 7 根 MACD 全绿柱
  let consecutiveGreenBars = 0;
  for (let j = targetIndex; j >= 0; j--) {
    if (hist[j] > 0) consecutiveGreenBars++;
    else break;
  }
  if (consecutiveGreenBars < config.minConsecutiveGreenBars) return null;

  return {
    candle,
    streakCount: streak.count,
    amp30Percent,
    upperShadowRatio,
    greenRatio,
    consecutiveGreenBars,
  };
}

export class PaperTradingEngine {
  private config: PaperStrategyConfig;
  private pendingOrders = new Map<string, PaperPendingOrder>(); // key: symbol
  private activePositions = new Map<string, PaperPosition>(); // key: symbol
  private closedPositions: PaperPosition[] = [];
  private account: PaperAccount;
  private stats: PaperTradingStats;
  private saveTimeout: NodeJS.Timeout | null = null;

  constructor(config: Partial<PaperStrategyConfig> = {}) {
    this.config = { ...PAPER_DEFAULT_CONFIG, ...config };
    this.account = {
      initialBalanceUsdt: this.config.initialBalanceUsdt,
      balanceUsdt: this.config.initialBalanceUsdt,
      equityUsdt: this.config.initialBalanceUsdt,
      usedMarginUsdt: 0,
      availableMarginUsdt: this.config.initialBalanceUsdt,
      totalPnlUsdt: 0,
      accountRoiPercent: 0,
    };
    this.stats = {
      initialBalanceUsdt: this.config.initialBalanceUsdt,
      balanceUsdt: this.config.initialBalanceUsdt,
      equityUsdt: this.config.initialBalanceUsdt,
      accountRoiPercent: 0,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      breakevenTrades: 0,
      winRate: 0,
      totalNetPnlUsdt: 0,
      grossGainsUsdt: 0,
      grossLossesUsdt: 0,
      profitFactor: 1.0,
      avgTradePnlUsdt: 0,
      realizedRewardRisk: null,
    };
    this.loadState();
  }

  public getConfig(): PaperStrategyConfig {
    return { ...this.config };
  }

  public getAccount(): PaperAccount {
    return { ...this.account };
  }

  public getActiveSymbols(): string[] {
    return Array.from(new Set([...this.activePositions.keys(), ...this.pendingOrders.keys()]));
  }

  public hasActivePosition(symbol: string): boolean {
    return this.activePositions.has(symbol);
  }

  public hasPendingOrder(symbol: string): boolean {
    return this.pendingOrders.has(symbol);
  }

  public getPosition(symbol: string): PaperPosition | undefined {
    return this.activePositions.get(symbol);
  }

  public getPendingOrder(symbol: string): PaperPendingOrder | undefined {
    return this.pendingOrders.get(symbol);
  }

  public getPendingOrders(): PaperPendingOrder[] {
    return Array.from(this.pendingOrders.values());
  }

  /**
   * 创建限价做空挂单：以 basePrice * (1 + 24h涨幅/limitDivisor/100) 向上挂单，
   * 等待价格惯性冲高触碰成交，建立容错垫。
   */
  public createPendingOrder(params: {
    symbol: string;
    dayChangePercent: number;
    rank?: number | null;
    basePrice: number;
    signal: SignalMatchDetails;
    now?: number;
  }): PaperPendingOrder {
    const { symbol, dayChangePercent, rank, basePrice, signal } = params;
    const now = params.now ?? Date.now();
    const divisor = this.config.limitDivisor > 0 ? this.config.limitDivisor : 100;
    const limitOffsetPercent = dayChangePercent / divisor;
    const limitPrice = basePrice * (1 + limitOffsetPercent / 100);
    const expireAt = now + this.config.limitExpireMinutes * 60 * 1000;

    // 保护位：若行情直接下杀跌破预估的阶段一止盈位，说明行情已直接跌完，不再接单
    const tp1OffsetPercent = dayChangePercent / this.config.exitX;
    const cancelBelowPrice = basePrice * (1 - tp1OffsetPercent / 100);

    const notionalUsdt = this.config.marginUsdt * this.config.leverage;

    const order: PaperPendingOrder = {
      id: `pending-${symbol}-${now}`,
      symbol,
      side: "SHORT",
      leverage: this.config.leverage,
      marginUsdt: this.config.marginUsdt,
      notionalUsdt,
      basePrice,
      limitPrice,
      limitOffsetPercent,
      currentPrice: basePrice,
      dayChangePercent,
      rank,
      amp30Percent: signal.amp30Percent,
      streakCount: signal.streakCount,
      upperShadowRatio: signal.upperShadowRatio,
      greenRatio: signal.greenRatio,
      consecutiveGreenBars: signal.consecutiveGreenBars,
      createdAt: now,
      expireAt,
      cancelBelowPrice,
    };

    this.pendingOrders.set(symbol, order);
    this.scheduleSave();

    console.log(
      `[paper-trading] ⏳ 提交限价做空挂单 ${symbol} @ ${limitPrice.toFixed(4)} ` +
      `(基准价: ${basePrice.toFixed(4)}, 上浮 +${limitOffsetPercent.toFixed(2)}%, 有效期 ${this.config.limitExpireMinutes}分钟)`,
    );

    this.notifyPendingOrder(order).catch((e) =>
      console.warn(`[paper-trading] 发送挂单通知异常:`, (e as any)?.message ?? e),
    );

    return order;
  }

  /**
   * 取消挂单
   */
  public cancelPendingOrder(symbol: string, reason = "已取消"): void {
    const order = this.pendingOrders.get(symbol);
    if (!order) return;
    this.pendingOrders.delete(symbol);
    this.scheduleSave();
    console.log(`[paper-trading] ⏱️ 撤销限价做空挂单 ${symbol} @ ${order.limitPrice.toFixed(4)}: ${reason}`);
  }

  /**
   * Called on every scan/refresh at candle close.
   * Scans Top 10 gainers for entry signals.
   */
  public async onScan(
    gainers: Ticker24h[],
    candleMap: Map<string, { candles1m: Candle[]; initialized: boolean }>,
  ): Promise<PaperPosition[]> {
    const openedList: PaperPosition[] = [];
    const pinnedSymbols = new Set(["BTCUSDT", "SOLUSDT"]);
    const now = Date.now();

    // Check timeouts first on scan
    this.checkTimeouts(now);

    for (let i = 0; i < gainers.length && i < this.config.topN; i++) {
      const ticker = gainers[i];
      if (pinnedSymbols.has(ticker.symbol)) continue;
      if (ticker.priceChangePercent <= 0) continue;
      if (this.hasActivePosition(ticker.symbol) || this.hasPendingOrder(ticker.symbol)) continue;

      // Check available margin (including reserved pending orders)
      const reservedCount = this.activePositions.size + this.pendingOrders.size;
      const usedMargin = reservedCount * this.config.marginUsdt;
      const availableMargin = this.account.balanceUsdt - usedMargin;
      if (availableMargin < this.config.marginUsdt) {
        console.warn(
          `[paper-trading] 可用保证金不足 (${availableMargin.toFixed(2)} USDT < ${this.config.marginUsdt} USDT)，跳过扫描 ${ticker.symbol}`,
        );
        break;
      }

      const symCache = candleMap.get(ticker.symbol);
      if (!symCache || !symCache.initialized || symCache.candles1m.length < 35) continue;

      const signal = checkPaperSignal(
        ticker.symbol,
        ticker.priceChangePercent,
        symCache.candles1m,
        this.config,
      );

      if (signal) {
        // 基准价格：优先取当前最新 K 线的最新 close（实时市价），否则用上一根已收盘的 close
        const forming = symCache.candles1m[symCache.candles1m.length - 1];
        const basePrice =
          forming && forming.close > 0 ? forming.close : signal.candle.close;

        if (this.config.limitDivisor > 0) {
          // 挂单模式：以 24h涨幅/limitDivisor 向上挂单等待冲高撮合
          this.createPendingOrder({
            symbol: ticker.symbol,
            dayChangePercent: ticker.priceChangePercent,
            rank: i + 1,
            basePrice,
            signal,
            now,
          });
        } else {
          // 回退直接市价开仓模式
          const pos = this.openPosition({
            symbol: ticker.symbol,
            dayChangePercent: ticker.priceChangePercent,
            rank: i + 1,
            entryPrice: basePrice,
            entryTime: now,
            signal,
          });
          openedList.push(pos);
        }
      }
    }

    return openedList;
  }

  public openPosition(params: {
    symbol: string;
    dayChangePercent: number;
    rank?: number | null;
    entryPrice: number;
    entryTime: number;
    limitPrice?: number;
    signal: SignalMatchDetails;
  }): PaperPosition {
    const { symbol, dayChangePercent, rank, entryPrice, entryTime, limitPrice, signal } = params;

    // Two-stage dynamic thresholds:
    // Stage 1: tp1 = dayChange / x, sl1 = dayChange / x
    // Stage 2: sl2 = dayChange * n / x, tp2 = dayChange * m / x
    const tp1Percent = dayChangePercent / this.config.exitX;
    const sl1Percent = dayChangePercent / this.config.exitX;
    const sl2Percent = (dayChangePercent * this.config.exitN) / this.config.exitX;
    const tp2Percent = (dayChangePercent * this.config.exitM) / this.config.exitX;

    // Short direction price levels:
    // Target (profit): entry * (1 - tp / 100)
    // Stop (loss): entry * (1 + sl / 100)
    const tp1Price = entryPrice * (1 - tp1Percent / 100);
    const sl1Price = entryPrice * (1 + sl1Percent / 100);
    const sl2Price = entryPrice * (1 + sl2Percent / 100);
    const tp2Price = entryPrice * (1 - tp2Percent / 100);

    const timeoutAt = entryTime + this.config.holdMinutes * 60 * 1000;
    const notionalUsdt = this.config.marginUsdt * this.config.leverage; // 10 * 10 = 100 USDT

    const position: PaperPosition = {
      id: `${symbol}-${entryTime}`,
      symbol,
      side: "SHORT",
      leverage: this.config.leverage,
      marginUsdt: this.config.marginUsdt,
      notionalUsdt,
      status: "OPEN",
      entryTime,
      entryPrice,
      limitPrice,
      currentPrice: entryPrice,
      dayChangePercent,
      rank,
      amp30Percent: signal.amp30Percent,
      streakCount: signal.streakCount,
      upperShadowRatio: signal.upperShadowRatio,
      greenRatio: signal.greenRatio,
      consecutiveGreenBars: signal.consecutiveGreenBars,

      tp1Percent,
      sl1Percent,
      tp1Price,
      sl1Price,

      sl2Percent,
      tp2Percent,
      sl2Price,
      tp2Price,

      timeoutAt,
      exits: [],
      remainingFraction: 1.0,

      realizedNetPnlUsdt: 0,
      unrealizedNetPnlUsdt: 0,
      totalNetPnlUsdt: 0,
      roePercent: 0,
    };

    this.activePositions.set(symbol, position);
    this.recalculateStats();
    this.scheduleSave();

    // Broadcast Telegram entry notification
    this.notifyEntry(position).catch((e) =>
      console.warn(`[paper-trading] 发送开仓通知异常:`, (e as any)?.message ?? e),
    );

    const isLimit = limitPrice != null;
    console.log(
      `[paper-trading] ⚡ ${isLimit ? "限价挂单成交做空" : "市价开空"} ${symbol} @ ${entryPrice.toFixed(4)} ` +
      `(${this.config.leverage}x, 保证金 ${this.config.marginUsdt} USDT, 24h: +${dayChangePercent.toFixed(2)}%, 30m振幅: ${signal.amp30Percent.toFixed(2)}%) ` +
      `TP1: ${tp1Price.toFixed(4)} SL1: ${sl1Price.toFixed(4)} SL2: ${sl2Price.toFixed(4)} TP2: ${tp2Price.toFixed(4)}`,
    );

    return position;
  }

  /**
   * Real-time trade tick processing.
   * Evaluates pending limit orders, take-profit, stop-loss and timeouts in milliseconds.
   */
  public onTick(tick: TradeTick): void {
    // 0. 优先撮合限价做空挂单
    const pending = this.pendingOrders.get(tick.symbol);
    if (pending) {
      pending.currentPrice = tick.price;
      // 挂单超时
      if (tick.time >= pending.expireAt) {
        this.cancelPendingOrder(pending.symbol, "超时未触碰撤销");
      }
      // 价格直接下杀跌破预估TP1（行情已走完，撤单）
      else if (pending.cancelBelowPrice && tick.price <= pending.cancelBelowPrice) {
        this.cancelPendingOrder(pending.symbol, "行情已直接下行提前撤单");
      }
      // 价格向上冲高打到限价挂单：撮合成交！
      else if (tick.price >= pending.limitPrice) {
        this.pendingOrders.delete(pending.symbol);
        console.log(
          `[paper-trading] 🎯 挂单成交！${pending.symbol} 触及做空限价 @ ${pending.limitPrice.toFixed(4)} (成交Tick: ${tick.price.toFixed(4)})`,
        );
        this.openPosition({
          symbol: pending.symbol,
          dayChangePercent: pending.dayChangePercent,
          rank: pending.rank,
          entryPrice: pending.limitPrice,
          entryTime: tick.time,
          limitPrice: pending.limitPrice,
          signal: {
            candle: {
              time: tick.time,
              open: pending.basePrice,
              high: tick.price,
              low: pending.basePrice,
              close: tick.price,
              volume: 0,
            },
            streakCount: pending.streakCount,
            amp30Percent: pending.amp30Percent,
            upperShadowRatio: pending.upperShadowRatio,
            greenRatio: pending.greenRatio,
            consecutiveGreenBars: pending.consecutiveGreenBars,
          },
        });
      }
    }

    // 1. 活跃持仓撮合处理
    const position = this.activePositions.get(tick.symbol);
    if (!position || position.status === "CLOSED") return;

    const price = tick.price;
    const time = tick.time;
    position.currentPrice = price;

    // 1. Check timeout
    if (time >= position.timeoutAt) {
      this.closeRemaining(position, price, time, "timeout");
      return;
    }

    // 2. Check Stage 1 if remainingFraction == 1.0
    if (position.remainingFraction === 1.0) {
      if (price <= position.tp1Price) {
        this.closeStage(position, 1, position.tp1Price, time, "target");
        // In extreme fast drops, check if Stage 2 is also hit on the same tick
        if (price <= position.tp2Price) {
          this.closeStage(position, 2, position.tp2Price, time, "target");
        }
        return;
      } else if (price >= position.sl1Price) {
        this.closeStage(position, 1, position.sl1Price, time, "stop");
        // In extreme fast jumps, check if Stage 2 stop is also hit
        if (price >= position.sl2Price) {
          this.closeStage(position, 2, position.sl2Price, time, "stop");
        }
        return;
      }
    }

    // 3. Check Stage 2 if remainingFraction == 0.5
    if (position.remainingFraction === 0.5) {
      if (price <= position.tp2Price) {
        this.closeStage(position, 2, position.tp2Price, time, "target");
        return;
      } else if (price >= position.sl2Price) {
        this.closeStage(position, 2, position.sl2Price, time, "stop");
        return;
      }
    }

    // 4. Update unrealized PnL
    this.updateUnrealizedPnl(position, price);
  }

  /**
   * Sweeps all pending orders and active positions for timeout.
   */
  public checkTimeouts(now = Date.now()): void {
    // 检查挂单超时
    for (const [sym, order] of this.pendingOrders) {
      if (now >= order.expireAt) {
        this.cancelPendingOrder(sym, "超时未触碰撤销");
      }
    }
    // 检查持仓超时
    for (const [_, pos] of this.activePositions) {
      if (pos.status !== "CLOSED" && now >= pos.timeoutAt) {
        this.closeRemaining(pos, pos.currentPrice, now, "timeout");
      }
    }
  }

  private updateUnrealizedPnl(pos: PaperPosition, currentPrice: number): void {
    if (pos.remainingFraction <= 0) {
      pos.unrealizedNetPnlUsdt = 0;
      pos.totalNetPnlUsdt = pos.realizedNetPnlUsdt;
      pos.roePercent = (pos.totalNetPnlUsdt / pos.marginUsdt) * 100;
      return;
    }

    const stageNotional = pos.notionalUsdt * pos.remainingFraction;
    // Short PnL: (entry - current) / entry
    const grossPnl = stageNotional * ((pos.entryPrice - currentPrice) / pos.entryPrice);
    const estExitCost =
      stageNotional *
      ((this.config.takerFeeBps + this.config.slippageBps) / 10000) *
      (1 + currentPrice / pos.entryPrice);

    pos.unrealizedNetPnlUsdt = grossPnl - estExitCost;
    pos.totalNetPnlUsdt = pos.realizedNetPnlUsdt + pos.unrealizedNetPnlUsdt;
    pos.roePercent = (pos.totalNetPnlUsdt / pos.marginUsdt) * 100;

    this.recalculateStats();
  }

  private closeStage(
    pos: PaperPosition,
    stage: 1 | 2,
    exitPrice: number,
    exitTime: number,
    reason: PaperExitReason,
  ): PaperExit {
    const fraction = this.config.firstCloseFraction;
    const stageNotional = pos.notionalUsdt * fraction;

    // Return calculations matching research backtest (wickReturn)
    const grossPercent = ((pos.entryPrice - exitPrice) / pos.entryPrice) * 100;
    const grossPnlUsdt = stageNotional * (grossPercent / 100);

    const entryFeeUsdt = stageNotional * (this.config.takerFeeBps / 10000);
    const exitNotional = stageNotional * (exitPrice / pos.entryPrice);
    const exitFeeUsdt = exitNotional * (this.config.takerFeeBps / 10000);
    const feeUsdt = entryFeeUsdt + exitFeeUsdt;

    const slippageUsdt =
      stageNotional * (this.config.slippageBps / 10000) +
      exitNotional * (this.config.slippageBps / 10000);

    const netPnlUsdt = grossPnlUsdt - feeUsdt - slippageUsdt;
    const netPercent = (netPnlUsdt / stageNotional) * 100;

    const exit: PaperExit = {
      stage,
      fraction,
      exitTime,
      exitPrice,
      reason,
      grossPnlUsdt,
      feeUsdt,
      slippageUsdt,
      netPnlUsdt,
      netPercent,
    };

    pos.exits.push(exit);
    pos.realizedNetPnlUsdt += netPnlUsdt;

    if (stage === 1) {
      pos.remainingFraction = 1 - fraction;
      pos.status = "PARTIAL";
      this.updateUnrealizedPnl(pos, exitPrice);

      this.notifyStage1(pos, exit).catch((e) =>
        console.warn(`[paper-trading] 发送阶段一平仓通知异常:`, (e as any)?.message ?? e),
      );

      console.log(
        `[paper-trading] 🎯 ${pos.symbol} 阶段一完成 (${reason}) @ ${exitPrice.toFixed(4)} | ` +
        `阶段净盈亏: ${netPnlUsdt >= 0 ? "+" : ""}${netPnlUsdt.toFixed(2)} USDT (ROE: ${pos.roePercent >= 0 ? "+" : ""}${pos.roePercent.toFixed(1)}%)`,
      );
    } else {
      pos.remainingFraction = 0;
      pos.status = "CLOSED";
      pos.closedAt = exitTime;
      pos.finalReason = reason;
      pos.unrealizedNetPnlUsdt = 0;
      pos.totalNetPnlUsdt = pos.realizedNetPnlUsdt;
      pos.roePercent = (pos.totalNetPnlUsdt / pos.marginUsdt) * 100;

      this.finalizePosition(pos);
    }

    this.scheduleSave();
    return exit;
  }

  private closeRemaining(
    pos: PaperPosition,
    exitPrice: number,
    exitTime: number,
    reason: PaperExitReason,
  ): void {
    if (pos.status === "CLOSED" || pos.remainingFraction <= 0) return;

    if (pos.remainingFraction === 1.0) {
      // Both stages close at this price
      this.closeStage(pos, 1, exitPrice, exitTime, reason);
      this.closeStage(pos, 2, exitPrice, exitTime, reason);
    } else {
      // Stage 2 closes
      this.closeStage(pos, 2, exitPrice, exitTime, reason);
    }
  }

  private finalizePosition(pos: PaperPosition): void {
    this.activePositions.delete(pos.symbol);
    this.closedPositions.unshift(pos);
    if (this.closedPositions.length > 500) {
      this.closedPositions.length = 500;
    }

    // Add realized profit to cash balance
    this.account.balanceUsdt += pos.totalNetPnlUsdt;
    this.recalculateStats();

    this.notifyFinal(pos).catch((e) =>
      console.warn(`[paper-trading] 发送结清通知异常:`, (e as any)?.message ?? e),
    );

    console.log(
      `[paper-trading] 🏆 ${pos.symbol} 订单结清 (${pos.finalReason}) | ` +
      `整单净盈亏: ${pos.totalNetPnlUsdt >= 0 ? "+" : ""}${pos.totalNetPnlUsdt.toFixed(2)} USDT (ROE: ${pos.roePercent >= 0 ? "+" : ""}${pos.roePercent.toFixed(1)}%) | ` +
      `胜率: ${this.stats.winRate.toFixed(1)}% | 账户最新余额: ${this.account.balanceUsdt.toFixed(2)} USDT`,
    );
  }

  private recalculateStats(): void {
    const totalTrades = this.closedPositions.length;
    let winningTrades = 0;
    let losingTrades = 0;
    let breakevenTrades = 0;
    let totalNetPnlUsdt = 0;
    let grossGainsUsdt = 0;
    let grossLossesUsdt = 0;

    for (const p of this.closedPositions) {
      totalNetPnlUsdt += p.totalNetPnlUsdt;
      if (p.totalNetPnlUsdt > 0.001) {
        winningTrades++;
        grossGainsUsdt += p.totalNetPnlUsdt;
      } else if (p.totalNetPnlUsdt < -0.001) {
        losingTrades++;
        grossLossesUsdt += Math.abs(p.totalNetPnlUsdt);
      } else {
        breakevenTrades++;
      }
    }

    const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
    const profitFactor =
      grossLossesUsdt > 0
        ? grossGainsUsdt / grossLossesUsdt
        : grossGainsUsdt > 0
          ? Infinity
          : 1.0;
    const avgTradePnlUsdt = totalTrades > 0 ? totalNetPnlUsdt / totalTrades : 0;

    const meanWin = winningTrades > 0 ? grossGainsUsdt / winningTrades : 0;
    const meanLoss = losingTrades > 0 ? grossLossesUsdt / losingTrades : 0;
    const realizedRewardRisk =
      meanWin > 0 && meanLoss > 0 ? meanWin / meanLoss : null;

    // Recalculate account equity and used margin
    let totalUnrealized = 0;
    for (const p of this.activePositions.values()) {
      totalUnrealized += p.unrealizedNetPnlUsdt;
    }
    const usedMargin = this.activePositions.size * this.config.marginUsdt;
    const availableMargin = Math.max(0, this.account.balanceUsdt - usedMargin);
    const equity = this.account.balanceUsdt + totalUnrealized;
    const totalPnl = equity - this.account.initialBalanceUsdt;
    const accountRoiPercent =
      this.account.initialBalanceUsdt > 0
        ? (totalPnl / this.account.initialBalanceUsdt) * 100
        : 0;

    this.account = {
      initialBalanceUsdt: this.config.initialBalanceUsdt,
      balanceUsdt: this.account.balanceUsdt,
      equityUsdt: equity,
      usedMarginUsdt: usedMargin,
      availableMarginUsdt: availableMargin,
      totalPnlUsdt: totalPnl,
      accountRoiPercent,
    };

    this.stats = {
      initialBalanceUsdt: this.config.initialBalanceUsdt,
      balanceUsdt: this.account.balanceUsdt,
      equityUsdt: equity,
      accountRoiPercent,
      totalTrades,
      winningTrades,
      losingTrades,
      breakevenTrades,
      winRate,
      totalNetPnlUsdt,
      grossGainsUsdt,
      grossLossesUsdt,
      profitFactor,
      avgTradePnlUsdt,
      realizedRewardRisk,
    };
  }

  // --- Telegram Alerts ---
  private async notifyPendingOrder(order: PaperPendingOrder): Promise<void> {
    const rankStr = order.rank ? `(#${order.rank})` : "";
    const msg =
      `⏳ <b>[模拟交易] 发现做空信号，已提交限价做空挂单</b>\n` +
      `• <b>标的</b>: <a href="https://www.binance.com/zh-CN/futures/${order.symbol}"><b>${order.symbol}</b></a>\n` +
      `• <b>挂单限价</b>: <code>${order.limitPrice.toFixed(4)}</code> (基准价: <code>${order.basePrice.toFixed(4)}</code>, 上浮: <b>+${order.limitOffsetPercent.toFixed(2)}%</b>)\n` +
      `• <b>杠杆 / 保证金</b>: <b>${order.leverage}x / ${order.marginUsdt} USDT</b> (名义仓位: ${order.notionalUsdt} USDT)\n` +
      `• <b>24h涨幅</b>: +${order.dayChangePercent.toFixed(2)}% ${rankStr} | <b>30m振幅</b>: ${order.amp30Percent.toFixed(2)}%\n` +
      `• <b>撮合机制</b>: 向上冲针触及挂单价即撮合成交 (有效期 ${this.config.limitExpireMinutes}分钟，未触碰或提前下跌自动撤单)`;
    await sendTelegramMessage(msg);
  }

  private async notifyEntry(pos: PaperPosition): Promise<void> {
    const rankStr = pos.rank ? `(#${pos.rank})` : "";
    const isLimit = pos.limitPrice != null;
    const msg =
      `⚡ <b>[模拟交易] ${isLimit ? "限价挂单冲高撮合成交" : "发现做空信号，市价开空"}</b>\n` +
      `• <b>标的</b>: <a href="https://www.binance.com/zh-CN/futures/${pos.symbol}"><b>${pos.symbol}</b></a>\n` +
      `• <b>杠杆 / 保证金</b>: <b>${pos.leverage}x / ${pos.marginUsdt} USDT</b> (名义仓位: ${pos.notionalUsdt} USDT)\n` +
      `• <b>成交开仓价</b>: <code>${pos.entryPrice.toFixed(4)}</code>\n` +
      `• <b>24h涨幅</b>: +${pos.dayChangePercent.toFixed(2)}% ${rankStr} | <b>30m振幅</b>: ${pos.amp30Percent.toFixed(2)}%\n` +
      `• <b>阶段一目标 (平50%)</b>:\n` +
      `   - 止盈1: <b>${pos.tp1Price.toFixed(4)}</b> (-${pos.tp1Percent.toFixed(2)}%)\n` +
      `   - 止损1: <b>${pos.sl1Price.toFixed(4)}</b> (+${pos.sl1Percent.toFixed(2)}%)\n` +
      `• <b>阶段二目标 (平50%)</b>:\n` +
      `   - 止损2: <b>${pos.sl2Price.toFixed(4)}</b> (+${pos.sl2Percent.toFixed(2)}%)\n` +
      `   - 止盈2: <b>${pos.tp2Price.toFixed(4)}</b> (-${pos.tp2Percent.toFixed(2)}%)\n` +
      `• <b>模拟账户状态</b>: 可用保证金 <b>${this.account.availableMarginUsdt.toFixed(2)} USDT</b> (净值 <b>${this.account.equityUsdt.toFixed(2)} USDT</b>)\n` +
      `• <b>最长持仓</b>: 15分钟超时市价平仓`;
    await sendTelegramMessage(msg);
  }

  private async notifyStage1(pos: PaperPosition, exit: PaperExit): Promise<void> {
    const action =
      exit.reason === "target"
        ? "止盈平仓 ✅"
        : exit.reason === "stop"
          ? "止损减仓 🛑"
          : "超时平仓 ⏱️";
    const pnlSign = exit.netPnlUsdt >= 0 ? "+" : "";
    const msg =
      `🎯 <b>[模拟交易] 阶段一达成 (平仓 50%)</b>\n` +
      `• <b>标的</b>: <a href="https://www.binance.com/zh-CN/futures/${pos.symbol}"><b>${pos.symbol}</b></a>\n` +
      `• <b>动作</b>: ${action}\n` +
      `• <b>成交价</b>: <code>${exit.exitPrice.toFixed(4)}</code>\n` +
      `• <b>阶段净盈亏</b>: <b>${pnlSign}${exit.netPnlUsdt.toFixed(2)} USDT</b>\n` +
      `• <b>剩余仓位</b>: 50% (等待阶段二: 止盈 <code>${pos.tp2Price.toFixed(4)}</code> / 止损 <code>${pos.sl2Price.toFixed(4)}</code>)`;
    await sendTelegramMessage(msg);
  }

  private async notifyFinal(pos: PaperPosition): Promise<void> {
    const holdMins = pos.closedAt
      ? ((pos.closedAt - pos.entryTime) / 60000).toFixed(1)
      : "15.0";
    const reasonStr =
      pos.finalReason === "target"
        ? "两阶段全部止盈 🎯"
        : pos.finalReason === "stop"
          ? "触发止损 🛑"
          : "15分钟超时市价平仓 ⏱️";
    const avgExitPrice =
      pos.exits.length > 0
        ? pos.exits.reduce((sum, e) => sum + e.exitPrice * e.fraction, 0)
        : pos.currentPrice;
    const pnlSign = pos.totalNetPnlUsdt >= 0 ? "+" : "";
    const totSign = this.account.totalPnlUsdt >= 0 ? "+" : "";

    const msg =
      `🏆 <b>[模拟交易] 订单全额结清</b>\n` +
      `• <b>标的</b>: <a href="https://www.binance.com/zh-CN/futures/${pos.symbol}"><b>${pos.symbol}</b></a>\n` +
      `• <b>杠杆 / 保证金</b>: 10x / ${pos.marginUsdt} USDT\n` +
      `• <b>持仓耗时</b>: ${holdMins} 分钟\n` +
      `• <b>结算原因</b>: ${reasonStr}\n` +
      `• <b>成交明细</b>: 开 <code>${pos.entryPrice.toFixed(4)}</code> → 平均 <code>${avgExitPrice.toFixed(4)}</code>\n` +
      `• <b>整单净盈亏</b>: <b>${pnlSign}${pos.totalNetPnlUsdt.toFixed(2)} USDT (ROE: ${pnlSign}${pos.roePercent.toFixed(1)}%)</b>\n` +
      `• <b>模拟账户总览</b>: 余额 <b>${this.account.balanceUsdt.toFixed(2)} USDT</b> (净值 <b>${this.account.equityUsdt.toFixed(2)} USDT</b>, 累计回报 <b>${totSign}${this.account.accountRoiPercent.toFixed(2)}%</b>)\n` +
      `• <b>累计模拟战绩</b>: 共 ${this.stats.totalTrades} 笔 | 胜率 <b>${this.stats.winRate.toFixed(1)}%</b> | PF <b>${Number.isFinite(this.stats.profitFactor) ? this.stats.profitFactor.toFixed(2) : "∞"}</b>`;
    await sendTelegramMessage(msg);
  }

  // --- Persistence ---
  private scheduleSave(): void {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => {
      this.saveState();
    }, 500);
  }

  public saveState(): void {
    if (!this.config.storageFile) return;
    try {
      const targetDir = path.dirname(this.config.storageFile);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      const data: PaperTradingState = {
        account: this.account,
        pendingOrders: Array.from(this.pendingOrders.values()),
        activePositions: Array.from(this.activePositions.values()),
        closedPositions: this.closedPositions,
        stats: this.stats,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(this.config.storageFile, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {
      console.warn(`[paper-trading] 保存状态文件失败:`, (e as any)?.message ?? e);
    }
  }

  public loadState(): void {
    if (!this.config.storageFile) return;
    try {
      if (fs.existsSync(this.config.storageFile)) {
        const raw = fs.readFileSync(this.config.storageFile, "utf8");
        const data = JSON.parse(raw) as PaperTradingState;
        if (data.account) {
          this.account = data.account;
        }
        if (Array.isArray(data.pendingOrders)) {
          this.pendingOrders.clear();
          for (const o of data.pendingOrders) {
            this.pendingOrders.set(o.symbol, o);
          }
        }
        if (Array.isArray(data.activePositions)) {
          this.activePositions.clear();
          for (const p of data.activePositions) {
            this.activePositions.set(p.symbol, p);
          }
        }
        if (Array.isArray(data.closedPositions)) {
          this.closedPositions = data.closedPositions;
        }
        if (data.stats) {
          this.stats = data.stats;
        }
        console.log(
          `[paper-trading] 成功载入模拟交易历史: 账户余额 ${this.account.balanceUsdt.toFixed(2)} USDT, 挂单 ${this.pendingOrders.size} 笔, 活跃 ${this.activePositions.size} 笔, 历史 ${this.closedPositions.length} 笔 (胜率 ${this.stats.winRate.toFixed(1)}%)`,
        );
      }
    } catch (e) {
      console.warn(`[paper-trading] 载入状态文件失败，使用初始状态:`, (e as any)?.message ?? e);
    }
  }

  public reset(): void {
    this.pendingOrders.clear();
    this.activePositions.clear();
    this.closedPositions = [];
    this.account = {
      initialBalanceUsdt: this.config.initialBalanceUsdt,
      balanceUsdt: this.config.initialBalanceUsdt,
      equityUsdt: this.config.initialBalanceUsdt,
      usedMarginUsdt: 0,
      availableMarginUsdt: this.config.initialBalanceUsdt,
      totalPnlUsdt: 0,
      accountRoiPercent: 0,
    };
    this.stats = {
      initialBalanceUsdt: this.config.initialBalanceUsdt,
      balanceUsdt: this.config.initialBalanceUsdt,
      equityUsdt: this.config.initialBalanceUsdt,
      accountRoiPercent: 0,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      breakevenTrades: 0,
      winRate: 0,
      totalNetPnlUsdt: 0,
      grossGainsUsdt: 0,
      grossLossesUsdt: 0,
      profitFactor: 1.0,
      avgTradePnlUsdt: 0,
      realizedRewardRisk: null,
    };
    this.saveState();
    console.log(`[paper-trading] 🔄 模拟交易账户、活跃持仓、挂单与历史明细已全部重置为初始状态 (100 USDT)`);
  }

  public getSummary(): PaperTradingSummary {
    return {
      account: this.account,
      pendingOrders: Array.from(this.pendingOrders.values()),
      pendingCount: this.pendingOrders.size,
      activeCount: this.activePositions.size,
      totalTrades: this.stats.totalTrades,
      winningTrades: this.stats.winningTrades,
      losingTrades: this.stats.losingTrades,
      winRate: this.stats.winRate,
      totalNetPnlUsdt: this.stats.totalNetPnlUsdt,
      profitFactor: this.stats.profitFactor,
      activePositions: Array.from(this.activePositions.values()),
    };
  }

  public getState(): PaperTradingState & { config: PaperStrategyConfig } {
    return {
      account: this.account,
      pendingOrders: Array.from(this.pendingOrders.values()),
      activePositions: Array.from(this.activePositions.values()),
      closedPositions: this.closedPositions,
      stats: this.stats,
      updatedAt: new Date().toISOString(),
      config: this.config,
    };
  }
}

export const paperTrading = new PaperTradingEngine();
