import { normalizeFactorMiningConfig, factorWindows, factorWindowKey } from "./factor-settings.ts";
import { all, rule, ref, evaluateRules } from "./strategy-rules.ts";
import { StrategyEngine, type StrategyMatch, type StrategyMonitorResult } from "./strategy-engine.ts";
import { StrategyFeatureMonitor } from "./strategy-features.ts";
import { validateStrategies, type StrategyDefinition } from "./strategy-definition.ts";
import { buildStrategyPresets, LEGACY_STRATEGY_KEYS, quantPreset } from "./strategy-presets.ts";
import fs from "node:fs";
import path from "node:path";
import { validateStrategySpec } from "./strategy-spec.ts";
import {
  DEFAULT_FACTOR_MINING, FACTOR_POLICY_VERSION, FACTOR_MAX_DATA_AGE_MS, MINUTE_MS,
  emptyFactorState, initialFactorMiningState, factorConfigKey, passesFactorCandidate, validateFactorMiningConfig,
  type FactorMiningConfig, type FactorMiningState, type FactorMiningResult, type FactorSide,
} from "./factor-policy.ts";
import {
  type Candle,
} from "./macd.ts";
import {
  appendSignalSnapshot,
  FEATURE_VERSION,
} from "./features.ts";
import { breakevenPrice, calcTradeReturn, FIRST_CLOSE_FRACTION, DEFAULT_MAX_POSITIONS, DEFAULT_MAX_PER_STRATEGY, orderMargin, summarizeDirections } from "./trading-core.ts";
import { sendTelegramMessage, telegramConfigured, escapeHtml } from "./telegram.ts";
import {
  STREAK_LIVE_DEFAULT_CONFIG,
  DUAL_SPEED_DEEP_REBOUND_CONFIG,
  HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG,
  type StreakStrategyLiveConfig,
  type DeepReboundLiveConfig,
  type HourlySuppressionLiveConfig,
} from "./unified-short-strategy.ts";
import {
  DUAL_SPEED_PEAK_REBOUND_CONFIG,
  type PeakReboundLiveConfig,
} from "./peak-rebound-strategy.ts";
import {
  W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG,
  type WBottomDivergenceLiveConfig,
} from "./unified-long-strategy.ts";
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
  KlineStatsStrategyLiveConfig,
  StrategyFault,
} from "./types.ts";
import type { Ticker24h } from "./binance.ts";
import type { TradeTick } from "./ws.ts";

export interface PaperStrategyConfig {
  strategies?: StrategyDefinition[];
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
  streakLeverage?: number;    // 新高顶背离闪击专属杠杆 (默认 3x)
  trendLeverage?: number;     // 顺势衰竭专属杠杆 (默认 3x)
  longLeverage?: number;      // 做多专属杠杆 (默认 3x)
  klineStatsLeverage?: number;// 量化特征专属杠杆 (默认 3x)
  marginUsdt: number;         // 单笔保证金金额基准 (默认 20 USDT 参考值)
  marginRate?: number;        // 单笔保证金占总资产比例 (默认 0.20 即 20% 资产量)
  marginPercent?: number;     // 百分比格式 (默认 20)
  maxPositions?: number;      // 全局最大同时持仓数 (默认 5)
  maxPositionsPerStrategy?: number; // 单策略最大同时持仓数 (默认 1，保证各大策略各持仓至多 1 笔)
  takerFeeBps: number;
  slippageBps: number;
  limitDivisor: number; // 挂单上浮幅度分母 N: 挂单上浮 = dayChangePercent / limitDivisor (默认 100)
  limitExpireMinutes: number; // 挂单有效期分钟数 (默认 3 分钟)
  storageFile?: string | null;
  stopAtHigh?: boolean; // 极端最高点止损模式 (触碰做空止损时按当根1m K线最高点/Tick最高突破价成交，默认 true)
  stopAtLow?: boolean;  // 极端最低点止损模式 (触碰做多止损时按当根1m K线最低点/Tick最低突破价成交，默认 true)
  enableStreak?: boolean;     // 是否启用新高顶背离闪击做空 (默认 true)
  enableRebound?: boolean;    // 是否启用首次跌10%弱反弹做空 (默认 true)
  enableDeepRebound?: boolean;// 是否启用跌到20%+次级反弹做空 (默认 true)
  enableHourlySuppression?: boolean; // 是否启用小时线压制做空 (默认 true)
  enableLongs?: boolean;      // 是否启用涨幅榜做多 (默认 true)
  enableWBottomDivergence?: boolean; // 是否启用左侧3W底背离弹射做多 (默认 true)
  enableKlineStatsShort?: boolean;   // 是否启用量化K线特征挖掘做空 (默认 true)
  enableKlineStatsLong?: boolean;    // 是否启用量化K线特征挖掘做多 (默认 true)
  streakConfig?: Partial<StreakStrategyLiveConfig>;
  reboundConfig?: Partial<PeakReboundLiveConfig>;
  deepReboundConfig?: Partial<DeepReboundLiveConfig>;
  hourlySuppressionConfig?: Partial<HourlySuppressionLiveConfig>;
  wBottomDivergenceConfig?: Partial<WBottomDivergenceLiveConfig>;
  klineStatsShortConfig?: Partial<KlineStatsStrategyLiveConfig>;
  klineStatsLongConfig?: Partial<KlineStatsStrategyLiveConfig>;
  factorMining?: FactorMiningConfig;
}

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "paper-trading.json");

export const PAPER_DEFAULT_CONFIG: PaperStrategyConfig = {
  factorMining: { ...DEFAULT_FACTOR_MINING },
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
  leverage: 3,             // 默认通用杠杆 3x
  trendLeverage: 3,        // 顺势衰竭长波段杠杆 3x
  streakLeverage: 3,      // 新高顶背离闪击战杠杆 3x
  longLeverage: 3,         // 做多专属杠杆 3x (回测黄金参数)
  klineStatsLeverage: 3,  // 量化特征做空专属杠杆 3x
  marginUsdt: 20,          // 单笔保证金基准 20 USDT (100U 初本时对应 20%)
  marginRate: 0.20,        // 单笔保证金占当前总资产 20%
  marginPercent: 20,       // 20%
  maxPositions: DEFAULT_MAX_POSITIONS,         // 全局最大同时持仓数 5 笔 (每策略至多 1 笔)
  maxPositionsPerStrategy: DEFAULT_MAX_PER_STRATEGY, // 单策略最大同时持仓数 1 笔 (确保各策略持仓至多 1 笔)
  takerFeeBps: 5,          // 0.05%
  slippageBps: 2,          // 0.02%
  limitDivisor: 0,         // 默认 0 (直开市价模式)
  limitExpireMinutes: 3,   // 默认 3 分钟
  stopAtHigh: true,        // 开启做空极端最高点止损模式
  stopAtLow: true,         // 开启做多极端最低点止损模式
  enableStreak: true,      // 策略 4: 开启新高顶背离 3x 闪击做空 (15m 持仓)
  enableRebound: true,     // 策略 2: 开启首次跌10%弱反弹做空 (最大 30m 持仓)
  enableDeepRebound: true, // 策略 5: 开启跌到20%+次级反弹做空 (最大 30m 持仓)
  enableHourlySuppression: true, // 策略 6: 开启小时线压制做空 (最大 30m 持仓)
  enableLongs: true,       // 默认 true (开启涨幅榜做多)
  enableWBottomDivergence: true, // 策略 1: 开启左侧3W底背离弹射做多 (最大 30m 持仓)
  enableKlineStatsShort: true,   // 策略 7: 开启量化K线统计特征做空 (45m 持仓)
  enableKlineStatsLong: false,   // 策略 8: 默认关闭量化做多 (审计结论：线上净亏 -15.9U、样本外留出收益负值，未达部署门槛前严禁默认开启)
  storageFile: STATE_FILE,
  streakConfig: {
    ...STREAK_LIVE_DEFAULT_CONFIG,
    divergenceLookbackMax: 20, // 紧邻双顶 20 根，严格遵从回测验证
  },
  reboundConfig: {
    ...DUAL_SPEED_PEAK_REBOUND_CONFIG,
    holdMinutes: 30,
    tp1Percent: 3.5,
    tp2Percent: 8.0,
    stopLossPercent: 7.0,
    moveSlToEntryAfterTp1: true,
    minGreenRatio20: 0.55, // 回测验证最优：0.55 兼顾胜率与收益比
  },
  deepReboundConfig: {
    ...DUAL_SPEED_DEEP_REBOUND_CONFIG,
    holdMinutes: 30,
    tp1Percent: 3.5,
    tp2Percent: 8.0,
    stopLossPercent: 7.0,
    moveSlToEntryAfterTp1: true,
    minGreenRatio20: 0.55, // 回测验证最优：0.55
  },
  hourlySuppressionConfig: {
    ...HOURLY_SUPPRESSION_LIVE_DEFAULT_CONFIG,
    holdMinutes: 30,
    tp1Percent: 3.5,
    tp2Percent: 8.0,
    stopLossPercent: 7.0,
    moveSlToEntryAfterTp1: true,
  },
  wBottomDivergenceConfig: {
    ...W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG,
    holdMinutes: 30,
    tp1Percent: 3.0,
    tp2Percent: 8.0,
    stopLossPercent: 7.0,
    moveSlToEntryAfterTp1: true,
  },
  klineStatsShortConfig: {
    topN: 10,
    minDayChange: 10,
    intervalWindow: 5,
    ampDivisor: 8,
    maRequirement: "MA10_BREAKDOWN",
    macdRequirement: "GREEN_RATIO_30_80",
    holdMinutes: 45,
    tp1Percent: 3.0,
    tp2Percent: 7.0,
    stopLossPercent: 5.0,
    moveSlToEntryAfterTp1: true,
    cooldownMinutes: 20,
    leverage: 3,
  },
  klineStatsLongConfig: {
    topN: 10,
    minDayChange: 10,
    intervalWindow: 5,
    ampDivisor: 8,
    maRequirement: "MA20_SUPPORT",
    macdRequirement: "GREEN_RATIO_15_70",
    holdMinutes: 30,
    tp1Percent: 2.5,
    tp2Percent: 5.5,
    stopLossPercent: 3.5,
    moveSlToEntryAfterTp1: true,
    cooldownMinutes: 20,
    leverage: 3,
  },
};

export function resolveKlineStatsLabel(side: "SHORT" | "LONG", maRequirement?: string): PaperSignalLabel {
  if (side === "SHORT") {
    if (maRequirement === "MA20_RESIST" || maRequirement === "MA60_RESIST" || maRequirement === "MA30_RESIST") return "均线受阻";
    if (maRequirement === "MA_BEARISH_STACK") return "空头排列";
    return "冲高破位";
  } else {
    if (maRequirement === "MA_BULLISH_STACK") return "多头排列";
    if (maRequirement === "MA10_BREAKOUT" || maRequirement === "MA20_BREAKOUT") return "均线突破";
    return "回踩支撑";
  }
}

export function formatSignalLabel(
  type?: PaperSignalType,
  label?: PaperSignalLabel | string,
  side?: "LONG" | "SHORT" | string,
): PaperSignalLabel {
  const isLong = side === "LONG" || side === "做多" || type === "kline_stats_long";
  const defaultKlineLabel: PaperSignalLabel = isLong ? "回踩支撑" : "冲高破位";

  if (label) {
    if (label === "量化特征做空") return "冲高破位";
    if (label === "量化特征做多") return "回踩支撑";
    if (label === "量化特征") return defaultKlineLabel;
    return label as PaperSignalLabel;
  }
  if (type === "deep_rebound") return "跌到20%+";
  if (type === "rebound") return "首次跌10%";
  if (type === "hourly_suppression") return "小时线压制";
  if (type === "w_bottom_divergence") return "左侧3W底背离";
  if (type === "kline_stats_short") return "冲高破位";
  if (type === "kline_stats_long") return "回踩支撑";
  return "新高顶背离";
}

const KNOWN_SIGNAL_TYPES = new Set([
  "streak",
  "rebound",
  "deep_rebound",
  "hourly_suppression",
  "w_bottom_divergence",
  "kline_stats_short",
  "kline_stats_long",
]);

/**
 * 格式化“方向 · 策略名称”文案，避免如“做空 · 量化特征做空”等重复方向修饰词或空泛的冗余表述
 */
export function formatDirectionAndSignal(
  sideOrDir: "LONG" | "SHORT" | "做多" | "做空" | string,
  typeOrLabel?: PaperSignalType | PaperSignalLabel | string,
  maybeLabel?: PaperSignalLabel | string,
): string {
  const dir = sideOrDir === "LONG" || sideOrDir === "做多" ? "做多" : "做空";
  const side = dir === "做多" ? "LONG" : "SHORT";
  let label: string;
  if (maybeLabel !== undefined) {
    label = formatSignalLabel(typeOrLabel as PaperSignalType, maybeLabel, side);
  } else if (typeOrLabel && KNOWN_SIGNAL_TYPES.has(typeOrLabel)) {
    label = formatSignalLabel(typeOrLabel as PaperSignalType, undefined, side);
  } else if (typeOrLabel) {
    label = formatSignalLabel(undefined, typeOrLabel, side);
  } else {
    label = "新高顶背离";
  }
  if (label === "量化特征做空") {
    label = "冲高破位";
  } else if (label === "量化特征做多") {
    label = "回踩支撑";
  } else if (label === "量化特征") {
    label = dir === "做多" ? "回踩支撑" : "冲高破位";
  } else if (label.endsWith(dir)) {
    label = label.slice(0, -dir.length).trim() || label;
  }
  return `${dir} · ${label}`;
}

