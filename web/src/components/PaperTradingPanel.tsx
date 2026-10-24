import { useState, useEffect } from "react";
import type { PaperTradingSummary, PaperPosition, PaperExitReason } from "../../../src/types.ts";

interface PaperTradingPanelProps {
  summary?: PaperTradingSummary;
  onSelectSymbol?: (symbol: string) => void;
  selectedSymbol?: string;
}

interface ClosedTradeItem extends PaperPosition {
  closedAt?: number;
  finalReason?: PaperExitReason;
}

function formatCountdown(targetTime: number): string {
  const remainingMs = targetTime - Date.now();
  if (remainingMs <= 0) return "超时平仓中";
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}分${seconds < 10 ? "0" : ""}${seconds}秒`;
}

export function PaperTradingPanel({
  summary,
  onSelectSymbol,
  selectedSymbol,
}: PaperTradingPanelProps) {
  const [showHistory, setShowHistory] = useState(false);
  const [historyList, setHistoryList] = useState<ClosedTradeItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [, setTick] = useState(0);

  // Update timer every second for countdowns
  useEffect(() => {
    const timer = setInterval(() => {
      setTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const loadHistory = async () => {
    if (showHistory) {
      setShowHistory(false);
      return;
    }
    setHistoryLoading(true);
    setShowHistory(true);
    try {
      const res = await fetch("/api/paper-trading");
      const data = await res.json();
      if (Array.isArray(data.closedPositions)) {
        setHistoryList(data.closedPositions);
      }
    } catch (e) {
      console.warn("加载模拟交易历史记录失败:", e);
    } finally {
      setHistoryLoading(false);
    }
  };

  const account = summary?.account ?? {
    initialBalanceUsdt: 100,
    balanceUsdt: 100,
    equityUsdt: 100,
    usedMarginUsdt: 0,
    availableMarginUsdt: 100,
    totalPnlUsdt: 0,
    accountRoiPercent: 0,
  };

  const winRate = summary ? summary.winRate : 0;
  const pf = summary ? summary.profitFactor : 1;
  const activePositions = summary?.activePositions ?? [];

  return (
    <section className="paper-trading-section">
      <div className="paper-header">
        <div className="paper-title-wrap">
          <h2 style={{ margin: 0 }}>
            <span>⚡ 模拟实盘交易</span>
            <span className="badge-leverage">10x 杠杆 · 保证金 10U</span>
            <span className="badge-strategy">30m振幅&gt;24h/12 · 上影0.5%~30% · 两段做空 (历史胜率 100% · PF ∞)</span>
          </h2>
          <div className="paper-stats-chips">
            <span className={`chip ${account.totalPnlUsdt >= 0 ? "chip-pos" : "chip-neg"}`}>
              账户净值: <b>{account.equityUsdt.toFixed(2)} USDT</b>
              <small> ({account.accountRoiPercent >= 0 ? "+" : ""}{account.accountRoiPercent.toFixed(1)}%)</small>
            </span>
            <span className="chip">
              可用保证金: <b>{account.availableMarginUsdt.toFixed(2)} USDT</b>
              <small> (本金 100U)</small>
            </span>
            <span className="chip chip-winrate">
              胜率: <b>{winRate.toFixed(1)}%</b>
            </span>
            <span className="chip">
              盈亏比 (PF): <b>{Number.isFinite(pf) ? pf.toFixed(2) : "∞"}</b>
            </span>
            <span className="chip">
              成交: <b>{summary?.totalTrades ?? 0}</b> 笔
              <span className="sub-counts"> (胜 {summary?.winningTrades ?? 0} / 负 {summary?.losingTrades ?? 0})</span>
            </span>
            <span className="chip chip-active-count">
              持仓中: <b>{activePositions.length}</b> 笔
            </span>
          </div>
        </div>
        <div className="paper-header-actions">
          <button
            type="button"
            className="btn-history-toggle"
            onClick={loadHistory}
          >
            {showHistory ? "收起历史记录" : "历史成交明细"}
          </button>
        </div>
      </div>

      {/* 活跃持仓列表 */}
      <div className="paper-body">
        {activePositions.length === 0 ? (
          <div className="empty-paper-state">
            <span className="empty-icon">📡</span>
            <span className="empty-text">
              当前暂无活跃持仓 · 账户资金 100 USDT · 单笔保证金 10 USDT (10x 杠杆, 名义 100 USDT) · 每分钟收盘扫描 Top 10 (命中 30m振幅&gt;24h/8 + MA[3,7,15]无支撑 + 上影&lt;30% + 绿柱&gt;70% + 连绿7 即时开空)
            </span>
          </div>
        ) : (
          <div className="paper-positions-grid">
            {activePositions.map((pos) => {
              const pnl = pos.totalNetPnlUsdt;
              const roe = pos.roePercent;
              const isSelected = selectedSymbol === pos.symbol;
              const remainingTime = formatCountdown(pos.timeoutAt);

              return (
                <div
                  key={pos.id}
                  className={`paper-pos-card ${isSelected ? "pos-card-selected" : ""}`}
                  onClick={() => onSelectSymbol?.(pos.symbol)}
                  title="点击在右侧查看该标的实时图表"
                >
                  <div className="pos-card-header">
                    <div className="pos-card-symbol">
                      <a
                        href={`https://www.binance.com/zh-CN/futures/${pos.symbol}`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <b>{pos.symbol}</b>
                      </a>
                      <span className="badge-short">{pos.leverage}x 做空</span>
                      <span className="badge-margin">保 {pos.marginUsdt}U</span>
                      {pos.rank && <span className="pos-rank">#{pos.rank}</span>}
                    </div>
                    <div className="pos-card-timer" title="到期后将以市价超时平仓">
                      ⏱️ 剩余: <b>{remainingTime}</b>
                    </div>
                  </div>

                  <div className="pos-card-main">
                    <div className="pos-info-col">
                      <span className="label">开仓价</span>
                      <span className="val">{pos.entryPrice.toFixed(4)}</span>
                    </div>
                    <div className="pos-info-col">
                      <span className="label">最新价</span>
                      <span className="val current-val">{pos.currentPrice.toFixed(4)}</span>
                    </div>
                    <div className="pos-info-col">
                      <span className="label">24h / 30m振幅</span>
                      <span className="val pos-gain">+{pos.dayChangePercent.toFixed(1)}% / {pos.amp30Percent ? pos.amp30Percent.toFixed(1) : "-"}%</span>
                    </div>
                    <div className="pos-info-col">
                      <span className="label">浮动盈亏 (ROE)</span>
                      <span className={`val ${pnl >= 0 ? "pos" : "neg"}`}>
                        <b>{pnl >= 0 ? "+" : ""}{pnl.toFixed(2)} U</b>
                        <small> ({roe >= 0 ? "+" : ""}{roe.toFixed(1)}%)</small>
                      </span>
                    </div>
                  </div>

                  <div className="pos-card-stages">
                    <div className={`stage-block ${pos.remainingFraction === 1.0 ? "stage-active" : "stage-done"}`}>
                      <div className="stage-title">
                        <span>阶段一 (50% 仓位 · 5U 保证金)</span>
                        <span className="stage-status">
                          {pos.remainingFraction === 1.0 ? "待触发" : "已平仓 ✅"}
                        </span>
                      </div>
                      <div className="stage-targets">
                        <span>止盈1: <b className="target-green">{pos.tp1Price.toFixed(4)} (-{pos.tp1Percent.toFixed(2)}%)</b></span>
                        <span>止损1: <b className="target-red">{pos.sl1Price.toFixed(4)} (+{pos.sl1Percent.toFixed(2)}%)</b></span>
                      </div>
                    </div>

                    <div className={`stage-block ${pos.remainingFraction === 0.5 ? "stage-active" : "stage-pending"}`}>
                      <div className="stage-title">
                        <span>阶段二 (剩余 50% · 5U 保证金)</span>
                        <span className="stage-status">
                          {pos.remainingFraction === 0.5 ? "运行中 ⏳" : "等待中"}
                        </span>
                      </div>
                      <div className="stage-targets">
                        <span>止损2: <b className="target-red">{pos.sl2Price.toFixed(4)} (+{pos.sl2Percent.toFixed(2)}%)</b></span>
                        <span>止盈2: <b className="target-green">{pos.tp2Price.toFixed(4)} (-{pos.tp2Percent.toFixed(2)}%)</b></span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 历史记录展开抽屉 */}
      {showHistory && (
        <div className="paper-history-drawer">
          <div className="history-header">
            <h3>历史平仓明细 (近 {historyList.length} 笔)</h3>
            {historyLoading && <span className="loading-hint">加载中…</span>}
          </div>
          {historyList.length === 0 ? (
            <div className="empty-history">暂无历史结清订单</div>
          ) : (
            <div className="table-wrap">
              <table className="paper-history-table">
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>时间</th>
                    <th style={{ textAlign: "left" }}>标的</th>
                    <th>24h涨幅</th>
                    <th>30m振幅</th>
                    <th>开仓价</th>
                    <th>平仓均价</th>
                    <th>持仓耗时</th>
                    <th>平仓原因</th>
                    <th>净盈亏 (USDT)</th>
                    <th>ROE (收益率)</th>
                  </tr>
                </thead>
                <tbody>
                  {historyList.map((item) => {
                    const avgExit =
                      item.exits && item.exits.length > 0
                        ? item.exits.reduce((sum, e) => sum + e.exitPrice * e.fraction, 0)
                        : item.currentPrice;
                    const pnl = item.totalNetPnlUsdt;
                    const roe = item.roePercent ?? (pnl / item.marginUsdt) * 100;
                    const holdMins = item.closedAt
                      ? ((item.closedAt - item.entryTime) / 60000).toFixed(1)
                      : "15.0";
                    const reasonMap: Record<string, string> = {
                      target: "两段全部止盈 🎯",
                      stop: "触发止损 🛑",
                      timeout: "15m 超时平仓 ⏱️",
                    };
                    const reasonText = reasonMap[item.finalReason ?? ""] ?? item.finalReason ?? "-";

                    return (
                      <tr
                        key={item.id}
                        className={selectedSymbol === item.symbol ? "chart-selected" : ""}
                        onClick={() => onSelectSymbol?.(item.symbol)}
                      >
                        <td style={{ textAlign: "left" }}>
                          {item.closedAt ? new Date(item.closedAt).toLocaleTimeString() : "-"}
                        </td>
                        <td style={{ textAlign: "left" }}>
                          <a
                            href={`https://www.binance.com/zh-CN/futures/${item.symbol}`}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <b>{item.symbol}</b>
                          </a>
                        </td>
                        <td className="pos">+{item.dayChangePercent.toFixed(2)}%</td>
                        <td>{item.amp30Percent ? `${item.amp30Percent.toFixed(2)}%` : "-"}</td>
                        <td>{item.entryPrice.toFixed(4)}</td>
                        <td>{avgExit.toFixed(4)}</td>
                        <td>{holdMins} 分钟</td>
                        <td>{reasonText}</td>
                        <td className={pnl >= 0 ? "pos" : "neg"}>
                          <b>{pnl >= 0 ? "+" : ""}{pnl.toFixed(2)} U</b>
                        </td>
                        <td className={roe >= 0 ? "pos" : "neg"}>
                          <b>{roe >= 0 ? "+" : ""}{roe.toFixed(1)}%</b>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
