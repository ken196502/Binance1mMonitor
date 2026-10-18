import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useKlines } from "../hooks/useKlines";
import type { ChartBar } from "../../../src/types.ts";

// 页面右侧的 1m 图表：主图 K 线 + 均线，副图 MACD(12,26,9)。
// 指标由后端 /api/klines 算好（与监控同源同口径），这里只负责渲染与交互。

const PANEL_BG = "#12161f";
const BORDER = "#232a38";
const MUTED = "#8b95a7";
const UP = "#2ecc71";
const DOWN = "#ff4d4f";

/** 均线配色，与表格里的色系保持一致的暗色可读性 */
const MA_COLORS: Record<number, string> = {
  5: "#f5a623",
  10: "#4d9dff",
  20: "#ff79c6",
  30: "#a78bfa",
  60: "#22d3ee",
};

/** K 线时间是 epoch 毫秒，lightweight-charts 要的是秒 */
function toTs(ms: number): UTCTimestamp {
  return Math.floor(ms / 1000) as UTCTimestamp;
}

/** 价格按量级自适应小数位，避免 BTC 和低价币都用同一个精度 */
function fmtPrice(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "-";
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toFixed(2);
  if (abs >= 1) return v.toFixed(4);
  return v.toFixed(6);
}

/** MACD 数值量级很小，用有效数字展示 */
function fmtSmall(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "-";
  if (v === 0) return "0";
  return String(Number(v.toPrecision(4)));
}

/** 期望的每根 K 线像素宽度：再窄蜡烛实体就会退化成 1px 竖线，看不出涨跌 */
const TARGET_BAR_SPACING = 8;
/** 右侧价格轴的大致占用，算可见根数时要扣掉 */
const PRICE_SCALE_WIDTH = 70;

/**
 * 首屏显示多少根 K 线：按容器宽度和目标像素宽度反推，而不是把 200 根全部 fitContent 进去。
 * 右栏只有半屏宽，硬塞 200 根会让每根只剩 3~4px（手机更窄只有 1~2px），
 * lightweight-charts 的蜡烛实体最小只画 1px，于是整屏只剩一排竖线（影线）。
 */
function defaultVisibleBars(hostWidth: number): number {
  const usable = Math.max(160, hostWidth - PRICE_SCALE_WIDTH - 8);
  return Math.max(30, Math.floor(usable / TARGET_BAR_SPACING));
}

interface ChartPanelProps {
  symbols: string[]; // 下拉可选标的（榜单 + 置顶）
  symbol: string; // 当前标的（受控：下拉与榜单点击都改它）
  onSymbolChange: (symbol: string) => void;
  active?: boolean; // 窄屏 tab 状态（与榜单保持一致，始终可见）
}