/**
 * 自适应价格格式化：避免低价山寨币（如 SLP/PEPE 价格 <0.001）在四位小数时发生截断失真
 */
export function formatPrice(price: number): string {
  if (!Number.isFinite(price) || price === 0) return "0";
  const abs = Math.abs(price);
  if (abs >= 100) return price.toFixed(2);
  if (abs >= 1) return price.toFixed(4);
  if (abs >= 0.01) return price.toFixed(5);
  if (abs >= 0.0001) return price.toFixed(6);
  return price.toFixed(8);
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
  const monitor = new StrategyFeatureMonitor(candles, { symbol, priceChangePercent: dayChangePercent, lastPrice: candles.at(-2)?.close ?? 0, quoteVolume: 0 }, 1);
  if (monitor.bars.length < Math.max(35, config.greenWindow + 5, ...config.supportMaPeriods)) return null;
  const entry = all(rule("dayChange", ">", 0), rule("streak.0.up", ">=", config.minStreakCount),
    rule("range.30", ">=", ref("dayChange", 1 / config.ampDivisor)),
    ...config.supportMaPeriods.map(p => rule(`support.${p}`, "==", false)),
    rule("upperShadowRatio", ">=", config.minUpperShadowRatio ?? 0.005), rule("upperShadowRatio", "<", config.maxUpperShadowRatio),
    rule(`greenRatio.${config.greenWindow}`, ">", config.minGreenRatio), rule("greenStreak", ">=", config.minConsecutiveGreenBars));
  if (!evaluateRules(entry, field => monitor.read(field)).pass) return null;
  const read = (field: string) => Number(monitor.read(field));
  return { candle: monitor.bar!, streakCount: read("streak.0.count"), amp30Percent: read("range.30"), upperShadowRatio: read("upperShadowRatio"),
    greenRatio: read(`greenRatio.${config.greenWindow}`), consecutiveGreenBars: read("greenStreak") };
}

export class PaperTradingEngine {
  private config: PaperStrategyConfig;
  private pendingOrders = new Map<string, PaperPendingOrder>(); // key: symbol
  private activePositions = new Map<string, PaperPosition>(); // key: symbol
  private closedPositions: PaperPosition[] = [];
  private account: PaperAccount;
  private stats: PaperTradingStats;
  private stats24h: PaperTradingStats;
  private saveTimeout: NodeJS.Timeout | null = null;
  private strategyEngine: StrategyEngine;
  private strategyMonitor: StrategyMonitorResult[] = [];
  private factorMiningState: FactorMiningState = emptyFactorState();
  private strategyFaults = new Map<string, StrategyFault>();
  private entryListeners = new Set<(position: PaperPosition) => void>();
  public onStrategyStopped?: (strategyId: string) => Promise<void> | void;

  /** New entries only: loading/resetting paper state must never replay live orders. */
  public onEntry(listener: (position: PaperPosition) => void): () => void {
    this.entryListeners.add(listener);
    return () => { this.entryListeners.delete(listener); };
  }

  constructor(config: Partial<PaperStrategyConfig> = {}) {
    this.config = { ...PAPER_DEFAULT_CONFIG, ...config, firstCloseFraction: FIRST_CLOSE_FRACTION };
    this.config.factorMining = normalizeFactorMiningConfig({ ...DEFAULT_FACTOR_MINING, ...config.factorMining });
    validateFactorMiningConfig(this.config.factorMining);
    if (config.marginUsdt !== undefined && config.marginRate === undefined && config.marginPercent === undefined) {
      const initBal = this.config.initialBalanceUsdt || 100;
      this.config.marginRate = config.marginUsdt / initBal;
      this.config.marginPercent = (config.marginUsdt / initBal) * 100;
    }
    // Existing positions keep their size; new entries use the core risk ceilings.
    this.config.marginRate = Math.min(0.2, Math.max(0, config.marginPercent !== undefined ? config.marginPercent / 100 : this.config.marginRate ?? 0.2));
    this.config.marginPercent = this.config.marginRate * 100;
    this.config.maxPositions = Math.min(5, Math.max(1, Math.floor(this.config.maxPositions ?? 5)));
    this.config.maxPositionsPerStrategy = 1;
    if (config.leverage !== undefined) {
      if (config.streakLeverage === undefined) {
        this.config.streakLeverage = config.leverage;
      }
      if (config.trendLeverage === undefined) {
        this.config.trendLeverage = config.leverage;
      }
      if (config.longLeverage === undefined) {
        this.config.longLeverage = config.leverage;
      }
    }
    this.config.strategies = structuredClone(config.strategies ?? buildStrategyPresets(this.config));
    this.strategyEngine = new StrategyEngine(this.config.strategies);
    for (const [id, keys] of Object.entries(LEGACY_STRATEGY_KEYS)) {
      Object.assign(this.config, { [keys.find(key => key.startsWith("enable"))!]: this.config.strategies.find(s => s.id === id)?.enabled ?? false });
    }
    this.account = {
      initialBalanceUsdt: this.config.initialBalanceUsdt,
      balanceUsdt: this.config.initialBalanceUsdt,
      equityUsdt: this.config.initialBalanceUsdt,
      usedMarginUsdt: 0,
      availableMarginUsdt: this.config.initialBalanceUsdt,
      totalPnlUsdt: 0,
      accountRoiPercent: 0,
    };
    this.stats = this.computeStatsForPositions([]);
    this.stats24h = this.computeStatsForPositions([]);
    this.loadState();
  }

  public getStrategyEngine(): StrategyEngine { return this.strategyEngine; }

  public getConfig(): PaperStrategyConfig {
    return structuredClone(this.config);
  }

  public getFactorMiningState(): FactorMiningState {
    return structuredClone(this.factorMiningState);
  }

  public setFactorMiningState(state: FactorMiningState): void {
    this.factorMiningState = structuredClone(state);
    this.scheduleSave();
  }

  public factorEntryAllowed(side: FactorSide, now = Date.now()): boolean {
    if (!this.config.factorMining?.enabled) return true;
    const sideState = this.factorMiningState.sides[side];
    const active = sideState?.active;
    const config = side === "LONG" ? this.config.klineStatsLongConfig : this.config.klineStatsShortConfig;
    if (!config || !active || active.revision.startsWith("baseline:") || !passesFactorCandidate(active)) return false;
    const definition = this.config.strategies?.find(s => s.id === `kline_stats_${side.toLowerCase()}`);
    const validated = quantPreset(side, active.config);
    if (!definition || JSON.stringify(definition.entry) !== JSON.stringify(validated.entry) ||
        JSON.stringify(definition.exit) !== JSON.stringify(validated.exit)) return false;
    return factorWindowKey(active.windows) === factorWindowKey(this.config.factorMining) &&
      active.featureVersion === FEATURE_VERSION && active.policyVersion === FACTOR_POLICY_VERSION &&
      active.dataAsOf <= now && now < Math.min(active.expiresAt, active.dataAsOf + this.config.factorMining.validForMinutes * MINUTE_MS) &&
      active.costs.takerFeeBps === this.config.takerFeeBps && active.costs.slippageBps === this.config.slippageBps &&
      factorConfigKey(active.config) === factorConfigKey(config ?? {});
  }

  public applyMinedFactors(result: FactorMiningResult, now = Date.now(), targetStrategyId?: string): void {
    if (!this.config.factorMining?.enabled) return;
    if (factorWindowKey(result.windows) !== factorWindowKey(this.config.factorMining) || result.featureVersion !== FEATURE_VERSION || result.policyVersion !== FACTOR_POLICY_VERSION ||
      !Number.isFinite(result.dataAsOf) || result.dataAsOf > now || now - result.dataAsOf > FACTOR_MAX_DATA_AGE_MS ||
      result.costs.takerFeeBps !== this.config.takerFeeBps || result.costs.slippageBps !== this.config.slippageBps) {
      throw new Error("因子结果版本、费用或数据时效不匹配");
    }
    const target = targetStrategyId ?? result.targetStrategyId;
    // Validate both sides before atomically replacing any parameters/approvals.
    for (const side of ["LONG", "SHORT"] as const) {
      const candidate = result.sides[side].candidate;
      if (candidate) {
        validateStrategySpec(candidate.config);
        if (!passesFactorCandidate(candidate)) throw new Error(`${side} 因子未达到验证门槛`);
      }
    }
    const appliedSides: ("LONG" | "SHORT")[] = [];
    for (const side of ["LONG", "SHORT"] as const) {
      const { candidate, reason } = result.sides[side];
      if (!target || target === (side === "LONG" ? "kline_stats_long" : "kline_stats_short")) {
        this.factorMiningState.sides[side] = { reason };
      }
      if (candidate) {
        appliedSides.push(side);
        const config = structuredClone(candidate.config);
        // Replace, rather than merge, so obsolete optional rules cannot survive validation.
        if (side === "LONG") this.config.klineStatsLongConfig = config;
        else this.config.klineStatsShortConfig = config;
        this.factorMiningState.sides[side].active = {
          windows: factorWindows(result.windows),
          ...structuredClone(candidate), revision: `${result.datasetHash}:${candidate.id}:${result.dataAsOf}`,
          dataAsOf: result.dataAsOf, expiresAt: result.dataAsOf + this.config.factorMining.validForMinutes * MINUTE_MS,
          featureVersion: result.featureVersion, policyVersion: result.policyVersion, costs: { ...result.costs },
        };
      }
    }
    this.config.strategies = (this.config.strategies ?? []).map(s => {
      const candidate = s.id === "kline_stats_long" ? result.sides.LONG.candidate : s.id === "kline_stats_short" ? result.sides.SHORT.candidate : undefined;
      return candidate ? { ...quantPreset(s.side, candidate.config), enabled: s.enabled } : s;
    });

    if (result.sides.LONG.candidate) {
      this.strategyFaults.delete("kline_stats_long");
    } else if (this.strategyFaults.has("kline_stats_long") && (!target || target === "kline_stats_long")) {
      this.setStrategyMiningCooldown("kline_stats_long", 60, now, result.sides.LONG.reason);
    }

    if (result.sides.SHORT.candidate) {
      this.strategyFaults.delete("kline_stats_short");
    } else if (this.strategyFaults.has("kline_stats_short") && (!target || target === "kline_stats_short")) {
      this.setStrategyMiningCooldown("kline_stats_short", 60, now, result.sides.SHORT.reason);
    }

    if (result.strategies) {
      for (const [strategyId, info] of Object.entries(result.strategies)) {
        if (info.candidate) {
          const config = structuredClone(info.candidate.config);
          if (strategyId === "streak") this.config.streakConfig = { ...this.config.streakConfig, ...config };
          else if (strategyId === "hourly_suppression") this.config.hourlySuppressionConfig = { ...this.config.hourlySuppressionConfig, ...config };
          else if (strategyId === "deep_rebound") this.config.deepReboundConfig = { ...this.config.deepReboundConfig, ...config };
          else if (strategyId === "rebound") this.config.reboundConfig = { ...this.config.reboundConfig, ...config };
          else if (strategyId === "w_bottom_divergence") this.config.wBottomDivergenceConfig = { ...this.config.wBottomDivergenceConfig, ...config };

          const presets = buildStrategyPresets(this.config);
          const updatedDef = presets.find(p => p.id === strategyId);
          if (updatedDef) {
            this.config.strategies = (this.config.strategies ?? []).map(s => s.id === strategyId ? { ...updatedDef, enabled: s.enabled } : s);
          }

          const wasFaulted = this.strategyFaults.has(strategyId);
          if (wasFaulted) {
            this.strategyFaults.delete(strategyId);
            const label = formatSignalLabel(strategyId as PaperSignalType);
            console.log(`[paper-trading] 🎉 策略 [${label}] 重新挖掘出达标参数并恢复交易 (留出胜率 ${info.candidate.holdout?.winRate.toFixed(1) ?? "100"}%)`);
            if (telegramConfigured()) {
              const text = `🎉 <b>策略挖掘达标并恢复交易</b>: [${escapeHtml(label)}]\n` +
                `• <b>状态</b>: 已通过近期行情回测验证并更新参数\n` +
                `• <b>留出集战绩</b>: ${info.candidate.holdout.trades}笔 | 胜率 ${info.candidate.holdout.winRate.toFixed(1)}% | 净利 +${info.candidate.holdout.netPercent.toFixed(2)}%\n` +
                `• <b>权限</b>: 停用状态已解除，恢复正常开仓`;
              sendTelegramMessage(text).catch(e => console.warn("[paper-trading] 发送恢复通知异常:", (e as any)?.message ?? e));
            }
          }
        } else if (this.strategyFaults.has(strategyId) && (!target || target === strategyId)) {
          this.setStrategyMiningCooldown(strategyId, 60, now, info.reason);
        }
      }
    }
    this.strategyEngine.setStrategies(this.config.strategies);
    this.factorMiningState.datasetHash = result.datasetHash;
    // A limit order belongs to its original factor; never fill it after that factor is retired.
    this.cancelRetiredFactorOrders(now);
    this.scheduleSave();
    if (appliedSides.length > 0) {
      this.notifyMinedFactorsApplied(result, appliedSides, now).catch(e =>
        console.error(`[paper-trading] TG 播报 [应用新因子参数] 失败:`, e)
      );
    }
  }

