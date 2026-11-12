import React from "react";
import type { Row, PaperPosition, PaperPendingOrder } from "../../../src/types.ts";

interface SymbolDetailCardProps {
  symbol: string;
  gainer?: Row;
  activePosition?: PaperPosition;
  pendingOrder?: PaperPendingOrder;
  onSwitchTab?: (tab: "positions" | "stats" | "history" | "mining") => void;
}

function formatPrice(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v === 0) return "-";
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toFixed(2);
  if (abs >= 1) return v.toFixed(4);
  if (abs >= 0.01) return v.toFixed(5);
  return v.toFixed(6);
}

function formatCountdown(targetTime: number): string {
  const remainingMs = targetTime - Date.now();
  if (remainingMs <= 0) return "已到期/结算中";
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}分${seconds < 10 ? "0" : ""}${seconds}秒`;
}

export function SymbolDetailCard({
  symbol,
  gainer,
  activePosition,
  pendingOrder,
  onSwitchTab,
}: SymbolDetailCardProps) {
  const priceChange = gainer?.priceChangePercent ?? 0;
  const isPos = priceChange >= 0;
  const posIn24h = gainer?.posIn24hRange != null ? Math.min(100, Math.max(0, gainer.posIn24hRange * 100)) : null;

  return (
    <div className="symbol-detail-card">
      <div className="sd-header">
        <div className="sd-title-wrap">
          <span className="sd-symbol">{symbol}</span>
          <span className={`sd-change-badge ${isPos ? "badge-up" : "badge-down"}`}>
            {isPos ? "+" : ""}{priceChange.toFixed(2)}%
          </span>
          {activePosition && (
            <span className={`sd-pos-badge ${activePosition.side === "LONG" ? "pos-long" : "pos-short"}`}>
              {activePosition.leverage}x {activePosition.side === "LONG" ? "多" : "空"}
            </span>
          )}
          {pendingOrder && (
            <span className="sd-pending-badge">
              {pendingOrder.leverage}x 挂单
            </span>
          )}
        </div>
        <div className="sd-price-wrap">
          <span className="sd-price">{formatPrice(gainer?.lastPrice)}</span>
          <a
            href={`https://www.binance.com/zh-CN/futures/${symbol}`}
            target="_blank"
            rel="noopener noreferrer"
            className="sd-binance-link"
            title="在币安查看合约行情"
          >
            ↗ 币安
          </a>
        </div>
      </div>

      {/* 24h 价格区间标尺 */}
      {gainer && (
        <div className="sd-range-wrap">
          <div className="sd-range-labels">
            <span className="sd-range-low">24h低 {formatPrice(gainer.lowPrice)}</span>
            <span className="sd-range-val">{posIn24h != null ? `${posIn24h.toFixed(0)}%` : "-"}</span>
            <span className="sd-range-high">24h高 {formatPrice(gainer.highPrice)}</span>
          </div>
          <div className="sd-range-track">
            {posIn24h != null && (
              <div
                className="sd-range-fill"
                style={{ width: `${posIn24h}%` }}
              />
            )}
            {posIn24h != null && (
              <div
                className="sd-range-thumb"
                style={{ left: `${posIn24h}%` }}
              />
            )}
          </div>
        </div>
      )}

      {/* 核心特征与量化矩阵 */}
      <div className="sd-grid">
        <div className="sd-cell">
          <span className="sd-cell-label">24h成交额</span>
          <span className="sd-cell-val">
            {gainer ? `${(gainer.quoteVolume / 1e8).toFixed(2)} 亿` : "-"}
          </span>
        </div>
        <div className="sd-cell">
          <span className="sd-cell-label">连阳统计</span>
          <span className={`sd-cell-val ${gainer && gainer.streakCount > 0 ? "pos" : ""}`}>
            {gainer ? `${gainer.streakCount} 根 (${gainer.streakGainPercent != null ? (gainer.streakGainPercent >= 0 ? "+" : "") + gainer.streakGainPercent.toFixed(1) + "%" : "-"})` : "-"}
          </span>
        </div>
        <div className="sd-cell">
          <span className="sd-cell-label">5m冲高比</span>
          <span className="sd-cell-val">
            {gainer?.surgeRatio5 != null ? gainer.surgeRatio5.toFixed(2) : "-"}
          </span>
        </div>
        <div className="sd-cell">
          <span className="sd-cell-label">1m30upR</span>
          <span className="sd-cell-val">
            {gainer?.greenBarRatio30 != null ? `${(gainer.greenBarRatio30 * 100).toFixed(0)}%` : "-"}
          </span>
        </div>
        <div className="sd-cell">
          <span className="sd-cell-label">支撑均线</span>
          <span className="sd-cell-val sd-highlight">
            {gainer?.supportMa ? gainer.supportMa.toUpperCase() : "无"}
          </span>
        </div>
        <div className="sd-cell">
          <span className="sd-cell-label">60日趋势</span>
          <span className={`sd-cell-val ${gainer?.change60d === "up" ? "pos" : gainer?.change60d === "down" ? "neg" : ""}`}>
            {gainer?.change60d === "up" ? "▲ 上涨" : gainer?.change60d === "down" ? "▼ 下跌" : "-"}
          </span>
        </div>
      </div>

      {/* 当前标的持仓/挂单快照 */}
      {activePosition ? (
        <div
          className="sd-position-box"
          onClick={() => onSwitchTab?.("positions")}
          title="点击切换到底部持仓明细面板"
        >
          <div className="sd-pos-row">
            <span className="sd-pos-lead">
              ⚡ 当前持仓: <b>{activePosition.side === "LONG" ? "做多" : "做空"} {activePosition.leverage}x</b> (保 {activePosition.marginUsdt.toFixed(1)}U)
            </span>
            <span className={`sd-pos-pnl ${activePosition.totalNetPnlUsdt >= 0 ? "pos" : "neg"}`}>
              {activePosition.totalNetPnlUsdt >= 0 ? "+" : ""}{activePosition.totalNetPnlUsdt.toFixed(2)} U ({activePosition.roePercent >= 0 ? "+" : ""}{activePosition.roePercent.toFixed(1)}%)
            </span>
          </div>
          <div className="sd-pos-sub">
            <span>开仓 {formatPrice(activePosition.entryPrice)} · 止损 {formatPrice(activePosition.sl1Price)} · 止盈 {formatPrice(activePosition.tp1Price)}</span>
            <span className="sd-pos-timer">⏱️ {formatCountdown(activePosition.timeoutAt)}</span>
          </div>
        </div>
      ) : pendingOrder ? (
        <div
          className="sd-pending-box"
          onClick={() => onSwitchTab?.("positions")}
          title="点击切换到底部挂单明细面板"
        >
          <div className="sd-pos-row">
            <span className="sd-pending-lead">
              ⏳ 冲高做空挂单: <b>{formatPrice(pendingOrder.limitPrice)}</b>
            </span>
            <span className="sd-pending-dist">
              (距现价 {(((pendingOrder.limitPrice - pendingOrder.currentPrice) / pendingOrder.currentPrice) * 100).toFixed(2)}%)
            </span>
          </div>
          <div className="sd-pos-sub">
            <span>有效期倒计时: {formatCountdown(pendingOrder.expireAt)}</span>
            <span className="sd-jump-hint">查看订单 →</span>
          </div>
        </div>
      ) : (
        <div className="sd-idle-hint">
          <span className="sd-idle-dot" />
          <span>策略实时监控中 · 暂无持仓与挂单</span>
        </div>
      )}
    </div>
  );
}
