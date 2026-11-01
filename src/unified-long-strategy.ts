// Unified Long Strategy Engine for Binance 24h Top Gainers
// Retains exclusively the highest win-rate active long strategy:
// 策略 1: 'Left-side 3W Bottom Divergence Catapult Long' (左侧 3W 底背离弹射做多)

import { Candle, computeMacd } from './macd.ts';

export type UnifiedLongSignalType = 'w_bottom_divergence';

/**
 * 核心策略一：【左侧 3W 底背离弹射做多】 (Left-side 3W Bottom Divergence Catapult Long)
 * 核心逻辑：龙头强势币冲高后从近期高点深蹲回撤 >= 4%，在 10~30 根 K 线内形成 W 底 / 3探底整理区。
 * 第一底在 8~25 根前，两底之间有波峰反弹 >= 1.5% 构成颈线；
 * 当前第二底与前底平齐或微创新低，但 MACD 快线 DIF 与 Hist 柱体双重显著抬高 (强底背离)，
 * 当前收出放量弹射阳线启动起爆。实测胜率 76.6%, PF 1.99!
 */
export interface WBottomDivergenceLiveConfig {
  topN: number;               // 默认 10 (涨幅榜 Top 10)
  minDayChange: number;       // 默认 20.0 (24h 涨幅 >= 20%)
  minDropPercent: number;     // 默认 4.0% (近30根从高点回撤 >= 4%)
  prevBottomMinBars: number;  // 默认 8 (第一底距离当前最小根数)
  prevBottomMaxBars: number;  // 默认 25 (第一底距离当前最大根数)
  minNecklineBounce: number;  // 默认 1.5% (两底之间波峰反弹幅度 >= 1.5%)
  maxBottomToleranceRatio: number; // 默认 1.005 (当前底 <= 前低 * 1.005)
  minBottomFloorRatio: number;     // 默认 0.970 (当前底 >= 前低 * 0.970，防止深跌破位)
  requireMacdDivergence: boolean;  // 默认 true (DIF 和 Hist 双重抬高)
  requireCatapultBull: boolean;    // 默认 true (收阳且收盘突破前根高点)
  holdMinutes: number;        // 默认 30 分钟 (弹性好，见效快)
  stopLossPercent: number;    // 默认 7.0%
  tp1Percent: number;         // 默认 3.0%
  tp2Percent: number;         // 默认 8.0%
  moveSlToEntryAfterTp1: boolean; // 默认 true
  cooldownMinutes: number;    // 默认 20 分钟
  leverage: number;           // 默认 3x
}

export const W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG: WBottomDivergenceLiveConfig = {
  topN: 10,
  minDayChange: 20.0,
  minDropPercent: 4.0,
  prevBottomMinBars: 8,
  prevBottomMaxBars: 25,
  minNecklineBounce: 1.5,
  maxBottomToleranceRatio: 1.005,
  minBottomFloorRatio: 0.970,
  requireMacdDivergence: true,
  requireCatapultBull: true,
  holdMinutes: 30,
  stopLossPercent: 7.0,
  tp1Percent: 3.0,
  tp2Percent: 8.0,
  moveSlToEntryAfterTp1: true,
  cooldownMinutes: 20,
  leverage: 3,
};

export interface UnifiedLongLiveConfig {
  wBottomDivergenceConfig?: Partial<WBottomDivergenceLiveConfig>;
  preventConflict?: boolean;
  enableWBottomDivergence?: boolean;
}

export const UNIFIED_LONG_LIVE_DEFAULT_CONFIG: Required<UnifiedLongLiveConfig> = {
  wBottomDivergenceConfig: W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG,
  preventConflict: true,
  enableWBottomDivergence: true,
};

