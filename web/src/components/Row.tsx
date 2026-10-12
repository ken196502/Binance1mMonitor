import type { Row } from "../../../src/types.ts";
import { fmt, pct, colClass } from "../lib/format";

interface RowProps {
  row: Row;
  changeLabel: number; // priceChangePercent (gainers/losers) or quoteVolume/1e8 (volume)
  isPercentage?: boolean; // true for price change, false for volume
}

// Single table row. Replicates the original rowHtml() logic exactly:
// alert row → red background; streak (连阳/连阴), bullish/bearish (多头/空头),
// high/low (高位/低位) columns coloured accordingly.
export function StatusRow({ row, changeLabel, isPercentage = true }: RowProps) {
  const isHigh = row.deaLevel === "high" || (row.deaLevel == null && row.high === true);
  const isHighBull = isHigh && row.bullish === true;
  const isPinned = row.isPinned ?? (row.symbol === "BTCUSDT" || row.symbol === "SOLUSDT");

  const rowClasses = [
    row.alert ? "alert" : "",
    isHighBull ? "high-bull" : "",
    isPinned ? "pinned-row" : "",
    row.isDropped ? "dropped-row" : "",
  ].filter(Boolean).join(" ");

  return (
    <tr className={rowClasses}>
      <td className="col-rank">
        {isPinned ? (
          <span className="pin-icon" title="置顶标的">📌</span>
        ) : row.rank != null ? (
          <span className="rank-num">{row.rank}</span>
        ) : (
          <span className="muted">-</span>
        )}
      </td>
      <td className="col-shift">
        {row.isDropped ? (
          <span
            className="shift-dropped"
            title={row.prevRank ? `上期第 ${row.prevRank} 名，已跌出前十` : "已跌出前十"}
          >
            跌
          </span>
        ) : row.rankChange === "up" ? (
          <span
            className="shift-up"
            title={row.rankDelta ? `较上期上升 ${row.rankDelta} 名` : "新进入前十"}
          >
            {row.rankDelta ? `▲${row.rankDelta}` : "▲"}
          </span>
        ) : row.rankChange === "down" ? (
          <span
            className="shift-down"
            title={row.rankDelta ? `较上期下降 ${Math.abs(row.rankDelta)} 名` : "排名下降"}
          >
            {row.rankDelta ? `▼${Math.abs(row.rankDelta)}` : "▼"}
          </span>
        ) : null}
      </td>
      <td className="col-symbol">
        <a
          href={`https://www.binance.com/zh-CN/futures/${row.symbol}`}
          target="_blank"
          rel="noopener noreferrer"
          className="symbol-link"
          title={`在币安查看 ${row.symbol} 合约行情`}
        >
          {row.symbol}
        </a>
      </td>
      <td className={colClass(changeLabel)}>{isPercentage ? pct(changeLabel) : fmt(changeLabel, 2)}</td>
      {row.supportMa ? (
        <td>{row.supportMa}</td>
      ) : (
        <td className="pink">N/A</td>
      )}
      {row.streakDir && row.streakCount > 0 ? (
        <td className={row.streakDir === "up" ? "pos" : "neg"}>
          {row.streakCount}
          {row.streakDir === "up" ? "阳" : "阴"}
        </td>
      ) : (
        <td className="muted">-</td>
      )}
      {row.diff1mLevel == null ? (
        <td className="muted" title={row.diff1m != null ? `1m DIFF: ${row.diff1m}` : undefined}>-</td>
      ) : row.diff1mLevel === "high" ? (
        <td className="yellow" title={`1m DIFF: ${row.diff1m != null ? row.diff1m.toFixed(4) : ""} (高)`}>高</td>
      ) : row.diff1mLevel === "mid" ? (
        <td className="white" title={`1m DIFF: ${row.diff1m != null ? row.diff1m.toFixed(4) : ""} (中)`}>中</td>
      ) : (
        <td className="muted" title={`1m DIFF: ${row.diff1m != null ? row.diff1m.toFixed(4) : ""} (低)`}>低</td>
      )}
      {row.diff5mLevel == null ? (
        <td className="muted" title={row.diff5m != null ? `5m DIFF: ${row.diff5m}` : undefined}>-</td>
      ) : row.diff5mLevel === "high" ? (
        <td className="yellow" title={`5m DIFF: ${row.diff5m != null ? row.diff5m.toFixed(4) : ""} (高)`}>高</td>
      ) : row.diff5mLevel === "mid" ? (
        <td className="white" title={`5m DIFF: ${row.diff5m != null ? row.diff5m.toFixed(4) : ""} (中)`}>中</td>
      ) : (
        <td className="muted" title={`5m DIFF: ${row.diff5m != null ? row.diff5m.toFixed(4) : ""} (低)`}>低</td>
      )}
    </tr>
  );
}
