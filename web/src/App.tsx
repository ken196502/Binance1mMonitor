import { useEffect, useState } from "react";
import { useStatus } from "./hooks/useStatus";
import { GroupSection } from "./components/GroupSection";
import { ChartPanel } from "./components/KlineChart";
import { Countdown } from "./components/Countdown";
import { PaperTradingPanel } from "./components/PaperTradingPanel";
import "./App.css";



export default function App() {
  const { status, error } = useStatus();
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
        ` · 规则：连阳涨幅达标 + 无MA支撑 + 近30根1m绿柱>80%` +
        ` · 每分钟轮询（对齐1m收盘）`;
    }
  }

  const alertCount = status?.gainers ? status.gainers.filter((r) => r.alert).length : 0;

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

  return (
    <>
      <header>
        <h1>
          Binance 1m Monitor
          <Countdown remaining={remaining} total={60} />
        </h1>
        <div className="meta">
          <span className="dot" style={{ background: dotColor }} />
          <span>{meta}</span>
        </div>
      </header>

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
          rows={status && !status.error ? status.gainers : []}
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
          markerTime={status && !status.error ? Date.parse(status.at) : null}
        />
      </div>
    </>
  );
}

