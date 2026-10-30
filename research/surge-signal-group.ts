import type { Frame } from './types.ts';
import type { MinuteDataset } from './gainers-types.ts';
import { HOUR } from './types.ts';
import { MINUTE } from './gainers-types.ts';
import { calculateSma } from './peak-rebound-signals.ts';
import { computeMacd, calculateSupportMaAt } from '../src/macd.ts';
import type {
  SignalGroupSubStrategy,
  GroupShortSignal,
  BaseImpulseConfig,
  MaFactorConfig,
  MacdFactorConfig,
} from './surge-signal-group-types.ts';

/**
 * 冲高基底评估函数
 */
export function evaluateBaseImpulse(
  bars: any[],
  targetIdx: number,
  row: { rank: number; dayChange: number },
  cfg: BaseImpulseConfig,
): { qualified: boolean; surge: number; requiredSurge: number; minLow: number; maxHigh: number } | null {
  if (row.rank > cfg.topN || row.dayChange < cfg.minDayChange) {
    return null;
  }

  const window = cfg.windowMinutes;
  const startIdx = targetIdx - window + 1;
  if (startIdx < 0) return null;

  let minLow = Infinity;
  let maxHigh = -Infinity;
  for (let k = startIdx; k <= targetIdx; k++) {
    const l = bars[k][3];
    const h = bars[k][2];
    if (l < minLow) minLow = l;
    if (h > maxHigh) maxHigh = h;
  }

  if (minLow <= 0) return null;

  const curClose = bars[targetIdx][4];
  const curOpen = bars[targetIdx][1];
  const mode = cfg.surgeMode ?? 'trough-to-close';

  let surge = 0;
  if (mode === 'trough-to-close') {
    surge = ((curClose - minLow) / minLow) * 100;
  } else if (mode === 'trough-to-high') {
    surge = ((maxHigh - minLow) / minLow) * 100;
  } else if (mode === 'open-to-close') {
    const wOpen = bars[startIdx][1];
    surge = wOpen > 0 ? ((curClose - wOpen) / wOpen) * 100 : 0;
  }

  const requiredSurge = row.dayChange / cfg.nFactor;
  if (surge < requiredSurge) return null;

  const minAbs = cfg.minAbsoluteSurge ?? 4.0;
  if (minAbs > 0 && surge < minAbs) return null;

  return { qualified: true, surge, requiredSurge, minLow, maxHigh };
}

/**
 * 均线相关因子评估函数
 */
export function evaluateMaFactors(
  closes: number[],
  highs: number[],
  targetIdx: number,
  cfg: MaFactorConfig,
  candlesForMaSupport?: any[],
): { pass: boolean; maDeviation?: number; maResistance?: boolean } {
  const curClose = closes[targetIdx];
  const curHigh = highs[targetIdx];
  let maDev: number | undefined;

  // 1. 均线乖离因子 (超买乖离率)
  if (cfg.requireMaDeviation) {
    const period = cfg.deviationPeriod ?? 30;
    const ma = calculateSma(closes, targetIdx, period);
    if (ma == null || ma <= 0) return { pass: false };
    maDev = ((curClose - ma) / ma) * 100;
    const minDev = cfg.minDeviationPercent ?? 1.5;
    if (maDev < minDev) return { pass: false };
  }

  // 2. 均线悬空因子 (下方短均线无支撑)
  if (cfg.requireNoMaSupport && candlesForMaSupport) {
    const periods = cfg.supportPeriods ?? [3, 7, 15];
    const supportedMa = calculateSupportMaAt(candlesForMaSupport, targetIdx, periods);
    if (supportedMa !== null) return { pass: false };
  }

  // 3. 均线压制/阻击因子 (1mClose < MA < 1mHigh)
  let isResisting = false;
  if (cfg.requireMaResistance) {
    const period = cfg.resistanceMaPeriod ?? 5;
    const ma = calculateSma(closes, targetIdx, period);
    if (ma == null) return { pass: false };
    if (!(curClose < ma && ma < curHigh)) {
      return { pass: false };
    }
    isResisting = true;
  }

  // 4. 大级别趋势均线排列因子 (如 MA15 < MA30)
  if (cfg.requireBearishAlignment) {
    const fastP = cfg.trendFastPeriod ?? 15;
    const slowP = cfg.trendSlowPeriod ?? 30;
    const fastMa = calculateSma(closes, targetIdx, fastP);
    const slowMa = calculateSma(closes, targetIdx, slowP);
    if (fastMa == null || slowMa == null || !(fastMa < slowMa)) {
      return { pass: false };
    }
  }

  // 5. 均线下倾确认
  if (cfg.requireMaSlopeDown && targetIdx >= 2) {
    const slowP = cfg.trendSlowPeriod ?? 30;
    const curSlow = calculateSma(closes, targetIdx, slowP);
    const prevSlow = calculateSma(closes, targetIdx - 2, slowP);
    if (curSlow == null || prevSlow == null || curSlow >= prevSlow) {
      return { pass: false };
    }
  }

  return { pass: true, maDeviation: maDev, maResistance: isResisting };
}

