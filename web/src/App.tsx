import { useEffect, useState } from "react";
import { useStatus } from "./hooks/useStatus";
import { GroupSection } from "./components/GroupSection";
import { Countdown } from "./components/Countdown";
import "./App.css";

type TabId = "s1" | "s2";

interface TabDef {
  id: TabId;
  label: string; // mobile tab label
}

const TABS: TabDef[] = [
  { id: "s1", label: "涨幅前十" },
  { id: "s2", label: "跌幅前十" },
];

export default function App() {
  const { status, error } = useStatus();
  const [active, setActive] = useState<TabId>("s1");
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
        ` · 高位=DEA≥${status.highRatio}×窗口峰值(${status.highWindow}m)` +
        ` · 每分钟轮询（对齐1m收盘）`;
    }
  }

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

      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab${t.id === active ? " active" : ""}`}
            type="button"
            onClick={() => setActive(t.id)}
          >
            {t.label}
            <span className={status ? (countAlerts(status, t.id) > 0 ? " alert-num" : "") : ""}>
              ({status ? countAlerts(status, t.id) : 0})
            </span>
          </button>
        ))}
      </div>

      <div className="grid">
        {status && !status.error ? (
          <>
            <GroupSection
              id="s1"
              title="24h 涨幅前十"
              changeHeader="涨幅%"
              rows={status.gainers}
              changeKey="priceChangePercent"
              active={active === "s1"}
            />
            <GroupSection
              id="s2"
              title="24h 跌幅前十"
              changeHeader="跌幅%"
              rows={status.losers}
              changeKey="priceChangePercent"
              active={active === "s2"}
            />
          </>
        ) : (
          // keep the two sections present (so narrow-screen CSS stays coherent) but empty
          <>
            <GroupSection id="s1" title="24h 涨幅前十" changeHeader="涨幅%" rows={[]} changeKey="priceChangePercent" active={active === "s1"} />
            <GroupSection id="s2" title="24h 跌幅前十" changeHeader="跌幅%" rows={[]} changeKey="priceChangePercent" active={active === "s2"} />
          </>
        )}
      </div>
    </>
  );
}

function countAlerts(status: NonNullable<ReturnType<typeof useStatus>["status"]>, id: TabId): number {
  const rows = id === "s1" ? status.gainers : status.losers;
  return rows.filter((r) => r.alert).length;
}
