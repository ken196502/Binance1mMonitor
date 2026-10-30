import type { PeakReboundParameters } from './peak-rebound-types.ts';

export interface MaGroup {
  shortMa: number;
  mediumMa?: number;
  longMa: number;
}

export interface PeakReboundGrid {
  pullbackX: number[];
  reboundY: number[];
  maGroups: MaGroup[];
  longMaOffsetPercent: number[];
  minGreenRatio20: number[];
  holdMinutes: number[];
  exitX: number[];
  exitN: number[];
  exitM: number[];
}

export interface PeakReboundConfig {
  topN: number; // 1 for rank 1
  minDayChangePercent: number; // minimum 24h change to be valid
  watchWindowHours: number; // how many hours to keep watching a coin after it was rank 1
  takerFeeBps: number;
  slippageBps: number;
  stopAtHigh?: boolean;
  grid: PeakReboundGrid;
}

export const PEAK_REBOUND_DEFAULT_GRID: PeakReboundGrid = {
  pullbackX: [5, 8, 10],
  reboundY: [3, 4],
  maGroups: [
    { shortMa: 5, mediumMa: 15, longMa: 30 },
    { shortMa: 5, mediumMa: 10, longMa: 20 },
    { shortMa: 5, mediumMa: 10, longMa: 30 },
    { shortMa: 7, mediumMa: 15, longMa: 30 },
    { shortMa: 5, mediumMa: 20, longMa: 40 },
    { shortMa: 5, longMa: 30 },
  ],
  longMaOffsetPercent: [0.5, 1.0, 1.5],
  minGreenRatio20: [0.50, 0.55, 0.60, 0.65],
  holdMinutes: [30, 45],
  exitX: [35, 40, 50],
  exitN: [1.5, 2.0],
  exitM: [1.5, 2.0, 3.0],
};

export const PEAK_REBOUND_DEFAULT_CONFIG: PeakReboundConfig = {
  topN: 1,
  minDayChangePercent: 0,
  watchWindowHours: 48,
  takerFeeBps: 5,
  slippageBps: 2,
  stopAtHigh: false,
  grid: PEAK_REBOUND_DEFAULT_GRID,
};

export function validatePeakReboundParameters(p: PeakReboundParameters): PeakReboundParameters {
  if (p.pullbackX <= 0 || p.pullbackX > 100) throw new Error('pullbackX 需在 (0, 100]');
  if (p.reboundY <= 0 || p.reboundY > 100) throw new Error('reboundY 需在 (0, 100]');
  if (!Array.isArray(p.maPeriods) || p.maPeriods.length === 0 || p.maPeriods.some(m => !Number.isInteger(m) || m <= 0)) {
    throw new Error('maPeriods 需为正整数均线周期数组');
  }
  if (!Number.isInteger(p.holdMinutes) || p.holdMinutes <= 0) throw new Error('holdMinutes 需为正整数');
  if (p.exitX <= 0) throw new Error('exitX 需 > 0');
  if (p.exitN <= 0) throw new Error('exitN 需 > 0');
  if (p.exitM <= 0) throw new Error('exitM 需 > 0');
  return p;
}