export function ChartPanel({ symbols, symbol, onSymbolChange, active }: ChartPanelProps) {
  const [hiddenMa, setHiddenMa] = useState<ReadonlySet<number>>(() => new Set<number>());
  const [hoverTime, setHoverTime] = useState<number | null>(null);

  const { data, error, loading } = useKlines(symbol);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const maRef = useRef<Map<number, ISeriesApi<"Line">>>(new Map());
  const histRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const difRef = useRef<ISeriesApi<"Line"> | null>(null);
  const deaRef = useRef<ISeriesApi<"Line"> | null>(null);
  // 记录上一次 setData 前的可见区间/长度，用于刷新后还原视野
  const viewRef = useRef<{ symbol: string | null; len: number }>({ symbol: null, len: 0 });
  const barsRef = useRef<Map<number, ChartBar>>(new Map());
  const hoverRef = useRef<number | null>(null);

  // 建图 + 建序列：只跑一次，之后靠 applyOptions / setData 更新
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: PANEL_BG },
        textColor: MUTED,
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(35,42,56,0.55)" },
        horzLines: { color: "rgba(35,42,56,0.55)" },
      },
      rightPriceScale: { borderColor: BORDER, scaleMargins: { top: 0.08, bottom: 0.06 } },
      timeScale: {
        borderColor: BORDER,
        rightOffset: 3,
        barSpacing: TARGET_BAR_SPACING,
        // 无论怎么缩放都不让每根低于 2px，否则又会退化成一排竖线
        minBarSpacing: 2,
        maxBarSpacing: 40,
        fixLeftEdge: true,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(230,237,243,0.35)", width: 1, style: 3, labelBackgroundColor: "#2a3140" },
        horzLine: { color: "rgba(230,237,243,0.35)", width: 1, style: 3, labelBackgroundColor: "#2a3140" },
      },
      localization: { locale: "zh-CN" },
    });

    candleRef.current = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceLineVisible: false,
    });

    // paneIndex=1 会新建副图，MACD 独占一个窗格，与主图共用时间轴/十字线
    histRef.current = chart.addSeries(
      HistogramSeries,
      { priceLineVisible: false, lastValueVisible: false },
      1,
    );
    difRef.current = chart.addSeries(
      LineSeries,
      { color: "#f5a623", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false },
      1,
    );
    deaRef.current = chart.addSeries(
      LineSeries,
      { color: "#4d9dff", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false },
      1,
    );

    const panes = chart.panes();
    if (panes.length > 1) {
      panes[0].setStretchFactor(3);
      panes[1].setStretchFactor(1);
    }
    histRef.current.priceScale().applyOptions({ scaleMargins: { top: 0.2, bottom: 0.05 } });

    const onCrosshair = (param: MouseEventParams<Time>) => {
      const t = param.time == null ? null : (param.time as number);
      // 十字线落在空白处或移出图表时，回落到最后一根 K 线
      const next = t != null && barsRef.current.has(t) ? t : null;
      if (next !== hoverRef.current) {
        hoverRef.current = next;
        setHoverTime(next);
      }
    };
    chart.subscribeCrosshairMove(onCrosshair);

    chartRef.current = chart;
    return () => {
      chart.unsubscribeCrosshairMove(onCrosshair);
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      histRef.current = null;
      difRef.current = null;
      deaRef.current = null;
      maRef.current = new Map();
      barsRef.current = new Map();
      viewRef.current = { symbol: null, len: 0 };
      hoverRef.current = null;
    };
  }, []);

  // 数据同步：建缺失的均线序列 + 写入全部序列，并在刷新后还原视野
  useEffect(() => {
    const chart = chartRef.current;
    const candle = candleRef.current;
    const hist = histRef.current;
    const dif = difRef.current;
    const dea = deaRef.current;
    if (!chart || !candle || !hist || !dif || !dea || !data) return;

    const periods = data.maPeriods;
    const map = maRef.current;
    for (const [period, series] of map) {
      if (!periods.includes(period)) {
        chart.removeSeries(series);
        map.delete(period);
      }
    }
    for (const period of periods) {
      if (map.has(period)) continue;
      map.set(
        period,
        chart.addSeries(
          LineSeries,
          {
            color: MA_COLORS[period] ?? "#ffffff",
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            visible: !hiddenMa.has(period),
          },
          0,
        ),
      );
    }

    const ts = chart.timeScale();
    const prevRange: LogicalRange | null = ts.getVisibleLogicalRange();
    const prev = viewRef.current;
    const symbolChanged = prev.symbol !== data.symbol;

    const barMap = new Map<number, ChartBar>();
    candle.setData(
      data.bars.map((b) => {
        const t = toTs(b.time);
        barMap.set(t, b);
        return { time: t, open: b.open, high: b.high, low: b.low, close: b.close };
      }),
    );
    for (const period of periods) {
      map.get(period)?.setData(
        data.bars
          .filter((b) => b.ma[String(period)] != null)
          .map((b) => ({ time: toTs(b.time), value: b.ma[String(period)] as number })),
      );
    }
    hist.setData(
      data.bars.map((b) => ({
        time: toTs(b.time),
        value: b.hist,
        color: b.hist >= 0 ? UP : DOWN,
      })),
    );
    dif.setData(data.bars.map((b) => ({ time: toTs(b.time), value: b.dif })));
    dea.setData(data.bars.map((b) => ({ time: toTs(b.time), value: b.dea })));

    if (symbolChanged || !prevRange) {
      // 首次加载 / 换标的：只显示"看得清"的最近若干根，而不是把全部历史压进一屏
      const len = data.bars.length;
      const visible = defaultVisibleBars(hostRef.current?.clientWidth ?? 0);
      if (visible >= len) ts.fitContent();
      else ts.setVisibleLogicalRange({ from: len - visible, to: len - 1 + 3 });
    } else if (prevRange.to >= prev.len - 1) {
      // 原本贴着最右侧 → 跟随最新一根；用户回看历史则保持原区间不动
      ts.scrollToRealTime();
    } else {
      ts.setVisibleLogicalRange(prevRange);
    }

    barsRef.current = barMap;
    viewRef.current = { symbol: data.symbol, len: data.bars.length };
    // hiddenMa 只影响可见性，由下面的 effect 处理，避免切换均线时重写全部数据
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // 均线显隐切换：只改可见性，不动数据与视野
  useEffect(() => {
    for (const [period, series] of maRef.current) {
      series.applyOptions({ visible: !hiddenMa.has(period) });
    }
  }, [hiddenMa]);

  const maPeriods = useMemo(() => data?.maPeriods ?? [], [data]);

  // 图例：默认显示最后一根 K 线，鼠标悬停时切到十字线所在的那根
  const lastBar = data && data.bars.length > 0 ? data.bars[data.bars.length - 1] : null;
  const shown = (hoverTime != null ? barsRef.current.get(hoverTime) : null) ?? lastBar;

  const toggleMa = (period: number) => {
    setHiddenMa((prev) => {
      const next = new Set(prev);
      if (next.has(period)) next.delete(period);
      else next.add(period);
      return next;
    });
  };

  // 下拉选项：去重后把当前 symbol 补进去（首帧数据未到时也不至于选不到）
  const options = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const s of [...symbols, symbol]) {
      if (!s || seen.has(s)) continue;
      seen.add(s);
      list.push(s);
    }
    return list;
  }, [symbols, symbol]);

  return (
    <section id="s2" className={`chart-panel${active ? " active" : ""}`}>
      <h2>
        1m K 线 · 均线 · MACD
        <span className="count">
          {data ? `${data.bars.length} 根 · ${data.source === "monitor" ? "实时缓存" : "REST"}` : "加载中…"}
        </span>
        <select
          className="chart-symbol"
          value={symbol}
          onChange={(e) => onSymbolChange(e.target.value)}
          aria-label="选择交易对"
        >
          {options.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </h2>

      <div className="chart-toolbar">
        {maPeriods.map((p) => (
          <button
            key={p}
            type="button"
            className={`ma-btn${hiddenMa.has(p) ? " off" : ""}`}
            style={{ color: MA_COLORS[p] ?? "#fff" }}
            onClick={() => toggleMa(p)}
            title={hiddenMa.has(p) ? `显示 MA${p}` : `隐藏 MA${p}`}
          >
            MA{p}
          </button>
        ))}
        {data && (
          <span className="chart-meta">
            MACD({data.macd.fast},{data.macd.slow},{data.macd.signal}) · 更新 {new Date(data.updatedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      <div className="chart-legend">
        {shown ? (
          <>
            <span className="lg-time">{new Date(shown.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            <span>开 <b>{fmtPrice(shown.open)}</b></span>
            <span>高 <b className="pos">{fmtPrice(shown.high)}</b></span>
            <span>低 <b className="neg">{fmtPrice(shown.low)}</b></span>
            <span>收 <b className={shown.close >= shown.open ? "pos" : "neg"}>{fmtPrice(shown.close)}</b></span>
            {maPeriods.map((p) => (
              <span key={p} style={{ color: MA_COLORS[p] ?? undefined }}>
                MA{p} <b>{fmtPrice(shown.ma[String(p)])}</b>
              </span>
            ))}
            <span className="muted">DIF <b className={shown.dif >= shown.dea ? "pos" : "neg"}>{fmtSmall(shown.dif)}</b></span>
            <span className="muted">DEA <b className={shown.dea >= 0 ? "pos" : "neg"}>{fmtSmall(shown.dea)}</b></span>
            <span className="muted">MACD <b className={shown.hist >= 0 ? "pos" : "neg"}>{fmtSmall(shown.hist)}</b></span>
          </>
        ) : (
          <span className="muted">等待数据…</span>
        )}
      </div>

      <div className="chart-host-wrap">
        <div className="chart-host" ref={hostRef} />
        {loading && <div className="chart-mask">加载中…</div>}
        {!loading && error && <div className="chart-mask err">K 线加载失败: {error}</div>}
      </div>
    </section>
  );
}