/**
 * MACD 相关因子评估函数
 */
export function evaluateMacdFactors(
  closes: number[],
  highs: number[],
  targetIdx: number,
  cfg: MacdFactorConfig,
  hist: number[],
  dif: number[],
): { pass: boolean; isDivergent?: boolean; isHistRollover?: boolean; curHist?: number; curDif?: number } {
  if (hist.length <= targetIdx || dif.length <= targetIdx) {
    return { pass: false };
  }

  const curHist = hist[targetIdx];
  const curDif = dif[targetIdx];
  const curHigh = highs[targetIdx];

  // 1. MACD 双重顶背离因子 (Bearish Divergence)
  let isDivergent = false;
  if (cfg.requireDivergence) {
    const lookbackMin = cfg.divergenceLookbackMin ?? 10;
    const lookbackMax = cfg.divergenceLookbackMax ?? 120;
    const start = Math.max(0, targetIdx - lookbackMax);
    const end = Math.max(0, targetIdx - lookbackMin);

    if (end <= start) return { pass: false };

    let prevPeakIdx = -1;
    let prevPeakHigh = 0;
    for (let k = start; k <= end; k++) {
      if (highs[k] > prevPeakHigh) {
        prevPeakHigh = highs[k];
        prevPeakIdx = k;
      }
    }

    if (prevPeakIdx < 0 || curHigh < prevPeakHigh) {
      return { pass: false };
    }

    const prevHist = hist[prevPeakIdx];
    const prevDif = dif[prevPeakIdx];

    // 柱体顶背离: 当前 Hist 显著小于前高时的 Hist
    if (curHist >= prevHist) return { pass: false };

    // 双重背离: DIF 快线也必须背离
    if ((cfg.requireDoubleDivergence ?? true) && curDif >= prevDif) {
      return { pass: false };
    }

    isDivergent = true;
  }

  // 2. MACD 柱峰值回落/拐头因子 (Histogram Rollover)
  let isRollover = false;
  if (cfg.requireHistRollover) {
    if (targetIdx < 2) return { pass: false };
    const prev1 = hist[targetIdx - 1];
    const prev2 = hist[targetIdx - 2];

    // 前一根是峰值 (prev1 > prev2), 且当前根出现向下拐头 (curHist < prev1), 且此前处于多头绿柱
    const minPositive = cfg.minHistBarsPositive ?? 2;
    let positiveCount = 0;
    for (let k = targetIdx - 1; k >= Math.max(0, targetIdx - 10); k--) {
      if (hist[k] > 0) positiveCount++;
      else break;
    }

    if (positiveCount < minPositive || curHist >= prev1) {
      return { pass: false };
    }
    isRollover = true;
  }

  // 3. MACD 绿柱超饱和衰竭因子
  if (cfg.requireGreenExhaustion) {
    const gw = cfg.greenWindow ?? 20;
    const start = Math.max(0, targetIdx - gw + 1);
    let greenCount = 0;
    for (let k = start; k <= targetIdx; k++) {
      if (hist[k] > 0) greenCount++;
    }
    const ratio = greenCount / gw;
    const minRatio = cfg.minGreenRatio ?? 0.65;
    if (ratio < minRatio) return { pass: false };
  }

  return { pass: true, isDivergent, isHistRollover: isRollover, curHist, curDif };
}