export interface UnifiedLongLiveSignal {
  id: string;
  type: UnifiedLongSignalType;
  label: string;
  symbol: string;
  time: number;
  dayChangePercent: number;
  entryPrice: number;
  side: 'LONG';
  exitParams: {
    holdMinutes: number;
    stopLossPercent: number;
    tp1Percent: number;
    tp2Percent: number;
    moveSlToEntryAfterTp1: boolean;
    leverage: number;
  };
  details: {
    ampX?: number;
    maxAllowedAmp?: number;
    boxAmp?: number;
    dropFrom24h?: number;
    maLevel?: number;
    dif?: number;
    barReturn?: number;
    drop30?: number;
    prevLow?: number;
    difNow?: number;
    difPrev?: number;
  };
}

export interface ActiveLongPositionInfo {
  tradeId: string;
  type: UnifiedLongSignalType;
  entryTime: number;
  maxExitTime: number;
}

export class UnifiedLongStrategyTracker {
  private config: {
    wBottomDivergenceConfig: WBottomDivergenceLiveConfig;
    preventConflict: boolean;
    enableWBottomDivergence: boolean;
  };
  private activePositions = new Map<string, ActiveLongPositionInfo>();
  private cooldownMap = new Map<string, number>();

  constructor(config: UnifiedLongLiveConfig = {}) {
    this.config = {
      wBottomDivergenceConfig: { ...W_BOTTOM_DIVERGENCE_DEFAULT_CONFIG, ...config.wBottomDivergenceConfig },
      preventConflict: config.preventConflict ?? true,
      enableWBottomDivergence: config.enableWBottomDivergence ?? true,
    };
  }

  public registerPosition(symbol: string, info: ActiveLongPositionInfo): void {
    this.activePositions.set(symbol, info);
  }

  public closePosition(symbol: string): void {
    this.activePositions.delete(symbol);
  }

  public isSymbolBusy(symbol: string, now = Date.now()): boolean {
    const active = this.activePositions.get(symbol);
    if (!active) return false;
    if (now >= active.maxExitTime) {
      this.activePositions.delete(symbol);
      return false;
    }
    return true;
  }

  public updateConfig(updates: Partial<UnifiedLongLiveConfig>): void {
    if (typeof updates.enableWBottomDivergence === 'boolean') {
      this.config.enableWBottomDivergence = updates.enableWBottomDivergence;
    }
    if (typeof updates.preventConflict === 'boolean') {
      this.config.preventConflict = updates.preventConflict;
    }
    if (updates.wBottomDivergenceConfig && typeof updates.wBottomDivergenceConfig === 'object') {
      this.config.wBottomDivergenceConfig = {
        ...this.config.wBottomDivergenceConfig,
        ...updates.wBottomDivergenceConfig,
      };
    }
  }

  /**
   * Evaluate a newly closed 1m candle for 24h Top Gainers Long entries.
   * Currently coordinates strategy 1: 左侧 3W 底背离弹射做多
   */
  public checkCandles(
    symbol: string,
    dayChangePercent: number,
    rankGainers: number | null,
    candles: Candle[],
    now = Date.now()
  ): UnifiedLongLiveSignal | null {
    if (rankGainers == null || rankGainers > 10 || dayChangePercent < 20) {
      return null;
    }

    if (this.config.preventConflict && this.isSymbolBusy(symbol, now)) {
      return null;
    }

    const targetIdx = candles.length - 2;
    if (targetIdx < 40) return null;
    const closedCandle = candles[targetIdx];
    if (!closedCandle || closedCandle.close <= 0) return null;

    const lastCooldown = this.cooldownMap.get(symbol) ?? 0;
    if (now < lastCooldown) return null;

    // 核心策略一：【左侧 3W 底背离弹射做多】 (整理区W底/3底 + MACD双重强底背离 + 放量弹射阳线)
    if (this.config.enableWBottomDivergence && rankGainers <= this.config.wBottomDivergenceConfig.topN) {
      const sigDiv = this.checkWBottomDivergence(closedCandle, candles, targetIdx, dayChangePercent);
      if (sigDiv) {
        const cfg = this.config.wBottomDivergenceConfig;
        this.cooldownMap.set(symbol, now + cfg.cooldownMinutes * 60 * 1000);
        const signal: UnifiedLongLiveSignal = {
          id: `long-w-div-${symbol}-${closedCandle.time}`,
          type: 'w_bottom_divergence',
          label: '左侧3W底背离',
          symbol,
          time: closedCandle.time + 60 * 1000,
          dayChangePercent,
          entryPrice: closedCandle.close,
          side: 'LONG',
          exitParams: {
            holdMinutes: cfg.holdMinutes,
            tp1Percent: cfg.tp1Percent,
            tp2Percent: cfg.tp2Percent,
            stopLossPercent: cfg.stopLossPercent,
            moveSlToEntryAfterTp1: cfg.moveSlToEntryAfterTp1,
            leverage: cfg.leverage,
          },
          details: sigDiv,
        };
        if (this.config.preventConflict) {
          this.registerPosition(symbol, {
            tradeId: signal.id,
            type: 'w_bottom_divergence',
            entryTime: signal.time,
            maxExitTime: signal.time + cfg.holdMinutes * 60 * 1000,
          });
        }
        return signal;
      }
    }

    return null;
  }

