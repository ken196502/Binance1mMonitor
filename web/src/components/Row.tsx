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
  return (
    <tr className={row.alert ? "alert" : ""}>
      <td>
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
      {row.streakDir && row.streakCount > 0 ? (
        <td className={row.streakDir === "up" ? "pos" : "neg"}>
          {row.streakCount}
          {row.streakDir === "up" ? "阳" : "阴"}
        </td>
      ) : (
        <td className="muted">-</td>
      )}
      {row.deaLevel == null && row.high == null ? (
        <td className="muted">-</td>
      ) : row.deaLevel === "high" || (row.deaLevel == null && row.high) ? (
        <td className="amber">高</td>
      ) : row.deaLevel === "mid" || (row.dea != null && row.dea >= 0) ? (
        <td className="muted">中</td>
      ) : (
        <td className="muted">低</td>
      )}
      {row.bullish == null ? (
        <td className="muted">-</td>
      ) : row.bullish ? (
        <td className="pos">多头</td>
      ) : (
        <td className="neg">空头</td>
      )}
    </tr>
  );
}