/**
 * 扫描全市场标的，执行信号组策略生成
 */
export function scanSignalGroup(
  data: MinuteDataset,
  frames: Frame[],
  subStrategies: SignalGroupSubStrategy[],
  cooldownMinutes = 20,
): GroupShortSignal[] {
  // 建立小时榜单缓存
  const boards = new Map<number, Map<string, { rank: number; dayChange: number }>>();
  for (const frame of frames) {
    const symbolMap = new Map<string, { rank: number; dayChange: number }>();
    for (const obs of frame.boards.gainers) {
      symbolMap.set(obs.symbol, { rank: obs.rank, dayChange: obs.dayChange });
    }
    boards.set(frame.time, symbolMap);
  }

  const generatedSignals: GroupShortSignal[] = [];

  for (const [symbol, bars] of data.candles) {
    if (!bars || bars.length < 65) continue;

    const highs = bars.map((b) => b[2]);
    const lows = bars.map((b) => b[3]);
    const closes = bars.map((b) => b[4]);
    const opens = bars.map((b) => b[1]);
    const times = bars.map((b) => b[0]);

    // 预计算 MACD
    const { hist, dif } = computeMacd(closes);
    const candlesList = bars.map((b) => ({ time: b[0], open: b[1], high: b[2], low: b[3], close: b[4] }));

    let cooldownUntil = 0;

    for (let i = 35; i < bars.length - 1; i++) {
      const candleTime = times[i];
      if (candleTime < cooldownUntil) continue;

      const boardTime = Math.floor(candleTime / HOUR) * HOUR;
      const board = boards.get(boardTime);
      const row = board?.get(symbol);
      if (!row) continue;

      // 对每个子策略进行因子检验
      for (const strat of subStrategies) {
        // 1. 基底检验 (X 分钟内上涨达 24h / N)
        const baseRes = evaluateBaseImpulse(bars, i, row, strat.baseImpulse);
        if (!baseRes) continue;

        // 2. 均线因子检验
        const maRes = evaluateMaFactors(closes, highs, i, strat.maFactors, candlesList);
        if (!maRes.pass) continue;

        // 3. MACD 因子检验
        const macdRes = evaluateMacdFactors(closes, highs, i, strat.macdFactors, hist, dif);
        if (!macdRes.pass) continue;

        // 因子检验全部通过，产生开仓信号 (下一根 K 线开盘入场)
        const nextBar = bars[i + 1];
        if (!nextBar) continue;

        const totalRange = highs[i] - lows[i];
        const upperShadow = totalRange > 0 ? (highs[i] - Math.max(opens[i], closes[i])) / totalRange : 0;

        generatedSignals.push({
          id: `${strat.id}-${symbol}-${candleTime}`,
          subStrategyId: strat.id,
          subStrategyName: strat.name,
          symbol,
          time: nextBar[0],
          entryPrice: nextBar[1],
          index: i,
          boardTime,
          rank: row.rank,
          dayChangePercent: row.dayChange,
          windowMinutes: strat.baseImpulse.windowMinutes,
          nFactor: strat.baseImpulse.nFactor,
          surgePercent: baseRes.surge,
          requiredSurgePercent: baseRes.requiredSurge,
          maDeviation: maRes.maDeviation,
          upperShadowRatio: upperShadow,
          macdHist: macdRes.curHist,
          macdDif: macdRes.curDif,
          isDivergent: macdRes.isDivergent,
          isHistRollover: macdRes.isHistRollover,
          exitParams: strat.exitParams,
        });

        // 触发同币冷却
        cooldownUntil = candleTime + cooldownMinutes * MINUTE;
        break; // 本根 K 线命中优先级最高的子策略后，不重复触发其他子策略
      }
    }
  }

  return generatedSignals.sort((a, b) => a.time - b.time);
}
