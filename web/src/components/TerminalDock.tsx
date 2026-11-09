import React, { useState } from "react";
import type { ChartBar, IntervalSignal, PaperTradingSummary } from "../../../src/types.ts";
import { KlineStatsPanel } from "./KlineStatsPanel";
import { PaperTradingPanel } from "./PaperTradingPanel";

export type DockTabKey = "positions" | "stats" | "history" | "strategy" | "mining";

interface TerminalDockProps {
  activeTab: DockTabKey;
  onTabChange: (tab: DockTabKey) => void;
  // Chart & Quant stats
  symbol: string;
  bars: ChartBar[];
  dayChangePercent?: number | null;
  signals: IntervalSignal[];
  windowMinutes: number;
  onWindowMinutesChange: (w: number) => void;
  mode: "surge" | "drop" | "both";
  onModeChange: (m: "surge" | "drop" | "both") => void;
  showMarkers: boolean;
  onToggleMarkers: () => void;
  onSelectTime: (timeMs: number) => void;
  // Paper trading data
  paperSummary?: PaperTradingSummary;
  onSelectSymbol?: (symbol: string) => void;
  selectedSymbol?: string;
  onOpenConfigModal?: () => void;
  showConfigModal?: boolean;
  onCloseConfigModal?: () => void;
}

export function TerminalDock({
  activeTab,
  onTabChange,
  symbol,
  bars,
  dayChangePercent,
  signals,
  windowMinutes,
  onWindowMinutesChange,
  mode,
  onModeChange,
  showMarkers,
  onToggleMarkers,
  onSelectTime,
  paperSummary,
  onSelectSymbol,
  selectedSymbol,
  onOpenConfigModal,
  showConfigModal,
  onCloseConfigModal,
}: TerminalDockProps) {
  const activePositions = paperSummary?.activePositions ?? [];
  const pendingOrders = paperSummary?.pendingOrders ?? [];
  const totalOrders = activePositions.length + pendingOrders.length;
  const factorMining = paperSummary?.factorMining;

  return (
    <div className="terminal-dock-pane">
      {/* 终端控制台 Tab 导航栏 */}
      <div className="terminal-dock-tabs">
        <div className="dock-tabs-group">
          <button
            type="button"
            className={`dock-tab ${activeTab === "positions" ? "active" : ""}`}
            onClick={() => onTabChange("positions")}
          >
            <span className="dock-tab-icon">⚡</span>
            <span>模拟持仓与挂单</span>
            {totalOrders > 0 && (
              <span className={`dock-badge ${activePositions.length > 0 ? "dock-badge-active" : ""}`}>
                {totalOrders}
              </span>
            )}
          </button>

          <button
            type="button"
            className={`dock-tab ${activeTab === "history" ? "active" : ""}`}
            onClick={() => onTabChange("history")}
          >
            <span className="dock-tab-icon">📜</span>
            <span>24h 成交明细</span>
            {paperSummary?.totalTrades ? (
              <span className="dock-badge">
                {paperSummary.totalTrades}
              </span>
            ) : null}
          </button>

          <button
            type="button"
            className={`dock-tab ${activeTab === "strategy" ? "active" : ""}`}
            onClick={() => onTabChange("strategy")}
          >
            <span className="dock-tab-icon">⚙️</span>
            <span>策略与风控配置</span>
          </button>

          <button
            type="button"
            className={`dock-tab ${activeTab === "mining" ? "active" : ""}`}
            onClick={() => onTabChange("mining")}
          >
            <span className="dock-tab-icon">⛏️</span>
            <span>持续因子挖掘</span>
            {factorMining?.running && <span className="dock-badge dock-badge-pulse">计算中</span>}
          </button>
        </div>

        {/* 右侧快捷动作按钮 */}
        <div className="dock-actions-group">
          <button
            type="button"
            className="btn-config-toggle"
            onClick={onOpenConfigModal}
            title="通过弹窗设置策略独立杠杆、顺势波段杠杆与保证金"
          >
            ⚙️ 策略参数设置
          </button>
        </div>
      </div>

      {/* 终端控制台内容区：独立纵向滚动，不撑高外层页面 */}
      <div className="terminal-dock-content">
        {activeTab === "stats" && (
          bars.length > 0 ? (
            <KlineStatsPanel
              symbol={symbol}
              bars={bars}
              dayChangePercent={dayChangePercent}
              onSelectTime={onSelectTime}
              windowMinutes={windowMinutes}
              onWindowMinutesChange={onWindowMinutesChange}
              mode={mode}
              onModeChange={onModeChange}
              showMarkers={showMarkers}
              onToggleMarkers={onToggleMarkers}
              signals={signals}
            />
          ) : (
            <div className="empty-paper-state">
              <span className="empty-icon">⏳</span>
              <span className="empty-text">正在加载 {symbol} 1m K线与特征指标…</span>
            </div>
          )
        )}

        <div style={{ display: activeTab === "stats" ? "none" : "contents" }}>
          <PaperTradingPanel
            summary={paperSummary}
            onSelectSymbol={onSelectSymbol}
            selectedSymbol={selectedSymbol}
            dockTab={activeTab === "stats" ? "positions" : activeTab}
            mode="dock"
            showConfigModal={showConfigModal}
            onCloseConfigModal={onCloseConfigModal}
            onOpenConfigModal={onOpenConfigModal}
          />
        </div>
      </div>
    </div>
  );
}
