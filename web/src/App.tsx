import { useEffect, useState } from "react";
import { useStatus } from "./hooks/useStatus";
import { GroupSection } from "./components/GroupSection";
import { Countdown } from "./components/Countdown";
import "./App.css";



export default function App() {
  const { status, error } = useStatus();
  const [remaining, setRemaining] = useState(60);

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

      <div className="grid">
        <GroupSection
          id="s1"
          title="24h 涨幅榜"
          changeHeader="24h涨幅%"
          rows={status && !status.error ? status.gainers : []}
          changeKey="priceChangePercent"
          active={true}
        />
      </div>
    </>
  );
}

