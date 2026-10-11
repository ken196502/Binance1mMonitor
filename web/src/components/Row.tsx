import type { Row } from "../../../src/types.ts";
import { fmt, pct, colClass } from "../lib/format";

interface RowProps {
  row: Row;
  changeLabel: number; // priceChangePercent (gainers/losers) or quoteVolume/1e8 (volume)
}

// Single table row. Replicates the original rowHtml() logic exactly:
// alert row → red background; streak (连阳/连阴), bullish/bearish (多头/空头),
// high/low (高位/低位) columns coloured accordingly.
export function StatusRow({ row, changeLabel }: RowProps) {
  return (
    <tr className={row.alert ? "alert" : ""}>
      <td>{row.symbol}</td>
      <td className={colClass(changeLabel)}>{pct(changeLabel)}</td>
      <td className="muted">{fmt(row.lastPrice)}</td>
      {row.streakDir && row.streakCount > 0 ? (
        <td className={row.streakDir === "up" ? "pos" : "neg"}>
          {row.streakCount}
          {row.streakDir === "up" ? "阳" : "阴"}
        </td>
      ) : (
        <td className="muted">-</td>
      )}
      {row.high == null ? (
        <td className="muted">-</td>
      ) : row.high ? (
        <td className="amber">高位</td>
      ) : (
        <td className="muted">低位</td>
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
