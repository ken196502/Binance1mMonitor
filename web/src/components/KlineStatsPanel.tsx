import React, { useState } from "react";
import type {
  ChartBar,
  IntervalSignal,
} from "../../../src/types.ts";
import {
  analyzeMaAlignment,
  analyzeOhlcComparison,
  analyzeMacdStats,
} from "../../../src/kline-stats.ts";

interface KlineStatsPanelProps {
  symbol: string;
  bars: ChartBar[];
  dayChangePercent?: number | null;
  hoverIndex?: number | null;
  onSelectTime: (timeMs: number) => void;
  windowMinutes: number;
  onWindowMinutesChange: (w: number) => void;
  mode: "surge" | "drop" | "both";
  onModeChange: (m: "surge" | "drop" | "both") => void;
  showMarkers: boolean;
  onToggleMarkers: () => void;
  signals: IntervalSignal[];
}

export function KlineStatsPanel({
  symbol: _symbol,
  bars,
  dayChangePercent,
  hoverIndex,
  onSelectTime,
  windowMinutes,
  onWindowMinutesChange,
  mode,
  onModeChange,
  showMarkers,
  onToggleMarkers,
  signals,
}: KlineStatsPanelProps) {
  const [tableCollapsed, setTableCollapsed] = useState(false);

  // 当前聚焦的 K 线索引（悬停十字线所在的索引，或最后一根收盘/实时 K 线）
  const activeIdx =
    hoverIndex != null && hoverIndex >= 0 && hoverIndex < bars.length
      ? hoverIndex
      : bars.length - 1;

  const currentBar = bars[activeIdx];
  const fallbackMa = analyzeMaAlignment(bars, activeIdx);
  const fallbackOhlc = analyzeOhlcComparison(bars, activeIdx);
  const fallbackMacd = analyzeMacdStats(bars, activeIdx);

  const effectiveDc =
    typeof dayChangePercent === "number" && Number.isFinite(dayChangePercent)
      ? dayChangePercent
      : bars.length >= 2 && bars[0].open > 0
      ? ((bars[bars.length - 1].close - bars[0].open) / bars[0].open) * 100
      : 0;

  // 匹配当前聚焦 K 线所在区间的最大振幅段信号
  const activeBarTime = currentBar ? currentBar.time : 0;
  const activeSignal =
    signals.find((s) => {
      if (s.intervalStartTime != null && s.intervalEndTime != null) {
        return activeBarTime >= s.intervalStartTime && activeBarTime < s.intervalEndTime;
      }
      return false;
    }) ??
    signals.find((s) => Math.abs(s.time - activeBarTime) < windowMinutes * 60_000) ??
    signals[0] ??
    null;

  // 提取该达标振幅段“启动前一段区间”的前兆特征
  const pre = activeSignal?.precursor ?? null;
  const dispMa = pre ? pre.maAlignment : fallbackMa;
  const dispOhlc = pre ? pre.ohlc : fallbackOhlc;
  const dispMacd = pre ? pre.macd : fallbackMacd;

  const formatPrice = (v: number | null | undefined) => {
    if (v == null || !Number.isFinite(v)) return "-";
    const abs = Math.abs(v);
    if (abs >= 1000) return v.toFixed(2);
    if (abs >= 1) return v.toFixed(4);
    return v.toFixed(6);
  };

  const formatTime = (ts?: number | null) => {
    if (!ts || !Number.isFinite(ts)) return "-";
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  const getMaTagClass = (type: string) => {
    switch (type) {
      case "bullish_full":
        return "tag-bull-full";
      case "bullish_short":
        return "tag-bull-short";
      case "bearish_full":
        return "tag-bear-full";
      case "bearish_short":
        return "tag-bear-short";
      default:
        return "tag-tangled";
    }
  };

  return (
    <div className="kline-stats-container">
      {/* 顶部量化参数与过滤栏 */}
      <div className="stats-toolbar">
        <div className="toolbar-group">
          <span className="toolbar-label">区间窗口:</span>
          {[3, 5, 10, 15, 30].map((w) => (
            <button
              key={w}
              type="button"
              className={`filter-btn ${windowMinutes === w ? "active" : ""}`}
              onClick={() => onWindowMinutesChange(w)}
            >
              {w}m
            </button>
          ))}
        </div>

        <div className="toolbar-group">
          <span className="toolbar-label">方向:</span>
          {[
            { m: "both", label: "全部" },
            { m: "surge", label: "冲高 🚀" },
            { m: "drop", label: "回撤 🔻" },
          ].map((item) => (
            <button
              key={item.m}
              type="button"
              className={`filter-btn ${mode === item.m ? "active" : ""}`}
              onClick={() => onModeChange(item.m as "surge" | "drop" | "both")}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="toolbar-group ml-auto">
          <label className="toggle-label" title="在K线图表上用箭头与文字标记出所有区间的最大振幅段">
            <input
              type="checkbox"
              checked={showMarkers}
              onChange={onToggleMarkers}
            />
            <span>图表标注 ({signals.length} 处)</span>
          </label>
        </div>
      </div>

      {/* 实时/光标所处 K 线量化特征四卡片 */}
      <div className="stats-cards-grid">
        {/* 卡片 1: 起爆前均线形态 (前一段区间，比对最近3根1mK线演变) */}
        <div className="stats-card">
          <div className="card-header">
            <span className="card-title">📈 起爆前均线形态 (前一段)</span>
            <div className="badge-group">
              <span className={`status-badge ${getMaTagClass(dispMa.type)}`}>
                {dispMa.label}
              </span>
              {dispMa.pattern3BarsLabel && (
                <span
                  className={`status-badge-sm ${
                    dispMa.pattern3Bars?.includes("bull")
                      ? "tag-bull-short"
                      : dispMa.pattern3Bars?.includes("bear")
                      ? "tag-bear-short"
                      : "tag-tangled"
                  }`}
                  title="比对最近 3 根 1m K 线的均线动态演变"
                >
                  {dispMa.pattern3BarsLabel}
                  {dispMa.streakBars != null && dispMa.streakBars > 1 ? ` · 连${dispMa.streakBars}根` : ""}
                </span>
              )}
            </div>
          </div>
          <div className="card-body">
            {dispMa.transitionText && (
              <div
                className="ma-transition-path"
                title="比对起爆前最近 3 根 1m K 线的均线排列演变过程 (T-2 ➔ T-1 ➔ T0)"
              >
                <span className="path-label">3根分时演变:</span>
                <span className="path-val">{dispMa.transitionText}</span>
              </div>
            )}
            <div className="ma-sequence" title="起爆点各周期均线按数值从高到低排列">
              {dispMa.orderText || "-"}
            </div>
            <div className="ma-trend-list">
              {dispMa.order.map((p) => {
                const item = dispMa.mas[p];
                if (!item) return null;
                const slopeIcon =
                  item.slope === "up" ? "↗" : item.slope === "down" ? "↘" : "➔";
                const slopeClass =
                  item.slope === "up" ? "pos" : item.slope === "down" ? "neg" : "muted";
                return (
                  <div key={p} className="ma-trend-item">
                    <span className="ma-name">MA{p}:</span>
                    <span className="ma-val">{formatPrice(item.value)}</span>
                    <span className={`ma-slope ${slopeClass}`} title={`趋势 ${item.slope}`}>
                      {slopeIcon}
                    </span>
                    <span
                      className={`ma-bias ${item.biasPercent >= 0 ? "pos" : "neg"}`}
                      title="起爆点收盘价与均线乖离率"
                    >
                      {item.biasPercent >= 0 ? "+" : ""}
                      {item.biasPercent.toFixed(1)}%
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* 卡片 2: 起爆前形态 / MA支撑 (前一段区间) */}
        <div className="stats-card">
          <div className="card-header">
            <span className="card-title">🕯️ 起爆前形态 / MA支撑</span>
            <span className="status-badge tag-highlight">
              站上 {dispOhlc.aboveCount}/5 条均线
            </span>
          </div>
          <div className="card-body">
            <div className="ohlc-summary">
              <span className="ohlc-item">
                实体:{" "}
                <b className={dispOhlc.bodyPercent >= 0 ? "pos" : "neg"}>
                  {dispOhlc.bodyPercent >= 0 ? "+" : ""}
                  {dispOhlc.bodyPercent.toFixed(2)}%
                </b>
              </span>
              <span className="ohlc-item">
                上影: <b className="neg">{dispOhlc.upperWickPercent.toFixed(2)}%</b>
              </span>
              <span className="ohlc-item">
                下影: <b className="pos">{dispOhlc.lowerWickPercent.toFixed(2)}%</b>
              </span>
            </div>
            <div className="ma-interaction-tags">
              {dispOhlc.supports.length > 0 && (
                <div className="tag-group">
                  <span className="interaction-label pos-label">起爆前支撑:</span>
                  {dispOhlc.supports.map((p) => (
                    <span key={p} className="tag tag-support" title="起爆前探底回踩此均线并收回在上方">
                      MA{p} 支撑
                    </span>
                  ))}
                </div>
              )}
              {dispOhlc.resistances.length > 0 && (
                <div className="tag-group">
                  <span className="interaction-label neg-label">起爆前压制:</span>
                  {dispOhlc.resistances.map((p) => (
                    <span key={p} className="tag tag-resist" title="冲高测试此均线受阻">
                      MA{p} 压制
                    </span>
                  ))}
                </div>
              )}
              {dispOhlc.supports.length === 0 && dispOhlc.resistances.length === 0 && (
                <div className="muted interaction-none">
                  {dispOhlc.aboveCount === 5
                    ? "多头蓄势，运行在所有均线上方"
                    : dispOhlc.aboveCount === 0
                    ? "受所有均线压制"
                    : "在均线密集带内整理蓄势"}
                </div>
              )}
            </div>
            {pre != null && (
              <div className="metric-row" style={{ marginTop: "4px", borderTop: "1px dashed rgba(255,255,255,0.06)", paddingTop: "4px" }}>
                <span className="metric-name">前区间蓄势振幅:</span>
                <span className="metric-val muted">
                  {pre.preAmpPercent.toFixed(2)}% (跨度 {pre.totalBars}m)
                </span>
              </div>
            )}
          </div>
        </div>

        {/* 卡片 3: 起爆前 MACD 绿柱比例 (前一段区间) */}
        <div className="stats-card">
          <div className="card-header">
            <span className="card-title">📊 起爆前 MACD 绿柱比例</span>
            <span
              className={`status-badge ${
                dispMacd.isBullishCross && dispMacd.isAboveZero
                  ? "tag-bull-full"
                  : dispMacd.isBullishCross
                  ? "tag-bull-short"
                  : "tag-bear-short"
              }`}
            >
              起爆前: {dispMacd.isAboveZero ? "零上" : "零下"} · {dispMacd.isBullishCross ? "金叉" : "死叉"}
            </span>
          </div>
          <div className="card-body">
            {/* 前一段区间绿柱进度条 (前兆特征) */}
            <div className="ratio-bar-wrap">
              <div className="ratio-bar-info">
                <span>前一段区间绿柱比例 (前兆):</span>
                <b>
                  {pre != null
                    ? `${(pre.greenRatio * 100).toFixed(1)}% (${pre.greenCount}/${pre.totalBars}根)`
                    : "-"}
                </b>
              </div>
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{
                    width: `${Math.min(100, (pre?.greenRatio ?? 0) * 100)}%`,
                  }}
                />
              </div>
            </div>

            {/* 紧随爆发段内绿柱进度条 */}
            <div className="ratio-bar-wrap">
              <div className="ratio-bar-info">
                <span>紧随爆发段内绿柱:</span>
                <b>
                  {activeSignal != null && activeSignal.segmentGreenRatio != null
                    ? `${(activeSignal.segmentGreenRatio * 100).toFixed(1)}% (${activeSignal.segmentGreenCount}/${activeSignal.segmentBarsCount}根)`
                    : "-"}
                </b>
              </div>
              <div className="progress-track">
                <div
                  className="progress-fill short-term"
                  style={{
                    width: `${Math.min(
                      100,
                      (activeSignal?.segmentGreenRatio ?? 0) * 100,
                    )}%`,
                  }}
                />
              </div>
            </div>

            <div className="macd-streak-info">
              {dispMacd.greenStreak > 0 ? (
                <span className="pos">
                  🔥 起爆前连绿 <b>{dispMacd.greenStreak}</b> 根
                </span>
              ) : dispMacd.redStreak > 0 ? (
                <span className="neg">
                  ❄️ 起爆前连红 <b>{dispMacd.redStreak}</b> 根
                </span>
              ) : (
                <span className="muted">柱线平稳</span>
              )}
              <span className="muted ml-auto">
                起爆 Hist: <b>{dispMacd.hist.toFixed(4)}</b>
              </span>
            </div>
          </div>
        </div>

        {/* 卡片 4: 紧随爆发段振幅与 24h 比例 */}
        <div className="stats-card">
          <div className="card-header">
            <span className="card-title">🎯 紧随爆发振幅与 24h 比例</span>
            <span
              className={`status-badge ${
                activeSignal?.type === "surge" ? "tag-bull-full" : "tag-bear-short"
              }`}
            >
              {activeSignal ? (activeSignal.type === "surge" ? "冲高段 🚀" : "回撤段 🔻") : "-"}
            </span>
          </div>
          <div className="card-body">
            <div className="metric-row">
              <span className="metric-name">24h 涨幅:</span>
              <span className={`metric-val ${effectiveDc >= 0 ? "pos" : "neg"}`}>
                {effectiveDc >= 0 ? "+" : ""}
                {effectiveDc.toFixed(2)}%
              </span>
            </div>
            <div className="metric-row">
              <span className="metric-name">紧随爆发最大振幅:</span>
              <span
                className={`metric-val ${
                  activeSignal?.type === "surge" ? "pos" : "neg"
                }`}
              >
                {activeSignal
                  ? `${activeSignal.type === "surge" ? "+" : "-"}${activeSignal.intervalChangePercent.toFixed(2)}%`
                  : "-"}
              </span>
            </div>
            <div className="metric-row">
              <span className="metric-name">该段振幅 / 24h:</span>
              <span className="metric-val pos bold">
                {activeSignal ? (
                  <>
                    {(activeSignal.ratioToDayChange * 100).toFixed(1)}%
                    {activeSignal.divisor > 0 && (
                      <span className="sub-ratio">
                        (24h/{activeSignal.divisor.toFixed(1)})
                      </span>
                    )}
                  </>
                ) : (
                  "-"
                )}
              </span>
            </div>
            <div className="metric-row">
              <span className="metric-name">爆发跨度 / 点位:</span>
              <span className="metric-val muted" style={{ fontSize: "10px" }}>
                {activeSignal ? (
                  `${activeSignal.segmentBarsCount ?? 0}m · ${formatPrice(
                    activeSignal.segmentStartPrice,
                  )} → ${formatPrice(activeSignal.segmentEndPrice)}`
                ) : (
                  "-"
                )}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 达标区间历史表格 */}
      <div className="stats-table-section">
        <div
          className="table-header-bar"
          onClick={() => setTableCollapsed((prev) => !prev)}
        >
          <span className="table-title">
            📋 检出区间最大振幅段与起爆前特征 ({signals.length} 个区间)
            <span className="table-hint">
              按 {windowMinutes}m 划分 · 统计该达标振幅前一段区间的均线形态与 MACD 绿柱率
            </span>
          </span>
          <button type="button" className="collapse-btn">
            {tableCollapsed ? "展开 ▼" : "折叠 ▲"}
          </button>
        </div>

        {!tableCollapsed && (
          <div className="table-responsive">
            {signals.length === 0 ? (
              <div className="empty-signals">
                在当前 1m K 线数据中，暂无对应的 {windowMinutes}m 区间数据。
              </div>
            ) : (
              <table className="signals-table">
                <thead>
                  <tr>
                    <th>区间时间</th>
                    <th>爆发振幅段 (耗时)</th>
                    <th>类型</th>
                    <th>爆发振幅</th>
                    <th>占24h比例</th>
                    <th>【起爆前】均线支撑/排列</th>
                    <th>【起爆前】MACD绿柱率</th>
                    <th>【起爆前】蓄势振幅</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {signals.map((s, idx) => {
                    const isSurge = s.type === "surge";
                    const intervalStartStr = s.intervalStartTime
                      ? new Date(s.intervalStartTime).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "-";
                    const intervalEndStr = s.intervalEndTime
                      ? new Date(s.intervalEndTime).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "-";
                    const segStartStr = s.segmentStartTime
                      ? new Date(s.segmentStartTime).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "-";
                    const segEndStr = s.segmentEndTime
                      ? new Date(s.segmentEndTime).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "-";

                    const preItem = s.precursor;

                    return (
                      <tr key={`${s.time}-${idx}`}>
                        <td className="time-col" title={`区间: ${intervalStartStr} ~ ${intervalEndStr}`}>
                          {intervalStartStr} - {intervalEndStr}
                        </td>
                        <td className="muted" style={{ fontSize: "11px", whiteSpace: "nowrap" }}>
                          {segStartStr} ~ {segEndStr} ({s.segmentBarsCount ?? s.windowMinutes}m)
                        </td>
                        <td>
                          <span
                            className={`badge ${
                              isSurge ? "badge-surge" : "badge-drop"
                            }`}
                          >
                            {isSurge ? "冲高 🚀" : "回撤 🔻"}
                          </span>
                        </td>
                        <td className={isSurge ? "pos bold" : "neg bold"}>
                          {isSurge ? "+" : "-"}
                          {s.intervalChangePercent.toFixed(2)}%
                        </td>
                        <td className="bold highlight">
                          {(s.ratioToDayChange * 100).toFixed(1)}%
                          {s.divisor > 0 && (
                            <span className="sub-ratio">(24h/{s.divisor})</span>
                          )}
                        </td>
                        {/* 【起爆前】均线排列与支撑 (比对最近3根1mK) */}
                        <td>
                          {preItem ? (
                            <div className="table-support-tags">
                              <span className={`status-badge-sm ${getMaTagClass(preItem.maAlignment.type)}`}>
                                {preItem.maAlignment.label}
                              </span>
                              {preItem.maAlignment.pattern3BarsLabel && (
                                <span
                                  className={`status-badge-sm tag-highlight`}
                                  title={`3根分时演变: ${preItem.maAlignment.transitionText ?? ""}`}
                                >
                                  {preItem.maAlignment.pattern3BarsLabel}
                                </span>
                              )}
                              {preItem.ohlc.supports.map((p) => (
                                <span key={p} className="tag tag-support-sm">
                                  MA{p}支撑
                                </span>
                              ))}
                              {preItem.ohlc.resistances.map((p) => (
                                <span key={p} className="tag tag-resist-sm">
                                  MA{p}压制
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="muted">-</span>
                          )}
                        </td>
                        {/* 【起爆前】MACD 绿柱率 */}
                        <td>
                          {preItem ? (
                            <span
                              className={
                                preItem.greenRatio >= 0.7 ? "pos bold" : "muted"
                              }
                            >
                              {(preItem.greenRatio * 100).toFixed(0)}% (
                              {preItem.greenCount}/{preItem.totalBars})
                            </span>
                          ) : (
                            <span className="muted">-</span>
                          )}
                        </td>
                        {/* 【起爆前】蓄势振幅 */}
                        <td className="muted" style={{ fontFamily: "monospace" }}>
                          {preItem ? `${preItem.preAmpPercent.toFixed(2)}%` : "-"}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="locate-btn"
                            onClick={() => onSelectTime(preItem?.endTime ?? s.segmentStartTime ?? s.time)}
                            title="定位到起爆点 K 线"
                          >
                            定位起爆点 🔍
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
