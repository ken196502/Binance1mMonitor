import { useMemo, useState } from "react";
import type { Row } from "../../../src/types.ts";
import { StatusRow } from "./Row";

interface GroupSectionProps {
  id: string; // s1 | s2
  title: string; // 24h 涨幅前十 / 跌幅前十
  changeHeader: string; // 涨幅% / 跌幅%
  rows: Row[];
  changeKey?: "priceChangePercent" | "quoteVolume";
  active: boolean; // narrow-screen tab active state
}

// Sortable columns. Each header maps to a key whose value is extracted from a
// row via sortValue below. The change column's value depends on the group's
// changeKey (priceChangePercent for gainers/losers, quoteVolume for volume).
type SortKey = "rank" | "shift" | "symbol" | "change" | "streak" | "streakGain" | "1m30upR" | "support" | "lastPrice";
type SortDir = "asc" | "desc";

export function GroupSection({
  id,
  title,
  changeHeader,
  rows,
  changeKey,
  active,
}: GroupSectionProps) {
  // Sort state is local to each panel. null sortKey = original server ranking.
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const alerts = rows.filter((r) => r.alert).length;
  // volume group: display quote volume scaled to 亿
  const changeLabel = (r: Row) =>
    changeKey === "quoteVolume" ? r.quoteVolume / 1e8 : r.priceChangePercent;

  const cols: { key: SortKey; label: string; className?: string }[] = [
    { key: "rank", label: "", className: "col-rank" },
    { key: "shift", label: "升跌", className: "col-shift" },
    { key: "symbol", label: "币种", className: "col-symbol" },
    { key: "change", label: changeHeader },
    { key: "streak", label: "连阳数" },
    { key: "streakGain", label: "连阳涨幅" },
    { key: "1m30upR", label: "1m30upR" },
    { key: "support", label: "支撑" },
  ];

  // Clicking a header: same key → toggle direction; new key → sensible default
  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "symbol" || key === "rank" ? "asc" : "desc");
    }
  };

  const valueAt = (r: Row, key: SortKey): number | string | null => {
    switch (key) {
      case "rank":
        return r.rank != null ? r.rank : r.isDropped ? 999 : null;
      case "shift": {
        if (r.isDropped) return -999;
        if (r.rankChange === "up") return r.rankDelta ?? 100;
        if (r.rankChange === "down") return r.rankDelta != null ? -Math.abs(r.rankDelta) : -100;
        return 0;
      }
      case "symbol":
        return r.symbol;
      case "change":
        return changeLabel(r);
      case "streak":
        return r.streakCount > 0 ? r.streakCount : null;
      case "streakGain":
        return r.streakGainPercent != null ? r.streakGainPercent : null;
      case "1m30upR":
        return r.greenBarRatio30 != null ? r.greenBarRatio30 : null;
      case "support": {
        if (!r.supportMa) return null;
        const num = parseInt(r.supportMa.replace(/^ma/i, ""), 10);
        return isNaN(num) ? r.supportMa : num;
      }
      case "lastPrice":
        return r.lastPrice;
    }
  };

  const PINNED_SYMBOLS = ["BTCUSDT", "SOLUSDT"];

  const sortedRows = useMemo(() => {
    const pinned = PINNED_SYMBOLS
      .map((sym) => rows.find((r) => r.symbol === sym))
      .filter(Boolean) as Row[];
    const unpinned = rows.filter((r) => !PINNED_SYMBOLS.includes(r.symbol));

    if (!sortKey) return [...pinned, ...unpinned];
    const dir = sortDir === "asc" ? 1 : -1;
    const sortedUnpinned = [...unpinned].sort((a, b) => {
      // 跌出前十的始终排在尾部
      if (a.isDropped && !b.isDropped) return 1;
      if (!a.isDropped && b.isDropped) return -1;

      const va = valueAt(a, sortKey);
      const vb = valueAt(b, sortKey);
      if (va == null && vb == null) return 0;
      if (va == null) return 1; // nulls always last
      if (vb == null) return -1;
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0; // stable: ties keep original (server) order
    });
    return [...pinned, ...sortedUnpinned];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sortKey, sortDir, changeKey]);

  return (
    <section id={id} className={active ? "active" : ""}>
      <h2>
        {title}{" "}
        <span className="count">
          {alerts ? `⚠️ ${alerts} 个命中` : "无告警命中"}
        </span>
      </h2>
      <div className="table-wrap">
        <table id={`t-${id}`}>
          <thead>
            <tr>
              {cols.map((c) => {
                const isActive = sortKey === c.key;
                const arrow = isActive ? (sortDir === "asc" ? "▲" : "▼") : (c.key === "shift" ? "" : "↕");
                return (
                  <th
                    key={c.key}
                    className={c.className}
                    aria-label={c.key === "rank" ? "排名" : undefined}
                  >
                    {c.label ? (
                      <button
                        type="button"
                        className={`sort-th${isActive ? " active" : ""}`}
                        onClick={() => onSort(c.key)}
                        aria-sort={
                          isActive
                            ? sortDir === "asc"
                              ? "ascending"
                              : "descending"
                            : "none"
                        }
                      >
                        {c.label}
                        {arrow ? <span className="arrow">{arrow}</span> : null}
                      </button>
                    ) : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((r) => (
              <StatusRow
                key={r.symbol}
                row={r}
                changeLabel={changeLabel(r)}
                isPercentage={changeKey !== "quoteVolume"}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
