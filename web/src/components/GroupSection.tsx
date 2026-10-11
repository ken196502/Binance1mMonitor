import { useMemo, useState } from "react";
import type { Row } from "../../../src/types.ts";
import { StatusRow } from "./Row";

interface GroupSectionProps {
  id: string; // s1 | s2 | s3
  title: string; // 24h 涨幅前十 / 跌幅前十 / 成交额前十
  changeHeader: string; // 涨幅% / 跌幅% / 成交额(亿)
  rows: Row[];
  changeKey: "priceChangePercent" | "quoteVolume";
  active: boolean; // narrow-screen tab active state
}

// Sortable columns. Each header maps to a key whose value is extracted from a
// row via sortValue below. The change column's value depends on the group's
// changeKey (priceChangePercent for gainers/losers, quoteVolume for volume).
type SortKey = "symbol" | "change" | "lastPrice" | "streak" | "high" | "bullish";
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

  const cols: { key: SortKey; label: string }[] = [
    { key: "symbol", label: "币种" },
    { key: "change", label: changeHeader },
    { key: "streak", label: "连阳/连阴" },
    { key: "high", label: "DEA" },
    { key: "bullish", label: "DIFF" },
  ];

  // Clicking a header: same key → toggle direction; new key → sensible default
  // (string column asc, numeric/boolean columns desc so biggest/most-notable
  // land on top).
  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "symbol" ? "asc" : "desc");
    }
  };

  // Extract the sort value for a row under a given key. Returns number | string
  // | null; nulls (missing data) always sort to the bottom regardless of dir.
  const valueAt = (r: Row, key: SortKey): number | string | null => {
    switch (key) {
      case "symbol":
        return r.symbol;
      case "change":
        return changeLabel(r);
      case "lastPrice":
        return r.lastPrice;
      case "streak":
        return r.streakCount > 0 ? r.streakCount : null;
      case "high": {
        const isHigh = r.deaLevel === "high" || (r.deaLevel == null && r.high === true);
        const isMid = r.deaLevel === "mid" || (r.deaLevel == null && !r.high && r.dea != null && r.dea >= 0);
        const isLow = r.deaLevel === "low" || (r.deaLevel == null && !r.high && r.dea != null && r.dea < 0);
        if (isHigh) return 2;
        if (isMid) return 1;
        if (isLow) return 0;
        return r.high == null ? null : r.high ? 2 : 0;
      }
      case "bullish":
        return r.bullish == null ? null : r.bullish ? 1 : 0;
    }
  };

  const sortedRows = useMemo(() => {
    if (!sortKey) return rows;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = valueAt(a, sortKey);
      const vb = valueAt(b, sortKey);
      if (va == null && vb == null) return 0;
      if (va == null) return 1; // nulls always last
      if (vb == null) return -1;
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0; // stable: ties keep original (server) order
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sortKey, sortDir, changeKey]);

  return (
    <section id={id} className={active ? "active" : ""}>
      <h2>
        {title}{" "}
        <span className="count">
          {alerts ? `⚠️ ${alerts} 个高位死叉` : "无高位死叉"}
        </span>
      </h2>
      <div className="table-wrap">
        <table id={`t-${id}`}>
          <thead>
            <tr>
              {cols.map((c) => {
                const isActive = sortKey === c.key;
                const arrow = isActive ? (sortDir === "asc" ? "▲" : "▼") : "↕";
                return (
                  <th key={c.key}>
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
                      <span className="arrow">{arrow}</span>
                    </button>
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
