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
  if (type === "extreme_dev") return "冲高极度乖离";
  if (type === "deep_rebound") return "跌到20%+";
  if (type === "rebound") return "首次跌10%";
  if (type === "ma30_pullback") return "龙头MA30回踩";
  if (type === "ma60_support") return "龙头MA60深蹲";
  if (type === "rank1_first_pullback") return "榜一首次回踩";
  if (type === "second_wave_expansion") return "龙头二浪突破";
  return "新高顶背离";
}

function formatPrice(price?: number): string {
  if (price == null || !Number.isFinite(price) || price === 0) return "0";
  const abs = Math.abs(price);
  if (abs >= 100) return price.toFixed(2);
  if (abs >= 1) return price.toFixed(4);
  if (abs >= 0.01) return price.toFixed(5);
  if (abs >= 0.0001) return price.toFixed(6);
  return price.toFixed(8);
}

function formatExitReason(item: ClosedTradeItem): string {
  const exit1 = item.exits?.find((e) => e.stage === 1);
  const exit2 = item.exits?.find((e) => e.stage === 2);

  if (exit1?.reason === "target" && exit2?.reason === "target") {
    return "两段全部止盈 🎯";
  }
  if (exit1?.reason === "target" && exit2?.reason === "stop" && item.isBreakevenArmed) {
    return "阶段一止盈 + 阶段二保本 🎯🛡️";
  }
  if (exit1?.reason === "target" && exit2?.reason === "timeout") {
    return "阶段一止盈 + 阶段二超时 🎯⏱️";
  }
  if (exit1?.reason === "target" && exit2?.reason === "stop") {
    return "阶段一止盈 + 阶段二止损 🎯🛑";
  }
  if (exit1?.reason === "stop" && exit2?.reason === "target") {
    return "阶段一止损 + 阶段二止盈 🛑🎯";
  }
  if (exit1?.reason === "stop" && exit2?.reason === "timeout") {
    return "阶段一止损 + 阶段二超时 🛑⏱️";
  }
  if (exit1?.reason === "stop" && exit2?.reason === "stop") {
    return "触发全额止损 🛑";
  }
  if (exit1?.reason === "timeout" && exit2?.reason === "timeout") {
    return "超时平仓 ⏱️";
  }

  if (item.finalReason === "target") return "两段全部止盈 🎯";
  if (item.finalReason === "stop") return item.isBreakevenArmed ? "保本止损锁定 🛡️" : "触发止损 🛑";
  if (item.finalReason === "timeout") return "超时平仓 ⏱️";
  return item.finalReason ?? "-";
}

