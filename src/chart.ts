// 图表数据组装：把 1m K 线算成前端 lightweight-charts 可直接消费的 bars（均线 + MACD）。
// 指标复用 macd.ts 的 ema / computeMacd，与监控表格里的 MACD、均线支撑完全同源同口径，
// 页面上看到的数值和告警逻辑用的是同一份计算结果。

import { computeMacd, type Candle } from "./macd.ts";
import type { ChartBar, ChartPayload } from "./types.ts";

/** 图表叠加的均线周期（仅用于显示，与 SUPPORT_MA_PERIODS 的支撑判定相互独立） */
export const CHART_MA_PERIODS = [5, 10, 20, 30, 60] as const;

/** MACD 参数，与监控默认一致（12 / 26 / 9） */
export const CHART_MACD = { fast: 12, slow: 26, signal: 9 } as const;

export const CHART_DEFAULT_LIMIT = 200;
export const CHART_MAX_LIMIT = 500;

/** 简单移动平均。不足 period 根的位置返回 null，前端渲染成断点，不画"假线"。 */
export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * 把 K 线序列转成图表 payload。最后一根可能是未收盘的实时 K 线（监控侧由 WS 推进），
 * 前端照常绘制为当前这根。
 */
export function buildChartPayload(
  symbol: string,
  candles: Candle[],
  source: ChartPayload["source"],
): ChartPayload {
  const closes = candles.map((c) => c.close);
  const maSeries = new Map<number, (number | null)[]>(
    CHART_MA_PERIODS.map((p) => [p, sma(closes, p)]),
  );
  const { dif, dea, hist } = computeMacd(closes, CHART_MACD.fast, CHART_MACD.slow, CHART_MACD.signal);

  const bars: ChartBar[] = candles.map((c, i) => {
    const ma: Record<string, number | null> = {};
    for (const period of CHART_MA_PERIODS) {
      ma[String(period)] = maSeries.get(period)?.[i] ?? null;
    }
    return {
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      ma,
      dif: dif[i],
      dea: dea[i],
      hist: hist[i],
    };
  });

  return {
    symbol,
    interval: "1m",
    updatedAt: new Date().toISOString(),
    source,
    maPeriods: [...CHART_MA_PERIODS],
    macd: { ...CHART_MACD },
    bars,
  };
}

/** 清洗 /api/klines 的查询参数：symbol 只允许字母数字（防注入），limit 夹在合理区间 */
export function parseChartQuery(rawSymbol: string | null, rawLimit: string | null): {
  symbol: string;
  limit: number;
} | null {
  const symbol = (rawSymbol ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{4,24}$/.test(symbol)) return null;
  const parsed = Number(rawLimit);
  const limit = Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.trunc(parsed), CHART_MAX_LIMIT)
    : CHART_DEFAULT_LIMIT;
  return { symbol, limit: Math.max(limit, 60) };
}
