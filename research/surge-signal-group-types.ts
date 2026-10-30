import type { Candle } from '../src/macd.ts';
import type { ExitReason } from './peak-rebound-types.ts';

/**
 * 冲高基底配置 (Base Impulse Foundation)
 * 24h 涨幅榜标的，在过去 X 分钟内上涨幅度达 24h 涨幅 / N
 */
export interface BaseImpulseConfig {
  topN: number;               // 涨幅榜排名过滤 (默认 10)
  minDayChange: number;       // 最小 24h 涨幅 (默认 20%)
  windowMinutes: number;      // X (冲高回溯窗口，分钟): 3, 5, 10, 15
  nFactor: number;            // N (涨幅除数): 3.0, 3.5, 4.0, 5.0, 8.0, 10.0
  minAbsoluteSurge?: number;  // 最小绝对冲高幅度底线 (%)，默认 4.0%
  surgeMode?: 'trough-to-close' | 'trough-to-high' | 'open-to-close';
}

/**
 * 均线相关因子参数 (Moving Average Factors)
 */
export interface MaFactorConfig {
  // 1. 均线乖离因子 (MA Extension / Deviation)
  requireMaDeviation?: boolean;
  deviationPeriod?: number;       // 基准均线，默认 30
  minDeviationPercent?: number;   // 最小乖离率 (%)，例如 1.5% 或 2.0%

  // 2. 均线悬空因子 (MA Floating / No Support)
  requireNoMaSupport?: boolean;
  supportPeriods?: readonly number[]; // 例如 [3, 7, 15]

  // 3. 均线压制/阻击因子 (MA Resistance / Pin Rejection)
  requireMaResistance?: boolean;
  resistanceMaPeriod?: number;    // 短周期阻击均线，例如 5 或 15 (1mClose < MA < 1mHigh)

  // 4. 大级别趋势排列因子 (MA Trend Alignment)
  requireBearishAlignment?: boolean; // 双均线空头排列 (如 MA15 < MA30)
  requireMaSlopeDown?: boolean;      // 中长均线向下倾斜确认
  trendFastPeriod?: number;          // 默认 15
  trendSlowPeriod?: number;          // 默认 30
}

/**
 * MACD 相关因子参数 (MACD Factors)
 */
export interface MacdFactorConfig {
  // 1. MACD 双重顶背离因子 (Bearish Divergence)
  requireDivergence?: boolean;
  divergenceLookbackMin?: number; // 默认 10
  divergenceLookbackMax?: number; // 默认 120
  requireDoubleDivergence?: boolean; // 要求 Hist 与 DIF 快线双重背离

  // 2. MACD 柱峰值回落/拐头因子 (Histogram Rollover / Peak Down)
  requireHistRollover?: boolean;  // 当前 Hist < 前一根 Hist，且前一根曾创新高
  minHistBarsPositive?: number;   // 拐头前绿柱连续数量 (如 >= 3)

  // 3. MACD 绿柱超饱和衰竭因子 (Green Ratio Climax)
  requireGreenExhaustion?: boolean;
  greenWindow?: number;           // 默认 20 或 30
  minGreenRatio?: number;         // 默认 0.65 或 0.70
}

/**
 * 信号组中的单个子策略定义 (Sub-Strategy Definition)
 */
export interface SignalGroupSubStrategy {
  id: string;
  name: string;
  description: string;
  baseImpulse: BaseImpulseConfig;
  maFactors: MaFactorConfig;
  macdFactors: MacdFactorConfig;
  // 退出参数
  exitParams: {
    holdMinutes: number;
    exitX: number;
    exitN: number;
    exitM: number;
  };
}

/**
 * 触发的做空信号 (Generated Group Signal)
 */
export interface GroupShortSignal {
  id: string;
  subStrategyId: string;
  subStrategyName: string;
  symbol: string;
  time: number;          // 下一根 K 线开盘入场时间
  entryPrice: number;    // 下一根 K 线的 open 价格
  index: number;
  boardTime: number;
  rank: number;
  dayChangePercent: number;
  // 基底指标
  windowMinutes: number;
  nFactor: number;
  surgePercent: number;
  requiredSurgePercent: number;
  // 因子特征快照
  maDeviation?: number;
  upperShadowRatio?: number;
  macdHist?: number;
  macdDif?: number;
  isDivergent?: boolean;
  isHistRollover?: boolean;
  maSupported?: boolean;
  exitParams: {
    holdMinutes: number;
    exitX: number;
    exitN: number;
    exitM: number;
  };
}