export function PaperTradingPanel({
  summary: propSummary,
  onSelectSymbol,
  selectedSymbol,
}: PaperTradingPanelProps) {
  const [liveSummary, setLiveSummary] = useState<PaperTradingSummary | undefined>(propSummary);
  const [showHistory, setShowHistory] = useState(false);
  const [historyList, setHistoryList] = useState<ClosedTradeItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [, setTick] = useState(0);

  // 策略配置模态框状态 (API 设置)
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [streakLevInput, setStreakLevInput] = useState<number>(10);
  const [trendLevInput, setTrendLevInput] = useState<number>(3);
  const [marginPercentInput, setMarginPercentInput] = useState<number>(20);
  const [maxPositionsInput, setMaxPositionsInput] = useState<number>(5);
  const [maxPerStrategyInput, setMaxPerStrategyInput] = useState<number>(1);
  const [limitDivisorInput, setLimitDivisorInput] = useState<number>(0);
  const [isSavingConfig, setIsSavingConfig] = useState(false);

  // 自主同步与高频轮询 /api/paper-trading，彻底摆脱主状态依赖与轮询迟滞
  const fetchLive = async () => {
    try {
      const res = await fetch("/api/paper-trading", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (data.summary) {
        setLiveSummary(data.summary);
      } else if (data.account && data.stats) {
        setLiveSummary({
          account: data.account,
          pendingOrders: data.pendingOrders ?? [],
          pendingCount: data.pendingOrders?.length ?? 0,
          activeCount: data.activePositions?.length ?? 0,
          totalTrades: data.stats.totalTrades ?? 0,
          winningTrades: data.stats.winningTrades ?? 0,
          losingTrades: data.stats.losingTrades ?? 0,
          winRate: data.stats.winRate ?? 0,
          totalNetPnlUsdt: data.stats.totalNetPnlUsdt ?? 0,
          profitFactor: data.stats.profitFactor ?? 1,
          activePositions: data.activePositions ?? [],
          config: {
            leverage: data.config?.leverage ?? 3,
            streakLeverage: data.config?.streakLeverage ?? 10,
            trendLeverage: data.config?.trendLeverage ?? 3,
            marginUsdt: data.config?.marginUsdt ?? 20,
            marginRate: data.config?.marginRate ?? 0.2,
            marginPercent: data.config?.marginPercent ?? 20,
            maxPositions: data.config?.maxPositions ?? 5,
            maxPositionsPerStrategy: data.config?.maxPositionsPerStrategy ?? 1,
            limitDivisor: data.config?.limitDivisor ?? 0,
            holdMinutes: data.config?.holdMinutes ?? 15,
            initialBalanceUsdt: data.config?.initialBalanceUsdt ?? 100,
          },
        });
      }
      if (Array.isArray(data.closedPositions)) {
        setHistoryList(data.closedPositions.slice().reverse());
      }
    } catch {
      // 忽略偶发网络波动
    }
  };

  // 挂载时立即拉取，并以 3 秒高频间隔后台轮询模拟实盘最新状态
  useEffect(() => {
    let active = true;
    fetchLive();
    const interval = setInterval(() => {
      if (active) fetchLive();
    }, 3000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  // Update timer every second for countdowns
  useEffect(() => {
    const timer = setInterval(() => {
      setTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (propSummary) {
      setLiveSummary(propSummary);
    }
  }, [propSummary]);

  const summary = liveSummary ?? propSummary;

  useEffect(() => {
    if (summary?.config) {
      setStreakLevInput(summary.config.streakLeverage ?? 10);
      setTrendLevInput(summary.config.trendLeverage ?? summary.config.leverage ?? 3);
      setMarginPercentInput(summary.config.marginPercent ?? 20);
      setMaxPositionsInput(summary.config.maxPositions ?? 5);
      setMaxPerStrategyInput(summary.config.maxPositionsPerStrategy ?? 1);
      setLimitDivisorInput(summary.config.limitDivisor ?? 0);
    }
  }, [summary?.config]);

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingConfig(true);
    try {
      const res = await fetch("/api/paper-trading/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          streakLeverage: Number(streakLevInput),
          trendLeverage: Number(trendLevInput),
          leverage: Number(trendLevInput),
          marginRate: Number(marginPercentInput) / 100,
          marginPercent: Number(marginPercentInput),
          maxPositions: Number(maxPositionsInput),
          maxPositionsPerStrategy: Number(maxPerStrategyInput),
          limitDivisor: Number(limitDivisorInput),
        }),
      });
      const data = await res.json();
      if (data.ok) {
        alert("✅ 模拟交易策略配置已通过 API 成功更新并持久化！");
        setShowConfigModal(false);
        fetchLive();
      } else {
        alert("❌ 更新配置失败: " + (data.error ?? "未知错误"));
      }
    } catch (err: any) {
      alert("❌ 请求异常: " + (err?.message ?? err));
    } finally {
      setIsSavingConfig(false);
    }
  };

  const handleResetOptimal = () => {
    setStreakLevInput(10);
    setTrendLevInput(3);
    setMarginPercentInput(20);
    setMaxPositionsInput(5);
    setMaxPerStrategyInput(1);
    setLimitDivisorInput(0);
  };

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
        setHistoryList(data.closedPositions.slice().reverse());
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

  const config = summary?.config;
  const streakLev = config?.streakLeverage ?? 10;
  const trendLev = config?.trendLeverage ?? (config?.leverage ?? 3);
  const marginPercent = config?.marginPercent ?? 20;
  const marginUsdt = config?.marginUsdt ?? (activePositions[0]?.marginUsdt ?? 20);
  const maxPositions = config?.maxPositions ?? 5;
  const maxPerStrategy = config?.maxPositionsPerStrategy ?? 1;
  const isLimitEntry = (config?.limitDivisor ?? 0) > 0;

  return (
    <section className="paper-trading-section">
      <div className="paper-header">
        <div className="paper-title-wrap">
          <h2 style={{ margin: 0 }}>
            <span>⚡ 模拟实盘交易</span>
            <span className="badge-leverage" title={`新高顶背离闪击 ${streakLev}x · 顺势衰竭长波段 ${trendLev}x · 动态仓位 ${marginPercent}% (当前约 ${marginUsdt}U) · 最大 ${maxPositions} 仓 (每策略 ${maxPerStrategy})`}>
              双速杠杆 ({streakLev}x 闪击 / {trendLev}x 波段) · 仓位 {marginPercent}% (约 {marginUsdt}U) · 限仓 {maxPositions} (每策略 {maxPerStrategy})
            </span>
            <span className="badge-strategy">
              5大高胜率精选策略 · 3大做空 (冲高极度乖离90.9% · 跌到20%+ 87.5% · 首次跌10% 80.0%) + 2大涨幅榜做多 (MA30黄金回踩75.7% · MA60深蹲77.8%) · 两段动态止盈止损
            </span>
          </h2>
          <div className="paper-stats-chips">
            <span className={`chip ${account.totalPnlUsdt >= 0 ? "chip-pos" : "chip-neg"}`}>
              账户净值: <b>{account.equityUsdt.toFixed(2)} USDT</b>
              <small> ({account.accountRoiPercent >= 0 ? "+" : ""}{account.accountRoiPercent.toFixed(1)}%)</small>
            </span>
            <span className="chip">
              可用保证金: <b>{account.availableMarginUsdt.toFixed(2)} USDT</b>
              <small> (本金 {account.initialBalanceUsdt.toFixed(0)}U)</small>
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
            className="btn-config-toggle"
            onClick={() => setShowConfigModal(true)}
            title="通过 API 设置新高背离独立杠杆、顺势波段杠杆与保证金"
          >
            ⚙️ 策略参数设置
          </button>
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
              <span>⏳ 限价挂单等待冲高撮合 (N={config?.limitDivisor ?? 100} · 向上溢价做空接针)</span>
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
                          {order.leverage}x 限价挂单
                        </span>
                        <span className="badge-margin">保 {order.marginUsdt.toFixed(1)}U</span>
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
                          {formatPrice(order.limitPrice)}
                          <small style={{ fontSize: "10px", marginLeft: "2px" }}>(+{order.limitOffsetPercent.toFixed(2)}%)</small>
                        </span>
                      </div>
                      <div className="pos-info-col">
                        <span className="label">最新价 (距离)</span>
                        <span className="val current-val">
                          {formatPrice(order.currentPrice)}
                          <small style={{ fontSize: "10px", color: distPercent > 0 ? "#2ecc71" : "#e74c3c", marginLeft: "2px" }}>
                            (还差 {distPercent > 0 ? "+" : ""}{distPercent.toFixed(2)}%)
                          </small>
                        </span>
                      </div>
                      <div className="pos-info-col">
                        <span className="label">基准价 (24h涨幅)</span>
                        <span className="val pos-gain">
                          {formatPrice(order.basePrice)} (+{order.dayChangePercent.toFixed(1)}%)
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
                当前暂无活跃持仓与挂单 · 账户净值 {account.equityUsdt.toFixed(1)} USDT · 动态保证金 {marginPercent}% (当前约 {marginUsdt} USDT) · 最大同时持仓 {maxPositions} 笔 (每策略至多 {maxPerStrategy} 笔，保证5大策略各持仓至多 1 笔) · 3大做空 (极度乖离90.9%、跌20%+ 87.5%、跌10% 80.0%) + 2大涨幅榜做多 (MA30黄金回踩75.7%、MA60深蹲77.8%)
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
              const isLong = pos.side === "LONG";

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
                      <span
                        className={isLong ? "badge-long" : "badge-short"}
                        style={isLong ? { background: "rgba(46, 204, 113, 0.2)", color: "#2ecc71" } : undefined}
                      >
                        {pos.leverage}x {isLong ? "做多" : "做空"}
                      </span>
                      <span className="badge-margin">保 {pos.marginUsdt.toFixed(1)}U</span>
                      {pos.rank && <span className="pos-rank">#{pos.rank}</span>}
                    </div>
                    <div className="pos-card-timer" title="到期后将以市价超时平仓">
                      ⏱️ 剩余: <b>{remainingTime}</b>
                    </div>
                  </div>

                  <div className="pos-card-main">
                    <div className="pos-info-col">
                      <span className="label">开仓价</span>
                      <span className="val">{formatPrice(pos.entryPrice)}</span>
                    </div>
                    <div className="pos-info-col">
                      <span className="label">最新价</span>
                      <span className="val current-val">{formatPrice(pos.currentPrice)}</span>
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
                        <span>阶段一 (50% 仓位 · {(pos.marginUsdt * 0.5).toFixed(1)}U 保证金)</span>
                        <span className="stage-status">
                          {pos.remainingFraction === 1.0 ? "待触发" : "已平仓 ✅"}
                        </span>
                      </div>
                      <div className="stage-targets">
                        <span>止盈1: <b className="target-green">{formatPrice(pos.tp1Price)} ({isLong ? "+" : "-"}{pos.tp1Percent.toFixed(2)}%)</b></span>
                        <span>止损1: <b className="target-red">{formatPrice(pos.sl1Price)} ({isLong ? "-" : "+"}{pos.sl1Percent.toFixed(2)}%)</b></span>
                      </div>
                    </div>

                    <div className={`stage-block ${pos.remainingFraction === 0.5 ? "stage-active" : "stage-pending"}`}>
                      <div className="stage-title">
                        <span>阶段二 (剩余 50% · {(pos.marginUsdt * 0.5).toFixed(1)}U 保证金)</span>
                        <span className="stage-status">
                          {pos.remainingFraction === 0.5 ? "运行中 ⏳" : "等待中"}
                        </span>
                      </div>
                      <div className="stage-targets">
                        <span>
                          止损2:{" "}
                          {pos.isBreakevenArmed ? (
                            <b className="target-green" title="阶段一止盈后已锁定保本">
                              保本锁定 ({formatPrice(pos.sl2Price)})
                            </b>
                          ) : (
                            <b className="target-red">
                              {formatPrice(pos.sl2Price)} ({isLong ? "-" : "+"}{pos.sl2Percent.toFixed(2)}%)
                            </b>
                          )}
                        </span>
                        <span>止盈2: <b className="target-green">{formatPrice(pos.tp2Price)} ({isLong ? "+" : "-"}{pos.tp2Percent.toFixed(2)}%)</b></span>
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
                            {item.side === "LONG" ? "做多 · " : "做空 · "}{formatSignalLabel(item.signalType, item.signalLabel)}
                          </span>
                        </td>
                        <td className="pos">+{item.dayChangePercent.toFixed(2)}%</td>
                        <td>{item.amp30Percent ? `${item.amp30Percent.toFixed(2)}%` : "-"}</td>
                        <td>{formatPrice(item.entryPrice)}</td>
                        <td>{formatPrice(avgExit)}</td>
                        <td>{holdDuration}</td>
                        <td>{formatExitReason(item)}</td>
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
      {/* 策略参数设置模态框 */}
      {showConfigModal && (
        <div className="config-modal-backdrop" onClick={() => setShowConfigModal(false)}>
          <div className="config-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="config-modal-header">
              <h3>⚙️ 模拟实盘交易策略参数设置 (API 同步)</h3>
              <button
                type="button"
                className="config-modal-close"
                onClick={() => setShowConfigModal(false)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleSaveConfig}>
              <div className="config-form-group">
                <label>
                  <span>⚡ 新高顶背离闪击杠杆 (Streak Leverage)</span>
                  <small>15m 紧止损 · 回测最优 10x (零爆仓)</small>
                </label>
                <input
                  type="number"
                  min="1"
                  max="50"
                  step="1"
                  value={streakLevInput}
                  onChange={(e) => setStreakLevInput(Number(e.target.value))}
                  required
                />
              </div>

              <div className="config-form-group">
                <label>
                  <span>🛡️ 顺势衰竭长波段杠杆 (Trend Leverage)</span>
                  <small>90m 波段 / 10% 大止损 · 最优 3x 黄金低杠杆</small>
                </label>
                <input
                  type="number"
                  min="1"
                  max="10"
                  step="1"
                  value={trendLevInput}
                  onChange={(e) => setTrendLevInput(Number(e.target.value))}
                  required
                />
              </div>

              <div className="config-form-group">
                <label>
                  <span>💰 单笔仓位比例 (Margin % of Equity)</span>
                  <small>默认 20% (动态按账户当前净资产 20% 计算单笔保证金，当前约 {(account.equityUsdt * (marginPercentInput / 100)).toFixed(1)} USDT)</small>
                </label>
                <input
                  type="number"
                  min="5"
                  max="100"
                  step="5"
                  value={marginPercentInput}
                  onChange={(e) => setMarginPercentInput(Number(e.target.value))}
                  required
                />
              </div>

              <div className="config-form-group">
                <label>
                  <span>📊 全局最大同时持仓数 (Max Positions)</span>
                  <small>默认 5 笔 (5 笔 × 20% = 100% 满仓风控上限)</small>
                </label>
                <input
                  type="number"
                  min="1"
                  max="20"
                  step="1"
                  value={maxPositionsInput}
                  onChange={(e) => setMaxPositionsInput(Number(e.target.value))}
                  required
                />
              </div>

              <div className="config-form-group">
                <label>
                  <span>⚖️ 单策略最大持仓数 (Max Per Strategy)</span>
                  <small>默认 1 笔 (保证四大做空策略各持仓至少 1 笔，互不挤占)</small>
                </label>
                <input
                  type="number"
                  min="1"
                  max="10"
                  step="1"
                  value={maxPerStrategyInput}
                  onChange={(e) => setMaxPerStrategyInput(Number(e.target.value))}
                  required
                />
              </div>

              <div className="config-form-group">
                <label>
                  <span>🎯 入场模式与挂单分母 (Limit Divisor N)</span>
                  <small>0 = 市价直开 (推荐)；&gt;0 = 溢价挂单接针</small>
                </label>
                <input
                  type="number"
                  min="0"
                  max="500"
                  step="10"
                  value={limitDivisorInput}
                  onChange={(e) => setLimitDivisorInput(Number(e.target.value))}
                  required
                />
              </div>

              <div className="config-modal-actions">
                <button
                  type="button"
                  className="btn-preset-reset"
                  onClick={handleResetOptimal}
                  title="恢复量化研究皇冠最优推荐：新高背离10x、顺势衰竭3x、动态20%仓位、限5仓(每策略至多1仓)、市价直开"
                >
                  恢复皇冠最优推荐
                </button>
                <button
                  type="submit"
                  className="btn-config-save"
                  disabled={isSavingConfig}
                >
                  {isSavingConfig ? "保存中…" : "保存并应用到模拟实盘"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