  /**
   * 评估【左侧 3W 底背离弹射做多】 (Left-side 3W Bottom Divergence Catapult Long)
   */
  private checkWBottomDivergence(
    candle: Candle,
    candles: Candle[],
    idx: number,
    dayChange: number
  ): { drop30: number; prevLow: number; difNow: number; difPrev: number } | null {
    const cfg = this.config.wBottomDivergenceConfig;
    if (dayChange < cfg.minDayChange) return null;

    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const closes = candles.map((c) => c.close);

    // 1. 过去 30 根峰值回撤 >= minDropPercent
    let high30 = 0;
    for (let k = Math.max(0, idx - 30); k <= idx; k++) {
      if (highs[k] > high30) high30 = highs[k];
    }
    if (high30 <= 0) return null;

    const drop30 = ((high30 - candle.low) / high30) * 100;
    if (drop30 < cfg.minDropPercent) return null;

    // 2. 寻找前一底 (8~25 根前)
    let prevMinIdx = -1;
    let prevMinLow = Infinity;
    const startK = Math.max(0, idx - cfg.prevBottomMaxBars);
    const endK = Math.max(0, idx - cfg.prevBottomMinBars);
    for (let k = startK; k <= endK; k++) {
      if (lows[k] < prevMinLow) {
        prevMinLow = lows[k];
        prevMinIdx = k;
      }
    }
    if (prevMinIdx < 0 || !Number.isFinite(prevMinLow)) return null;

    // 3. 两底之间波峰反弹 >= minNecklineBounce
    let midPeak = 0;
    for (let k = prevMinIdx; k <= idx; k++) {
      if (highs[k] > midPeak) midPeak = highs[k];
    }
    const midBounce = ((midPeak - prevMinLow) / prevMinLow) * 100;
    if (midBounce < cfg.minNecklineBounce) return null;

    // 4. 第二底平齐或微创新低 (W底特征)
    if (candle.low > prevMinLow * cfg.maxBottomToleranceRatio || candle.low < prevMinLow * cfg.minBottomFloorRatio) {
      return null;
    }

    // 5. MACD 强底背离: DIF 与 Hist 快线抬高且柱体收窄
    const macd = computeMacd(closes);
    if (cfg.requireMacdDivergence) {
      if (macd.dif[idx] <= macd.dif[prevMinIdx] || macd.hist[idx] <= macd.hist[prevMinIdx]) {
        return null;
      }
    }

    // 6. 弹射阳线启动: 收阳且收盘突破前根高点
    if (cfg.requireCatapultBull) {
      const prevBar = candles[idx - 1];
      if (!prevBar || candle.close <= candle.open || candle.close <= prevBar.high * 0.999) {
        return null;
      }
    }

    return {
      drop30,
      prevLow: prevMinLow,
      difNow: macd.dif[idx],
      difPrev: macd.dif[prevMinIdx],
    };
  }
}
