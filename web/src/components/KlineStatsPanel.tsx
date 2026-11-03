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
  divisor: number;
  onDivisorChange: (d: number) => void;
  mode: "surge" | "drop" | "both";
  onModeChange: (m: "surge" | "drop" | "both") => void;
  showMarkers: boolean;
  onToggleMarkers: () => void;
  signals: IntervalSignal[];
}

export function KlineStatsPanel({
  symbol,
  bars,
  dayChangePercent,
  hoverIndex,
  onSelectTime,
  windowMinutes,
  onWindowMinutesChange,
  divisor,
  onDivisorChange,
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
  const maAlignment = analyzeMaAlignment(bars, activeIdx);
  const ohlc = analyzeOhlcComparison(bars, activeIdx);
  const macd = analyzeMacdStats(bars, activeIdx);

  // 计算当前聚焦 K 线的区间涨跌幅
  const startIdx = Math.max(0, activeIdx - windowMinutes + 1);
  let minLow = Infinity;
  let maxHigh = -Infinity;
  for (let k = startIdx; k <= activeIdx; k++) {
    if (bars[k].low < minLow) minLow = bars[k].low;
    if (bars[k].high > maxHigh) maxHigh = bars[k].high;
  }
  const curSurgePct =
    minLow > 0 && currentBar ? ((currentBar.high - minLow) / minLow) * 100 : 0;
  const curDropPct =
    maxHigh > 0 && currentBar ? ((maxHigh - currentBar.low) / maxHigh) * 100 : 0;

  const effectiveDc =
    typeof dayChangePercent === "number" && Number.isFinite(dayChangePercent)
      ? dayChangePercent
      : bars.length >= 2 && bars[0].open > 0
      ? ((bars[bars.length - 1].close - bars[0].open) / bars[0].open) * 100
      : 0;

  const curSurgeRatio = effectiveDc > 0 ? (curSurgePct / effectiveDc) * 100 : 0;
  const targetThresholdPct = (1 / divisor) * 100;
  const isSurgeQualified = curSurgeRatio >= targetThresholdPct;

  const formatPrice = (v: number | null | undefined) => {
    if (v == null || !Number.isFinite(v)) return "-";
    const abs = Math.abs(v);
    if (abs >= 1000) return v.toFixed(2);
    if (abs >= 1) return v.toFixed(4);
    return v.toFixed(6);
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
          <span className="toolbar-label">24h 涨幅比例:</span>
          {[
            { d: 5, label: "24h/5 (20%)" },
            { d: 8, label: "24h/8 (12.5%)" },
            { d: 10, label: "24h/10 (10%)" },
            { d: 12, label: "24h/12 (8.3%)" },
            { d: 15, label: "24h/15 (6.7%)" },
          ].map((item) => (
            <button
              key={item.d}
              type="button"
              className={`filter-btn ${divisor === item.d ? "active" : ""}`}
              onClick={() => onDivisorChange(item.d)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="toolbar-group">
          <span className="toolbar-label">方向:</span>
          {[
            { m: "surge", label: "冲高 🚀" },
            { m: "drop", label: "回撤 🔻" },
            { m: "both", label: "全部" },
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
          <label className="toggle-label" title="在K线图表上用箭头与文字标记出所有达标区间">
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
        {/* 卡片 1: 均线排列 */}
        <div className="stats-card">
          <div className="card-header">
            <span className="card-title">📈 均线排列 (MA)</span>
            <span className={`status-badge ${getMaTagClass(maAlignment.type)}`}>
              {maAlignment.label}
            </span>
          </div>
          <div className="card-body">
            <div className="ma-sequence" title="各周期均线按数值从高到低排列">
              {maAlignment.orderText || "-"}
            </div>
            <div className="ma-trend-list">
              {maAlignment.order.map((p) => {
                const item = maAlignment.mas[p];
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
                      title="收盘价与均线乖离率"
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

        {/* 卡片 2: K线 OHLC 与均线对比 */}
        <div className="stats-card">
          <div className="card-header">
            <span className="card-title">🕯️ K线(OHLC) vs 均线</span>
            <span className="status-badge tag-highlight">
              站上 {ohlc.aboveCount}/5 条均线
            </span>
          </div>
          <div className="card-body">
            <div className="ohlc-summary">
              <span className="ohlc-item">
                实体:{" "}
                <b className={ohlc.bodyPercent >= 0 ? "pos" : "neg"}>
                  {ohlc.bodyPercent >= 0 ? "+" : ""}
                  {ohlc.bodyPercent.toFixed(2)}%
                </b>
              </span>
              <span className="ohlc-item">
                上影: <b className="neg">{ohlc.upperWickPercent.toFixed(2)}%</b>
              </span>
              <span className="ohlc-item">
                下影: <b className="pos">{ohlc.lowerWickPercent.toFixed(2)}%</b>
              </span>
            </div>
            <div className="ma-interaction-tags">
              {ohlc.supports.length > 0 && (
                <div className="tag-group">
                  <span className="interaction-label pos-label">支撑生效:</span>
                  {ohlc.supports.map((p) => (
                    <span key={p} className="tag tag-support" title="探底回踩此均线并收回在上方">
                      MA{p} 支撑
                    </span>
                  ))}
                </div>
              )}
              {ohlc.resistances.length > 0 && (
                <div className="tag-group">
                  <span className="interaction-label neg-label">受阻压制:</span>
                  {ohlc.resistances.map((p) => (
                    <span key={p} className="tag tag-resist" title="冲高测试此均线但收在下方">
                      MA{p} 压制
                    </span>
                  ))}
                </div>
              )}
              {ohlc.supports.length === 0 && ohlc.resistances.length === 0 && (
                <div className="muted interaction-none">
                  {ohlc.aboveCount === 5
                    ? "全线飘红运行在所有均线上方"
                    : ohlc.aboveCount === 0
                    ? "均线下行，受所有均线压制"
                    : "在均线带区间运行"}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 卡片 3: MACD 绿柱比例 */}
        <div className="stats-card">
          <div className="card-header">
            <span className="card-title">📊 MACD 绿柱比例</span>
            <span
              className={`status-badge ${
                macd.isBullishCross && macd.isAboveZero
                  ? "tag-bull-full"
                  : macd.isBullishCross
                  ? "tag-bull-short"
                  : "tag-bear-short"
              }`}
            >
              {macd.isAboveZero ? "零上多头" : "零下"} · {macd.isBullishCross ? "金叉" : "死叉"}
            </span>
          </div>
          <div className="card-body">
            {/* 近 30 根绿柱进度条 */}
            <div className="ratio-bar-wrap">
              <div className="ratio-bar-info">
                <span>近 30 根 1m 绿柱:</span>
                <b>
                  {(macd.greenBarRatio30 * 100).toFixed(1)}% ({macd.greenCount30}/30)
                </b>
              </div>
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: `${Math.min(100, macd.greenBarRatio30 * 100)}%` }}
                />
              </div>
            </div>

            {/* 近 15 根绿柱进度条 */}
            <div className="ratio-bar-wrap">
              <div className="ratio-bar-info">
                <span>近 15 根 1m 绿柱:</span>
                <b>
                  {(macd.greenBarRatio15 * 100).toFixed(1)}% ({macd.greenCount15}/15)
                </b>
              </div>
              <div className="progress-track">
                <div
                  className="progress-fill short-term"
                  style={{ width: `${Math.min(100, macd.greenBarRatio15 * 100)}%` }}
                />
              </div>
            </div>

            <div className="macd-streak-info">
              {macd.greenStreak > 0 ? (
                <span className="pos">
                  🔥 连绿 <b>{macd.greenStreak}</b> 根
                </span>
              ) : macd.redStreak > 0 ? (
                <span className="neg">
                  ❄️ 连红 <b>{macd.redStreak}</b> 根
                </span>
              ) : (
                <span className="muted">柱线平稳</span>
              )}
              <span className="muted ml-auto">
                Hist: <b>{macd.hist.toFixed(4)}</b>
              </span>
            </div>
          </div>
        </div>

        {/* 卡片 4: 24h 涨幅与区间比率 */}
        <div className="stats-card">
          <div className="card-header">
            <span className="card-title">🎯 24h 涨幅与区间比率</span>
            <span
              className={`status-badge ${
                isSurgeQualified ? "tag-bull-full" : "tag-muted"
              }`}
            >
              {isSurgeQualified ? "已达标" : "未达标"}
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
              <span className="metric-name">{windowMinutes}m 冲高涨幅:</span>
              <span className="metric-val pos">+{curSurgePct.toFixed(2)}%</span>
            </div>
            <div className="metric-row">
              <span className="metric-name">区间/24h 比例:</span>
              <span
                className={`metric-val ${isSurgeQualified ? "pos bold" : "muted"}`}
              >
                {curSurgeRatio.toFixed(1)}%
                <span className="sub-ratio">
                  (阈值: {targetThresholdPct.toFixed(1)}%)
                </span>
              </span>
            </div>
            <div className="metric-row">
              <span className="metric-name">{windowMinutes}m 回撤跌幅:</span>
              <span className="metric-val neg">-{curDropPct.toFixed(2)}%</span>
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
            📋 检出达标区间 ({signals.length} 处)
            <span className="table-hint">
              {windowMinutes}m 涨跌幅 / 24h 涨幅 ≥ {(100 / divisor).toFixed(1)}% (24h/{divisor})
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
                在当前 1m K 线数据中，未发现满足 {windowMinutes}m 涨跌幅 ≥ 24h/{divisor} 比例的区间。
                可适当调小比例或切换窗口。
              </div>
            ) : (
              <table className="signals-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>类型</th>
                    <th>区间涨跌幅</th>
                    <th>占24h比例</th>
                    <th>均线排列</th>
                    <th>K线形态 / MA支撑</th>
                    <th>MACD绿柱(30m)</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {signals.map((s, idx) => {
                    const timeStr = new Date(s.time).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    });
                    const isSurge = s.type === "surge";
                    return (
                      <tr key={`${s.time}-${idx}`}>
                        <td className="time-col">{timeStr}</td>
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
                          <span className="sub-ratio">(24h/{s.divisor})</span>
                        </td>
                        <td>
                          <span
                            className={`status-badge-sm ${getMaTagClass(
                              s.maAlignment.type
                            )}`}
                          >
                            {s.maAlignment.label}
                          </span>
                        </td>
                        <td>
                          <div className="table-support-tags">
                            {s.ohlc.supports.length > 0 &&
                              s.ohlc.supports.map((p) => (
                                <span key={p} className="tag tag-support-sm">
                                  MA{p}支撑
                                </span>
                              ))}
                            {s.ohlc.resistances.length > 0 &&
                              s.ohlc.resistances.map((p) => (
                                <span key={p} className="tag tag-resist-sm">
                                  MA{p}压制
                                </span>
                              ))}
                            {s.ohlc.supports.length === 0 &&
                              s.ohlc.resistances.length === 0 && (
                                <span className="muted">站上 {s.ohlc.aboveCount}/5 MA</span>
                              )}
                          </div>
                        </td>
                        <td>
                          <span
                            className={
                              s.macd.greenBarRatio30 >= 0.7 ? "pos bold" : "muted"
                            }
                          >
                            {(s.macd.greenBarRatio30 * 100).toFixed(0)}% (
                            {s.macd.greenCount30}/30)
                          </span>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="locate-btn"
                            onClick={() => onSelectTime(s.time)}
                            title="定位到该 K 线"
                          >
                            定位 🔍
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
