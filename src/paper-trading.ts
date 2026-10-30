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
import {
  UnifiedShortStrategyTracker,
  STREAK_LIVE_DEFAULT_CONFIG,
  DUAL_SPEED_EXTREME_DEV_CONFIG,
  DUAL_SPEED_DEEP_REBOUND_CONFIG,
  type ExtremeDevLiveConfig,
  type StreakStrategyLiveConfig,
  type DeepReboundLiveConfig,
  type UnifiedLiveConfig,
} from "./unified-short-strategy.ts";
import {
  DUAL_SPEED_PEAK_REBOUND_CONFIG,
  type PeakReboundLiveConfig,
} from "./peak-rebound-strategy.ts";
import type {
  PaperAccount,
  PaperPosition,
  PaperPendingOrder,
  PaperExit,
  PaperExitReason,
  PaperTradingStats,
  PaperTradingState,
  PaperTradingSummary,
  PaperSignalType,
  PaperSignalLabel,
  PaperExitParams,
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
  leverage: number;           // 通用/顺势波段杠杆 (默认 3x)
  streakLeverage?: number;    // 新高顶背离闪击专属杠杆 (回测最优 10x)
  trendLeverage?: number;     // 顺势衰竭专属杠杆 (默认 3x)
  marginUsdt: number;         // 20 USDT 单笔保证金 (名义本金 60/200 USDT)
  takerFeeBps: number;
  slippageBps: number;
  limitDivisor: number; // 挂单上浮幅度分母 N: 挂单上浮 = dayChangePercent / limitDivisor (默认 100)
  limitExpireMinutes: number; // 挂单有效期分钟数 (默认 3 分钟)
  storageFile?: string | null;
  stopAtHigh?: boolean; // 极端最高点止损模式 (触碰止损时按当根1m K线最高点/Tick最高突破价成交，默认 true)
  streakConfig?: Partial<StreakStrategyLiveConfig>;
  reboundConfig?: Partial<PeakReboundLiveConfig>;
  deepReboundConfig?: Partial<DeepReboundLiveConfig>;
  extremeDevConfig?: Partial<ExtremeDevLiveConfig>;
}

const DATA_DIR = path.join(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "paper-trading.json");

export const PAPER_DEFAULT_CONFIG: PaperStrategyConfig = {
  topN: 10,
  supportMaPeriods: [3, 7, 15],
  ampDivisor: 10, // 5 分钟冲高涨幅 >= 24h 涨幅 / 10
  minStreakCount: 2,
  minUpperShadowRatio: 0.005, // 上影线 >= 0.5% 柱体
  maxUpperShadowRatio: 0.30,  // 上影线 < 30% 柱体
  greenWindow: 30,
  minGreenRatio: 0.70,
  minConsecutiveGreenBars: 7,
  holdMinutes: 15,
  exitX: 50,
  exitN: 1.5,
  exitM: 3.0,
  firstCloseFraction: 0.5,
  initialBalanceUsdt: 100, // 初始模拟资金 100 USDT
  leverage: 3,             // 默认通用/顺势衰竭杠杆 3x (黄金收益/回撤比，零爆仓)
  trendLeverage: 3,        // 顺势衰竭长波段杠杆 3x (10% 大止损)
  streakLeverage: 10,      // 新高顶背离闪击战杠杆 10x (15m 紧止损，回测最优解，零爆仓)
  marginUsdt: 20,          // 单笔保证金 20 USDT
  takerFeeBps: 5,          // 0.05%
  slippageBps: 2,          // 0.02%
  limitDivisor: 0,         // 默认 0 (直开市价模式，回测胜率 71.2%，PF 3.23)
  limitExpireMinutes: 3,   // 默认 3 分钟
  stopAtHigh: true,        // 默认 true (开启极端最高点止损模式)
  storageFile: STATE_FILE,
  // 默认启用黄金双速最优组合 (Dual-Speed Ensemble: 首次跌10%、跌到20%、极度乖离走 3x / 10% 止损 / 90m 长波段，新高顶背离保留 15m 闪击战)
  reboundConfig: DUAL_SPEED_PEAK_REBOUND_CONFIG,
  deepReboundConfig: DUAL_SPEED_DEEP_REBOUND_CONFIG,
  extremeDevConfig: DUAL_SPEED_EXTREME_DEV_CONFIG,
};

