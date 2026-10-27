import path from 'node:path';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import { planWatchlistMinutes, loadWatchlistMinutes } from '../research/peak-rebound-data.ts';
import { backtestPeakRebound } from '../research/peak-rebound-backtest.ts';
import { calculateSma, getRank1Watchlist } from '../research/peak-rebound-signals.ts';
import type { Candle } from '../src/macd.ts';
import type { PeakReboundSignal } from '../research/peak-rebound-types.ts';

interface NewStrategyOptions {
  pullbackX: number; // 距离24h高点跌超过X%
  reboundY: number;  // 距最近15m最低点反弹超过Y%
  requireMa30Ceiling?: boolean; // 是否要求 ma30 >= high * 1.005
  requireSlopeDown?: boolean;   // 是否要求 ma30 向下倾斜
  requireMacdGreen?: boolean;   // 是否要求近20根绿柱占比 > 65%
  holdMinutes?: number;
  exitM?: number;
  useMa5?: boolean;
}

function runNewStrategyScan(
  minuteData: any,
  frames: any[],
  options: NewStrategyOptions
): PeakReboundSignal[] {
  const {
    pullbackX,
    reboundY,
    requireMa30Ceiling = false,
    requireSlopeDown = false,
    requireMacdGreen = false,
  } = options;

  // 获取处于 Top 10 或有过第一的标的
  const watchlist = getRank1Watchlist(frames);
  const signals: PeakReboundSignal[] = [];

  for (const [symbol, info] of watchlist.entries()) {
    const bars = minuteData.candles.get(symbol);
    if (!bars || bars.length < 65) continue;

    const watchStart = info.firstRank1Time;
    const watchEnd = info.lastRank1Time + 24 * 3600000;

    const closes = bars.map((b: any) => b[4]);
    const highs = bars.map((b: any) => b[2]);
    const lows = bars.map((b: any) => b[3]);

    let cooldownUntil = 0;

    for (let i = 60; i < bars.length - 1; i++) {
      const bar = bars[i];
      const time = bar[0];
      if (time < watchStart || time > watchEnd) continue;
      if (time < cooldownUntil) continue;

      const candle: Candle = {
        time,
        open: bar[1],
        high: bar[2],
        low: bar[3],
        close: bar[4],
        volume: bar[5],
      };

      // 1. 计算 24h 高点 (过去至多 1440 根 1m K 线)
      const start24h = Math.max(0, i - 1439);
      let high24h = 0;
      for (let k = start24h; k <= i; k++) {
        if (highs[k] > high24h) high24h = highs[k];
      }
      if (high24h <= 0) continue;

      // 距离 24h 高点跌超过 X% (以当前 close 或 high 衡量)
      const dropFrom24h = ((high24h - candle.close) / high24h) * 100;
      if (dropFrom24h < pullbackX) continue;

      // 2. 计算最近 15m 的最低点 (过去 15 根 K 线: [i - 14 ... i])
      const start15m = Math.max(0, i - 14);
      let low15m = Infinity;
      for (let k = start15m; k <= i; k++) {
        if (lows[k] < low15m) low15m = lows[k];
      }
      if (!Number.isFinite(low15m) || low15m <= 0) continue;

      // 和最近 15m 最低点比高 Y% (反弹超过 Y%)
      const reboundFrom15m = ((candle.high - low15m) / low15m) * 100;
      if (reboundFrom15m < reboundY) continue;

      // 3. 均线计算:
      const ma15 = calculateSma(closes, i, 15);
      const ma30 = calculateSma(closes, i, 30);
      if (ma15 == null || ma30 == null) continue;

      if (options.useMa5) {
        const ma5 = calculateSma(closes, i, 5);
        if (ma5 == null) continue;
        // MA5 阻击: 1mClose < ma5 < 1mHigh
        if (!(candle.close < ma5 && ma5 < candle.high)) continue;
        // 排列: ma5 < ma15 < ma30
        if (!(ma5 < ma15 && ma15 < ma30)) continue;
      } else {
        // 均线压制条件: 1mClose < ma15 < 1mHigh
        const isMa15Suppressed = candle.close < ma15 && ma15 < candle.high;
        if (!isMa15Suppressed) continue;

        // 均线排列条件: ma15 < ma30
        if (!(ma15 < ma30)) continue;
      }

      // 可选过滤: ma30 天花板 >= high * 1.005
      if (requireMa30Ceiling && ma30 < candle.high * 1.005) {
        continue;
      }

      // 可选过滤: ma30 向下倾斜
      if (requireSlopeDown && i >= 2) {
        const ma30Prev = calculateSma(closes, i - 2, 30);
        if (ma30Prev != null && ma30 > ma30Prev) continue;
      }

      // 可选过滤: MACD 20 根绿柱占比 > 65%
      if (requireMacdGreen) {
        // 计算 MACD
        // 这里若需要可加上，先测试纯形态
      }

      // 触发开仓信号 (下一根开盘入场)
      const nextBar = bars[i + 1];
      if (!nextBar) continue;

      signals.push({
        symbol,
        time: nextBar[0],
        entryTime: nextBar[0],
        entryPrice: nextBar[1], // next open
        index: i,
        boardTime: Math.floor(time / 3600000) * 3600000,
        dayChangePercent: 25,
        rank: 1,
        peakPrice: high24h,
        peakTime: time,
        pullbackPercent: dropFrom24h,
        troughPrice: low15m,
        troughTime: time,
        reboundPercent: reboundFrom15m,
        fibRetracement: 0,
        reboundUpCandles: 0,
        upperShadowRatio: 0,
        shortMa: 15,
        mediumMa: 30,
        longMa: 30,
        longMaOffsetPercent: 0,
        greenRatio20: 0,
        maPeriod: 15,
        maPeriods: [15, 30],
        maValues: { 15: ma15, 30: ma30 },
        close: candle.close,
        high: candle.high,
        low: candle.low,
        open: candle.open,
      });

      // 冷却时间: 30 分钟防同一标的连续刷单
      cooldownUntil = time + 30 * 60 * 1000;
    }
  }

  return signals.sort((a, b) => a.time - b.time);
}

