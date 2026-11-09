import { useEffect, useState } from "react";
import { useStatus } from "./hooks/useStatus";
import { useLiveTrading } from "./hooks/useLiveTrading";
import { GroupSection } from "./components/GroupSection";
import { ChartPanel } from "./components/KlineChart";
import { Countdown } from "./components/Countdown";
import { PaperTradingPanel } from "./components/PaperTradingPanel";
import { LiveTradingPanel } from "./components/LiveTradingPanel";
import "./App.css";

export default function App() {
  const { status, error } = useStatus();
  const { state: liveState, connected: liveConnected, setState: setLiveState } = useLiveTrading(status?.liveTrading);
  const [showLiveModal, setShowLiveModal] = useState(false);
  const [remaining, setRemaining] = useState(60);
  // 图表当前标的：下拉与"点击榜单行"共用同一份状态，右上角标题随它更新
  const [chartSymbol, setChartSymbol] = useState("BTCUSDT");

  // Countdown ring: seconds left until the current 1m candle closes (the
  // wall-clock minute boundary). Driven off the clock, not lastFetchedAt, so it
  // keeps ticking down correctly even if a poll failed or is in flight.
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

  // Dot colour mirrors the original: green = ok, red = API error, orange = fetch failed.
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
        ` · 规则：统一特征监控 + 条件与参数组合` +
        ` · 每分钟轮询（对齐1m收盘）`;
    }
  }

  // 标题栏状态胶囊
  let dotClass = "dot-green";
  const modeLabel = isLiveTrading ? (liveState?.testnet ? "🔥 实盘交易 (测试网)" : "🔥 实盘交易") : "⚡ 模拟交易";
  let statusLabel = "运行中";
  let modeTooltip = "";

  if (isLiveTrading) {
    if (!liveConnected) {
      dotClass = "dot-amber";
      statusLabel = "连接断开";
      modeTooltip = "实盘接口连接中断，正在自动重连… 点击查看实盘控制面板";
    } else if (liveState?.status === "halted") {
      dotClass = "dot-red";
      statusLabel = "已熔断";
      modeTooltip = `实盘已触发熔断: ${liveState.reason ?? "请结清持仓后恢复"}。点击查看实盘控制面板`;
    } else if (liveState?.status === "paused") {
      dotClass = "dot-amber";
      statusLabel = "已暂停";
      modeTooltip = "实盘开仓已暂停。点击查看实盘控制面板";
    } else if (liveState?.status === "starting") {
      dotClass = "dot-blue";
      statusLabel = "检查中";
      modeTooltip = "正在对账和检查实盘账户…";
    } else if (liveState?.activeTrade) {
      dotClass = "dot-green";
      statusLabel = `持仓中 (${liveState.activeTrade.symbol})`;
      modeTooltip = `实盘当前持仓 ${liveState.activeTrade.symbol}，点击查看详情`;
    } else {
      dotClass = "dot-green";
      statusLabel = "等待新信号";
      modeTooltip = `实盘已就绪 (资金上限 ${liveState?.budgetUsdt ?? 10} USDT)，跟随新开仓信号。点击查看实盘控制面板`;
    }
  } else {
    // 模拟交易
    if (error && !liveConnected) {
      dotClass = "dot-amber";
      statusLabel = "连接断开";
      modeTooltip = "服务连接异常，正在尝试重连…";
    } else {
      dotClass = "dot-green";
      statusLabel = "运行中";
      modeTooltip = "当前处于【模拟交易】模式 · 不扣除真实资金 · 挂单与持仓由本地模拟引擎撮合。点击查看模拟面板";
    }
  }

  const scrollToTradingPanel = () => {
    const targetId = isLiveTrading ? "live-trading-panel" : "paper-trading-panel";
    document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // 图表可选标的：榜单在列的优先（含置顶的 BTC/SOL），保证点得到刚看到的币种
  const chartSymbols = status?.gainers
    ? status.gainers.map((r) => r.symbol)
    : ["BTCUSDT", "SOLUSDT"];

  // 点击榜单行 → 切图表。窄屏上图表在表格下方，得滚过去才看得到切没切成。
  const selectSymbol = (symbol: string) => {
    setChartSymbol(symbol);
    if (window.innerWidth < 900) {
      document.getElementById("s2")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  // 查找当前标的在涨幅榜/快照中的 24h 涨跌幅
  const currentGainer = status?.gainers?.find((r) => r.symbol === chartSymbol);
  const dayChangePercent = currentGainer?.priceChangePercent ?? null;

  return (
    <>
      <header>
        <div className="header-row">
          <h1>
            <span>Binance 1m Monitor</span>
            <Countdown remaining={remaining} total={60} />
          </h1>
          <div
            className={`trading-mode-badge trading-mode-${isLiveTrading ? "live" : "paper"} ${liveState?.status === "halted" ? "is-halted" : ""}`}
            onClick={() => setShowLiveModal(true)}
            title={`${modeTooltip} · 点击弹出实盘控制与配置说明`}
            role="status"
          >
            <span className={`badge-dot ${dotClass}`} />
            <span className="badge-mode-label">{modeLabel}</span>
            <span className="badge-divider">·</span>
            <span className="badge-status-label">{statusLabel}</span>
            <span className="badge-action-hint">实盘说明</span>
          </div>
        </div>
        <div className="meta">
          <span className="dot" style={{ background: dotColor }} />
          <span>{meta}</span>
        </div>
      </header>

      <LiveTradingPanel
        isOpen={showLiveModal}
        onClose={() => setShowLiveModal(false)}
        state={liveState}
        connected={liveConnected}
        onStateChange={setLiveState}
      />
      <PaperTradingPanel
        summary={status?.paperTrading}
        onSelectSymbol={selectSymbol}
        selectedSymbol={chartSymbol}
      />

      <div className="grid">
        <GroupSection
          id="s1"
          title="24h 涨幅榜"
          changeHeader="24h涨幅%"
          rows={status?.gainers ?? []}
          changeKey="priceChangePercent"
          active={true}
          onSelectSymbol={selectSymbol}
          selectedSymbol={chartSymbol}
        />
        <ChartPanel
          symbols={chartSymbols}
          symbol={chartSymbol}
          onSymbolChange={setChartSymbol}
          active={true}
          markerTime={status?.at ? Date.parse(status.at) : null}
          dayChangePercent={dayChangePercent}
        />
      </div>
    </>
  );
}
