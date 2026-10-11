import { useEffect, useState } from "react";
import { useStatus } from "./hooks/useStatus";
import { GroupSection } from "./components/GroupSection";
import { Countdown } from "./components/Countdown";
import "./App.css";

type TabId = "s1" | "s2" | "s3";

interface TabDef {
  id: TabId;
  label: string; // mobile tab label
}

const TABS: TabDef[] = [
  { id: "s1", label: "24h 涨幅前十" },
  { id: "s2", label: "24h 跌幅前十" },
  { id: "s3", label: "24h 成交额前十" },
];

export default function App() {
  const { status, error, lastFetchedAt } = useStatus();
  const [active, setActive] = useState<TabId>("s1");
  const [remaining, setRemaining] = useState(5);

  // Countdown ring: seconds since the last poll, ticking ~10×/s for smoothness.
  useEffect(() => {
    const id = setInterval(() => {
      const elapsed = (Date.now() - lastFetchedAt) / 1000;
      setRemaining(Math.max(0, 5 - elapsed));
    }, 100);
    return () => clearInterval(id);
  }, [lastFetchedAt]);

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
        ` · 每 5s 轮询`;
    }
  }

  return (
    <>
      <header>
        <h1>
          Binance 1m Monitor
          <Countdown remaining={remaining} total={5} />
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
            <GroupSection
              id="s3"
              title="24h 成交额前十"
              changeHeader="成交额(亿)"
              rows={status.volume}
              changeKey="quoteVolume"
              active={active === "s3"}
            />
          </>
        ) : (
          // keep the three sections present (so narrow-screen CSS stays coherent) but empty
          <>
            <GroupSection id="s1" title="24h 涨幅前十" changeHeader="涨幅%" rows={[]} changeKey="priceChangePercent" active={active === "s1"} />
            <GroupSection id="s2" title="24h 跌幅前十" changeHeader="跌幅%" rows={[]} changeKey="priceChangePercent" active={active === "s2"} />
            <GroupSection id="s3" title="24h 成交额前十" changeHeader="成交额(亿)" rows={[]} changeKey="quoteVolume" active={active === "s3"} />
          </>
        )}
      </div>
    </>
  );
}

function countAlerts(status: NonNullable<ReturnType<typeof useStatus>["status"]>, id: TabId): number {
  const rows = id === "s1" ? status.gainers : id === "s2" ? status.losers : status.volume;
  return rows.filter((r) => r.alert).length;
}
