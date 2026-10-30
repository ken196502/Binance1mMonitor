import type { Frame } from './types.ts';
import type { MinuteDataset } from './gainers-types.ts';
import { MINUTE } from './gainers-types.ts';
import { HOUR } from './types.ts';
import { calculateSma } from './peak-rebound-signals.ts';
import type { SurgeShortScanConfig, SurgeShortSignal } from './surge-short-types.ts';

/**
 * 冲高脉冲见顶做空信号生成器
 * 核心逻辑：24h 涨幅榜标的，在过去 x 分钟内爆发上涨幅度达 (24h涨幅 / N)
 */
export function buildSurgeShortSignals(
  data: MinuteDataset,
  frames: Frame[],
  config: SurgeShortScanConfig,
): SurgeShortSignal[] {
  const {
    topN = 10,
    minDayChange = 20,
    windowMinutes = 3,
    nFactor = 3.5,
    minAbsoluteSurge = 4.0,
    minMa30Deviation = 1.5,
    surgeMode = 'trough-to-close',
    requireRedCandle = false,
    minUpperShadow = 0,
    cooldownMinutes = 20,
  } = config;

  // 建立小时榜单缓存: hourTime -> Map(symbol, { rank, dayChange })
  const boards = new Map<number, Map<string, { rank: number; dayChange: number }>>();
  for (const frame of frames) {
    const symbolMap = new Map<string, { rank: number; dayChange: number }>();
    for (const obs of frame.boards.gainers) {
      symbolMap.set(obs.symbol, { rank: obs.rank, dayChange: obs.dayChange });
    }
    boards.set(frame.time, symbolMap);
  }

  const signals: SurgeShortSignal[] = [];

  for (const [symbol, bars] of data.candles) {
    if (!bars || bars.length < Math.max(windowMinutes + 5, 35)) continue;

    const highs = bars.map((b) => b[2]);
    const lows = bars.map((b) => b[3]);
    const closes = bars.map((b) => b[4]);
    const opens = bars.map((b) => b[1]);
    const times = bars.map((b) => b[0]);

    let cooldownUntil = 0;

    for (let i = Math.max(windowMinutes - 1, 30); i < bars.length - 1; i++) {
      const candleTime = times[i];
      if (candleTime < cooldownUntil) continue;

      // 确定当时榜单归属
      const boardTime = Math.floor(candleTime / HOUR) * HOUR;
      const board = boards.get(boardTime);
      const row = board?.get(symbol);

      // 1. 榜位与基础 24h 涨幅过滤
      if (!row || row.rank > topN || row.dayChange < minDayChange) continue;

      const dayChangePercent = row.dayChange;
      const requiredSurge = dayChangePercent / nFactor;

      // 2. 提取 x 分钟窗口极值
      const startIdx = i - windowMinutes + 1;
      let minLow = Infinity;
      let maxHigh = -Infinity;

      for (let k = startIdx; k <= i; k++) {
        if (lows[k] < minLow) minLow = lows[k];
        if (highs[k] > maxHigh) maxHigh = highs[k];
      }

      const curClose = closes[i];
      const curOpen = opens[i];
      const curHigh = highs[i];
      const curLow = lows[i];

      let actualSurge = 0;
      if (surgeMode === 'trough-to-close') {
        actualSurge = minLow > 0 ? ((curClose - minLow) / minLow) * 100 : 0;
      } else if (surgeMode === 'trough-to-high') {
        actualSurge = minLow > 0 ? ((maxHigh - minLow) / minLow) * 100 : 0;
      } else if (surgeMode === 'open-to-close') {
        const windowOpen = opens[startIdx];
        actualSurge = windowOpen > 0 ? ((curClose - windowOpen) / windowOpen) * 100 : 0;
      }

      // 3. 核心条件：x 分钟内涨幅达 24h / N，且满足绝对涨幅底线 (防微小波动被放大)
      if (actualSurge < requiredSurge) continue;
      if (minAbsoluteSurge > 0 && actualSurge < minAbsoluteSurge) continue;

      // 4. MA30 均线乖离过滤 (确认脉冲极端脱离基准均线)
      const ma30 = calculateSma(closes, i, 30) ?? curClose;
      const maDev = ((curClose - ma30) / ma30) * 100;
      if (minMa30Deviation > 0 && maDev < minMa30Deviation) continue;

      // 5. 形态过滤 (可选)
      const isRed = curClose < curOpen;
      if (requireRedCandle && !isRed) continue;

      const totalRange = curHigh - curLow;
      const upperShadow = totalRange > 0 ? (curHigh - Math.max(curOpen, curClose)) / totalRange : 0;
      if (minUpperShadow > 0 && upperShadow < minUpperShadow) continue;

      // 6. 入场价格为下一根 K 线的 Open
      const nextBar = bars[i + 1];
      if (!nextBar) continue;
      const signalTime = nextBar[0];
      const entryPrice = nextBar[1];

      signals.push({
        symbol,
        time: signalTime,
        entryPrice,
        index: i,
        boardTime,
        rank: row.rank,
        dayChangePercent,
        windowMinutes,
        nFactor,
        requiredSurgePercent: requiredSurge,
        surgePercent: actualSurge,
        lowPrice: minLow,
        highPrice: maxHigh,
        closePrice: curClose,
        ma30DeviationPercent: maDev,
        upperShadowRatio: upperShadow,
        isRedCandle: isRed,
      });

      // 冷却防重复开仓
      cooldownUntil = candleTime + cooldownMinutes * MINUTE;
    }
  }

  return signals.sort((a, b) => a.time - b.time);
}
