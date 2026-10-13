import type { Bar, Manifest, Metrics } from "./types.ts";
import type { FifteenFeature } from './fifteen.ts';
import type { BtcFiveFeature } from './btc-five.ts';
import type { Streak } from '../src/macd.ts';

export const MINUTE = 60_000;
export interface GainersParameters {
  highRatio: number;
  holdMinutes: number;
  stopLossPercent: number;
  takeProfitPercent: number;
}
export type GainersGrid = { [K in keyof GainersParameters]: number[] };
export interface GainersOptions {
  topN: number;
  highWindow: number;
  rounds: number;
  trialsPerRound: number;
  seed: number;
  minTrades: number;
  trainRatio: number;
  validationRatio: number;
  feeBps: number;
  slippageBps: number;
  grid: GainersGrid;
}
export interface MinutePlan {
  version: 1;
  hourlyHash: string;
  topN: number;
  highWindow: number;
  warmupMinutes: number;
  maxHoldMinutes: number;
  start: number;
  end: number;
  ranges: Record<string, [number, number][]>;
}
export interface MinuteManifest {
  version: 1;
  interval: "1m";
  source: string;
  fetchedAt: string;
  plan: MinutePlan;
  files: Record<string, { file: string; sha256: string; bars: number; missingMinutes: number }>;
  archiveChecksums?: Record<string, string>;
}
export interface MinuteDataset {
  manifest: MinuteManifest;
  candles: Map<string, Bar[]>;
}
export interface MinuteSignal {
  symbol: string;
  rank: number;
  boardTime: number;
  time: number; // Closed 1m signal time, also next-bar entry time.
  index: number;
  dif: number;
  dea: number;
  peakDea: number;
  deaPeakRatio: number;
  supportMa: string | null; // null only after evaluating all configured MAs on the signal bar.
  fifteen?: FifteenFeature | null; // null: missing, stale or still warming up; undefined: legacy 1m research.
  btcFive?: BtcFiveFeature | null; // BTCUSDT context shared by all ranked symbols; never a traded-symbol 5m snapshot.
  streak?: Streak;
}
export interface MinuteTrade {
  symbol: string;
  rank: number;
  boardTime: number;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  reason: "stop" | "target" | "timeout";
  ambiguous: boolean;
  grossPercent: number;
  netPercent: number;
  signal: MinuteSignal;
}
export interface MinuteTrial {
  id: string;
  round: number;
  parameters: GainersParameters;
  train: Metrics;
  validation: Metrics | null;
}
export interface GainersStudy {
  version: 1;
  strategy: "gainers-high-bull-no-ma-1m";
  createdAt: string;
  hourly: Manifest;
  minute: MinuteManifest;
  options: GainersOptions;
  signalCount: number;
  split: { start: number; trainEnd: number; validationEnd: number; end: number };
  trials: MinuteTrial[];
  winner: null | {
    trialId: string;
    parameters: GainersParameters;
    train: Metrics;
    validation: Metrics;
    test: Metrics;
    testTrades: MinuteTrade[];
  };
}