export function formatSignalLabel(type?: PaperSignalType, label?: PaperSignalLabel): PaperSignalLabel {
  if (label) return label;
  if (type === "extreme_dev") return "冲高极度乖离";
  if (type === "deep_rebound") return "跌到20%+";
  if (type === "rebound") return "首次跌10%";
  return "新高顶背离";
}

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
  private unifiedTracker: UnifiedShortStrategyTracker;

  constructor(config: Partial<PaperStrategyConfig> = {}) {
    this.config = { ...PAPER_DEFAULT_CONFIG, ...config };
    if (config.leverage !== undefined) {
      if (config.streakLeverage === undefined) {
        this.config.streakLeverage = config.leverage;
      }
      if (config.trendLeverage === undefined) {
        this.config.trendLeverage = config.leverage;
      }
    }
    this.unifiedTracker = new UnifiedShortStrategyTracker({
      streakConfig: {
        ...STREAK_LIVE_DEFAULT_CONFIG,
        topN: this.config.topN,
        supportMaPeriods: this.config.supportMaPeriods,
        ampDivisor: this.config.ampDivisor,
        holdMinutes: this.config.holdMinutes,
        exitX: this.config.exitX,
        exitN: this.config.exitN,
        exitM: this.config.exitM,
        minStreakCount: this.config.minStreakCount,
        minUpperShadowRatio: this.config.minUpperShadowRatio,
        maxUpperShadowRatio: this.config.maxUpperShadowRatio,
        greenWindow: this.config.greenWindow,
        minGreenRatio: this.config.minGreenRatio,
        minConsecutiveGreenBars: this.config.minConsecutiveGreenBars,
        ...this.config.streakConfig,
      },
      reboundConfig: this.config.reboundConfig,
      deepReboundConfig: this.config.deepReboundConfig,
      extremeDevConfig: this.config.extremeDevConfig,
      preventConflict: true,
    });
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

  public getUnifiedTracker(): UnifiedShortStrategyTracker {
    return this.unifiedTracker;
  }

  public getConfig(): PaperStrategyConfig {
    return { ...this.config };
  }

  public getLeverageForSignal(signalType?: PaperSignalType): number {
    if (signalType === "streak") {
      return this.config.streakLeverage ?? 10;
    }
    return this.config.trendLeverage ?? this.config.leverage;
  }

  public updateConfig(updates: Partial<PaperStrategyConfig>): PaperStrategyConfig {
    if (typeof updates.leverage === "number" && Number.isFinite(updates.leverage) && updates.leverage >= 1 && updates.leverage <= 100) {
      this.config.leverage = updates.leverage;
    }
    if (typeof updates.streakLeverage === "number" && Number.isFinite(updates.streakLeverage) && updates.streakLeverage >= 1 && updates.streakLeverage <= 100) {
      this.config.streakLeverage = updates.streakLeverage;
    }
    if (typeof updates.trendLeverage === "number" && Number.isFinite(updates.trendLeverage) && updates.trendLeverage >= 1 && updates.trendLeverage <= 100) {
      this.config.trendLeverage = updates.trendLeverage;
    }
    if (typeof updates.marginUsdt === "number" && Number.isFinite(updates.marginUsdt) && updates.marginUsdt > 0) {
      this.config.marginUsdt = updates.marginUsdt;
    }
    if (typeof updates.limitDivisor === "number" && Number.isFinite(updates.limitDivisor) && updates.limitDivisor >= 0) {
      this.config.limitDivisor = updates.limitDivisor;
    }
    if (typeof updates.limitExpireMinutes === "number" && Number.isFinite(updates.limitExpireMinutes) && updates.limitExpireMinutes > 0) {
      this.config.limitExpireMinutes = updates.limitExpireMinutes;
    }
    if (typeof updates.stopAtHigh === "boolean") {
      this.config.stopAtHigh = updates.stopAtHigh;
    }
    if (typeof updates.holdMinutes === "number" && Number.isFinite(updates.holdMinutes) && updates.holdMinutes > 0) {
      this.config.holdMinutes = updates.holdMinutes;
    }

    console.log(
      `[paper-trading] ⚙️ 配置已通过 API 动态更新: 新高背离闪击杠杆 ${this.config.streakLeverage ?? 10}x, 顺势波段杠杆 ${this.config.trendLeverage ?? this.config.leverage}x, 单笔保证金 ${this.config.marginUsdt} USDT`,
    );

    this.scheduleSave();
    return this.getConfig();
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
    signalType?: PaperSignalType;
    signalLabel?: PaperSignalLabel;
    exitParams?: PaperExitParams;
    now?: number;
  }): PaperPendingOrder {
    const { symbol, dayChangePercent, rank, basePrice, signal, exitParams } = params;
    const now = params.now ?? Date.now();
    const divisor = this.config.limitDivisor > 0 ? this.config.limitDivisor : 100;
    const limitOffsetPercent = dayChangePercent / divisor;
    const limitPrice = basePrice * (1 + limitOffsetPercent / 100);
    const expireAt = now + this.config.limitExpireMinutes * 60 * 1000;

    const exitX = exitParams?.exitX ?? this.config.exitX;
    // 保护位：若行情直接下杀跌破预估的阶段一止盈位，说明行情已直接跌完，不再接单
    const tp1OffsetPercent = exitParams?.tp1Percent ?? (dayChangePercent / exitX);
    const cancelBelowPrice = basePrice * (1 - tp1OffsetPercent / 100);

    const signalType = params.signalType ?? "streak";
    const signalLabel = formatSignalLabel(signalType, params.signalLabel);
    const leverage = exitParams?.leverage ?? this.getLeverageForSignal(signalType);
    const notionalUsdt = this.config.marginUsdt * leverage;

    const order: PaperPendingOrder = {
      id: `pending-${symbol}-${now}`,
      symbol,
      side: "SHORT",
      leverage,
      marginUsdt: this.config.marginUsdt,
      notionalUsdt,
      signalType,
      signalLabel,
      exitParams: exitParams ?? {
        holdMinutes: this.config.holdMinutes,
        exitX: this.config.exitX,
        exitN: this.config.exitN,
        exitM: this.config.exitM,
      },
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
      `[paper-trading] ⏳ 提交限价做空挂单 [${signalLabel}] ${symbol} @ ${limitPrice.toFixed(4)} ` +
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
    this.unifiedTracker.closePosition(symbol);
    this.scheduleSave();
    console.log(`[paper-trading] ⏱️ 撤销限价做空挂单 [${order.signalLabel ?? "做空"}] ${symbol} @ ${order.limitPrice.toFixed(4)}: ${reason}`);
  }

  /**
   * Called on every scan/refresh at candle close.
   * Scans gainers for entry signals using Unified 3-Signal strategy (连阳悬空 / 首次跌10% / 跌到20%+).
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

    // 1. 同步非置顶榜首标的至弱反弹追踪器 (watch 24h gainers rank 1)
    const nonPinnedGainers = gainers.filter((t) => !pinnedSymbols.has(t.symbol));
    const topGainer = nonPinnedGainers[0];
    if (topGainer && topGainer.priceChangePercent > 0) {
      this.unifiedTracker.onRankUpdate(topGainer.symbol, topGainer.priceChangePercent, now);
    }

    // 收集所有需要扫描的标的：全量传入标的 (含 Top N 与跌出前十标的) + 处于弱反弹监控中的标的 (三者同时并行判断，任一满足即开仓)
    const candidates: Array<{ ticker: Ticker24h; rank: number }> = [];
    const seenSymbols = new Set<string>();

    for (let i = 0; i < nonPinnedGainers.length; i++) {
      const ticker = nonPinnedGainers[i];
      if (!seenSymbols.has(ticker.symbol)) {
        seenSymbols.add(ticker.symbol);
        candidates.push({ ticker, rank: i + 1 });
      }
    }

    for (const watched of this.unifiedTracker.getReboundWatchlist()) {
      if (!seenSymbols.has(watched.symbol)) {
        const found = nonPinnedGainers.find((t) => t.symbol === watched.symbol);
        if (found) {
          seenSymbols.add(found.symbol);
          const r = nonPinnedGainers.indexOf(found) + 1;
          candidates.push({ ticker: found, rank: r });
        }
      }
    }

    for (const { ticker, rank } of candidates) {
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

      const liveSignal = this.unifiedTracker.checkCandles(
        ticker.symbol,
        ticker.priceChangePercent,
        rank,
        symCache.candles1m,
        now,
      );

      if (liveSignal) {
        const targetIdx = symCache.candles1m.length - 2;
        const forming = symCache.candles1m[symCache.candles1m.length - 1];
        const basePrice =
          forming && forming.close > 0 ? forming.close : liveSignal.entryPrice;

        const signalType = liveSignal.type;
        const signalLabel = formatSignalLabel(signalType, liveSignal.label);
        const exitParams = liveSignal.exitParams;

        const streakCount =
          liveSignal.details.streakSignal?.streakCount ??
          liveSignal.details.reboundSignal?.reboundUpCandles ??
          2;
        const upperShadowRatio =
          liveSignal.details.streakSignal?.upperShadowRatio ??
          liveSignal.details.reboundSignal?.upperShadowRatio ??
          0;
        const greenRatio =
          liveSignal.details.streakSignal?.greenRatio ??
          liveSignal.details.reboundSignal?.greenRatio20 ??
          liveSignal.details.deepReboundSignal?.greenRatio20 ??
          0;
        const consecutiveGreenBars =
          liveSignal.details.streakSignal?.consecutiveGreenBars ?? 0;
        const amp30Percent =
          liveSignal.details.streakSignal?.amp30Percent ??
          liveSignal.details.reboundSignal?.reboundPercent ??
          liveSignal.details.deepReboundSignal?.reboundFrom10m ??
          0;

        const signalDetails: SignalMatchDetails = {
          candle: symCache.candles1m[targetIdx],
          streakCount,
          amp30Percent,
          upperShadowRatio,
          greenRatio,
          consecutiveGreenBars,
        };

        if (this.config.limitDivisor > 0) {
          // 挂单模式：以 24h涨幅/limitDivisor 向上挂单等待冲高撮合
          this.createPendingOrder({
            symbol: ticker.symbol,
            dayChangePercent: ticker.priceChangePercent,
            rank,
            basePrice,
            signal: signalDetails,
            signalType,
            signalLabel,
            exitParams,
            now,
          });
        } else {
          // 回退直接市价开仓模式
          const pos = this.openPosition({
            symbol: ticker.symbol,
            dayChangePercent: ticker.priceChangePercent,
            rank,
            entryPrice: basePrice,
            entryTime: now,
            signal: signalDetails,
            signalType,
            signalLabel,
            exitParams,
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
    signalType?: PaperSignalType;
    signalLabel?: PaperSignalLabel;
    exitParams?: PaperExitParams;
    leverage?: number;
  }): PaperPosition {
    const {
      symbol,
      dayChangePercent,
      rank,
      entryPrice,
      entryTime,
      limitPrice,
      signal,
      exitParams,
    } = params;

    const exitX = exitParams?.exitX ?? this.config.exitX;
    const exitN = exitParams?.exitN ?? this.config.exitN;
    const exitM = exitParams?.exitM ?? this.config.exitM;
    const holdMinutes = exitParams?.holdMinutes ?? this.config.holdMinutes;

    // Two-stage dynamic thresholds:
    // 支持显式大止损/大止盈参数 (如 10% 大止损, 4% TP1, 8% TP2) 或回退至动态公式
    const tp1Percent = exitParams?.tp1Percent ?? (dayChangePercent / exitX);
    const sl1Percent = exitParams?.stopLossPercent ?? (dayChangePercent / exitX);
    const sl2Percent = exitParams?.stopLossPercent ?? ((dayChangePercent * exitN) / exitX);
    const tp2Percent = exitParams?.tp2Percent ?? ((dayChangePercent * exitM) / exitX);

    // Short direction price levels:
    // Target (profit): entry * (1 - tp / 100)
    // Stop (loss): entry * (1 + sl / 100)
    const tp1Price = entryPrice * (1 - tp1Percent / 100);
    const sl1Price = entryPrice * (1 + sl1Percent / 100);
    const sl2Price = entryPrice * (1 + sl2Percent / 100);
    const tp2Price = entryPrice * (1 - tp2Percent / 100);

    const timeoutAt = entryTime + holdMinutes * 60 * 1000;

    const signalType = params.signalType ?? "streak";
    const signalLabel = formatSignalLabel(signalType, params.signalLabel);
    const leverage = params.leverage ?? exitParams?.leverage ?? this.getLeverageForSignal(signalType);
    const notionalUsdt = this.config.marginUsdt * leverage;

    const position: PaperPosition = {
      id: `${symbol}-${entryTime}`,
      symbol,
      side: "SHORT",
      leverage,
      marginUsdt: this.config.marginUsdt,
      notionalUsdt,
      status: "OPEN",
      signalType,
      signalLabel,
      exitParams: {
        holdMinutes,
        exitX,
        exitN,
        exitM,
        stopLossPercent: exitParams?.stopLossPercent,
        tp1Percent: exitParams?.tp1Percent,
        tp2Percent: exitParams?.tp2Percent,
        moveSlToEntryAfterTp1: exitParams?.moveSlToEntryAfterTp1,
      },
      moveSlToEntryAfterTp1: exitParams?.moveSlToEntryAfterTp1 ?? true,
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
    this.unifiedTracker.registerPosition(symbol, {
      tradeId: position.id,
      type: signalType,
      entryTime,
      maxExitTime: timeoutAt,
    });
    this.recalculateStats();
    this.scheduleSave();

    // Broadcast Telegram entry notification
    this.notifyEntry(position).catch((e) =>
      console.warn(`[paper-trading] 发送开仓通知异常:`, (e as any)?.message ?? e),
    );

    const isLimit = limitPrice != null;
    console.log(
      `[paper-trading] ⚡ ${isLimit ? "限价挂单成交做空" : "市价开空"} [${signalLabel}] ${symbol} @ ${entryPrice.toFixed(4)} ` +
      `(${leverage}x, 保证金 ${this.config.marginUsdt} USDT, 24h: +${dayChangePercent.toFixed(2)}%, 30m振幅: ${signal.amp30Percent.toFixed(2)}%) ` +
      `TP1: ${tp1Price.toFixed(4)} SL1: ${sl1Price.toFixed(4)} SL2: ${sl2Price.toFixed(4)} TP2: ${tp2Price.toFixed(4)} 持仓: ${holdMinutes}m`,
    );

    return position;
  }

  /**
   * Real-time trade tick processing.
   * Evaluates pending limit orders, take-profit, stop-loss and timeouts in milliseconds.
   */
  public onTick(tick: TradeTick, currentCandleHigh?: number): void {
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
          `[paper-trading] 🎯 挂单成交！[${pending.signalLabel ?? "做空"}] ${pending.symbol} 触及做空限价 @ ${pending.limitPrice.toFixed(4)} (成交Tick: ${tick.price.toFixed(4)})`,
        );
        this.openPosition({
          symbol: pending.symbol,
          dayChangePercent: pending.dayChangePercent,
          rank: pending.rank,
          entryPrice: pending.limitPrice,
          entryTime: tick.time,
          limitPrice: pending.limitPrice,
          signalType: pending.signalType,
          signalLabel: pending.signalLabel,
          exitParams: pending.exitParams,
          leverage: pending.leverage,
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
        const exitPrice1 = this.config.stopAtHigh
          ? Math.max(price, currentCandleHigh ?? price, position.sl1Price)
          : position.sl1Price;
        this.closeStage(position, 1, exitPrice1, time, "stop");
        // In extreme fast jumps, check if Stage 2 stop is also hit
        if (price >= position.sl2Price) {
          const exitPrice2 = this.config.stopAtHigh
            ? Math.max(price, currentCandleHigh ?? price, position.sl2Price)
            : position.sl2Price;
          this.closeStage(position, 2, exitPrice2, time, "stop");
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
        const exitPrice = this.config.stopAtHigh
          ? Math.max(price, currentCandleHigh ?? price, position.sl2Price)
          : position.sl2Price;
        this.closeStage(position, 2, exitPrice, time, "stop");
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

      // 阶段一止盈达成后，若开启保本机制，将剩余仓位止损移动至入场保本价 (微留 0.2% 覆盖手续费)
      if (reason === "target" && pos.moveSlToEntryAfterTp1 !== false) {
        pos.sl2Price = pos.entryPrice * 1.002;
        pos.sl2Percent = 0.2;
        pos.isBreakevenArmed = true;
        console.log(
          `[paper-trading] 🛡️ ${pos.symbol} 阶段一止盈达成，剩余仓位止损已锁定保本价 @ ${pos.sl2Price.toFixed(4)}`,
        );
      }

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
    this.unifiedTracker.closePosition(pos.symbol);
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

    const label = formatSignalLabel(pos.signalType, pos.signalLabel);
    console.log(
      `[paper-trading] 🏆 ${pos.symbol} [${label}] 订单结清 (${pos.finalReason}) | ` +
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
    const label = formatSignalLabel(order.signalType, order.signalLabel);
    const msg =
      `⏳ <b>[模拟交易] 发现做空信号【${label}】，已提交限价做空挂单</b>\n` +
      `• <b>标的</b>: <a href="https://www.binance.com/zh-CN/futures/${order.symbol}"><b>${order.symbol}</b></a>\n` +
      `• <b>信号类型</b>: <b>【${label}】</b>\n` +
      `• <b>挂单限价</b>: <code>${order.limitPrice.toFixed(4)}</code> (基准价: <code>${order.basePrice.toFixed(4)}</code>, 上浮: <b>+${order.limitOffsetPercent.toFixed(2)}%</b>)\n` +
      `• <b>杠杆 / 保证金</b>: <b>${order.leverage}x / ${order.marginUsdt} USDT</b> (名义仓位: ${order.notionalUsdt} USDT)\n` +
      `• <b>24h涨幅</b>: +${order.dayChangePercent.toFixed(2)}% ${rankStr} | <b>30m振幅</b>: ${order.amp30Percent.toFixed(2)}%\n` +
      `• <b>撮合机制</b>: 向上冲针触及挂单价即撮合成交 (有效期 ${this.config.limitExpireMinutes}分钟，未触碰或提前下跌自动撤单)`;
    await sendTelegramMessage(msg);
  }

  private async notifyEntry(pos: PaperPosition): Promise<void> {
    const rankStr = pos.rank ? `(#${pos.rank})` : "";
    const isLimit = pos.limitPrice != null;
    const label = formatSignalLabel(pos.signalType, pos.signalLabel);
    const holdMin = pos.exitParams?.holdMinutes ?? this.config.holdMinutes;
    const msg =
      `⚡ <b>[模拟交易] ${isLimit ? "限价挂单冲高撮合成交" : "发现做空信号，市价开空"}【${label}】</b>\n` +
      `• <b>标的</b>: <a href="https://www.binance.com/zh-CN/futures/${pos.symbol}"><b>${pos.symbol}</b></a>\n` +
      `• <b>信号类型</b>: <b>【${label}】</b>\n` +
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
      `• <b>最长持仓</b>: ${holdMin}分钟超时市价平仓`;
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
    const label = formatSignalLabel(pos.signalType, pos.signalLabel);
    const beStr = pos.isBreakevenArmed
      ? `\n• <b>保护机制</b>: 🛡️ 剩余仓位止损已上移锁定保本价 <code>${pos.sl2Price.toFixed(4)}</code> (锁定无风险交易！)`
      : "";
    const msg =
      `🎯 <b>[模拟交易] 阶段一达成 (平仓 50%) 【${label}】</b>\n` +
      `• <b>标的</b>: <a href="https://www.binance.com/zh-CN/futures/${pos.symbol}"><b>${pos.symbol}</b></a>\n` +
      `• <b>信号类型</b>: <b>【${label}】</b>\n` +
      `• <b>动作</b>: ${action}\n` +
      `• <b>成交价</b>: <code>${exit.exitPrice.toFixed(4)}</code>\n` +
      `• <b>阶段净盈亏</b>: <b>${pnlSign}${exit.netPnlUsdt.toFixed(2)} USDT</b>\n` +
      `• <b>剩余仓位</b>: 50% (等待阶段二: 止盈 <code>${pos.tp2Price.toFixed(4)}</code> / 止损 <code>${pos.sl2Price.toFixed(4)}</code>)${beStr}`;
    await sendTelegramMessage(msg);
  }

  private async notifyFinal(pos: PaperPosition): Promise<void> {
    const holdMins = pos.closedAt
      ? ((pos.closedAt - pos.entryTime) / 60000).toFixed(1)
      : (pos.exitParams?.holdMinutes ?? this.config.holdMinutes).toFixed(1);
    const reasonStr =
      pos.finalReason === "target"
        ? "两阶段全部止盈 🎯"
        : pos.finalReason === "stop"
          ? (pos.isBreakevenArmed ? "触发保本止损 🛡️" : "触发止损 🛑")
          : `${holdMins}分钟超时市价平仓 ⏱️`;
    const avgExitPrice =
      pos.exits.length > 0
        ? pos.exits.reduce((sum, e) => sum + e.exitPrice * e.fraction, 0)
        : pos.currentPrice;
    const pnlSign = pos.totalNetPnlUsdt >= 0 ? "+" : "";
    const totSign = this.account.totalPnlUsdt >= 0 ? "+" : "";
    const label = formatSignalLabel(pos.signalType, pos.signalLabel);

    const msg =
      `🏆 <b>[模拟交易] 订单全额结清 (${reasonStr}) 【${label}】</b>\n` +
      `• <b>标的</b>: <a href="https://www.binance.com/zh-CN/futures/${pos.symbol}"><b>${pos.symbol}</b></a>\n` +
      `• <b>信号类型</b>: <b>【${label}】</b>\n` +
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
      const data: PaperTradingState & { configOverrides?: Partial<PaperStrategyConfig> } = {
        account: this.account,
        pendingOrders: Array.from(this.pendingOrders.values()),
        activePositions: Array.from(this.activePositions.values()),
        closedPositions: this.closedPositions,
        stats: this.stats,
        updatedAt: new Date().toISOString(),
        configOverrides: {
          leverage: this.config.leverage,
          streakLeverage: this.config.streakLeverage,
          trendLeverage: this.config.trendLeverage,
          marginUsdt: this.config.marginUsdt,
          limitDivisor: this.config.limitDivisor,
          limitExpireMinutes: this.config.limitExpireMinutes,
          stopAtHigh: this.config.stopAtHigh,
          holdMinutes: this.config.holdMinutes,
        },
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
            o.signalType = o.signalType ?? "streak";
            o.signalLabel = formatSignalLabel(o.signalType, o.signalLabel);
            this.pendingOrders.set(o.symbol, o);
            this.unifiedTracker.registerPosition(o.symbol, {
              tradeId: o.id,
              type: o.signalType,
              entryTime: o.createdAt,
              maxExitTime: o.expireAt,
            });
          }
        }
        if (Array.isArray(data.activePositions)) {
          this.activePositions.clear();
          for (const p of data.activePositions) {
            p.signalType = p.signalType ?? "streak";
            p.signalLabel = formatSignalLabel(p.signalType, p.signalLabel);
            this.activePositions.set(p.symbol, p);
            this.unifiedTracker.registerPosition(p.symbol, {
              tradeId: p.id,
              type: p.signalType,
              entryTime: p.entryTime,
              maxExitTime: p.timeoutAt,
            });
          }
        }
        if (Array.isArray(data.closedPositions)) {
          this.closedPositions = data.closedPositions.map((p) => {
            p.signalType = p.signalType ?? "streak";
            p.signalLabel = formatSignalLabel(p.signalType, p.signalLabel);
            return p;
          });
        }
        if (data.stats) {
          this.stats = data.stats;
        }
        if ((data as any).configOverrides) {
          const cfg = (data as any).configOverrides;
          if (typeof cfg.leverage === "number") this.config.leverage = cfg.leverage;
          if (typeof cfg.streakLeverage === "number") this.config.streakLeverage = cfg.streakLeverage;
          if (typeof cfg.trendLeverage === "number") this.config.trendLeverage = cfg.trendLeverage;
          if (typeof cfg.marginUsdt === "number") this.config.marginUsdt = cfg.marginUsdt;
          if (typeof cfg.limitDivisor === "number") this.config.limitDivisor = cfg.limitDivisor;
          if (typeof cfg.limitExpireMinutes === "number") this.config.limitExpireMinutes = cfg.limitExpireMinutes;
          if (typeof cfg.stopAtHigh === "boolean") this.config.stopAtHigh = cfg.stopAtHigh;
          if (typeof cfg.holdMinutes === "number") this.config.holdMinutes = cfg.holdMinutes;
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
    this.unifiedTracker = new UnifiedShortStrategyTracker({
      streakConfig: {
        ...STREAK_LIVE_DEFAULT_CONFIG,
        topN: this.config.topN,
        minStreakCount: this.config.minStreakCount,
        supportMaPeriods: this.config.supportMaPeriods,
        ampDivisor: this.config.ampDivisor,
        minUpperShadowRatio: this.config.minUpperShadowRatio,
        maxUpperShadowRatio: this.config.maxUpperShadowRatio,
        greenWindow: this.config.greenWindow,
        minGreenRatio: this.config.minGreenRatio,
        minConsecutiveGreenBars: this.config.minConsecutiveGreenBars,
        holdMinutes: this.config.holdMinutes,
        exitX: this.config.exitX,
        exitN: this.config.exitN,
        exitM: this.config.exitM,
        ...this.config.streakConfig,
      },
      reboundConfig: this.config.reboundConfig,
      deepReboundConfig: this.config.deepReboundConfig,
      extremeDevConfig: this.config.extremeDevConfig,
      preventConflict: true,
    });
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
      config: {
        leverage: this.config.leverage,
        streakLeverage: this.config.streakLeverage ?? 10,
        trendLeverage: this.config.trendLeverage ?? this.config.leverage,
        marginUsdt: this.config.marginUsdt,
        limitDivisor: this.config.limitDivisor,
        holdMinutes: this.config.holdMinutes,
        initialBalanceUsdt: this.config.initialBalanceUsdt,
      },
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
