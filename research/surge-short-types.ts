import type { ExitReason } from './peak-rebound-types.ts';

export interface SurgeShortSignal {
  symbol: string;
  time: number;          // Timestamp when signal bar closes (next bar open = entry time)
  entryPrice: number;    // Next bar's open price
  index: number;
  boardTime: number;
  rank: number;
  dayChangePercent: number;     // 24h 涨幅 (%)
  windowMinutes: number;        // x (分钟窗口)
  nFactor: number;              // N (倍数)
  requiredSurgePercent: number; // 24h涨幅 / N (%)
  surgePercent: number;         // 实际 x 分钟内涨幅 (%)
  lowPrice: number;             // x 分钟内最低价
  highPrice: number;            // x 分钟内最高价
  closePrice: number;           // 信号触发时收盘价
  ma30DeviationPercent: number; // 当前价偏离 MA30 乖离率 (%)
  upperShadowRatio: number;     // 上影线占比
  isRedCandle: boolean;
}

export type SurgeMode = 'trough-to-close' | 'trough-to-high' | 'open-to-close';

export interface SurgeShortScanConfig {
  topN?: number;                 // 涨幅榜排名过滤，默认 10 (前10名)
  minDayChange?: number;         // 最小 24h 涨幅 (默认 20%)
  windowMinutes: number;         // x (分钟): 3, 5 等
  nFactor: number;               // N: 3.0, 3.5 等
  minAbsoluteSurge?: number;     // 最小绝对冲高幅度 (默认 4.0%)
  minMa30Deviation?: number;     // 最小 MA30 乖离率 (默认 1.5%)
  surgeMode?: SurgeMode;         // 计算涨幅方式，默认 'trough-to-close'
  requireRedCandle?: boolean;    // 是否要求当根 K 线收阴
  minUpperShadow?: number;       // 最小上影线比例
  cooldownMinutes?: number;      // 信号冷却时间 (分钟)，默认 20
}

export interface SurgeShortExitConfig {
  holdMinutes: number;           // 最大持有时间 (分钟)，推荐 20 或 30
  exitType: 'two-stage-dynamic' | 'fixed-tp-sl' | 'surge-proportional' | 'time-only';
  // two-stage-dynamic 参数 (与系统标准一致)
  exitX?: number;                // 阶段一 TP1 = sl1 = dayChange / exitX (推荐 30 或 35)
  exitN?: number;                // 阶段二 sl2 = (dayChange * exitN) / exitX (推荐 2.0)
  exitM?: number;                // 阶段二 tp2 = (dayChange * exitM) / exitX (推荐 2.0)
  // fixed-tp-sl 参数
  takeProfitPercent?: number;    // 固定止盈 %
  stopLossPercent?: number;      // 固定止损 %
  // surge-proportional 参数
  surgeTpRatio?: number;         // tp = surge * ratio
  surgeSlRatio?: number;         // sl = surge * ratio
}

export interface SurgeShortTradeExit {
  stage: 1 | 2;
  fraction: number;
  exitTime: number;
  exitPrice: number;
  reason: ExitReason;
  grossPercent: number;
  netPercent: number;
}

export interface SurgeShortTrade {
  symbol: string;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  durationMinutes: number;
  dayChangePercent: number;
  surgePercent: number;
  requiredSurge: number;
  maDev: number;
  reason: ExitReason;
  grossPercent: number;
  netPercent: number;
  entryFeePercent: number;
  exitFeePercent: number;
  slippagePercent: number;
  exits: SurgeShortTradeExit[];
}

export interface SurgeShortMetrics {
  totalTrades: number;
  winCount: number;
  lossCount: number;
  breakevenCount: number;
  winRate: number;
  winRate95: [number, number] | null;
  grossPnlPercent: number;
  netPnlPercent: number;
  profitFactor: number | null;
  meanTradePercent: number;
  meanWinPercent: number;
  meanLossPercent: number;
  rewardRiskRatio: number | null;
  maxDrawdownPercent: number;
  exitReasons: Record<string, number>;
}