  private factorOrderAllowed(order: PaperPendingOrder, now: number): boolean {
    if (!this.config.factorMining?.enabled || !order.signalType?.startsWith("kline_stats_")) return true;
    const side = order.signalType === "kline_stats_long" ? "LONG" : "SHORT";
    return this.factorEntryAllowed(side, now) &&
      order.exitParams?.factorRevision === this.factorMiningState.sides[side].active?.revision;
  }

  private cancelRetiredFactorOrders(now: number): void {
    for (const order of this.pendingOrders.values()) {
      if (!this.factorOrderAllowed(order, now)) this.cancelPendingOrder(order.symbol, "因子过期或已更新");
    }
  }

  public getLeverageForSignal(signalType?: PaperSignalType): number {
    const configured = this.config.strategies?.find(s => s.id === signalType)?.exit.leverage;
    if (configured !== undefined) return configured;
    if (signalType === "streak") {
      return this.config.streakLeverage ?? 3;
    }
    if (signalType === "w_bottom_divergence") {
      return this.config.longLeverage ?? 3;
    }
    if (signalType === "kline_stats_long") {
      return this.config.klineStatsLongConfig?.leverage ?? this.config.longLeverage ?? 3;
    }
    if (signalType === "kline_stats_short") {
      return this.config.klineStatsShortConfig?.leverage ?? this.config.klineStatsLeverage ?? 3;
    }
    return this.config.trendLeverage ?? this.config.leverage;
  }

  public countPositionsByStrategy(type?: PaperSignalType): number {
    if (!type) return 0;
    let count = 0;
    for (const p of this.activePositions.values()) {
      if (p.signalType === type) count++;
    }
    for (const o of this.pendingOrders.values()) {
      if (o.signalType === type) count++;
    }
    return count;
  }

  public calculateUsedMargin(): number {
    const activeMargin = Array.from(this.activePositions.values()).reduce((sum, p) => sum + p.marginUsdt, 0);
    const pendingMargin = Array.from(this.pendingOrders.values()).reduce((sum, o) => sum + o.marginUsdt, 0);
    return activeMargin + pendingMargin;
  }

  public calculateOrderMargin(): number {
    const rate = this.config.marginRate ?? (this.config.marginPercent != null ? this.config.marginPercent / 100 : 0.20);
    return orderMargin(this.account.equityUsdt, rate);
  }

  public isStrategyFaulted(strategyId?: string): boolean {
    if (!strategyId) return false;
    return this.strategyFaults.has(strategyId);
  }

  public getStrategyFaults(): StrategyFault[] {
    return Array.from(this.strategyFaults.values());
  }

  public clearStrategyFault(strategyId: string): void {
    if (this.strategyFaults.delete(strategyId)) {
      this.scheduleSave();
    }
  }

  public getNextReadyFaultedStrategy(now = Date.now()): StrategyFault | undefined {
    for (const fault of this.strategyFaults.values()) {
      if (!fault.nextMineAt || now >= fault.nextMineAt) {
        return fault;
      }
    }
    return undefined;
  }

  public setStrategyMiningCooldown(strategyId: string, cooldownMinutes = 60, now = Date.now(), reason?: string): void {
    const fault = this.strategyFaults.get(strategyId);
    if (!fault) return;
    fault.nextMineAt = now + cooldownMinutes * 60_000;
    fault.lastMinedAt = now;
    fault.miningAttempts = (fault.miningAttempts || 0) + 1;
    this.scheduleSave();
    const label = formatSignalLabel(strategyId as PaperSignalType);
    const nextTimeStr = new Date(fault.nextMineAt).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
    console.log(`[paper-trading] ⏸️ 策略 [${label}] 本轮重新挖掘未达标 (${reason ?? "无达标参数"})，进入 ${cooldownMinutes} 分钟冷却期 (至 ${nextTimeStr})`);
    if (telegramConfigured()) {
      const text = `⏸️ <b>策略重新挖掘未达标，进入 ${cooldownMinutes} 分钟冷却</b>: [${escapeHtml(label)}]\n` +
        `• <b>原因</b>: ${escapeHtml(reason ?? fault.reason)}\n` +
        `• <b>状态</b>: 保持停用，暂不开仓\n` +
        `• <b>下次重试</b>: 将于 <b>${nextTimeStr}</b> 再次触发该策略挖掘`;
      sendTelegramMessage(text).catch(e => console.warn("[paper-trading] 发送冷却通知异常:", (e as any)?.message ?? e));
    }
  }

  public stopStrategy(
    strategyId: string,
    reason: string,
    recentTradesCount: number,
    consecutiveLosses: number,
    winRate: number,
    netPnlUsdt: number,
    stoppedAt = Date.now(),
  ): void {
    const fault: StrategyFault = {
      strategyId,
      stoppedAt,
      reason,
      recentTradesCount,
      consecutiveLosses,
      winRate,
      netPnlUsdt,
      nextMineAt: stoppedAt,
      miningAttempts: 0,
    };
    this.strategyFaults.set(strategyId, fault);
    this.scheduleSave();

    for (const order of this.pendingOrders.values()) {
      if (order.signalType === strategyId) {
        this.cancelPendingOrder(order.symbol, "策略表现不佳已停用，等待挖掘新参数");
      }
    }

    const label = formatSignalLabel(strategyId as PaperSignalType);
    console.warn(
      `[paper-trading] 🛑 策略 [${label}] 表现不佳已停用: ${reason}。立即针对该策略触发重新挖掘，若未达标则冷却 60 分钟后重试`,
    );

    if (telegramConfigured()) {
      const text =
        `🛑 <b>策略表现不佳已停用</b>: [${escapeHtml(label)}]\n` +
        `• <b>停用原因</b>: ${escapeHtml(reason)}\n` +
        `• <b>风控处理</b>: 触发停用并<b>立即针对该策略重新挖掘参数</b>\n` +
        `• <b>恢复条件</b>: 挖掘出达标参数后自动更新并解除停用；若未达标则进入 60 分钟冷却`;
      sendTelegramMessage(text).catch((e) =>
        console.warn("[paper-trading] 发送停用通知异常:", (e as any)?.message ?? e),
      );
    }

    this.onStrategyStopped?.(strategyId);
  }

  private checkStrategyHealth(pos: PaperPosition): void {
    const strategyId = pos.signalType ?? "streak";
    if (this.strategyFaults.has(strategyId)) return;

    const stratPositions = this.closedPositions.filter(
      (p) => (p.signalType ?? "streak") === strategyId,
    );
    if (!stratPositions.length) return;

    let consecutiveLosses = 0;
    for (const p of stratPositions) {
      if (p.totalNetPnlUsdt < -0.001) {
        consecutiveLosses++;
      } else {
        break;
      }
    }

    const windowTrades = stratPositions.slice(0, 5);
    const windowCount = windowTrades.length;
    const windowWins = windowTrades.filter((p) => p.totalNetPnlUsdt > 0.001).length;
    const windowWinRate = windowCount > 0 ? (windowWins / windowCount) * 100 : 0;
    const windowNetPnl = windowTrades.reduce((sum, p) => sum + p.totalNetPnlUsdt, 0);

    let faultReason: string | null = null;
    if (consecutiveLosses >= 2) {
      faultReason = `连续亏损 ${consecutiveLosses} 笔 (近 ${windowCount} 笔累计亏损 ${windowNetPnl.toFixed(2)} USDT)`;
    } else if (windowCount >= 3 && windowWinRate < 50 && windowNetPnl < 0) {
      faultReason = `近 ${windowCount} 笔胜率仅 ${windowWinRate.toFixed(1)}% 且净亏损 (${windowNetPnl.toFixed(2)} USDT)`;
    }

    if (faultReason) {
      this.stopStrategy(
        strategyId,
        faultReason,
        windowCount,
        consecutiveLosses,
        windowWinRate,
        windowNetPnl,
      );
    }
  }

  private assertCapacity(symbol: string, signalType: PaperSignalType, now = Date.now()): void {
    if (this.isStrategyFaulted(signalType)) {
      const fault = this.strategyFaults.get(signalType)!;
      throw new Error(`策略 ${signalType} 因表现不佳已停用 (${fault.reason})，等待挖掘新参数`);
    }
    if (["kline_stats_long", "kline_stats_short"].includes(signalType) && !this.factorEntryAllowed(signalType === "kline_stats_long" ? "LONG" : "SHORT", now)) {
      throw new Error("量化因子尚未通过近期验证或已过期，暂停新开仓");
    }
    if (this.activePositions.has(symbol) || this.pendingOrders.has(symbol)) throw new Error(`${symbol} 已有持仓或挂单`);
    if (this.activePositions.size + this.pendingOrders.size >= (this.config.maxPositions ?? 5)) throw new Error("已达全局持仓上限");
    if (this.countPositionsByStrategy(signalType) >= (this.config.maxPositionsPerStrategy ?? 1)) throw new Error("已达单策略持仓上限");
  }

  private assertOrderMargin(margin: number): void {
    const available = Math.min(this.account.balanceUsdt, this.account.equityUsdt) - this.calculateUsedMargin();
    if (!Number.isFinite(margin) || margin <= 0 || margin > this.calculateOrderMargin() + 1e-8 || margin > available + 1e-8) {
      throw new Error("保证金超过单笔仓位比例或可用资金");
    }
  }

  /**
   * 检查 K 线统计量化特征策略入场信号 (做多或做空)
   */
  private paperSignal(match: StrategyMatch) {
    const { strategy: s, monitor } = match;
    const read = (field: string) => Number(monitor.read(field, match.observation)) || 0;
    return { side: s.side, type: s.id, label: s.label, entryPrice: monitor.bar!.close,
      exitParams: { ...s.exit, factorRevision: s.factorManaged && this.config.factorMining?.enabled ? this.factorMiningState.sides[s.side].active?.revision : undefined },
      signalDetails: { candle: monitor.bar!, streakCount: read("streak.0.count"), amp30Percent: read("surge.5"),
        upperShadowRatio: read("upperShadowRatio"), greenRatio: read("greenRatio.30"), consecutiveGreenBars: read("greenStreak") } };
  }

  /** Compatibility entry point; uses the same definition and evaluator as onScan/replay. */
  public checkKlineStatsSignal(side: "SHORT" | "LONG", symbol: string, dayChangePercent: number, rank: number, candles: Candle[], now = Date.now(), ticker?: Ticker24h) {
    if (this.isStrategyFaulted(`kline_stats_${side.toLowerCase()}`)) return null;
    if (!this.factorEntryAllowed(side, now)) return null;
    const monitor = new StrategyFeatureMonitor(candles, { ...ticker, symbol, priceChangePercent: dayChangePercent, lastPrice: candles.at(-2)?.close ?? 0, quoteVolume: ticker?.quoteVolume ?? 0 }, rank);
    const match = this.strategyEngine.evaluate(monitor, now, s => s.id === `kline_stats_${side.toLowerCase()}`)[0];
    return match ? this.paperSignal(match) : null;
  }

