import { useEffect, useMemo, useState } from "react";
import { useStatus } from "./hooks/useStatus";
import { useLiveTrading } from "./hooks/useLiveTrading";
import { GroupSection } from "./components/GroupSection";
import { ChartPanel } from "./components/KlineChart";
import { Countdown } from "./components/Countdown";
import { LiveTradingPanel } from "./components/LiveTradingPanel";
import { SymbolDetailCard } from "./components/SymbolDetailCard";
import { TerminalDock, type DockTabKey } from "./components/TerminalDock";
import { KlineStatsPanel } from "./components/KlineStatsPanel";
import { detectIntervalSignals } from "../../src/kline-stats.ts";
import type { ChartBar } from "../../src/types.ts";
import "./App.css";

export default function App() {
  const { status, error } = useStatus();
  const { state: liveState, connected: liveConnected, setState: setLiveState } = useLiveTrading(status?.liveTrading);
  const [showLiveModal, setShowLiveModal] = useState(false);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [remaining, setRemaining] = useState(60);

  // 当前选中标的：榜单点击与图表下拉联动
  const [chartSymbol, setChartSymbol] = useState("BTCUSDT");

  // 底部控制台当前激活 Tab
  const [dockTab, setDockTab] = useState<DockTabKey>("positions");

  // 窄屏/移动端当前激活模块
  const [mobileTab, setMobileTab] = useState<"board" | "chart" | "dock">("chart");

  // K 线与量化统计联动状态
  const [currentBars, setCurrentBars] = useState<ChartBar[]>([]);
  const [effectiveDayChange, setEffectiveDayChange] = useState<number | null>(null);
  const [windowMinutes, setWindowMinutes] = useState(15);
  const [quantMode, setQuantMode] = useState<"surge" | "drop" | "both">("both");
  const [showMarkers, setShowMarkers] = useState(true);
  const [jumpToTime, setJumpToTime] = useState<number | null>(null);

  // 倒计时：距下根 1m K线收盘时间 (对齐自然分钟)
  useEffect(() => {
    const id = setInterval(() => {
      const secIntoMinute = (Date.now() / 1000) % 60;
      setRemaining(Math.max(0, 60 - secIntoMinute));
    }, 100);
    return () => clearInterval(id);
  }, []);

  const isLiveTrading = Boolean(liveState?.enabled);

  // 同步浏览器窗口标题栏（Tab 标题）
  useEffect(() => {
    const modeName = isLiveTrading ? (liveState?.testnet ? "实盘(测试网)" : "实盘交易") : "模拟交易";
    document.title = `[${modeName}] Binance 1m Monitor`;
  }, [isLiveTrading, liveState?.testnet]);

  // 连接状态点与元信息
  let dotColor = "#2ecc71";
  let meta = "加载中…";
  if (error) {
    dotColor = "#f5a623";
    meta = `请求失败: ${error}`;
  } else if (status) {
    if (status.error) {
      dotColor = "#ff4d4f";
      meta = `错误: ${status.error}`;
    } else {
      meta =
        `更新于 ${new Date(status.at).toLocaleTimeString()}` +
        ` · 数据源 ${status.base}` +
        ` · 统一特征监控 + 参数组合` +
        ` · 1m收盘轮询`;
    }
  }

  // 标题栏状态胶囊
  let dotClass = "dot-green";
  const modeLabel = isLiveTrading ? (liveState?.testnet ? "🔥 实盘(测试网)" : "🔥 实盘交易") : "⚡ 模拟交易";
  let statusLabel = "运行中";
  let modeTooltip = "";

  if (isLiveTrading) {
    if (!liveConnected) {
      dotClass = "dot-amber";
      statusLabel = "断开";
      modeTooltip = "实盘连接中断，重连中…";
    } else if (liveState?.status === "halted") {
      dotClass = "dot-red";
      statusLabel = "熔断";
      modeTooltip = `实盘熔断: ${liveState.reason ?? "请结清持仓后恢复"}`;
    } else if (liveState?.status === "paused") {
      dotClass = "dot-amber";
      statusLabel = "暂停";
      modeTooltip = "实盘开仓已暂停";
    } else if (liveState?.status === "starting") {
      dotClass = "dot-blue";
      statusLabel = "检查中";
      modeTooltip = "正在对账实盘账户…";
    } else if (liveState?.activeTrade) {
      dotClass = "dot-green";
      statusLabel = `持仓 (${liveState.activeTrade.symbol})`;
      modeTooltip = `实盘持仓: ${liveState.activeTrade.symbol}`;
    } else {
      dotClass = "dot-green";
      statusLabel = "等待信号";
      modeTooltip = `实盘就绪 (资金上限 ${liveState?.budgetUsdt ?? 10} USDT)`;
    }
  } else {
    if (error && !liveConnected) {
      dotClass = "dot-amber";
      statusLabel = "异常";
      modeTooltip = "模拟服务连接异常，重试中…";
    } else {
      dotClass = "dot-green";
      statusLabel = "运行中";
      modeTooltip = "模拟交易模式 · 本地引擎实时撮合 · 初始 100 USDT";
    }
  }

  // 图表可选标的列表
  const chartSymbols = status?.gainers
    ? status.gainers.map((r) => r.symbol)
    : ["BTCUSDT", "SOLUSDT"];

  // 点击榜单行 → 切换标的
  const selectSymbol = (symbol: string) => {
    setChartSymbol(symbol);
  };

  // 当前选中标的在榜单中的快照
  const currentGainer = status?.gainers?.find((r) => r.symbol === chartSymbol);
  const dayChangePercent = currentGainer?.priceChangePercent ?? null;

  // 活跃持仓与挂单标的索引 Set
  const activePositions = status?.paperTrading?.activePositions ?? [];
  const pendingOrders = status?.paperTrading?.pendingOrders ?? [];
  const activePositionSymbols = useMemo(() => {
    const s = new Set<string>();
    activePositions.forEach((p) => s.add(p.symbol));
    return s;
  }, [activePositions]);
  const activeOrderSymbols = useMemo(() => {
    const s = new Set<string>();
    pendingOrders.forEach((o) => s.add(o.symbol));
    return s;
  }, [pendingOrders]);

  const activePosForChart = activePositions.find((p) => p.symbol === chartSymbol);
  const pendingOrderForChart = pendingOrders.find((o) => o.symbol === chartSymbol);

  // 接收 ChartPanel 传出的 K 线，同步计算量化达标振幅区间
  const handleBarsLoaded = (bars: ChartBar[], dayChange: number | null) => {
    setCurrentBars(bars);
    setEffectiveDayChange(dayChange);
  };

  const signals = useMemo(() => {
    if (!currentBars || currentBars.length === 0) return [];
    return detectIntervalSignals(currentBars, effectiveDayChange, {
      windowMinutes,
      mode: quantMode,
    });
  }, [currentBars, effectiveDayChange, windowMinutes, quantMode]);

  // 账户概况快照
  const account = status?.paperTrading?.account ?? {
    equityUsdt: 100,
    availableMarginUsdt: 100,
    profitFactor: 1,
    accountRoiPercent: 0,
  };
  const pf = status?.paperTrading?.profitFactor ?? 1;
  const factorMiningInfo = useMemo(() => {
    const fm = status?.paperTrading?.factorMining;
    const config = status?.paperTrading?.config;
    const isEnabled = config?.factorMining?.enabled;
    let label = "已关闭";
    let color = "var(--text-muted, #888)";
    if (isEnabled) {
      if (fm?.running) {
        label = "计算中...";
        color = "#3498db";
      } else if (fm) {
        const shortActive = fm.sides.SHORT.active;
        const longActive = fm.sides.LONG.active;
        const shortUsable = shortActive && fm.entryAllowed.SHORT && Date.now() < Math.min(shortActive.expiresAt, shortActive.dataAsOf + (config?.factorMining?.validForMinutes ?? 120) * 60_000);
        const longUsable = longActive && fm.entryAllowed.LONG && Date.now() < Math.min(longActive.expiresAt, longActive.dataAsOf + (config?.factorMining?.validForMinutes ?? 120) * 60_000);
        if (shortUsable && longUsable) {
          label = `多空生效 (空${shortActive.holdout.winRate.toFixed(0)}%/多${longActive.holdout.winRate.toFixed(0)}%)`;
          color = "#2ecc71";
        } else if (shortUsable) {
          label = `空头生效 (胜率${shortActive.holdout.winRate.toFixed(0)}%)`;
          color = "#2ecc71";
        } else if (longUsable) {
          label = `多头生效 (胜率${longActive.holdout.winRate.toFixed(0)}%)`;
          color = "#2ecc71";
        } else {
          label = shortActive || longActive ? "因子失效 · 等待新验证" : "待近期样本验证";
          color = "#f39c12";
        }
      }
    }
    return { label, color, isEnabled };
  }, [status?.paperTrading?.factorMining, status?.paperTrading?.config]);

  return (
    <div className="terminal-container">
      {/* 金融终端顶级导航条 */}
      <header className="terminal-header">
        <div className="terminal-header-left">
          <div className="terminal-brand">
            <span className="brand-logo">⚡</span>
            <span className="brand-name">BINANCE 1M MONITOR</span>
            <Countdown remaining={remaining} total={60} />
          </div>

          <div className="terminal-meta" title={meta}>
            <span className="meta-dot" style={{ background: dotColor }} />
            <span className="meta-text">{status ? `更新 ${new Date(status.at).toLocaleTimeString()}` : meta}</span>
          </div>
        </div>

        {/* 顶部账户核心指标摘要 Ticker */}
        <div className="terminal-header-ticker">
          <div className="ticker-chip" title="模拟账户净值与累计收益率">
            <span className="ticker-label">净值</span>
            <span className={`ticker-val ${account.equityUsdt >= 100 ? "pos" : "neg"}`}>
              {account.equityUsdt.toFixed(2)} U
              <small> ({account.accountRoiPercent >= 0 ? "+" : ""}{account.accountRoiPercent.toFixed(1)}%)</small>
            </span>
          </div>

          <div className="ticker-chip" title="可用保证金余额">
            <span className="ticker-label">可用</span>
            <span className="ticker-val">{account.availableMarginUsdt.toFixed(1)} U</span>
          </div>

          <div className="ticker-chip" title="策略盈亏比 (Profit Factor)">
            <span className="ticker-label">PF</span>
            <span className="ticker-val">{Number.isFinite(pf) ? pf.toFixed(2) : "∞"}</span>
          </div>

          <div
            className={`ticker-chip ticker-interactive ${activePositions.length > 0 ? "chip-has-pos" : ""}`}
            onClick={() => setDockTab("positions")}
            title="点击切换到底部持仓明细"
          >
            <span className="ticker-label">持仓</span>
            <span className="ticker-val">
              <b>{activePositions.length}</b> 笔
            </span>
          </div>

          {pendingOrders.length > 0 && (
            <div
              className="ticker-chip ticker-interactive chip-has-order"
              onClick={() => setDockTab("positions")}
              title="点击查看冲高做空挂单"
            >
              <span className="ticker-label">挂单</span>
              <span className="ticker-val">
                <b>{pendingOrders.length}</b> 笔
              </span>
            </div>
          )}

          {factorMiningInfo.isEnabled && (
            <div
              className="ticker-chip ticker-interactive"
              onClick={() => setDockTab("mining")}
              title="持续因子挖掘状态"
            >
              <span className="ticker-label">⛏️ 因子挖掘</span>
              <span className="ticker-val" style={{ color: factorMiningInfo.color }}>
                {factorMiningInfo.label}
              </span>
            </div>
          )}
        </div>

        {/* 顶部右侧：实盘/模拟切换胶囊与设置按钮 */}
        <div className="terminal-header-right">
          <div
            className={`trading-mode-badge trading-mode-${isLiveTrading ? "live" : "paper"} ${liveState?.status === "halted" ? "is-halted" : ""}`}
            onClick={() => setShowLiveModal(true)}
            title={`${modeTooltip} · 点击查看实盘控制面板`}
            role="status"
          >
            <span className={`badge-dot ${dotClass}`} />
            <span className="badge-mode-label">{modeLabel}</span>
            <span className="badge-divider">·</span>
            <span className="badge-status-label">{statusLabel}</span>
          </div>

          <button
            type="button"
            className="btn-config-toggle header-config-btn"
            onClick={() => setShowConfigModal(true)}
            title="策略参数设置"
          >
            ⚙️ 策略参数设置
          </button>
        </div>
      </header>

      {/* 窄屏/移动端 Top Tab Bar */}
      <div className="mobile-tabs-bar">
        <button
          type="button"
          className={`mobile-tab-btn ${mobileTab === "board" ? "active" : ""}`}
          onClick={() => setMobileTab("board")}
        >
          📊 行情榜单
        </button>
        <button
          type="button"
          className={`mobile-tab-btn ${mobileTab === "chart" ? "active" : ""}`}
          onClick={() => setMobileTab("chart")}
        >
          📈 K线与特征
        </button>
        <button
          type="button"
          className={`mobile-tab-btn ${mobileTab === "dock" ? "active" : ""}`}
          onClick={() => setMobileTab("dock")}
        >
          ⚡ 交易详情 ({activePositions.length + pendingOrders.length})
        </button>
      </div>

      {/* 金融终端 3 列工作台布局 (100vh 满屏，无全局滚动条) */}
      <main className="terminal-workspace">
        {/* 左列：24h 涨幅榜 + 底部选中标的深度卡片 */}
        <div className={`terminal-left ${mobileTab === "board" ? "mobile-active" : ""}`}>
          <div className="terminal-left-board">
            <GroupSection
              id="s1"
              title="24h 涨幅榜"
              changeHeader="24h涨幅%"
              rows={status?.gainers ?? []}
              changeKey="priceChangePercent"
              active={true}
              onSelectSymbol={selectSymbol}
              selectedSymbol={chartSymbol}
              activePositionSymbols={activePositionSymbols}
              activeOrderSymbols={activeOrderSymbols}
            />
          </div>

          {/* 标的详细指标与持仓速览（完美填补榜单下方空白） */}
          <div className="terminal-left-detail">
            <SymbolDetailCard
              symbol={chartSymbol}
              gainer={currentGainer}
              activePosition={activePosForChart}
              pendingOrder={pendingOrderForChart}
              onSwitchTab={(tab) => {
                setDockTab(tab);
                setMobileTab("dock");
              }}
            />
          </div>
        </div>

        {/* 中间列：K线 (上半区) + 量化特征统计 (下半区)，占约三分之一宽度 */}
        <div className={`terminal-center ${mobileTab === "chart" ? "mobile-active" : ""}`}>
          {/* 中间列上半区：1m K 线图表 */}
          <div className="terminal-center-chart">
            <ChartPanel
              symbols={chartSymbols}
              symbol={chartSymbol}
              onSymbolChange={setChartSymbol}
              active={true}
              markerTime={status?.at ? Date.parse(status.at) : null}
              dayChangePercent={dayChangePercent}
              jumpToTime={jumpToTime}
              windowMinutes={windowMinutes}
              mode={quantMode}
              showMarkers={showMarkers}
              embedStats={false}
              onBarsLoaded={handleBarsLoaded}
            />
          </div>

          {/* 中间列下半区：K 线量化特征统计与分时明细 (独立纵向滚动，点击直接在上方K线定位) */}
          <div className="terminal-center-stats">
            {currentBars.length > 0 ? (
              <KlineStatsPanel
                symbol={chartSymbol}
                bars={currentBars}
                dayChangePercent={dayChangePercent}
                onSelectTime={(timeMs) => setJumpToTime(timeMs)}
                windowMinutes={windowMinutes}
                onWindowMinutesChange={setWindowMinutes}
                mode={quantMode}
                onModeChange={setQuantMode}
                showMarkers={showMarkers}
                onToggleMarkers={() => setShowMarkers((v) => !v)}
                signals={signals}
              />
            ) : (
              <div className="center-stats-empty">
                <span>⏳ 正在加载 {chartSymbol} 1m K线与特征指标…</span>
              </div>
            )}
          </div>
        </div>

        {/* 右侧列：交易详情全高面板 (模拟持仓、挂单、成交明细、策略风控、因子挖掘) */}
        <div className={`terminal-right ${mobileTab === "dock" ? "mobile-active" : ""}`}>
          <TerminalDock
            activeTab={dockTab}
            onTabChange={setDockTab}
            symbol={chartSymbol}
            bars={currentBars}
            dayChangePercent={dayChangePercent}
            signals={signals}
            windowMinutes={windowMinutes}
            onWindowMinutesChange={setWindowMinutes}
            mode={quantMode}
            onModeChange={setQuantMode}
            showMarkers={showMarkers}
            onToggleMarkers={() => setShowMarkers((v) => !v)}
            onSelectTime={(timeMs) => setJumpToTime(timeMs)}
            paperSummary={status?.paperTrading}
            onSelectSymbol={selectSymbol}
            selectedSymbol={chartSymbol}
            showConfigModal={showConfigModal}
            onOpenConfigModal={() => setShowConfigModal(true)}
            onCloseConfigModal={() => setShowConfigModal(false)}
          />
        </div>
      </main>

      {/* 实盘交易模态弹窗 */}
      <LiveTradingPanel
        isOpen={showLiveModal}
        onClose={() => setShowLiveModal(false)}
        state={liveState}
        connected={liveConnected}
        onStateChange={setLiveState}
      />
    </div>
  );
}
