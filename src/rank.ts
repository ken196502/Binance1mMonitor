import type { Row } from "./types.ts";

export interface BoardSnapshot {
  gainers: string[]; // 自然前 10 标的 symbol 列表（按排名 1..10 升序）
  losers: string[];  // 自然前 10 标的 symbol 列表（按排名 1..10 升序）
}

/**
 * 根据上期快照对比计算当前榜单行的排名变动，以及为跌出前十的标的赋予变动与跌出标记
 */
export function enrichRankChanges(
  currRows: Row[],
  droppedRows: Row[],
  prevSnapshot: string[] | null,
): { rankedTop: Row[]; rankedDropped: Row[] } {
  const hasSnapshot = prevSnapshot !== null;
  const rankedTop = currRows.map((r, idx) => {
    const rank = idx + 1; // 自然排位 1..10
    let prevRank: number | null = null;
    let rankChange: "up" | "down" | null = null;
    let rankDelta: number | null = null;

    if (hasSnapshot) {
      const prevIdx = prevSnapshot.indexOf(r.symbol);
      if (prevIdx !== -1) {
        prevRank = prevIdx + 1;
        const delta = prevRank - rank; // 上期名次 - 本期名次：如上期第 5、本期第 2，delta = +3 (上升)
        if (delta > 0) {
          rankChange = "up";
          rankDelta = delta;
        } else if (delta < 0) {
          rankChange = "down";
          rankDelta = delta;
        } else {
          // 没有变化就不标记
          rankChange = null;
          rankDelta = 0;
        }
      } else {
        // 上期不在前十，新进前十，标记上升
        rankChange = "up";
        rankDelta = null;
      }
    }

    return {
      ...r,
      rank,
      prevRank,
      rankChange,
      rankDelta,
      isDropped: false,
      isPinned: false,
    };
  });

  const rankedDropped = droppedRows.map((r) => {
    const prevIdx = prevSnapshot ? prevSnapshot.indexOf(r.symbol) : -1;
    const prevRank = prevIdx !== -1 ? prevIdx + 1 : null;
    return {
      ...r,
      rank: null,
      prevRank,
      rankChange: "down" as const, // 跌出前十标记为下跌
      rankDelta: null,
      isDropped: true,
      isPinned: false,
    };
  });

  return { rankedTop, rankedDropped };
}
