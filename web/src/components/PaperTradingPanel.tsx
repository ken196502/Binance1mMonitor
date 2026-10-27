import { useState, useEffect } from "react";
import type {
  PaperTradingSummary,
  PaperPosition,
  PaperPendingOrder,
  PaperExitReason,
} from "../../../src/types.ts";

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
  if (remainingMs <= 0) return "已到期/处理中";
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}分${seconds < 10 ? "0" : ""}${seconds}秒`;
}

function formatHoldDuration(closedAt?: number, entryTime?: number): string {
  if (!closedAt || !entryTime) return "-";
  const durationMs = Math.max(0, closedAt - entryTime);
  if (durationMs < 1000) return "<1 秒";
  if (durationMs < 60000) return `${Math.floor(durationMs / 1000)} 秒`;
  return `${(durationMs / 60000).toFixed(1)} 分钟`;
}

function formatSignalLabel(type?: string, label?: string): string {
  if (label) return label;
  if (type === "deep_rebound") return "跌到20%+";
  if (type === "rebound") return "首次跌10%";
  return "连阳悬空";
}

export function PaperTradingPanel({
  summary,
  onSelectSymbol,
  selectedSymbol,
}: PaperTradingPanelProps) {
  const [showHistory, setShowHistory] = useState(false);
  const [historyList, setHistoryList] = useState<ClosedTradeItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [, setTick] = useState(0);

  // Update timer every second for countdowns
  useEffect(() => {
    const timer = setInterval(() => {
      setTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const handleReset = async () => {
    const ok = window.confirm(
      "⚠️ 确定要重置模拟交易账户吗？\n\n这将清空当前所有活跃持仓、挂单与历史平仓明细，账户余额将恢复为初始 100 USDT。",
    );
    if (!ok) return;

    setIsResetting(true);
    try {
      const res = await fetch("/api/paper-trading/reset", { method: "POST" });
      if (res.ok) {
        setHistoryList([]);
        setShowHistory(false);
        // 自动重新加载页面状态
        window.location.reload();
      } else {
        alert("重置失败，请检查后端服务连接");
      }
    } catch (err) {
      console.warn("重置模拟交易失败:", err);
      alert("请求异常: " + String(err));
    } finally {
      setIsResetting(false);
    }
  };

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
  const pendingOrders = summary?.pendingOrders ?? [];

  return (
    <section className="paper-trading-section">
      <div className="paper-header">
        <div className="paper-title-wrap">
          <h2 style={{ margin: 0 }}>
            <span>⚡ 模拟实盘交易</span>
            <span className="badge-leverage">10x 杠杆 · 保证金 10U</span>
            <span className="badge-strategy">3大互斥最高胜率策略 (连阳悬空 100% · 首次跌10% 74% · 跌到20%+ 88%) · 挂单接针 (N=100) · 两段动态止盈止损</span>
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
            {pendingOrders.length > 0 && (
              <span className="chip" style={{ background: "rgba(245, 166, 35, 0.15)", color: "#f5a623" }}>
                挂单中: <b>{pendingOrders.length}</b> 笔
              </span>
            )}
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
          <button
            type="button"
            className="btn-reset-paper"
            onClick={handleReset}
            disabled={isResetting}
            title="清空所有模拟持仓、挂单与历史平仓明细，账户恢复为初始 100 USDT"
          >
            {isResetting ? "重置中…" : "重置模拟仓位"}
          </button>
        </div>
      </div>

      <div className="paper-body">
        {/* 限价做空挂单列表 */}
        {pendingOrders.length > 0 && (
          <div className="paper-pending-wrap" style={{ marginBottom: "14px" }}>
            <div style={{ fontSize: "12px", fontWeight: "bold", color: "#f5a623", marginBottom: "8px", display: "flex", alignItems: "center", gap: "6px" }}>
              <span>⏳ 限价挂单等待冲高撮合 (N=100 · 向上溢价做空接针)</span>
              <span style={{ fontSize: "11px", opacity: 0.8 }}>({pendingOrders.length} 笔等待触碰)</span>
            </div>
            <div className="paper-positions-grid">
              {pendingOrders.map((order) => {
                const isSelected = selectedSymbol === order.symbol;
                const remainingTime = formatCountdown(order.expireAt);
                const distPercent = ((order.limitPrice - order.currentPrice) / order.currentPrice) * 100;
                return (
                  <div
                    key={order.id}
                    className={`paper-pos-card ${isSelected ? "pos-card-selected" : ""}`}
                    style={{ borderLeft: "3px solid #f5a623", background: "rgba(245, 166, 35, 0.05)" }}
                    onClick={() => onSelectSymbol?.(order.symbol)}
                    title="点击在右侧查看该标的实时图表"
                  >
                    <div className="pos-card-header">
                      <div className="pos-card-symbol">
                        <a
                          href={`https://www.binance.com/zh-CN/futures/${order.symbol}`}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <b>{order.symbol}</b>
                        </a>
                        <span className={`badge-signal badge-${order.signalType || "streak"}`}>
                          {formatSignalLabel(order.signalType, order.signalLabel)}
                        </span>
                        <span className="badge-short" style={{ background: "rgba(245, 166, 35, 0.2)", color: "#f5a623" }}>
                          10x 限价挂单
                        </span>
                        <span className="badge-margin">保 {order.marginUsdt}U</span>
                        {order.rank && <span className="pos-rank">#{order.rank}</span>}
                      </div>
                      <div className="pos-card-timer" title="有效期内冲针触碰即成交，超时自动撤单">
                        ⏱️ 有效期: <b>{remainingTime}</b>
                      </div>
                    </div>

                    <div className="pos-card-main">
                      <div className="pos-info-col">
                        <span className="label">做空挂单价</span>
                        <span className="val" style={{ color: "#f5a623", fontWeight: "bold" }}>
                          {order.limitPrice.toFixed(4)}
                          <small style={{ fontSize: "10px", marginLeft: "2px" }}>(+{order.limitOffsetPercent.toFixed(2)}%)</small>
                        </span>
                      </div>
                      <div className="pos-info-col">
                        <span className="label">最新价 (距离)</span>
                        <span className="val current-val">
                          {order.currentPrice.toFixed(4)}
                          <small style={{ fontSize: "10px", color: distPercent > 0 ? "#2ecc71" : "#e74c3c", marginLeft: "2px" }}>
                            (还差 {distPercent > 0 ? "+" : ""}{distPercent.toFixed(2)}%)
                          </small>
                        </span>
                      </div>
                      <div className="pos-info-col">
                        <span className="label">基准价 (24h涨幅)</span>
                        <span className="val pos-gain">
                          {order.basePrice.toFixed(4)} (+{order.dayChangePercent.toFixed(1)}%)
                        </span>
                      </div>
                      <div className="pos-info-col">
                        <span className="label">撮合状态</span>
                        <span className="val" style={{ color: "#f5a623", fontSize: "11px" }}>
                          等待冲针撮合 ⏳
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 活跃持仓列表 */}
        {activePositions.length === 0 ? (
          pendingOrders.length === 0 ? (
            <div className="empty-paper-state">
              <span className="empty-icon">📡</span>
              <span className="empty-text">
                当前暂无活跃持仓与挂单 · 账户资金 100 USDT · 单笔保证金 10 USDT (10x 杠杆, 名义 100 USDT) · 每分钟收盘扫描 Top 10 (命中条件后以 24h涨幅/100 向上挂单做空接针)
              </span>
            </div>
          ) : null
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
                      <span className={`badge-signal badge-${pos.signalType || "streak"}`}>
                        {formatSignalLabel(pos.signalType, pos.signalLabel)}
                      </span>
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
                    <th>信号</th>
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
                    const holdDuration = formatHoldDuration(item.closedAt, item.entryTime);
                    const reasonMap: Record<string, string> = {
                      target: "两段全部止盈 🎯",
                      stop: "触发止损 🛑",
                      timeout: "超时平仓 ⏱️",
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
                        <td>
                          <span className={`badge-signal badge-${item.signalType || "streak"}`}>
                            {formatSignalLabel(item.signalType, item.signalLabel)}
                          </span>
                        </td>
                        <td className="pos">+{item.dayChangePercent.toFixed(2)}%</td>
                        <td>{item.amp30Percent ? `${item.amp30Percent.toFixed(2)}%` : "-"}</td>
                        <td>{item.entryPrice.toFixed(4)}</td>
                        <td>{avgExit.toFixed(4)}</td>
                        <td>{holdDuration}</td>
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
