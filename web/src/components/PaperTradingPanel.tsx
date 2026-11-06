import { KlineStrategySettings } from "./KlineStrategySettings";
import { useState, useEffect } from "react";
import type {
  PaperTradingSummary,
  KlineStatsStrategyLiveConfig,
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
  if (type === "hourly_suppression") return "小时线压制";
  if (type === "w_bottom_divergence") return "左侧3W底背离";
  return "新高顶背离";
}

function formatHistoryTime(timeMs?: number): string {
  if (!timeMs) return "-";
  const d = new Date(timeMs);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const timeStr = d.toLocaleTimeString("zh-CN", { hour12: false });
  if (isToday) return `今天 ${timeStr}`;
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${timeStr}`;
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${month}/${day} ${timeStr}`;
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
  const [historyFilter, setHistoryFilter] = useState<"24h" | "all">("24h");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [, setTick] = useState(0);

  // 策略配置模态框状态 (API 设置)
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [streakLevInput, setStreakLevInput] = useState<number>(3);
  const [trendLevInput, setTrendLevInput] = useState<number>(3);
  const [longLevInput, setLongLevInput] = useState<number>(3);
  const [marginPercentInput, setMarginPercentInput] = useState<number>(20);
  const [maxPositionsInput, setMaxPositionsInput] = useState<number>(5);
  const [maxPerStrategyInput, setMaxPerStrategyInput] = useState<number>(1);
  const [limitDivisorInput, setLimitDivisorInput] = useState<number>(0);
  const [ampDivisorInput, setAmpDivisorInput] = useState<number>(8);
  const [enableStreakInput, setEnableStreakInput] = useState<boolean>(true);
  const [enableReboundInput, setEnableReboundInput] = useState<boolean>(true);
  const [enableDeepReboundInput, setEnableDeepReboundInput] = useState<boolean>(true);
  const [enableHourlySuppressionInput, setEnableHourlySuppressionInput] = useState<boolean>(true);
  const [enableLongsInput, setEnableLongsInput] = useState<boolean>(true);
  const [enableWBottomDivergenceInput, setEnableWBottomDivergenceInput] = useState<boolean>(true);
  const [enableKlineStatsShortInput, setEnableKlineStatsShortInput] = useState<boolean>(true);
  const [enableKlineStatsLongInput, setEnableKlineStatsLongInput] = useState<boolean>(true);
  const [shortSpec, setShortSpec] = useState<Partial<KlineStatsStrategyLiveConfig>>({});
  const [longSpec, setLongSpec] = useState<Partial<KlineStatsStrategyLiveConfig>>({});
  const [factorMiningInput, setFactorMiningInput] = useState({ enabled: true, refreshMinutes: 60, validForMinutes: 720 });
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
          bySide: data.stats.bySide,
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
          stats24h: data.stats24h,
          config: {
            leverage: data.config?.leverage ?? 3,
            streakLeverage: data.config?.streakLeverage ?? 3,
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
        setHistoryList(data.closedPositions.slice().sort((a: PaperPosition, b: PaperPosition) => (b.closedAt ?? b.entryTime) - (a.closedAt ?? a.entryTime)));
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
    if (summary?.config && !showConfigModal) {
      setFactorMiningInput(summary.config.factorMining ?? { enabled: true, refreshMinutes: 60, validForMinutes: 720 });
      setShortSpec(summary.config.klineStatsShortConfig ?? {});
      setLongSpec(summary.config.klineStatsLongConfig ?? {});
      setStreakLevInput(summary.config.streakLeverage ?? 3);
      setTrendLevInput(summary.config.trendLeverage ?? summary.config.leverage ?? 3);
      setLongLevInput(summary.config.longLeverage ?? 3);
      setMarginPercentInput(summary.config.marginPercent ?? 20);
      setMaxPositionsInput(summary.config.maxPositions ?? 5);
      setMaxPerStrategyInput(summary.config.maxPositionsPerStrategy ?? 1);
      setLimitDivisorInput(summary.config.limitDivisor ?? 0);
      setAmpDivisorInput(summary.config.ampDivisor ?? 8);
      setEnableStreakInput(summary.config.enableStreak ?? true);
      setEnableReboundInput(summary.config.enableRebound ?? true);
      setEnableDeepReboundInput(summary.config.enableDeepRebound ?? true);
      setEnableHourlySuppressionInput(summary.config.enableHourlySuppression ?? true);
      setEnableLongsInput(summary.config.enableLongs ?? true);
      setEnableWBottomDivergenceInput(summary.config.enableWBottomDivergence ?? true);
      setEnableKlineStatsShortInput(summary.config.enableKlineStatsShort ?? true);
      setEnableKlineStatsLongInput(summary.config.enableKlineStatsLong ?? true);
    }
  }, [summary?.config, showConfigModal]);

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingConfig(true);
    try {
      const res = await fetch("/api/paper-trading/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          factorMining: factorMiningInput,
          klineStatsShortConfig: shortSpec,
          klineStatsLongConfig: longSpec,
          streakLeverage: Number(streakLevInput),
          trendLeverage: Number(trendLevInput),
          longLeverage: Number(longLevInput),
          leverage: Number(trendLevInput),
          marginRate: Number(marginPercentInput) / 100,
          marginPercent: Number(marginPercentInput),
          maxPositions: Number(maxPositionsInput),
          maxPositionsPerStrategy: Number(maxPerStrategyInput),
          limitDivisor: Number(limitDivisorInput),
          ampDivisor: Number(ampDivisorInput),
          enableStreak: enableStreakInput,
          enableRebound: enableReboundInput,
          enableDeepRebound: enableDeepReboundInput,
          enableHourlySuppression: enableHourlySuppressionInput,
          enableLongs: enableLongsInput,
          enableWBottomDivergence: enableWBottomDivergenceInput,
          enableKlineStatsShort: enableKlineStatsShortInput,
          enableKlineStatsLong: enableKlineStatsLongInput,
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
    setLongLevInput(3);
    setMarginPercentInput(20);
    setMaxPositionsInput(5);
    setMaxPerStrategyInput(1);
    setLimitDivisorInput(0);
    setAmpDivisorInput(8);
    setEnableStreakInput(true);
    setEnableReboundInput(true);
    setEnableDeepReboundInput(true);
    setEnableHourlySuppressionInput(true);
    setEnableLongsInput(true);
    setEnableWBottomDivergenceInput(true);
    setEnableKlineStatsShortInput(true);
    setEnableKlineStatsLongInput(true);
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
        setHistoryList(data.closedPositions.slice().sort((a: PaperPosition, b: PaperPosition) => (b.closedAt ?? b.entryTime) - (a.closedAt ?? a.entryTime)));
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

  const pf = summary ? summary.profitFactor : 1;
  const activePositions = summary?.activePositions ?? [];
  const pendingOrders = summary?.pendingOrders ?? [];

  const config = summary?.config;
  const streakLev = config?.streakLeverage ?? 3;
  const trendLev = config?.trendLeverage ?? (config?.leverage ?? 3);
  const klineStatsLev = config?.klineStatsShortConfig?.leverage ?? config?.klineStatsLeverage ?? 3;
  const longLev = config?.longLeverage ?? 3;
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
            <span className="badge-leverage" title={`新高闪击 ${streakLev}x · 量化特征 ${klineStatsLev}x · 做多 ${longLev}x · 顺势波段 ${trendLev}x · 动态仓位 ${marginPercent}% (当前约 ${marginUsdt}U) · 最大 ${maxPositions} 仓 (每策略 ${maxPerStrategy})`}>
              杠杆 (闪击{streakLev}x / 量化{klineStatsLev}x / 多{longLev}x / 波段{trendLev}x) · 仓位 {marginPercent}% (约 {marginUsdt}U) · 限仓 {maxPositions}
            </span>
            <span className="badge-strategy" title="可独立配置的策略：新高顶背离 · 首次跌10% · 跌到20%+ · 小时线压制 · 左侧3W底背离 · 量化特征做空 · 量化特征做多">
              量化形态挖掘 · 多空二阶段交易
            </span>
          </h2>
          {summary?.factorMining && <div className="paper-factor-status" aria-live="polite">
            <strong>{config?.factorMining?.enabled ? (summary.factorMining.running ? "正在挖掘新因子" : "持续挖掘已启用") : "因子自动更新已关闭"}</strong>
            {config?.factorMining?.enabled && <>
              <span>每 {config.factorMining.refreshMinutes} 分钟更新 · 有效期 {config.factorMining.validForMinutes / 60} 小时 · 持仓期间持续运行</span>
              {(["LONG", "SHORT"] as const).map(side => {
                const status = summary.factorMining!.sides[side];
                const active = status.active;
                const enabled = side === "LONG" ? config.enableLongs && config.enableKlineStatsLong : config.enableKlineStatsShort;
                const allowed = summary.factorMining!.entryAllowed[side];
                return <span key={side}>
                  {side === "LONG" ? "量化做多" : "量化做空"}：{!enabled ? "策略已关闭" : allowed ? "验证通过，可开仓" : "暂停新开仓"}
                  {active && <> · 留出胜率 {active.holdout.winRate.toFixed(1)}% / {active.holdout.trades} 笔 · 到期 {new Date(active.expiresAt).toLocaleString("zh-CN")}</>}
                  {!active && enabled && <> · {status.reason}</>}
                </span>;
              })}
              {summary.factorMining.nextRunAt && <span>下轮：{new Date(summary.factorMining.nextRunAt).toLocaleString("zh-CN")}</span>}
              {summary.factorMining.lastError && <span>最近一轮：{summary.factorMining.lastError}</span>}
            </>}
          </div>}
          <div className="paper-stats-chips">
            <span className={`chip ${account.totalPnlUsdt >= 0 ? "chip-pos" : "chip-neg"}`}>
              账户净值: <b>{account.equityUsdt.toFixed(2)} USDT</b>
              <small> ({account.accountRoiPercent >= 0 ? "+" : ""}{account.accountRoiPercent.toFixed(1)}%)</small>
            </span>
            <span className="chip">
              可用保证金: <b>{account.availableMarginUsdt.toFixed(2)} USDT</b>
              <small> (本金 {account.initialBalanceUsdt.toFixed(0)}U)</small>
            </span>
            <span className="chip">
              盈亏比 (PF): <b>{Number.isFinite(pf) ? pf.toFixed(2) : "∞"}</b>
            </span>
            <span className="chip">
              成交: <b>{summary?.totalTrades ?? 0}</b> 笔
              <span className="sub-counts"> (胜 {summary?.winningTrades ?? 0} / 负 {summary?.losingTrades ?? 0})</span>
            </span>
            {(["LONG", "SHORT"] as const).map(side => {
              const total = summary?.bySide?.[side];
              const recent = summary?.stats24h?.bySide?.[side];
              const format = (stats: typeof total) => stats?.totalTrades ? `${stats.winRate.toFixed(1)}% (${stats.winningTrades}/${stats.totalTrades})` : "— (0笔)";
              return <span className="chip" key={side} title="按整笔交易扣除手续费和滑点后的净盈亏统计；未完全平仓不计入">
                {side === "LONG" ? "做多" : "做空"}胜率: <b>{format(total)}</b>
                <small> · 24h {format(recent)}</small>
              </span>;
            })}
            {summary?.stats24h && summary.stats24h.totalTrades > 0 && (
              <span className="chip" style={{ background: "rgba(52, 152, 219, 0.12)", borderColor: "rgba(52, 152, 219, 0.3)" }} title="过去 24 小时已结清订单战绩">
                24h平仓: <b>{summary.stats24h.totalTrades}</b> 笔
                <span className="sub-counts"> (胜率 {summary.stats24h.winRate.toFixed(1)}% · {summary.stats24h.totalNetPnlUsdt >= 0 ? "+" : ""}{summary.stats24h.totalNetPnlUsdt.toFixed(2)}U)</span>
              </span>
            )}
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
            {showHistory ? "收起历史记录" : "24h 历史成交明细"}
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
                当前暂无活跃持仓与挂单 · 账户净值 {account.equityUsdt.toFixed(1)} USDT · 动态保证金 {marginPercent}% (当前约 {marginUsdt} USDT) · 最大同时持仓 {maxPositions} 笔 (每策略至多 {maxPerStrategy} 笔) · 首次跌10% · 新高顶背离 · 跌到20%+ · 小时线压制 · 左侧3W底背离
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

      {/* 历史记录展开抽屉 (默认优先呈现 24h 内的交易，支持查看全部) */}
      {showHistory && (() => {
        const nowMs = Date.now();
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        const history24h = historyList.filter(
          (item) => (item.closedAt ?? item.entryTime) >= nowMs - ONE_DAY_MS
        );
        const displayedHistory = historyFilter === "24h" ? history24h : historyList;

        return (
          <div className="paper-history-drawer">
            <div className="history-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px", marginBottom: "8px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <h3 style={{ margin: 0, fontSize: "14px" }}>
                  {historyFilter === "24h"
                    ? `🕒 过去 24 小时平仓明细 (${displayedHistory.length} 笔)`
                    : `📜 全部历史平仓明细 (${displayedHistory.length} 笔)`}
                </h3>
                {historyLoading && <span className="loading-hint">加载中…</span>}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <button
                  type="button"
                  className={`btn-sub-tab ${historyFilter === "24h" ? "active" : ""}`}
                  onClick={() => setHistoryFilter("24h")}
                  style={{
                    padding: "4px 10px",
                    fontSize: "12px",
                    borderRadius: "4px",
                    cursor: "pointer",
                    background: historyFilter === "24h" ? "#3498db" : "rgba(255, 255, 255, 0.05)",
                    color: historyFilter === "24h" ? "#fff" : "var(--muted)",
                    border: "1px solid " + (historyFilter === "24h" ? "#3498db" : "var(--border)"),
                    fontWeight: historyFilter === "24h" ? "bold" : "normal",
                  }}
                >
                  近 24 小时 ({history24h.length} 笔)
                </button>
                <button
                  type="button"
                  className={`btn-sub-tab ${historyFilter === "all" ? "active" : ""}`}
                  onClick={() => setHistoryFilter("all")}
                  style={{
                    padding: "4px 10px",
                    fontSize: "12px",
                    borderRadius: "4px",
                    cursor: "pointer",
                    background: historyFilter === "all" ? "#3498db" : "rgba(255, 255, 255, 0.05)",
                    color: historyFilter === "all" ? "#fff" : "var(--muted)",
                    border: "1px solid " + (historyFilter === "all" ? "#3498db" : "var(--border)"),
                    fontWeight: historyFilter === "all" ? "bold" : "normal",
                  }}
                >
                  全部历史 ({historyList.length} 笔)
                </button>
              </div>
            </div>

            {/* 24 小时平仓战绩概览条 */}
            {history24h.length > 0 && (
              <div
                style={{
                  display: "flex",
                  gap: "14px",
                  alignItems: "center",
                  flexWrap: "wrap",
                  padding: "8px 12px",
                  background: "rgba(52, 152, 219, 0.08)",
                  borderRadius: "6px",
                  border: "1px solid rgba(52, 152, 219, 0.2)",
                  marginBottom: "10px",
                  fontSize: "12px",
                }}
              >
                <span>
                  🕒 <b>24h 战绩汇总</b>：成交 <b>{history24h.length}</b> 笔
                  (胜 <b>{history24h.filter((t) => t.totalNetPnlUsdt > 0.001).length}</b> / 负 <b>{history24h.filter((t) => t.totalNetPnlUsdt < -0.001).length}</b>)
                </span>
                <span>
                  24h 胜率: <b style={{ color: "#3498db" }}>{(history24h.filter((t) => t.totalNetPnlUsdt > 0.001).length / history24h.length * 100).toFixed(1)}%</b>
                </span>
                {(() => {
                  const net24h = history24h.reduce((acc, t) => acc + t.totalNetPnlUsdt, 0);
                  return (
                    <span className={net24h >= 0 ? "pos" : "neg"}>
                      24h 累计净盈亏: <b>{net24h >= 0 ? "+" : ""}{net24h.toFixed(2)} USDT</b>
                    </span>
                  );
                })()}
              </div>
            )}

            {displayedHistory.length === 0 ? (
              <div className="empty-history" style={{ display: "flex", alignItems: "center", gap: "10px", padding: "12px 0" }}>
                <span>
                  {historyFilter === "24h"
                    ? `近 24 小时暂无已结清订单 (历史总计 ${historyList.length} 笔)。`
                    : "暂无历史结清订单"}
                </span>
                {historyFilter === "24h" && historyList.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setHistoryFilter("all")}
                    style={{
                      padding: "3px 10px",
                      fontSize: "11px",
                      borderRadius: "4px",
                      border: "1px solid var(--border)",
                      background: "rgba(255, 255, 255, 0.06)",
                      color: "var(--text)",
                      cursor: "pointer",
                    }}
                  >
                    查看全部历史订单
                  </button>
                )}
              </div>
            ) : (
              <div className="table-wrap">
                <table className="paper-history-table">
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left" }}>平仓时间</th>
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
                    {displayedHistory.map((item) => {
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
                            {formatHistoryTime(item.closedAt)}
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
        );
      })()}
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
              {/* 1. 杠杆倍数设置 */}
              <div style={{ marginBottom: "14px", padding: "10px", background: "rgba(52, 152, 219, 0.08)", borderRadius: "8px", border: "1px solid rgba(52, 152, 219, 0.2)" }}>
                <div style={{ fontSize: "12px", fontWeight: "bold", color: "#4d9dff", marginBottom: "8px" }}>⚡ 策略杠杆倍数设置</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                  <div className="config-form-group" style={{ margin: 0 }}>
                    <label style={{ display: "block", fontSize: "11px", marginBottom: "3px" }}>新高闪击空 (Streak)</label>
                    <input
                      type="number"
                      min="1"
                      max="50"
                      value={streakLevInput}
                      onChange={(e) => setStreakLevInput(Number(e.target.value))}
                      required
                    />
                  </div>
                  <div className="config-form-group" style={{ margin: 0 }}>
                    <label style={{ display: "block", fontSize: "11px", marginBottom: "3px" }}>3W 底背离做多杠杆</label>
                    <input
                      type="number"
                      min="1"
                      max="20"
                      value={longLevInput}
                      onChange={(e) => setLongLevInput(Number(e.target.value))}
                      required
                    />
                  </div>
                  <div className="config-form-group" style={{ margin: 0 }}>
                    <label style={{ display: "block", fontSize: "11px", marginBottom: "3px" }}>顺势衰竭杠杆 (Trend)</label>
                    <input
                      type="number"
                      min="1"
                      max="10"
                      value={trendLevInput}
                      onChange={(e) => setTrendLevInput(Number(e.target.value))}
                      required
                    />
                  </div>
                </div>
              </div>

              {/* 2. 仓位与风控 */}
              <div style={{ marginBottom: "14px", padding: "10px", background: "rgba(255, 255, 255, 0.03)", borderRadius: "8px", border: "1px solid var(--border)" }}>
                <div style={{ fontSize: "12px", fontWeight: "bold", color: "var(--text)", marginBottom: "8px" }}>🛡️ 仓位风控与门槛参数</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                  <div className="config-form-group" style={{ margin: 0 }}>
                    <label style={{ display: "block", fontSize: "11px", marginBottom: "3px" }}>单笔仓位比例 (%)</label>
                    <input
                      type="number"
                      min="5"
                      max="20"
                      step="1"
                      value={marginPercentInput}
                      onChange={(e) => setMarginPercentInput(Number(e.target.value))}
                      required
                    />
                  </div>
                  <div className="config-form-group" style={{ margin: 0 }}>
                    <label style={{ display: "block", fontSize: "11px", marginBottom: "3px" }}>全局最大持仓数</label>
                    <input
                      type="number"
                      min="1"
                      max="5"
                      value={maxPositionsInput}
                      onChange={(e) => setMaxPositionsInput(Number(e.target.value))}
                      required
                    />
                  </div>
                  <div className="config-form-group" style={{ margin: 0 }}>
                    <label style={{ display: "block", fontSize: "11px", marginBottom: "3px" }}>单策略限仓 (笔)</label>
                    <input
                      type="number"
                      min="1"
                      max="1"
                      value={maxPerStrategyInput}
                      onChange={(e) => setMaxPerStrategyInput(Number(e.target.value))}
                      required
                    />
                  </div>
                  <div className="config-form-group" style={{ margin: 0 }}>
                    <label style={{ display: "block", fontSize: "11px", marginBottom: "3px" }}>新高背离分母 (24h/N)</label>
                    <input
                      type="number"
                      min="1"
                      max="50"
                      value={ampDivisorInput}
                      onChange={(e) => setAmpDivisorInput(Number(e.target.value))}
                      required
                    />
                  </div>
                </div>
                <div className="config-form-group" style={{ marginTop: "8px", marginBottom: 0 }}>
                  <label style={{ display: "block", fontSize: "11px", marginBottom: "3px" }}>入场挂单分母 (0=市价直开；&gt;0=向上溢价接针)</label>
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
              </div>

              <fieldset className="kline-strategy-settings">
                <legend>持续因子挖掘</legend>
                <label><input type="checkbox" checked={factorMiningInput.enabled}
                  onChange={e => setFactorMiningInput({ ...factorMiningInput, enabled: e.target.checked })} /> 建仓后继续挖掘，通过近期验证后自动更新量化多空参数</label>
                <div className="kline-strategy-fields">
                  <label>刷新间隔（分钟）<input type="number" min={15} max={factorMiningInput.validForMinutes - 1} step={1} required
                    value={factorMiningInput.refreshMinutes} onChange={e => setFactorMiningInput({ ...factorMiningInput, refreshMinutes: Number(e.target.value) })} /></label>
                  <label>有效期（分钟，最长半天）<input type="number" min={Math.max(30, factorMiningInput.refreshMinutes + 1)} max={720} step={1} required
                    value={factorMiningInput.validForMinutes} onChange={e => setFactorMiningInput({ ...factorMiningInput, validForMinutes: Number(e.target.value) })} /></label>
                </div>
                <p>自动模式使用 3x。手动修改量化参数后须重新验证；因子过期时暂停新开仓，已有持仓按建仓规则退出。策略开关仍由你控制。</p>
              </fieldset>
              <KlineStrategySettings title="量化做空形态与二阶段退出" value={shortSpec} onChange={setShortSpec} />
              <KlineStrategySettings title="量化做多形态与二阶段退出" value={longSpec} onChange={setLongSpec} />
              {/* 3. 策略开关 */}
              <div style={{ marginBottom: "16px", padding: "10px", background: "rgba(255, 255, 255, 0.03)", borderRadius: "8px", border: "1px solid var(--border)" }}>
                <div style={{ fontSize: "12px", fontWeight: "bold", color: "var(--text)", marginBottom: "8px" }}>🚦 策略独立运行开关</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", fontSize: "12px" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={enableStreakInput}
                      onChange={(e) => setEnableStreakInput(e.target.checked)}
                    />
                    <span>新高顶背离闪击空</span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={enableReboundInput}
                      onChange={(e) => setEnableReboundInput(e.target.checked)}
                    />
                    <span>首次跌10%弱反弹空</span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={enableDeepReboundInput}
                      onChange={(e) => setEnableDeepReboundInput(e.target.checked)}
                    />
                    <span>跌20%+次级反弹空</span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={enableHourlySuppressionInput}
                      onChange={(e) => setEnableHourlySuppressionInput(e.target.checked)}
                    />
                    <span>小时线压制做空</span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={enableLongsInput}
                      onChange={(e) => setEnableLongsInput(e.target.checked)}
                    />
                    <span>做多总开关</span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={enableWBottomDivergenceInput}
                      onChange={(e) => setEnableWBottomDivergenceInput(e.target.checked)}
                    />
                    <span>左侧3W底背离做多</span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={enableKlineStatsShortInput}
                      onChange={(e) => setEnableKlineStatsShortInput(e.target.checked)}
                    />
                    <span style={{ color: "#f0ad4e", fontWeight: "bold" }}>量化特征做空 (策略7)</span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={enableKlineStatsLongInput}
                      onChange={(e) => setEnableKlineStatsLongInput(e.target.checked)}
                    />
                    <span style={{ color: "#5cb85c", fontWeight: "bold" }}>量化特征做多 (策略8)</span>
                  </label>
                </div>
              </div>

              <div className="config-modal-actions">
                <button
                  type="button"
                  className="btn-preset-reset"
                  onClick={handleResetOptimal}
                  title="恢复默认推荐设置"
                >
                  恢复基础配置
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