async function main() {
  console.log('================================================================');
  console.log('🧪【新策略回测】24h跌幅超X% + 15m低点反弹Y% + 1mClose<ma15<1mHigh + ma15<ma30');
  console.log('================================================================\n');

  const hourlyDir = path.resolve('data/research/hourly-168h');
  const minutesDir = path.resolve('data/research/peak-rebound-1m-168h');

  console.log('正在载入 168 小时全市场历史数据...');
  const hourly = await loadDataset(hourlyDir);
  const frames = buildFrames(hourly, 10, 1);
  const plan = planWatchlistMinutes(hourly, frames);
  const minuteData = await loadWatchlistMinutes(minutesDir, plan);
  console.log(`成功载入 ${minuteData.candles.size} 个榜首标的 1m 高精度行情数据。\n`);

  // 基准: 原策略 MA 5/15/30
  const baseSignals = (await import('../research/peak-rebound-signals.ts')).buildPeakReboundSignals(minuteData, frames, {
    pullbackX: 10.0,
    reboundY: 4.0,
    shortMa: 5,
    mediumMa: 15,
    longMa: 30,
    longMaOffsetPercent: 0.5,
    minGreenRatio20: 0.65,
    requireMaSlopeDown: true,
  });
  const baseRes = backtestPeakRebound(
    minuteData,
    baseSignals,
    { pullbackX: 10.0, reboundY: 4.0, maPeriods: [5, 15, 30], holdMinutes: 45, exitX: 35, exitN: 2.0, exitM: 3.0 },
    hourly.manifest.start,
    hourly.manifest.end,
    { takerFeeBps: 5, slippageBps: 2 }
  );

  console.log(`原基准 (MA 5/15/30): 交易 ${baseRes.metrics.trades} 笔, 胜率 ${baseRes.metrics.winRate?.toFixed(1)}%, 净收益 ${baseRes.metrics.netPnlPercent.toFixed(2)}%, 盈利因子 ${baseRes.metrics.profitFactor?.toFixed(2)}\n`);

  // 网格搜索不同 X 和 Y 参数
  const xValues = [8, 10, 12, 15];
  const yValues = [1.5, 2.0, 2.5, 3.0, 4.0];

  console.log('-----------------------------------------------------------------------------------------------------------------------------------------');
  console.log('📊 纯形态方案网格扫描: 1mClose < ma15 < 1mHigh + ma15 < ma30 (m=3.0, 45m)');
  console.log('-----------------------------------------------------------------------------------------------------------------------------------------');
  console.log(
    '参数组合 (X%, Y%)'.padEnd(24) +
    '信号'.padStart(6) +
    '交易'.padStart(6) +
    '胜率'.padStart(8) +
    '净收益%'.padStart(10) +
    '盈利因子'.padStart(10) +
    '盈亏比'.padStart(8) +
    '段2止盈'.padStart(9) +
    '段2超时'.padStart(9) +
    '段2止损'.padStart(9)
  );
  console.log('-----------------------------------------------------------------------------------------------------------------------------------------');

  const gridResults: any[] = [];

  for (const x of xValues) {
    for (const y of yValues) {
      const sigs = runNewStrategyScan(minuteData, frames, {
        pullbackX: x,
        reboundY: y,
        requireMa30Ceiling: false,
        requireSlopeDown: false,
      });

      const { metrics, trades } = backtestPeakRebound(
        minuteData,
        sigs,
        { pullbackX: x, reboundY: y, maPeriods: [15, 30], holdMinutes: 45, exitX: 35, exitN: 2.0, exitM: 3.0 },
        hourly.manifest.start,
        hourly.manifest.end,
        { takerFeeBps: 5, slippageBps: 2 }
      );

      const s2Target = trades.filter((t) => t.exits[1]?.reason === 'target').length;
      const s2Timeout = trades.filter((t) => t.exits[1]?.reason === 'timeout').length;
      const s2Stop = trades.filter((t) => t.exits[1]?.reason === 'stop').length;

      const row = {
        name: `X=${x}%, Y=${y}%`,
        x,
        y,
        signals: sigs.length,
        trades: metrics.trades,
        winRate: metrics.winRate ?? 0,
        netPnl: metrics.netPnlPercent,
        profitFactor: metrics.profitFactor ?? 0,
        rewardRisk: metrics.realizedRewardRisk ?? 0,
        s2Target,
        s2Timeout,
        s2Stop,
      };
      gridResults.push(row);

      console.log(
        row.name.padEnd(24) +
        String(row.signals).padStart(6) +
        String(row.trades).padStart(6) +
        `${row.winRate.toFixed(1)}%`.padStart(8) +
        `${row.netPnl >= 0 ? '+' : ''}${row.netPnl.toFixed(2)}%`.padStart(10) +
        row.profitFactor.toFixed(2).padStart(10) +
        row.rewardRisk.toFixed(2).padStart(8) +
        String(row.s2Target).padStart(9) +
        String(row.s2Timeout).padStart(9) +
        String(row.s2Stop).padStart(9)
      );
    }
  }

  console.log('-----------------------------------------------------------------------------------------------------------------------------------------\n');

  // 测试加上 MA30 压制 >= 0.5% 和 向下倾斜的增强版
  console.log('-----------------------------------------------------------------------------------------------------------------------------------------');
  console.log('📊 增强过滤对比 (加入 MA30 高出高点 >= 0.5% + MA30 向下倾斜确认)');
  console.log('-----------------------------------------------------------------------------------------------------------------------------------------');
  console.log(
    '方案名称'.padEnd(46) +
    '信号'.padStart(6) +
    '交易'.padStart(6) +
    '胜率'.padStart(8) +
    '净收益%'.padStart(10) +
    '盈利因子'.padStart(10) +
    '盈亏比'.padStart(8) +
    '段2止盈'.padStart(9) +
    '段2超时'.padStart(9) +
    '段2止损'.padStart(9)
  );
  console.log('-----------------------------------------------------------------------------------------------------------------------------------------');

  const filterExps = [
    { name: 'X=10%, Y=2.0% + MA30压制>=0.5%', opt: { pullbackX: 10, reboundY: 2.0, requireMa30Ceiling: true, requireSlopeDown: false } },
    { name: 'X=10%, Y=2.0% + MA30压制>=0.5% + 下倾', opt: { pullbackX: 10, reboundY: 2.0, requireMa30Ceiling: true, requireSlopeDown: true } },
    { name: 'X=10%, Y=2.5% + MA30压制>=0.5% + 下倾', opt: { pullbackX: 10, reboundY: 2.5, requireMa30Ceiling: true, requireSlopeDown: true } },
    { name: 'X=10%, Y=3.0% + MA30压制>=0.5% + 下倾', opt: { pullbackX: 10, reboundY: 3.0, requireMa30Ceiling: true, requireSlopeDown: true } },
    { name: 'X=12%, Y=2.0% + MA30压制>=0.5% + 下倾', opt: { pullbackX: 12, reboundY: 2.0, requireMa30Ceiling: true, requireSlopeDown: true } },
    { name: 'X=15%, Y=2.0% + MA30压制>=0.5% + 下倾', opt: { pullbackX: 15, reboundY: 2.0, requireMa30Ceiling: true, requireSlopeDown: true } },
    { name: 'X=10%, Y=2.0% + MA30压制 + 持仓30m (m=1.5)', opt: { pullbackX: 10, reboundY: 2.0, requireMa30Ceiling: true, requireSlopeDown: true, holdMinutes: 30, exitM: 1.5 } },
    // 对比延伸: 改用 MA5 阻击 (1mClose < ma5 < 1mHigh, ma5 < ma15 < ma30)
    { name: '对比: 改用 MA5 阻击 (X=10%, Y=2.0%, MA30压制+下倾)', opt: { pullbackX: 10, reboundY: 2.0, requireMa30Ceiling: true, requireSlopeDown: true, useMa5: true } },
    { name: '对比: 改用 MA5 阻击 (X=10%, Y=3.0%, MA30压制+下倾)', opt: { pullbackX: 10, reboundY: 3.0, requireMa30Ceiling: true, requireSlopeDown: true, useMa5: true } },
  ];

  for (const exp of filterExps) {
    const sigs = runNewStrategyScan(minuteData, frames, exp.opt);
    const hold = exp.opt.holdMinutes ?? 45;
    const m = exp.opt.exitM ?? 3.0;

    const { metrics, trades } = backtestPeakRebound(
      minuteData,
      sigs,
      { pullbackX: exp.opt.pullbackX, reboundY: exp.opt.reboundY, maPeriods: [15, 30], holdMinutes: hold, exitX: 35, exitN: 2.0, exitM: m },
      hourly.manifest.start,
      hourly.manifest.end,
      { takerFeeBps: 5, slippageBps: 2 }
    );

    const s2Target = trades.filter((t) => t.exits[1]?.reason === 'target').length;
    const s2Timeout = trades.filter((t) => t.exits[1]?.reason === 'timeout').length;
    const s2Stop = trades.filter((t) => t.exits[1]?.reason === 'stop').length;

    console.log(
      exp.name.padEnd(46) +
      String(sigs.length).padStart(6) +
      String(metrics.trades).padStart(6) +
      `${(metrics.winRate ?? 0).toFixed(1)}%`.padStart(8) +
      `${metrics.netPnlPercent >= 0 ? '+' : ''}${metrics.netPnlPercent.toFixed(2)}%`.padStart(10) +
      (metrics.profitFactor ?? 0).toFixed(2).padStart(10) +
      (metrics.realizedRewardRisk ?? 0).toFixed(2).padStart(8) +
      String(s2Target).padStart(9) +
      String(s2Timeout).padStart(9) +
      String(s2Stop).padStart(9)
    );
  }
  console.log('-----------------------------------------------------------------------------------------------------------------------------------------\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