  public updateConfig(updates: Partial<PaperStrategyConfig>, options?: { skipNotify?: boolean }): PaperStrategyConfig {
    if (!updates || typeof updates !== "object" || Array.isArray(updates)) throw new Error("配置必须是对象");
    if (updates.factorMining !== undefined) validateFactorMiningConfig(updates.factorMining);
    const nextFactorMining = updates.factorMining === undefined ? undefined
      : normalizeFactorMiningConfig({ ...this.config.factorMining, ...updates.factorMining });
    const proposed = { ...this.config, ...updates };
    for (const key of ["streakConfig", "reboundConfig", "deepReboundConfig", "hourlySuppressionConfig", "wBottomDivergenceConfig", "klineStatsShortConfig", "klineStatsLongConfig"] as const) {
      if (updates[key] !== undefined) {
        if (!updates[key] || typeof updates[key] !== "object" || Array.isArray(updates[key])) throw new Error(`${key} 必须是对象`);
        Object.assign(proposed, { [key]: { ...this.config[key], ...updates[key] } });
      }
    }
    if (updates.ampDivisor !== undefined) proposed.streakConfig = { ...proposed.streakConfig, ampDivisor: updates.streakConfig?.ampDivisor ?? updates.ampDivisor };
    if (updates.supportMaPeriods !== undefined) proposed.streakConfig = { ...proposed.streakConfig, supportMaPeriods: updates.streakConfig?.supportMaPeriods ?? updates.supportMaPeriods };
    const presets = buildStrategyPresets(proposed);
    validateStrategies(presets);
    const nextStrategies = updates.strategies ?? (this.config.strategies ?? presets).map(s => {
      const keys = LEGACY_STRATEGY_KEYS[s.id as keyof typeof LEGACY_STRATEGY_KEYS];
      const changed = keys?.filter(key => updates[key] !== undefined && JSON.stringify(updates[key]) !== JSON.stringify(this.config[key])) ?? [];
      if (!changed.length) return s;
      const preset = presets.find(p => p.id === s.id)!;
      if (changed.some(key => !key.startsWith("enable") && !key.toLowerCase().endsWith("leverage"))) return preset;
      return { ...s, enabled: changed.some(key => key.startsWith("enable")) ? preset.enabled : s.enabled,
        exit: { ...s.exit, leverage: changed.some(key => key.toLowerCase().endsWith("leverage")) ? preset.exit.leverage : s.exit.leverage } };
    });
    validateStrategies(nextStrategies);

    for (const [key, max] of [["marginRate", 0.2], ["marginPercent", 20], ["maxPositions", 5], ["maxPositionsPerStrategy", 1]] as const) {
      const value = updates[key];
      if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > max || (key.startsWith("maxPositions") && !Number.isInteger(value)))) {
        throw new Error(`${key} 必须大于 0 且不超过 ${max}`);
      }
    }
    if (updates.marginUsdt !== undefined && updates.marginRate === undefined && updates.marginPercent === undefined && updates.marginUsdt > this.account.equityUsdt * 0.2) {
      throw new Error("单笔保证金不能超过当前净权益的 20%");
    }
    // Validate the entire patch before mutating any live settings.
    for (const key of ["klineStatsShortConfig", "klineStatsLongConfig"] as const) {
      if (updates[key] !== undefined) {
        validateStrategySpec(updates[key]);
        validateStrategySpec({ ...this.config[key], ...updates[key] });
      }
    }
    if (updates.firstCloseFraction !== undefined && updates.firstCloseFraction !== FIRST_CLOSE_FRACTION) {
      throw new Error("二阶段平仓固定每阶段 50%");
    }
    for (const key of ["takerFeeBps", "slippageBps"] as const) {
      const value = updates[key];
      if (value !== undefined && (!Number.isFinite(value) || value < 0 || value >= 1000)) throw new Error(`${key} 必须在 0 ~ 1000 bps 之间`);
    }
    if (updates.factorMining !== undefined) {
      const previous = this.config.factorMining;
      this.config.factorMining = nextFactorMining!;
      if (this.config.factorMining.enabled) {
        const next = (this.factorMiningState.lastCompletedAt ?? 0) + this.config.factorMining.refreshMinutes * MINUTE_MS;
        this.factorMiningState.nextRunAt = previous?.enabled
          ? Math.min(this.factorMiningState.nextRunAt ?? 0, next) : 0;
      }
      if (!this.config.factorMining.enabled) {
        this.factorMiningState.sides.SHORT = { reason: "因子自动更新已关闭" };
        this.factorMiningState.sides.LONG = { reason: "因子自动更新已关闭" };
      }
    }
    if (typeof updates.leverage === "number" && Number.isFinite(updates.leverage) && updates.leverage >= 1 && updates.leverage <= 100) {
      this.config.leverage = updates.leverage;
    }
    if (typeof updates.streakLeverage === "number" && Number.isFinite(updates.streakLeverage) && updates.streakLeverage >= 1 && updates.streakLeverage <= 100) {
      this.config.streakLeverage = updates.streakLeverage;
    }
    if (typeof updates.trendLeverage === "number" && Number.isFinite(updates.trendLeverage) && updates.trendLeverage >= 1 && updates.trendLeverage <= 100) {
      this.config.trendLeverage = updates.trendLeverage;
    }
    if (typeof updates.longLeverage === "number" && Number.isFinite(updates.longLeverage) && updates.longLeverage >= 1 && updates.longLeverage <= 100) {
      this.config.longLeverage = updates.longLeverage;
    }
    if (typeof updates.klineStatsLeverage === "number" && Number.isFinite(updates.klineStatsLeverage) && updates.klineStatsLeverage >= 1 && updates.klineStatsLeverage <= 100) {
      this.config.klineStatsLeverage = updates.klineStatsLeverage;
    }
    if (typeof updates.marginRate === "number" && Number.isFinite(updates.marginRate) && updates.marginRate > 0 && updates.marginRate <= 1) {
      this.config.marginRate = updates.marginRate;
      this.config.marginPercent = Math.round(updates.marginRate * 100);
    }
    if (typeof updates.marginPercent === "number" && Number.isFinite(updates.marginPercent) && updates.marginPercent > 0 && updates.marginPercent <= 100) {
      this.config.marginPercent = updates.marginPercent;
      this.config.marginRate = updates.marginPercent / 100;
    }
    if (typeof updates.maxPositions === "number" && Number.isFinite(updates.maxPositions) && updates.maxPositions >= 1) {
      this.config.maxPositions = Math.floor(updates.maxPositions);
    }
    if (typeof updates.maxPositionsPerStrategy === "number" && Number.isFinite(updates.maxPositionsPerStrategy) && updates.maxPositionsPerStrategy >= 1) {
      this.config.maxPositionsPerStrategy = Math.floor(updates.maxPositionsPerStrategy);
    }
    if (typeof updates.marginUsdt === "number" && Number.isFinite(updates.marginUsdt) && updates.marginUsdt > 0) {
      this.config.marginUsdt = updates.marginUsdt;
      if (updates.marginRate === undefined && updates.marginPercent === undefined) {
        const totalAssets = Math.max(1, this.account.equityUsdt > 0 ? this.account.equityUsdt : this.account.balanceUsdt);
        this.config.marginRate = updates.marginUsdt / totalAssets;
        this.config.marginPercent = (updates.marginUsdt / totalAssets) * 100;
      }
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
    if (typeof updates.stopAtLow === "boolean") {
      this.config.stopAtLow = updates.stopAtLow;
    }
    if (typeof updates.enableStreak === "boolean") {
      this.config.enableStreak = updates.enableStreak;
    }
    if (typeof updates.enableRebound === "boolean") {
      this.config.enableRebound = updates.enableRebound;
    }
    if (typeof updates.enableDeepRebound === "boolean") {
      this.config.enableDeepRebound = updates.enableDeepRebound;
    }
    if (typeof updates.enableHourlySuppression === "boolean") {
      this.config.enableHourlySuppression = updates.enableHourlySuppression;
    }
    if (typeof updates.enableLongs === "boolean") {
      this.config.enableLongs = updates.enableLongs;
    }
    if (typeof updates.enableWBottomDivergence === "boolean") {
      this.config.enableWBottomDivergence = updates.enableWBottomDivergence;
    }
    if (typeof updates.enableKlineStatsShort === "boolean") {
      this.config.enableKlineStatsShort = updates.enableKlineStatsShort;
    }
    if (typeof updates.enableKlineStatsLong === "boolean") {
      this.config.enableKlineStatsLong = updates.enableKlineStatsLong;
    }
    if (typeof updates.topN === "number" && Number.isFinite(updates.topN) && updates.topN >= 1) {
      this.config.topN = Math.floor(updates.topN);
    }
    if (typeof updates.ampDivisor === "number" && Number.isFinite(updates.ampDivisor) && updates.ampDivisor > 0) {
      this.config.ampDivisor = updates.ampDivisor;
      if (this.config.streakConfig) {
        this.config.streakConfig = { ...this.config.streakConfig, ampDivisor: updates.ampDivisor };
      }
    }
    if (Array.isArray(updates.supportMaPeriods) && updates.supportMaPeriods.every((p) => typeof p === "number" && p > 0)) {
      this.config.supportMaPeriods = [...updates.supportMaPeriods];
      if (this.config.streakConfig) {
        this.config.streakConfig = { ...this.config.streakConfig, supportMaPeriods: this.config.supportMaPeriods };
      }
    }
    if (typeof updates.minStreakCount === "number" && Number.isFinite(updates.minStreakCount) && updates.minStreakCount >= 1) {
      this.config.minStreakCount = Math.floor(updates.minStreakCount);
    }
    if (typeof updates.minUpperShadowRatio === "number" && Number.isFinite(updates.minUpperShadowRatio)) {
      this.config.minUpperShadowRatio = updates.minUpperShadowRatio;
    }
    if (typeof updates.maxUpperShadowRatio === "number" && Number.isFinite(updates.maxUpperShadowRatio)) {
      this.config.maxUpperShadowRatio = updates.maxUpperShadowRatio;
    }
    if (typeof updates.greenWindow === "number" && Number.isFinite(updates.greenWindow) && updates.greenWindow > 0) {
      this.config.greenWindow = Math.floor(updates.greenWindow);
    }
    if (typeof updates.minGreenRatio === "number" && Number.isFinite(updates.minGreenRatio) && updates.minGreenRatio >= 0 && updates.minGreenRatio <= 1) {
      this.config.minGreenRatio = updates.minGreenRatio;
    }
    if (typeof updates.minConsecutiveGreenBars === "number" && Number.isFinite(updates.minConsecutiveGreenBars) && updates.minConsecutiveGreenBars >= 0) {
      this.config.minConsecutiveGreenBars = Math.floor(updates.minConsecutiveGreenBars);
    }
    if (typeof updates.holdMinutes === "number" && Number.isFinite(updates.holdMinutes) && updates.holdMinutes > 0) {
      this.config.holdMinutes = updates.holdMinutes;
    }
    if (typeof updates.exitX === "number" && Number.isFinite(updates.exitX) && updates.exitX > 0) {
      this.config.exitX = updates.exitX;
    }
    if (typeof updates.exitN === "number" && Number.isFinite(updates.exitN) && updates.exitN > 0) {
      this.config.exitN = updates.exitN;
    }
    if (typeof updates.exitM === "number" && Number.isFinite(updates.exitM) && updates.exitM > 0) {
      this.config.exitM = updates.exitM;
    }
    if (typeof updates.firstCloseFraction === "number" && Number.isFinite(updates.firstCloseFraction) && updates.firstCloseFraction > 0 && updates.firstCloseFraction <= 1) {
      this.config.firstCloseFraction = FIRST_CLOSE_FRACTION;
    }
    if (typeof updates.takerFeeBps === "number" && Number.isFinite(updates.takerFeeBps)) {
      this.config.takerFeeBps = updates.takerFeeBps;
    }
    if (typeof updates.slippageBps === "number" && Number.isFinite(updates.slippageBps)) {
      this.config.slippageBps = updates.slippageBps;
    }
    if (updates.streakConfig && typeof updates.streakConfig === "object") {
      this.config.streakConfig = { ...this.config.streakConfig, ...updates.streakConfig };
    }
    if (updates.reboundConfig && typeof updates.reboundConfig === "object") {
      this.config.reboundConfig = { ...this.config.reboundConfig, ...updates.reboundConfig };
    }
    if (updates.deepReboundConfig && typeof updates.deepReboundConfig === "object") {
      this.config.deepReboundConfig = { ...this.config.deepReboundConfig, ...updates.deepReboundConfig };
    }
    if (updates.hourlySuppressionConfig && typeof updates.hourlySuppressionConfig === "object") {
      this.config.hourlySuppressionConfig = { ...this.config.hourlySuppressionConfig, ...updates.hourlySuppressionConfig };
    }
    if (updates.wBottomDivergenceConfig && typeof updates.wBottomDivergenceConfig === "object") {
      this.config.wBottomDivergenceConfig = { ...this.config.wBottomDivergenceConfig, ...updates.wBottomDivergenceConfig };
    }
    if (updates.klineStatsShortConfig && typeof updates.klineStatsShortConfig === "object") {
      this.config.klineStatsShortConfig = {
        ...this.config.klineStatsShortConfig,
        ...updates.klineStatsShortConfig,
      };
      if (this.factorMiningState?.sides?.SHORT?.active &&
          factorConfigKey(this.factorMiningState.sides.SHORT.active.config) !== factorConfigKey(this.config.klineStatsShortConfig)) {
        this.factorMiningState.sides.SHORT = { reason: "手动修改参数，等待重新验证" };
      }
    }
    if (updates.klineStatsLongConfig && typeof updates.klineStatsLongConfig === "object") {
      this.config.klineStatsLongConfig = {
        ...this.config.klineStatsLongConfig,
        ...updates.klineStatsLongConfig,
      };
      if (this.factorMiningState?.sides?.LONG?.active &&
          factorConfigKey(this.factorMiningState.sides.LONG.active.config) !== factorConfigKey(this.config.klineStatsLongConfig)) {
        this.factorMiningState.sides.LONG = { reason: "手动修改参数，等待重新验证" };
      }
    }

    this.config.strategies = structuredClone(nextStrategies);
    this.strategyEngine.setStrategies(nextStrategies);
    // Keep old clients' switches in sync with the canonical list.
    for (const [id, keys] of Object.entries(LEGACY_STRATEGY_KEYS)) {
      const enabledKey = keys.find(key => key.startsWith("enable"))!;
      Object.assign(this.config, { [enabledKey]: nextStrategies.find(s => s.id === id)?.enabled ?? false });
    }
    this.cancelRetiredFactorOrders(Date.now());
    const currentMargin = this.calculateOrderMargin();
    console.log(
      `[paper-trading] ⚙️ 配置已通过 API 动态更新: 新高闪击杠杆 ${this.config.streakLeverage ?? 3}x, 顺势波段杠杆 ${this.config.trendLeverage ?? this.config.leverage}x, 量化特征杠杆 ${this.config.klineStatsLeverage ?? 3}x, 做多杠杆 ${this.config.longLeverage ?? 3}x, 仓位比例 ${((this.config.marginRate ?? 0.2) * 100).toFixed(0)}% (约 ${currentMargin.toFixed(1)}U), 最大持仓 ${this.config.maxPositions ?? 5} 笔 (每策略 ${this.config.maxPositionsPerStrategy ?? 1} 笔), ampDivisor=${this.config.ampDivisor ?? 10}`,
    );

    this.scheduleSave();
    if (!options?.skipNotify) {
      this.notifyManualConfigApplied(updates).catch(e =>
        console.error(`[paper-trading] TG 播报 [手动应用策略参数] 失败:`, e)
      );
    }
    return this.getConfig();
  }

  public getAccount(): PaperAccount {
    return { ...this.account };
  }

  public getWatchedSymbols(): string[] { return this.strategyEngine.getWatchedSymbols(); }

  public getActiveSymbols(): string[] {
    return Array.from(new Set([...this.activePositions.keys(), ...this.pendingOrders.keys(), ...this.getWatchedSymbols()]));
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
    marginUsdt?: number;
    signal: SignalMatchDetails;
    signalType?: PaperSignalType;
    signalLabel?: PaperSignalLabel;
    exitParams?: PaperExitParams;
    now?: number;
  }): PaperPendingOrder {
    const { symbol, dayChangePercent, rank, basePrice, signal, exitParams } = params;
    const now = params.now ?? Date.now();
    this.assertCapacity(symbol, params.signalType ?? "streak", now);
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
    const marginUsdt = params.marginUsdt ?? this.calculateOrderMargin();
    this.assertOrderMargin(marginUsdt);
    const notionalUsdt = marginUsdt * leverage;

    const order: PaperPendingOrder = {
      id: `pending-${symbol}-${now}`,
      symbol,
      side: "SHORT",
      leverage,
      marginUsdt,
      notionalUsdt,
      signalType,
      signalLabel,
      exitParams: {
        ...(exitParams ?? {
          holdMinutes: this.config.holdMinutes,
          exitX: this.config.exitX,
          exitN: this.config.exitN,
          exitM: this.config.exitM,
        }),
        factorRevision: exitParams?.factorRevision ?? (this.config.factorMining?.enabled && signalType === "kline_stats_short"
          ? this.factorMiningState.sides.SHORT.active?.revision : undefined),
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
    this.recalculateStats();
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

    this.recalculateStats();
    this.scheduleSave();
    console.log(`[paper-trading] ⏱️ 撤销限价挂单 [${order.signalLabel ?? (order.side === "LONG" ? "做多" : "做空")}] ${symbol} @ ${order.limitPrice.toFixed(4)}: ${reason}`);
  }

  /**
   * Called on every scan/refresh at candle close.
   * Scans gainers for entry signals using 4 Core Strategies:
   * 3 Shorts: 首次跌10%弱反弹, 跌20%+次级反弹, 新高顶背离闪击
   * 1 Long: 左侧3W底背离弹射
   */
  public async onScan(
    gainers: Ticker24h[],
    candleMap: Map<string, { candles1m: Candle[]; initialized: boolean }>,
    ranks?: ReadonlyMap<string, number>,
  ): Promise<PaperPosition[]> {
    const openedList: PaperPosition[] = [];
    const now = Date.now();
    this.checkTimeouts(now);
    this.strategyMonitor = [];
    const candidates = gainers.filter(t => !["BTCUSDT", "SOLUSDT"].includes(t.symbol));
    const seen = new Set<string>();
    for (let i = 0; i < candidates.length; i++) {
      const ticker = candidates[i], rank = ranks?.get(ticker.symbol) ?? i + 1;
      if (seen.has(ticker.symbol)) continue;
      seen.add(ticker.symbol);
      this.strategyEngine.onRank(ticker.symbol, rank, ticker.priceChangePercent, now);
      const cache = candleMap.get(ticker.symbol);
      if (!cache?.initialized) continue;
      const monitor = new StrategyFeatureMonitor(cache.candles1m, ticker, rank);
      const margin = this.calculateOrderMargin();
      const available = Math.min(this.account.balanceUsdt, this.account.equityUsdt) - this.calculateUsedMargin();
      const capacity = !this.hasActivePosition(ticker.symbol) && !this.hasPendingOrder(ticker.symbol) &&
        this.activePositions.size + this.pendingOrders.size < (this.config.maxPositions ?? 5) && margin > 0 && available >= margin;
      const match = this.strategyEngine.evaluate(monitor, now, s => capacity &&
        (s.side !== "LONG" || this.config.enableLongs !== false) &&
        !this.isStrategyFaulted(s.id) &&
        this.countPositionsByStrategy(s.id) < (this.config.maxPositionsPerStrategy ?? 1) &&
        (!s.factorManaged || this.factorEntryAllowed(s.side, now)))[0];
      this.strategyMonitor.push(...this.strategyEngine.getResults());
      if (!match) continue;
      const chosen = this.paperSignal(match);
      const forming = cache.candles1m.at(-1);
      const basePrice = forming && forming.close > 0 ? forming.close : chosen.entryPrice;
      if (chosen.side === "SHORT" && this.config.limitDivisor > 0) {
        this.createPendingOrder({ symbol: ticker.symbol, dayChangePercent: ticker.priceChangePercent, rank, basePrice, marginUsdt: margin,
          signal: chosen.signalDetails, signalType: chosen.type, signalLabel: chosen.label, exitParams: chosen.exitParams, now });
      } else {
        openedList.push(this.openPosition({ symbol: ticker.symbol, side: chosen.side, dayChangePercent: ticker.priceChangePercent, rank,
          entryPrice: basePrice, entryTime: now, marginUsdt: margin, signal: chosen.signalDetails, signalType: chosen.type, signalLabel: chosen.label, exitParams: chosen.exitParams }));
      }
      // Only accepted entries/orders consume a signal or start its cooldown.
      this.strategyEngine.commit(match, now);
      const vector = monitor.vector;
      if (vector) void appendSignalSnapshot({ time: monitor.bar!.time, symbol: ticker.symbol, type: chosen.type, side: chosen.side,
        triggered: true, featureVector: vector, ticker, configVersion: FEATURE_VERSION, strategy: match.strategy, monitoredFeatures: monitor.snapshot() });
    }
    this.scheduleSave();
    return openedList;
  }

  public openPosition(params: {
    symbol: string;
    side?: "SHORT" | "LONG";
    dayChangePercent: number;
    rank?: number | null;
    entryPrice: number;
    entryTime: number;
    limitPrice?: number;
    marginUsdt?: number;
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

    const signalType = params.signalType ?? "streak";
    const isLong = (params.side ?? (signalType === "w_bottom_divergence" || signalType === "kline_stats_long" ? "LONG" : "SHORT")) === "LONG";
    this.assertCapacity(symbol, signalType, entryTime);
    const side: "SHORT" | "LONG" = isLong ? "LONG" : "SHORT";

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

    // Direction-aware price levels:
    let tp1Price: number;
    let sl1Price: number;
    let sl2Price: number;
    let tp2Price: number;

    if (isLong) {
      // Long: Target above entry, Stop below entry
      tp1Price = entryPrice * (1 + tp1Percent / 100);
      sl1Price = entryPrice * (1 - sl1Percent / 100);
      sl2Price = entryPrice * (1 - sl2Percent / 100);
      tp2Price = entryPrice * (1 + tp2Percent / 100);
    } else {
      // Short: Target below entry, Stop above entry
      tp1Price = entryPrice * (1 - tp1Percent / 100);
      sl1Price = entryPrice * (1 + sl1Percent / 100);
      sl2Price = entryPrice * (1 + sl2Percent / 100);
      tp2Price = entryPrice * (1 - tp2Percent / 100);
    }

    const timeoutAt = entryTime + holdMinutes * 60 * 1000;

    const signalLabel = formatSignalLabel(signalType, params.signalLabel);
    const leverage = params.leverage ?? exitParams?.leverage ?? this.getLeverageForSignal(signalType);
    const marginUsdt = params.marginUsdt ?? this.calculateOrderMargin();
    this.assertOrderMargin(marginUsdt);
    const notionalUsdt = marginUsdt * leverage;

    const position: PaperPosition = {
      id: `${symbol}-${entryTime}`,
      symbol,
      side,
      leverage,
      marginUsdt,
      notionalUsdt,
      status: "OPEN",
      signalType,
      signalLabel,
      exitParams: {
        holdMinutes,
        factorRevision: exitParams?.factorRevision ?? (this.config.factorMining?.enabled && signalType.startsWith("kline_stats_")
          ? this.factorMiningState.sides[side].active?.revision : undefined),
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
    this.recalculateStats();
    this.scheduleSave();
    for (const listener of this.entryListeners) {
      try { listener(structuredClone(position)); }
      catch { console.warn("[paper-trading] 新开仓监听器异常，模拟盘继续运行"); }
    }

    // Broadcast Telegram entry notification
    this.notifyEntry(position).catch((e) =>
      console.warn(`[paper-trading] 发送开仓通知异常:`, (e as any)?.message ?? e),
    );

    const isLimit = limitPrice != null;
    const actionLabel = isLong
      ? (isLimit ? "限价挂单成交做多" : "市价开多")
      : (isLimit ? "限价挂单成交做空" : "市价开空");
    console.log(
      `[paper-trading] ⚡ ${actionLabel} [${signalLabel}] ${symbol} @ ${entryPrice.toFixed(4)} ` +
      `(${leverage}x, 保证金 ${position.marginUsdt.toFixed(1)} USDT, 24h: +${dayChangePercent.toFixed(2)}%, 30m振幅: ${signal.amp30Percent.toFixed(2)}%) ` +
      `TP1: ${tp1Price.toFixed(4)} SL1: ${sl1Price.toFixed(4)} SL2: ${sl2Price.toFixed(4)} TP2: ${tp2Price.toFixed(4)} 持仓: ${holdMinutes}m`,
    );

    return position;
  }

  /**
   * Real-time trade tick processing.
   * Evaluates pending limit orders, take-profit, stop-loss and timeouts in milliseconds.
   */
  public onTick(tick: TradeTick, currentCandleHigh?: number, currentCandleLow?: number): void {
    // 0. 优先撮合限价做空/做多挂单
    const pending = this.pendingOrders.get(tick.symbol);
    if (pending) {
      pending.currentPrice = tick.price;
      // 挂单超时
      if (!this.factorOrderAllowed(pending, Math.max(Date.now(), tick.time))) {
        this.cancelPendingOrder(pending.symbol, "因子过期或已更新");
      } else if (tick.time >= pending.expireAt) {
        this.cancelPendingOrder(pending.symbol, "超时未触碰撤销");
      }
      // 价格直接下杀跌破预估TP1（做空行情已走完，撤单）
      else if (pending.side === "SHORT" && pending.cancelBelowPrice && tick.price <= pending.cancelBelowPrice) {
        this.cancelPendingOrder(pending.symbol, "行情已直接下行提前撤单");
      }
      // 价格向上冲高打到做空限价挂单：撮合成交！
      else if (pending.side === "SHORT" && tick.price >= pending.limitPrice) {
        const maxPerStrategy = this.config.maxPositionsPerStrategy ?? 1;
        const availableAfterRelease = Math.min(this.account.balanceUsdt, this.account.equityUsdt) - this.calculateUsedMargin() + pending.marginUsdt;
        if (this.activePositions.size >= (this.config.maxPositions ?? 5) || this.countPositionsByStrategy(pending.signalType) > maxPerStrategy || pending.marginUsdt > this.calculateOrderMargin() + 1e-8 || pending.marginUsdt > availableAfterRelease + 1e-8) {
          this.cancelPendingOrder(pending.symbol, "配置更新后持仓额度不足");
          return;
        }
        this.pendingOrders.delete(pending.symbol);
        console.log(
          `[paper-trading] 🎯 挂单成交！[${pending.signalLabel ?? "做空"}] ${pending.symbol} 触及做空限价 @ ${pending.limitPrice.toFixed(4)} (成交Tick: ${tick.price.toFixed(4)})`,
        );
        this.openPosition({
          symbol: pending.symbol,
          side: "SHORT",
          dayChangePercent: pending.dayChangePercent,
          rank: pending.rank,
          entryPrice: pending.limitPrice,
          entryTime: tick.time,
          limitPrice: pending.limitPrice,
          marginUsdt: pending.marginUsdt,
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
    // 确保撮合时间戳不小于开仓时间戳，规避本地服务器与币安撮合时钟的微小毫秒偏差
    const time = Math.max(tick.time, position.entryTime);
    position.currentPrice = price;

    // 1. Check timeout
    if (time >= position.timeoutAt) {
      this.closeRemaining(position, price, time, "timeout");
      return;
    }

    const isLong = position.side === "LONG";

    if (isLong) {
      // ---- 做多撮合逻辑 (LONG) ----
      // 2. Check Stage 1 if remainingFraction == 1.0
      if (position.remainingFraction === 1.0) {
        if (price >= position.tp1Price) {
          const dualTarget = price >= position.tp2Price;
          this.closeStage(position, 1, position.tp1Price, time, "target", dualTarget);
          if (dualTarget) {
            this.closeStage(position, 2, position.tp2Price, time, "target");
          }
          return;
        } else if (price <= position.sl1Price) {
          const exitPrice1 = (this.config.stopAtLow ?? true)
            ? Math.min(price, currentCandleLow ?? price, position.sl1Price)
            : position.sl1Price;
          const dualStop = price <= position.sl2Price;
          this.closeStage(position, 1, exitPrice1, time, "stop", dualStop);
          if (dualStop) {
            const exitPrice2 = (this.config.stopAtLow ?? true)
              ? Math.min(price, currentCandleLow ?? price, position.sl2Price)
              : position.sl2Price;
            this.closeStage(position, 2, exitPrice2, time, "stop");
          }
          return;
        }
      }

      // 3. Check Stage 2 if remainingFraction == 0.5
      if (position.remainingFraction > 0 && position.remainingFraction < 1) {
        if (price >= position.tp2Price) {
          this.closeStage(position, 2, position.tp2Price, time, "target");
          return;
        } else if (price <= position.sl2Price) {
          const exitPrice = (this.config.stopAtLow ?? true)
            ? Math.min(price, currentCandleLow ?? price, position.sl2Price)
            : position.sl2Price;
          this.closeStage(position, 2, exitPrice, time, "stop");
          return;
        }
      }
    } else {
      // ---- 做空撮合逻辑 (SHORT) ----
      // 2. Check Stage 1 if remainingFraction == 1.0
      if (position.remainingFraction === 1.0) {
        if (price <= position.tp1Price) {
          const dualTarget = price <= position.tp2Price;
          this.closeStage(position, 1, position.tp1Price, time, "target", dualTarget);
          if (dualTarget) {
            this.closeStage(position, 2, position.tp2Price, time, "target");
          }
          return;
        } else if (price >= position.sl1Price) {
          const exitPrice1 = this.config.stopAtHigh
            ? Math.max(price, currentCandleHigh ?? price, position.sl1Price)
            : position.sl1Price;
          const dualStop = price >= position.sl2Price;
          this.closeStage(position, 1, exitPrice1, time, "stop", dualStop);
          if (dualStop) {
            const exitPrice2 = this.config.stopAtHigh
              ? Math.max(price, currentCandleHigh ?? price, position.sl2Price)
              : position.sl2Price;
            this.closeStage(position, 2, exitPrice2, time, "stop");
          }
          return;
        }
      }

      // 3. Check Stage 2 if remainingFraction == 0.5
      if (position.remainingFraction > 0 && position.remainingFraction < 1) {
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
    }

    // 4. Update unrealized PnL
    this.updateUnrealizedPnl(position, price);
  }

  /**
   * Sweeps all pending orders and active positions for timeout.
   */
  public checkTimeouts(now = Date.now()): void {
    this.cancelRetiredFactorOrders(now);
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
    const isLong = pos.side === "LONG";
    const grossPnl = isLong
      ? stageNotional * ((currentPrice - pos.entryPrice) / pos.entryPrice)
      : stageNotional * ((pos.entryPrice - currentPrice) / pos.entryPrice);
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
    skipNotify = false,
  ): PaperExit {
    const safeExitTime = Math.max(exitTime, pos.entryTime);
    const fraction = stage === 1 ? FIRST_CLOSE_FRACTION : pos.remainingFraction;
    const stageNotional = pos.notionalUsdt * fraction;

    const ret = calcTradeReturn(pos.side, pos.entryPrice, exitPrice, this.config);
    const grossPnlUsdt = stageNotional * ret.grossPercent / 100;
    const feeUsdt = stageNotional * ret.feePercent / 100;
    const slippageUsdt = stageNotional * ret.slippagePercent / 100;
    const netPnlUsdt = stageNotional * ret.netPercent / 100;
    const netPercent = ret.netPercent;

    const exit: PaperExit = {
      stage,
      fraction,
      exitTime: safeExitTime,
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

      // 阶段一止盈达成后，若开启保本机制，将剩余仓位止损移动至入场保本价 (覆盖手续费)
      if (reason === "target" && pos.moveSlToEntryAfterTp1 !== false) {
        pos.sl2Price = breakevenPrice(pos.side, pos.entryPrice, this.config);
        pos.sl2Percent = Math.abs(pos.sl2Price / pos.entryPrice - 1) * 100;
        pos.isBreakevenArmed = true;
        console.log(
          `[paper-trading] 🛡️ ${pos.symbol} 阶段一止盈达成，剩余仓位止损已锁定保本价 @ ${formatPrice(pos.sl2Price)}`,
        );
      }

      this.updateUnrealizedPnl(pos, exitPrice);

      if (!skipNotify) {
        this.notifyStage1(pos, exit).catch((e) =>
          console.warn(`[paper-trading] 发送阶段一平仓通知异常:`, (e as any)?.message ?? e),
        );
      }

      console.log(
        `[paper-trading] 🎯 ${pos.symbol} 阶段一完成 (${reason}) @ ${formatPrice(exitPrice)} | ` +
        `阶段净盈亏: ${netPnlUsdt >= 0 ? "+" : ""}${netPnlUsdt.toFixed(2)} USDT (ROE: ${pos.roePercent >= 0 ? "+" : ""}${pos.roePercent.toFixed(1)}%)`,
      );
    } else {
      pos.remainingFraction = 0;
      pos.status = "CLOSED";
      pos.closedAt = safeExitTime;
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
      this.closeStage(pos, 1, exitPrice, exitTime, reason, true);
      this.closeStage(pos, 2, exitPrice, exitTime, reason);
    } else {
      // Stage 2 closes
      this.closeStage(pos, 2, exitPrice, exitTime, reason);
    }
  }

  private finalizePosition(pos: PaperPosition): void {
    this.activePositions.delete(pos.symbol);
    this.strategyEngine.recordExit(pos.signalType ?? "streak", pos.symbol, pos.closedAt ?? Date.now());
    this.closedPositions.unshift(pos);
    // 默认保留最近 1000 笔平仓明细，确保至少完整保留 24 小时内的所有交易记录
    if (this.closedPositions.length > 1000) {
      this.closedPositions.length = 1000;
    }

    // Add realized profit to cash balance
    this.account.balanceUsdt += pos.totalNetPnlUsdt;
    this.recalculateStats();
    this.checkStrategyHealth(pos);

    this.notifyFinal(pos).catch((e) =>
      console.warn(`[paper-trading] 发送结清通知异常:`, (e as any)?.message ?? e),
    );

    const label = formatSignalLabel(pos.signalType, pos.signalLabel);
    console.log(
      `[paper-trading] 🏆 ${pos.symbol} [${label}] 订单结清 (${pos.finalReason}) | ` +
      `整单净盈亏: ${pos.totalNetPnlUsdt >= 0 ? "+" : ""}${pos.totalNetPnlUsdt.toFixed(2)} USDT (ROE: ${pos.roePercent >= 0 ? "+" : ""}${pos.roePercent.toFixed(1)}%) | ` +
      `做多胜率: ${this.stats.bySide.LONG.winRate.toFixed(1)}% / 做空胜率: ${this.stats.bySide.SHORT.winRate.toFixed(1)}% | 账户最新余额: ${this.account.balanceUsdt.toFixed(2)} USDT`,
    );
  }

  public getClosedPositions24h(): PaperPosition[] {
    const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
    return this.closedPositions.filter((p) => (p.closedAt ?? p.entryTime) >= cutoff24h);
  }

  public getStats24h(): PaperTradingStats {
    this.stats24h = this.computeStatsForPositions(this.getClosedPositions24h());
    return { ...this.stats24h };
  }

  private computeStatsForPositions(positions: PaperPosition[]): PaperTradingStats {
    const totalTrades = positions.length;
    let winningTrades = 0;
    let losingTrades = 0;
    let breakevenTrades = 0;
    let totalNetPnlUsdt = 0;
    let grossGainsUsdt = 0;
    let grossLossesUsdt = 0;

    for (const p of positions) {
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

    let totalUnrealized = 0;
    for (const p of this.activePositions.values()) {
      totalUnrealized += p.totalNetPnlUsdt;
    }
    const equity = this.account ? this.account.balanceUsdt + totalUnrealized : this.config.initialBalanceUsdt;
    const totalPnl = equity - this.config.initialBalanceUsdt;
    const accountRoiPercent =
      this.config.initialBalanceUsdt > 0
        ? (totalPnl / this.config.initialBalanceUsdt) * 100
        : 0;

    return {
      initialBalanceUsdt: this.config.initialBalanceUsdt,
      balanceUsdt: this.account?.balanceUsdt ?? this.config.initialBalanceUsdt,
      equityUsdt: equity,
      accountRoiPercent,
      bySide: summarizeDirections(positions),
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

  private recalculateStats(): void {
    // 1. 全量历史统计
    this.stats = this.computeStatsForPositions(this.closedPositions);

    // 2. 过去 24 小时滚动窗口统计
    this.stats24h = this.computeStatsForPositions(this.getClosedPositions24h());

    // 3. 账户净值与可用保证金计算
    let totalUnrealized = 0;
    for (const p of this.activePositions.values()) {
      totalUnrealized += p.totalNetPnlUsdt;
    }
    const usedMargin = Array.from(this.activePositions.values()).reduce((sum, p) => sum + p.marginUsdt, 0);
    const pendingMargin = Array.from(this.pendingOrders.values()).reduce((sum, o) => sum + o.marginUsdt, 0);
    const equity = this.account.balanceUsdt + totalUnrealized;
    const availableMargin = Math.max(0, Math.min(this.account.balanceUsdt, equity) - usedMargin - pendingMargin);
    const totalPnl = equity - this.account.initialBalanceUsdt;
    const accountRoiPercent =
      this.account.initialBalanceUsdt > 0
        ? (totalPnl / this.account.initialBalanceUsdt) * 100
        : 0;

    this.account = {
      initialBalanceUsdt: this.config.initialBalanceUsdt,
      balanceUsdt: this.account.balanceUsdt,
      equityUsdt: equity,
      usedMarginUsdt: usedMargin + pendingMargin,
      availableMarginUsdt: availableMargin,
      totalPnlUsdt: totalPnl,
      accountRoiPercent,
    };
  }

  // --- Telegram Alerts ---
  private async sendTg(text: string, title: string): Promise<void> {
    if (!telegramConfigured()) {
      return;
    }
    const res = await sendTelegramMessage(text);
    if (!res.ok) {
      console.error(`[paper-trading] TG 播报 [${title}] 发送失败: ${res.error}`);
    } else {
      console.log(`[paper-trading] TG 播报 [${title}] 发送成功`);
    }
  }

  private async notifyPendingOrder(order: PaperPendingOrder): Promise<void> {
    const rankStr = order.rank ? `(#${order.rank})` : "";
    const label = formatSignalLabel(order.signalType, order.signalLabel);
    const ampStr = order.amp30Percent != null ? `${order.amp30Percent.toFixed(2)}%` : "-";
    const dirStr = order.side === "LONG" ? "做多" : "做空";
    const msg =
      `⏳ <b>[模拟交易] 发现${dirStr}信号【${label}】，已提交限价${dirStr}挂单</b>\n` +
      `• <b>标的</b>: <a href="https://www.binance.com/zh-CN/futures/${order.symbol}"><b>${order.symbol}</b></a>\n` +
      `• <b>信号类型</b>: <b>【${formatDirectionAndSignal(dirStr, label)}】</b>\n` +
      `• <b>挂单限价</b>: <code>${formatPrice(order.limitPrice)}</code> (基准价: <code>${formatPrice(order.basePrice)}</code>, 偏移: <b>${order.limitOffsetPercent >= 0 ? "+" : ""}${order.limitOffsetPercent.toFixed(2)}%</b>)\n` +
      `• <b>杠杆 / 保证金</b>: <b>${order.leverage}x / ${order.marginUsdt.toFixed(1)} USDT</b> (名义仓位: ${order.notionalUsdt.toFixed(1)} USDT)\n` +
      `• <b>24h涨幅</b>: +${order.dayChangePercent.toFixed(2)}% ${rankStr} | <b>30m振幅</b>: ${ampStr}\n` +
      `• <b>撮合机制</b>: 触及挂单价即撮合成交 (有效期 ${this.config.limitExpireMinutes}分钟，未触碰或提前反向自动撤单)`;
    await this.sendTg(msg, `挂单提交 ${order.symbol}`);
  }

  private async notifyEntry(pos: PaperPosition): Promise<void> {
    const rankStr = pos.rank ? `(#${pos.rank})` : "";
    const isLimit = pos.limitPrice != null;
    const label = formatSignalLabel(pos.signalType, pos.signalLabel);
    const holdMin = pos.exitParams?.holdMinutes ?? this.config.holdMinutes;
    const ampStr = pos.amp30Percent != null ? `${pos.amp30Percent.toFixed(2)}%` : "-";
    const isLong = pos.side === "LONG";
    const dirStr = isLong ? "做多" : "做空";
    const actionStr = isLong
      ? (isLimit ? "限价挂单撮合成交做多" : "发现做多信号，市价开多")
      : (isLimit ? "限价挂单冲高撮合成交做空" : "发现做空信号，市价开空");
    const tp1Sign = isLong ? "+" : "-";
    const sl1Sign = isLong ? "-" : "+";
    const tp2Sign = isLong ? "+" : "-";
    const sl2Sign = isLong ? "-" : "+";

    const msg =
      `⚡ <b>[模拟交易] ${actionStr}【${label}】</b>\n` +
      `• <b>标的</b>: <a href="https://www.binance.com/zh-CN/futures/${pos.symbol}"><b>${pos.symbol}</b></a>\n` +
      `• <b>方向 / 信号</b>: <b>【${formatDirectionAndSignal(dirStr, label)}】</b>\n` +
      `• <b>杠杆 / 保证金</b>: <b>${pos.leverage}x / ${pos.marginUsdt.toFixed(1)} USDT</b> (名义仓位: ${pos.notionalUsdt.toFixed(1)} USDT)\n` +
      `• <b>成交开仓价</b>: <code>${formatPrice(pos.entryPrice)}</code>\n` +
      `• <b>24h涨幅</b>: +${pos.dayChangePercent.toFixed(2)}% ${rankStr} | <b>30m振幅</b>: ${ampStr}\n` +
      `• <b>阶段一目标 (平50%)</b>:\n` +
      `   - 止盈1: <b>${formatPrice(pos.tp1Price)}</b> (${tp1Sign}${pos.tp1Percent.toFixed(2)}%)\n` +
      `   - 止损1: <b>${formatPrice(pos.sl1Price)}</b> (${sl1Sign}${pos.sl1Percent.toFixed(2)}%)\n` +
      `• <b>阶段二目标 (平50%)</b>:\n` +
      `   - 止盈2: <b>${formatPrice(pos.tp2Price)}</b> (${tp2Sign}${pos.tp2Percent.toFixed(2)}%)\n` +
      `   - 止损2: <b>${formatPrice(pos.sl2Price)}</b> (${sl2Sign}${pos.sl2Percent.toFixed(2)}%${pos.moveSlToEntryAfterTp1 !== false ? "，阶段一止盈后自动锁定保本" : ""})\n` +
      `• <b>模拟账户状态</b>: 可用保证金 <b>${this.account.availableMarginUsdt.toFixed(2)} USDT</b> (净值 <b>${this.account.equityUsdt.toFixed(2)} USDT</b>)\n` +
      `• <b>最长持仓</b>: ${holdMin}分钟超时市价平仓`;
    await this.sendTg(msg, `开仓 ${pos.symbol}`);
  }

  private async notifyStage1(pos: PaperPosition, exit: PaperExit): Promise<void> {
    const action =
      exit.reason === "target"
        ? "止盈平仓 ✅"
        : exit.reason === "stop"
          ? "止损减仓 🛑"
          : "超时平仓 ⏱️";
    const pnlSign = exit.netPnlUsdt >= 0 ? "+" : "";
    const roeSign = exit.netPnlUsdt >= 0 ? "+" : "";
    const stageRoe = ((exit.netPnlUsdt / Math.max(0.01, pos.marginUsdt * 0.5)) * 100).toFixed(1);
    const label = formatSignalLabel(pos.signalType, pos.signalLabel);
    const dirStr = pos.side === "LONG" ? "做多" : "做空";
    const beStr = pos.isBreakevenArmed
      ? `\n• <b>保护机制</b>: 🛡️ 剩余仓位止损已锁定保本价 <code>${formatPrice(pos.sl2Price)}</code> (锁定无风险交易！)`
      : "";
    const msg =
      `🎯 <b>[模拟交易] 阶段一达成 (平仓 50%) 【${formatDirectionAndSignal(dirStr, label)}】</b>\n` +
      `• <b>标的</b>: <a href="https://www.binance.com/zh-CN/futures/${pos.symbol}"><b>${pos.symbol}</b></a>\n` +
      `• <b>方向 / 信号</b>: <b>【${formatDirectionAndSignal(dirStr, label)}】</b>\n` +
      `• <b>动作</b>: ${action}\n` +
      `• <b>成交价</b>: <code>${formatPrice(exit.exitPrice)}</code>\n` +
      `• <b>阶段净盈亏</b>: <b>${pnlSign}${exit.netPnlUsdt.toFixed(2)} USDT (ROE: ${roeSign}${stageRoe}%)</b>\n` +
      `• <b>剩余仓位</b>: 50% (等待阶段二: 止盈 <code>${formatPrice(pos.tp2Price)}</code> / 止损 <code>${formatPrice(pos.sl2Price)}</code>)${beStr}`;
    await this.sendTg(msg, `阶段一平仓 ${pos.symbol}`);
  }

  private async notifyFinal(pos: PaperPosition): Promise<void> {
    const holdMins = pos.closedAt
      ? ((pos.closedAt - pos.entryTime) / 60000).toFixed(1)
      : (pos.exitParams?.holdMinutes ?? this.config.holdMinutes).toFixed(1);

    const exit1 = pos.exits.find((e) => e.stage === 1);
    const exit2 = pos.exits.find((e) => e.stage === 2);

    let reasonStr = "";
    if (exit1?.reason === "target" && exit2?.reason === "target") {
      reasonStr = "两阶段全部止盈 🎯";
    } else if (exit1?.reason === "target" && exit2?.reason === "stop" && pos.isBreakevenArmed) {
      reasonStr = "阶段一止盈 + 阶段二保本锁定 🎯🛡️";
    } else if (exit1?.reason === "target" && exit2?.reason === "timeout") {
      reasonStr = "阶段一止盈 + 阶段二超时平仓 🎯⏱️";
    } else if (exit1?.reason === "target" && exit2?.reason === "stop") {
      reasonStr = "阶段一止盈 + 阶段二止损 🎯🛑";
    } else if (exit1?.reason === "stop" && exit2?.reason === "target") {
      reasonStr = "阶段一止损 + 阶段二止盈 🛑🎯";
    } else if (exit1?.reason === "stop" && exit2?.reason === "timeout") {
      reasonStr = "阶段一止损 + 阶段二超时 🛑⏱️";
    } else if (exit1?.reason === "stop" && exit2?.reason === "stop") {
      reasonStr = "触发全额止损 🛑";
    } else if (exit1?.reason === "timeout" && exit2?.reason === "timeout") {
      reasonStr = `${holdMins}分钟超时市价平仓 ⏱️`;
    } else {
      reasonStr =
        pos.finalReason === "target"
          ? "目标达成止盈 🎯"
          : pos.finalReason === "stop"
            ? (pos.isBreakevenArmed ? "保本止损锁定 🛡️" : "触发止损 🛑")
            : `${holdMins}分钟超时市价平仓 ⏱️`;
    }

    const headerIcon =
      pos.totalNetPnlUsdt > 0.001 ? "🏆" : pos.totalNetPnlUsdt < -0.001 ? "🛑" : "🛡️";

    const totalFraction = pos.exits.reduce((sum, e) => sum + e.fraction, 0);
    const avgExitPrice =
      totalFraction > 0
        ? pos.exits.reduce((sum, e) => sum + e.exitPrice * e.fraction, 0) / totalFraction
        : pos.currentPrice;

    const pnlSign = pos.totalNetPnlUsdt >= 0 ? "+" : "";
    const totSign = this.account.totalPnlUsdt >= 0 ? "+" : "";
    const label = formatSignalLabel(pos.signalType, pos.signalLabel);
    const dirStr = pos.side === "LONG" ? "做多" : "做空";

    const msg =
      `${headerIcon} <b>[模拟交易] 订单全额结清 (${reasonStr}) 【${formatDirectionAndSignal(dirStr, label)}】</b>\n` +
      `• <b>标的</b>: <a href="https://www.binance.com/zh-CN/futures/${pos.symbol}"><b>${pos.symbol}</b></a>\n` +
      `• <b>方向 / 信号</b>: <b>【${formatDirectionAndSignal(dirStr, label)}】</b>\n` +
      `• <b>杠杆 / 保证金</b>: <b>${pos.leverage}x / ${pos.marginUsdt.toFixed(1)} USDT</b> (名义仓位: ${pos.notionalUsdt.toFixed(1)} USDT)\n` +
      `• <b>持仓耗时</b>: ${holdMins} 分钟\n` +
      `• <b>结算原因</b>: ${reasonStr}\n` +
      `• <b>成交明细</b>: 开 <code>${formatPrice(pos.entryPrice)}</code> → 平均 <code>${formatPrice(avgExitPrice)}</code>\n` +
      `• <b>整单净盈亏</b>: <b>${pnlSign}${pos.totalNetPnlUsdt.toFixed(2)} USDT (ROE: ${pnlSign}${pos.roePercent.toFixed(1)}%)</b>\n` +
      `• <b>模拟账户总览</b>: 余额 <b>${this.account.balanceUsdt.toFixed(2)} USDT</b> (净值 <b>${this.account.equityUsdt.toFixed(2)} USDT</b>, 累计回报 <b>${totSign}${this.account.accountRoiPercent.toFixed(2)}%</b>)\n` +
      `• <b>累计模拟战绩</b>: 共 ${this.stats.totalTrades} 笔 | 做多 <b>${this.stats.bySide.LONG.winRate.toFixed(1)}%</b> (${this.stats.bySide.LONG.totalTrades}笔) / 做空 <b>${this.stats.bySide.SHORT.winRate.toFixed(1)}%</b> (${this.stats.bySide.SHORT.totalTrades}笔) | PF <b>${Number.isFinite(this.stats.profitFactor) ? this.stats.profitFactor.toFixed(2) : "∞"}</b>`;
    await this.sendTg(msg, `订单结清 ${pos.symbol}`);
  }

  public async notifyFactorMiningStarted(jobConfig?: FactorMiningConfig, targetStrategyId?: string): Promise<void> {
    if (!telegramConfigured() || !targetStrategyId) {
      return;
    }
    const fm = {
      ...DEFAULT_FACTOR_MINING,
      ...this.config.factorMining,
      ...jobConfig,
    };
    const trainMin = fm.trainingMinutes ?? 720;
    const valMin = fm.validationMinutes ?? 120;
    const holdMin = fm.holdoutMinutes ?? 120;
    const totalMin = trainMin + valMin + holdMin;
    const takerBps = this.config.takerFeeBps ?? 5;
    const slipBps = this.config.slippageBps ?? 5;
    const timeStr = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

    const targetLabel = formatSignalLabel(targetStrategyId as PaperSignalType);
    const msg = [
      `🧠 <b>[量化策略] 策略停用触发针对性参数重挖</b>`,
      `• <b>目标策略</b>: <b>[${escapeHtml(targetLabel)}]</b>`,
      `• <b>触发时间</b>: ${timeStr} (UTC+8)`,
      `• <b>数据窗口</b>: 回溯 <b>${(totalMin / 60).toFixed(1)}h</b> (${totalMin}分钟)`,
      `• <b>模拟成本</b>: 手续费 <b>${takerBps} bps</b> | 滑点 <b>${slipBps} bps</b>`,
      `• <b>规则机制</b>: 重新挖掘参数；若达标即刻恢复，若未达标则进入 <b>60 分钟冷却期</b>`,
      `• <b>执行状态</b>: 后台子进程独立计算，特征持续录制中，不影响其他策略运行。`,
    ].join("\n");
    await this.sendTg(msg, `针对性因子挖掘 [${targetLabel}]`);
  }

  private async notifyMinedFactorsApplied(
    result: FactorMiningResult,
    appliedSides: ("LONG" | "SHORT")[],
    now: number,
  ): Promise<void> {
    if (!telegramConfigured()) {
      return;
    }
    const validMinutes = this.config.factorMining?.validForMinutes ?? 120;
    const expiresAt = now + validMinutes * MINUTE_MS;
    const expireTimeStr = new Date(expiresAt).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
    const sideLabels = appliedSides.map(s => s === "LONG" ? "做多 (LONG)" : "做空 (SHORT)").join(" & ");

    const lines: string[] = [
      `🎯 <b>[量化策略] 新一轮模型参数已通过验证并成功应用生效！</b>`,
      `• <b>生效方向</b>: <b>${sideLabels}</b>`,
      `• <b>模型有效期</b>: <b>${validMinutes} 分钟</b> (至 <b>${expireTimeStr}</b> 止)`,
    ];

    for (const side of appliedSides) {
      const c = result.sides[side].candidate!;
      const dirStr = side === "LONG" ? "🟢 做多" : "🔴 做空";
      const cfg = c.config;
      const trainPf = c.train.profitFactor != null && Number.isFinite(c.train.profitFactor) ? c.train.profitFactor.toFixed(2) : "∞";
      const holdPf = c.holdout.profitFactor != null && Number.isFinite(c.holdout.profitFactor) ? c.holdout.profitFactor.toFixed(2) : "∞";

      lines.push(
        ``,
        `<b>【${dirStr} 策略新参数】</b>`,
        `• <b>形态特征</b>: 均线 <code>${escapeHtml(cfg.maRequirement)}</code> | MACD <code>${escapeHtml(cfg.macdRequirement)}</code>`,
        `• <b>入场条件</b>: 前置窗口 <b>${cfg.intervalWindow}m</b> | 振幅门槛 <b>24h/${cfg.ampDivisor}</b>`,
        `• <b>止盈止损</b>: 阶段一 <b>+${cfg.tp1Percent.toFixed(1)}%</b> / 阶段二 <b>+${cfg.tp2Percent.toFixed(1)}%</b> | 止损 <b>-${cfg.stopLossPercent.toFixed(1)}%</b>`,
        `• <b>持仓杠杆</b>: <b>${cfg.holdMinutes}分钟</b>超时平仓 | <b>${cfg.leverage}x</b> 杠杆${cfg.moveSlToEntryAfterTp1 ? " (TP1后保本)" : ""}`,
        `• <b>回测战绩</b>:`,
        `   - 训练集 (Train): <b>${c.train.trades}笔</b> | 胜率 <b>${c.train.winRate.toFixed(1)}%</b> | PF <b>${trainPf}</b> | 净利 <b>${c.train.netPercent >= 0 ? "+" : ""}${c.train.netPercent.toFixed(2)}%</b>`,
      );

      if (c.validation) {
        const valPf = c.validation.profitFactor != null && Number.isFinite(c.validation.profitFactor) ? c.validation.profitFactor.toFixed(2) : "∞";
        lines.push(
          `   - 验证集 (Val): <b>${c.validation.trades}笔</b> | 胜率 <b>${c.validation.winRate.toFixed(1)}%</b> | PF <b>${valPf}</b> | Wilson <b>${c.validation.wilsonLow.toFixed(1)}%</b>`,
        );
      }

      lines.push(
        `   - 留出集 (Holdout): <b>${c.holdout.trades}笔</b> | 胜率 <b>${c.holdout.winRate.toFixed(1)}%</b> | PF <b>${holdPf}</b> | Wilson <b>${c.holdout.wilsonLow.toFixed(1)}%</b>`,
      );
    }

    for (const side of ["LONG", "SHORT"] as const) {
      if (!appliedSides.includes(side)) {
        const dirStr = side === "LONG" ? "做多" : "做空";
        lines.push(
          ``,
          `• <b>${dirStr}方向状态</b>: 未更新 (${escapeHtml(result.sides[side].reason)})`,
        );
      }
    }

    lines.push(
      ``,
      `• <b>执行状态</b>: 策略引擎已热加载新参数，后续符合形态的标的将按新规则触发入场挂单/开仓。`,
    );

    await this.sendTg(lines.join("\n"), "应用新策略参数 (量化因子)");
  }

  private async notifyManualConfigApplied(
    updates: Partial<PaperStrategyConfig>,
  ): Promise<void> {
    if (!telegramConfigured()) {
      return;
    }
    const timeStr = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
    const changes: string[] = [];

    if (updates.klineStatsShortConfig) {
      const sc = updates.klineStatsShortConfig;
      changes.push(`• <b>量化做空参数</b>: 窗口 ${sc.intervalWindow ?? "-"}m | 振幅 24h/${sc.ampDivisor ?? "-"} | 均线 ${escapeHtml(sc.maRequirement ?? "-")} | MACD ${escapeHtml(sc.macdRequirement ?? "-")} | TP1 +${sc.tp1Percent}% / TP2 +${sc.tp2Percent}% / SL -${sc.stopLossPercent}%`);
    }
    if (updates.klineStatsLongConfig) {
      const lc = updates.klineStatsLongConfig;
      changes.push(`• <b>量化做多参数</b>: 窗口 ${lc.intervalWindow ?? "-"}m | 振幅 24h/${lc.ampDivisor ?? "-"} | 均线 ${escapeHtml(lc.maRequirement ?? "-")} | MACD ${escapeHtml(lc.macdRequirement ?? "-")} | TP1 +${lc.tp1Percent}% / TP2 +${lc.tp2Percent}% / SL -${lc.stopLossPercent}%`);
    }
    if (updates.strategies) {
      const enabledList = updates.strategies.filter(s => s.enabled).map(s => escapeHtml(s.label || s.id));
      changes.push(`• <b>生效策略 (${enabledList.length}个)</b>: ${enabledList.join(", ") || "无"}`);
    }
    const levParts: string[] = [];
    if (updates.klineStatsLeverage != null) levParts.push(`量化特征 ${updates.klineStatsLeverage}x`);
    if (updates.streakLeverage != null) levParts.push(`闪击 ${updates.streakLeverage}x`);
    if (updates.longLeverage != null) levParts.push(`做多 ${updates.longLeverage}x`);
    if (updates.trendLeverage != null) levParts.push(`顺势 ${updates.trendLeverage}x`);
    if (updates.leverage != null) levParts.push(`默认 ${updates.leverage}x`);
    if (levParts.length > 0) {
      changes.push(`• <b>杠杆调整</b>: ${levParts.join(" | ")}`);
    }
    if (updates.marginPercent != null || updates.marginRate != null || updates.maxPositions != null || updates.maxPositionsPerStrategy != null) {
      const mPct = updates.marginPercent ?? (updates.marginRate ? updates.marginRate * 100 : undefined);
      const parts: string[] = [];
      if (mPct != null) parts.push(`单笔保证金 ${mPct}%`);
      if (updates.maxPositions != null) parts.push(`最大持仓 ${updates.maxPositions} 笔`);
      if (updates.maxPositionsPerStrategy != null) parts.push(`每策略至多 ${updates.maxPositionsPerStrategy} 笔`);
      changes.push(`• <b>风控调整</b>: ${parts.join(" | ")}`);
    }

    const switches: string[] = [];
    for (const [key, label] of [
      ["enableStreak", "新高闪击"],
      ["enableRebound", "首次跌10%反弹"],
      ["enableDeepRebound", "跌20%+超跌"],
      ["enableHourlySuppression", "小时线压制"],
      ["enableLongs", "做多总开关"],
      ["enableWBottomDivergence", "W底背离做多"],
      ["enableKlineStatsShort", "量化特征做空"],
      ["enableKlineStatsLong", "量化特征做多"],
    ] as const) {
      if ((updates as any)[key] !== undefined) {
        switches.push(`${label}: <b>${(updates as any)[key] ? "开启 ✅" : "关闭 ❌"}</b>`);
      }
    }
    if (switches.length > 0) {
      changes.push(`• <b>策略启闭</b>: ${switches.join(" | ")}`);
    }

    if (updates.factorMining) {
      const fm = updates.factorMining;
      const parts: string[] = [];
      if (fm.enabled !== undefined) parts.push(`自动训练: <b>${fm.enabled ? "开启 ✅" : "关闭 ❌"}</b>`);
      if (fm.refreshMinutes) parts.push(`刷新周期 ${fm.refreshMinutes}m`);
      if (fm.validForMinutes) parts.push(`模型有效期 ${fm.validForMinutes}m`);
      if (parts.length > 0) {
        changes.push(`• <b>因子挖掘调度</b>: ${parts.join(" | ")}`);
      }
    }

    if (changes.length === 0) {
      return;
    }

    const msg = [
      `⚙️ <b>[策略管理] 已应用新策略参数 (手动/API配置)</b>`,
      `• <b>生效时间</b>: ${timeStr} (UTC+8)`,
      ...changes,
      `• <b>执行状态</b>: 策略参数已实时热加载生效并落盘持久化。`,
    ].join("\n");

    await this.sendTg(msg, "应用新策略参数 (手动配置)");
  }

  // --- Persistence ---
  private scheduleSave(): void {
    if (!this.config.storageFile) return;
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
      const data: PaperTradingState & { configOverrides?: Partial<PaperStrategyConfig>; leverageDefaultsVersion: number } = {
        leverageDefaultsVersion: 1,
        factorMining: this.getFactorMiningState(),
        strategyFaults: this.getStrategyFaults(),
        account: this.account,
        pendingOrders: Array.from(this.pendingOrders.values()),
        activePositions: Array.from(this.activePositions.values()),
        closedPositions: this.closedPositions,
        stats: this.stats,
        reboundWatchlist: this.strategyEngine.getWatch("rebound").getWatchlist(),
        strategyRuntime: this.strategyEngine.exportState(),
        updatedAt: new Date().toISOString(),
        configOverrides: {
          ...this.config,
          storageFile: undefined,
        },
      };
      const temporaryFile = `${this.config.storageFile}.tmp`;
      fs.writeFileSync(temporaryFile, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(temporaryFile, this.config.storageFile);
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
            o.side = o.side ?? "SHORT";
            o.signalType = o.signalType ?? "streak";
            o.signalLabel = formatSignalLabel(o.signalType, o.signalLabel);
            this.pendingOrders.set(o.symbol, o);

          }
        }
        if (Array.isArray(data.activePositions)) {
          this.activePositions.clear();
          for (const p of data.activePositions) {
            p.side = p.side ?? (
              p.signalType === "w_bottom_divergence" || p.signalType === "kline_stats_long" ? "LONG" : "SHORT"
            );
            p.signalType = p.signalType ?? "streak";
            p.signalLabel = formatSignalLabel(p.signalType, p.signalLabel);
            this.activePositions.set(p.symbol, p);

          }
        }
        if (Array.isArray(data.closedPositions)) {
          this.closedPositions = data.closedPositions.map((p) => {
            p.side = p.side ?? (
              p.signalType === "w_bottom_divergence" || p.signalType === "kline_stats_long" ? "LONG" : "SHORT"
            );
            p.signalType = p.signalType ?? "streak";
            p.signalLabel = formatSignalLabel(p.signalType, p.signalLabel);
            return p;
          });
        }
        if (Array.isArray(data.reboundWatchlist) && data.reboundWatchlist.length > 0) {
          this.strategyEngine.getWatch("rebound").restoreWatchlist(data.reboundWatchlist);
        }
        if (data.strategyRuntime) this.strategyEngine.restoreState(data.strategyRuntime);
        if (data.stats) {
          this.stats = data.stats;
        }
        this.recalculateStats();
        if ((data as any).configOverrides) {
          const saved = (data as any).configOverrides as Partial<PaperStrategyConfig>;
          // One-time migration: old persisted 5x/10x defaults must not override the new 3x policy.
          // Existing position/order notionals remain the historical execution snapshot.
          if ((data as any).leverageDefaultsVersion !== 1) {
            if (saved.strategies) saved.strategies = saved.strategies.map(s => ({ ...s, exit: { ...s.exit, leverage: 3 } }));
            Object.assign(saved, { leverage: 3, streakLeverage: 3, trendLeverage: 3, longLeverage: 3, klineStatsLeverage: 3 });
            for (const key of ["klineStatsLongConfig", "klineStatsShortConfig", "hourlySuppressionConfig", "wBottomDivergenceConfig"] as const) {
              saved[key] = { ...saved[key], leverage: 3 };
            }
          }
          const rate = Math.min(0.2, saved.marginPercent != null ? saved.marginPercent / 100 : saved.marginRate ?? 0.2);
          this.updateConfig({ ...saved, marginRate: rate, marginPercent: rate * 100,
            maxPositions: Math.min(5, saved.maxPositions ?? 5), maxPositionsPerStrategy: 1, firstCloseFraction: FIRST_CLOSE_FRACTION }, { skipNotify: true });
        }
        if (data.factorMining?.sides?.LONG && data.factorMining?.sides?.SHORT) {
          this.factorMiningState = { ...data.factorMining, running: false,
            nextRunAt: data.factorMining.running ? 0 : data.factorMining.nextRunAt };
        }
        if (Array.isArray((data as any).strategyFaults)) {
          this.strategyFaults.clear();
          for (const f of (data as any).strategyFaults) {
            this.strategyFaults.set(f.strategyId, f);
          }
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
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = null;
    this.pendingOrders.clear();
    this.activePositions.clear();
    this.closedPositions = [];
    this.strategyEngine = new StrategyEngine(this.config.strategies);
    this.strategyMonitor = [];
    this.account = {
      initialBalanceUsdt: this.config.initialBalanceUsdt,
      balanceUsdt: this.config.initialBalanceUsdt,
      equityUsdt: this.config.initialBalanceUsdt,
      usedMarginUsdt: 0,
      availableMarginUsdt: this.config.initialBalanceUsdt,
      totalPnlUsdt: 0,
      accountRoiPercent: 0,
    };
    this.stats = this.computeStatsForPositions([]);
    this.stats24h = this.computeStatsForPositions([]);
    this.strategyFaults.clear();
    this.factorMiningState = initialFactorMiningState();
    this.saveState();
    console.log(`[paper-trading] 🔄 模拟交易账户、活跃持仓、挂单与历史明细已全部重置为初始状态 (100 USDT)`);
  }

  public getSummary(): PaperTradingSummary {
    this.getStats24h();
    return {
      strategyFaults: this.getStrategyFaults(),
      factorMining: { ...this.getFactorMiningState(), entryAllowed: {
        LONG: !!this.config.enableLongs && !!this.config.enableKlineStatsLong && this.factorEntryAllowed("LONG"),
        SHORT: !!this.config.enableKlineStatsShort && this.factorEntryAllowed("SHORT"),
      } },
      bySide: this.stats.bySide,
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
      stats24h: this.stats24h,
      config: {
        strategies: this.strategyEngine.getStrategies(),
        factorMining: this.config.factorMining,
        leverage: this.config.leverage,
        streakLeverage: this.config.streakLeverage ?? 3,
        trendLeverage: this.config.trendLeverage ?? this.config.leverage,
        longLeverage: this.config.longLeverage ?? 3,
        klineStatsLeverage: this.config.klineStatsLeverage ?? 3,
        marginUsdt: this.calculateOrderMargin(),
        marginRate: this.config.marginRate ?? 0.20,
        marginPercent: this.config.marginPercent ?? (this.config.marginRate ? Math.round(this.config.marginRate * 100) : 20),
        maxPositions: this.config.maxPositions ?? 5,
        maxPositionsPerStrategy: this.config.maxPositionsPerStrategy ?? 1,
        limitDivisor: this.config.limitDivisor,
        holdMinutes: this.config.holdMinutes,
        initialBalanceUsdt: this.config.initialBalanceUsdt,
        topN: this.config.topN,
        ampDivisor: this.config.ampDivisor,
        supportMaPeriods: this.config.supportMaPeriods,
        enableStreak: this.config.enableStreak ?? true,
        enableRebound: this.config.enableRebound ?? true,
        enableDeepRebound: this.config.enableDeepRebound ?? true,
        enableHourlySuppression: this.config.enableHourlySuppression ?? true,
        enableLongs: this.config.enableLongs ?? true,
        enableWBottomDivergence: this.config.enableWBottomDivergence ?? true,
        enableKlineStatsShort: this.config.enableKlineStatsShort ?? true,
        enableKlineStatsLong: this.config.enableKlineStatsLong ?? true,
        streakConfig: this.config.streakConfig,
        reboundConfig: this.config.reboundConfig,
        deepReboundConfig: this.config.deepReboundConfig,
        hourlySuppressionConfig: this.config.hourlySuppressionConfig,
        wBottomDivergenceConfig: this.config.wBottomDivergenceConfig,
        klineStatsShortConfig: this.config.klineStatsShortConfig,
        klineStatsLongConfig: this.config.klineStatsLongConfig,
      },
    };
  }

  public getState(): PaperTradingState & { config: PaperStrategyConfig; summary: PaperTradingSummary } {
    this.getStats24h();
    return {
      strategyMonitor: this.strategyMonitor,
      strategyFaults: this.getStrategyFaults(),
      factorMining: this.getFactorMiningState(),
      account: this.account,
      pendingOrders: Array.from(this.pendingOrders.values()),
      activePositions: Array.from(this.activePositions.values()),
      closedPositions: this.closedPositions,
      stats: this.stats,
      stats24h: this.stats24h,
      updatedAt: new Date().toISOString(),
      config: this.config,
      summary: this.getSummary(),
    };
  }
}

export const paperTrading = new PaperTradingEngine(process.env.NODE_TEST_CONTEXT ? { storageFile: null } : {});
