export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const BOARDS = ["gainers", "losers", "volume"] as const;
export type Board = typeof BOARDS[number];
export const BOARD_NAMES: Record<Board, string> = { gainers: "涨幅榜 / 冲高衰竭", losers: "跌幅榜 / 弱势延续", volume: "成交额榜 / 放量转弱" };

// Binance 1h open time, OHLC, base volume and quote volume (USDT).
export type Bar = [number, number, number, number, number, number, number];
export interface Contract {
  symbol: string;
  onboardDate: number;
}
export interface Manifest {
  version: 1;
  source: string;
  fetchedAt: string;
  start: number;
  end: number;
  fetchStart: number;
  interval: "1h";
  universeAt: string;
  contracts: Contract[];
  symbols: string[];
  files: Record<string, { file: string; sha256: string; bars: number; gaps: number; first: number | null; last: number | null }>;
}
export interface Dataset {
  manifest: Manifest;
  candles: Map<string, Bar[]>;
}
export interface Observation {
  symbol: string;
  rank: number; // Rank in this board at the historical signal time.
  index: number;
  time: number; // Signal close = potential next-bar entry time.
  dayChange: number;
  quoteVolume: number;
  weekChange: number | null;
  bearish: boolean;
  freshCross: boolean;
  deaPeakRatio: number;
  streak: number; // Positive = consecutive red candles; zero otherwise.
  volumeRatio: number;
  change5h: number;
  breaksLow: boolean;
}
export interface Frame {
  time: number;
  eligibleSymbols: number;
  boards: Record<Board, Observation[]>;
}
export interface Parameters {
  holdHours: number;
  minStreak: number;
  volumeRatio: number;
  weekFilter: boolean;
  dayMovePercent: number;
  highRatio: number;
  stopLossPercent: number;
  takeProfitPercent: number;
}
export type Grid = { [K in keyof Parameters]: Parameters[K][] };
export interface Metrics {
  trades: number;
  missing: number;
  purged: number;
  wins: number;
  winRate: number | null;
  meanNetPercent: number | null;
  sumNetPercent: number;
  profitFactor: number | null;
  lossPercent: number;
  worstTradePercent: number | null;
  maxDrawdownPoints: number;
}
export interface Trade {
  board: Board;
  symbol: string;
  rank: number;
  signalTime: number;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  reason: "stop" | "target" | "timeout";
  grossPercent: number;
  netPercent: number;
  observation: Observation;
}
export interface Trial {
  id: string;
  board: Board;
  round: number;
  parameters: Parameters;
  train: Metrics;
  validation: Metrics | null;
}
export interface Winner {
  trialId: string;
  board: Board;
  parameters: Parameters;
  train: Metrics;
  validation: Metrics;
  test: Metrics;
  testTrades: Trade[];
}
export interface SearchOptions {
  topN: number;
  stepHours: number;
  rounds: number;
  trialsPerRound: number;
  seed: number;
  minTrades: number;
  trainRatio: number;
  validationRatio: number;
  feeBps: number;
  slippageBps: number;
  grid: Grid;
}
export interface Study {
  version: 1;
  createdAt: string;
  board: Board;
  dataset: Manifest;
  options: SearchOptions;
  split: { start: number; trainEnd: number; validationEnd: number; end: number };
  coverage: { frames: number; minSymbols: number; maxSymbols: number; incompleteFrames: number };
  trials: Trial[];
  winner: Winner | null;
  membership: { symbol: string; appearances: number }[];
}
