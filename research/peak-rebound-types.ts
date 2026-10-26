import type { Frame } from './types.ts';
import type { MinuteDataset } from './gainers-types.ts';

export interface WatchlistEntry {
  symbol: string;
  enteredAt: number;
  dayChangeAtRank1: number;
  peakPrice: number;
  peakTime: number;
  troughPrice: number;
  troughTime: number;
  status: 'watching' | 'pulled_back' | 'rebounded';
}

export interface PeakReboundSignal {
  symbol: string;
  time: number; // minute timestamp when next bar opens
  index: number;
  boardTime: number;
  dayChangePercent: number;
  rank: number;
  peakPrice: number;
  peakTime: number;
  pullbackPercent: number;
  troughPrice: number;
  troughTime: number;
  reboundPercent: number;
  fibRetracement?: number;
  reboundUpCandles?: number;
  upperShadowRatio?: number;
  shortMa: number;
  mediumMa?: number;
  longMa: number;
  longMaOffsetPercent: number;
  greenRatio20: number;
  maPeriod: number;
  maPeriods: readonly number[];
  maValues: Record<number, number>;
  close: number;
  high: number;
  low: number;
  open: number;
}

export interface PeakReboundParameters {
  pullbackX: number; // X%: Minimum pullback from peak (e.g. 3%, 5%, 8%, 10%)
  reboundY: number;  // y%: Minimum rebound from trough (e.g. 1%, 2%, 3%, 5%)
  shortMa: number;   // 短周期均线 (如 5)
  mediumMa?: number; // 中周期均线 (如 15，用于三均线空头排列 maLong > maMed > maShort)
  longMa: number;    // 长周期均线 (如 30)
  longMaOffsetPercent: number; // 长周期均线高于上影线最高点 X% (如 0%, 0.5%, 1.0%, 1.5%)
  minGreenRatio20: number; // 近20根1m MACD绿柱占比阈值 (如 0.5, 0.55, 0.6)
  minReboundUpCandles?: number; // 反弹区间最少阳线数量 (如 1 或 2)
  maxFibRetracement?: number;   // 反弹斐波那契回撤上限 (如 0.50，反弹不超过跌幅50%)
  minUpperShadowRatio?: number; // 信号K线上影线占比阈值 (如 0.30)
  requireBearishOrUpperShadow?: boolean; // 信号K线需收阴或留显著上影线
  maPeriods: number[]; // MA periods used for resistance suppression check
  holdMinutes: number; // Maximum holding minutes (e.g. 15, 30, 45, 60)
  exitX: number;       // Stage 1 denominator: TP1 = 24h% / exitX, SL1 = 24h% / exitX (close 50%)
  exitN: number;       // Stage 2 SL multiplier: SL2 = 24h% * exitN / exitX (close remaining 50%)
  exitM: number;       // Stage 2 TP multiplier: TP2 = 24h% * exitM / exitX (close remaining 50%)
}

export type ExitReason = 'stop' | 'target' | 'timeout';

export interface PeakReboundExit {
  stage: 1 | 2;
  fraction: number; // 0.5 of original position
  cumulativeClosedPercent: 50 | 100;
  exitTime: number;
  exitPrice: number;
  reason: ExitReason;
  grossPercent: number;
  entryFeePercent: number;
  exitFeePercent: number;
  slippagePercent: number;
  netPercent: number;
}

export interface PeakReboundTrade {
  signal: PeakReboundSignal;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  reason: ExitReason;
  exits: PeakReboundExit[];
  ambiguous: boolean;
  grossPercent: number;
  entryFeePercent: number;
  exitFeePercent: number;
  slippagePercent: number;
  netPercent: number;
  netR: number;
}

export interface PeakReboundOrder {
  signal: PeakReboundSignal;
  entryPrice: number | null;
  status: 'closed' | 'missing';
  resolvedAt: number;
  entryTime: number | null;
  exits: PeakReboundExit[];
  remainingFraction: number;
  entryFeePercent: number;
}

export interface PeakReboundMetrics {
  signalCount: number;
  submitted: number;
  filled: number;
  fillRate: number | null;
  missingAfterFill: number;
  partialOrders: number;
  skippedBusy: number;
  trades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number | null;
  winRate95: [number, number] | null;
  grossPnlPercent: number;
  netPnlPercent: number;
  totalCostsPercent: number;
  profitFactor: number | null;
  meanTradePercent: number | null;
  meanWinPercent: number | null;
  meanLossPercent: number | null;
  realizedRewardRisk: number | null;
  meanNetR: number | null;
  firstExits: { target: number; stop: number; timeout: number };
  exits: { target: number; stop: number; timeout: number };
}
