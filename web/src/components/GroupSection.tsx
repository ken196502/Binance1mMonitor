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

// A single ranked list panel. On wide screens all three panels render side by
// side; on narrow screens only the `active` one is shown (toggled by the tab
// bar in App). The second column header/value depends on the group: gainers/
// losers show priceChangePercent, volume shows quoteVolume in 亿 (1e8).
export function GroupSection({
  id,
  title,
  changeHeader,
  rows,
  changeKey,
  active,
}: GroupSectionProps) {
  const alerts = rows.filter((r) => r.alert).length;
  // volume group: display quote volume scaled to 亿
  const changeLabel = (r: Row) =>
    changeKey === "quoteVolume" ? r.quoteVolume / 1e8 : r.priceChangePercent;

  return (
    <section id={id} className={active ? "active" : ""}>
      <h2>
        {title}{" "}
        <span className="count">
          {alerts ? `⚠️ ${alerts} 个高位死叉` : "无高位死叉"}
        </span>
      </h2>
      <table id={`t-${id}`}>
        <thead>
          <tr>
            <th>币种</th>
            <th>{changeHeader}</th>
            <th>价格</th>
            <th>连阳/连阴</th>
            <th>DEA</th>
            <th>DIFF</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <StatusRow key={r.symbol} row={r} changeLabel={changeLabel(r)} />
          ))}
        </tbody>
      </table>
    </section>
  );
}
