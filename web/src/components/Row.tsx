import type { Row } from "../../../src/types.ts";
import { fmt, pct, colClass } from "../lib/format";

interface RowProps {
  row: Row;
  changeLabel: number; // priceChangePercent (gainers) or quoteVolume/1e8 (volume)
  isPercentage?: boolean; // true for price change, false for volume
}

// Single table row: displays rank, shift, symbol, 24h change, streak count, streak gain, 1m30upR, support.
export function StatusRow({ row, changeLabel, isPercentage = true }: RowProps) {
  const isPinned = row.isPinned ?? (row.symbol === "BTCUSDT" || row.symbol === "SOLUSDT");

  const rowClasses = [
    row.alert ? "alert" : "",
    isPinned ? "pinned-row" : "",
    row.isDropped ? "dropped-row" : "",
  ].filter(Boolean).join(" ");

  const streakGainStr = row.streakGainPercent != null
    ? `${row.streakGainPercent >= 0 ? "+" : ""}${row.streakGainPercent.toFixed(2)}%`
    : "-";

  const ratioStr = row.greenBarRatio30 != null
    ? `${(row.greenBarRatio30 * 100).toFixed(1)}%`
    : "-";

  const ratioTitle = row.greenBarCount30 != null
    ? `${row.greenBarCount30}/30 (${ratioStr})`
    : undefined;

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
      <td className={row.streakDir === "up" ? "pos" : row.streakDir === "down" ? "neg" : "muted"}>
        {row.streakDir && row.streakCount > 0 ? `${row.streakCount}${row.streakDir === "up" ? "阳" : "阴"}` : "-"}
      </td>
      <td className={row.streakGainPercent != null && row.streakGainPercent > 0 ? "pos" : "muted"}>
        {streakGainStr}
      </td>
      <td
        className={row.greenBarRatio30 != null && row.greenBarRatio30 > 0.8 ? "yellow" : "muted"}
        title={ratioTitle}
      >
        {ratioStr}
      </td>
      {row.supportMa ? (
        <td>{row.supportMa}</td>
      ) : (
        <td className="pink">无</td>
      )}
    </tr>
  );
}
