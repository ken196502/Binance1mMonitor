import test from "node:test";
import assert from "node:assert/strict";
import { enrichRankChanges } from "../../src/rank.ts";
import type { Row } from "../../src/types.ts";

function makeRow(symbol: string): Row {
  return {
    symbol,
    lastPrice: 100,
    priceChangePercent: 5,
    quoteVolume: 1000000,
    state: "low-above",
    alert: false,
    bullish: true,
    high: false,
    streakCount: 0,
    streakDir: null,
  };
}

test("首次请求无快照：前10标的 rank 正常赋值且无位置变动标记", () => {
  const currentSymbols = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
  const currentRows = currentSymbols.map(makeRow);
  const droppedRows: Row[] = [];

  const { rankedTop, rankedDropped } = enrichRankChanges(currentRows, droppedRows, null);

  assert.equal(rankedTop.length, 10);
  assert.equal(rankedDropped.length, 0);

  rankedTop.forEach((r, idx) => {
    assert.equal(r.rank, idx + 1);
    assert.equal(r.prevRank, null);
    assert.equal(r.rankChange, null, "没有快照时没有变化就不标记");
    assert.equal(r.isDropped, false);
  });
});

test("有快照对比：正确识别上升、下跌、无变化及新进前十", () => {
  // 上期快照：A(#1), B(#2), C(#3), D(#4), E(#5), F(#6), G(#7), H(#8), I(#9), J(#10)
  const prevSnapshot = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

  // 本期变化：
  // #1: A（保持第1名 -> 无变化）
  // #2: E（上期第5名 -> 上升3名）
  // #3: B（上期第2名 -> 下跌1名）
  // #4: NEW1（新进前十 -> 标记上升）
  // #5: C（上期第3名 -> 下跌2名）
  // #6: D（上期第4名 -> 下跌2名）
  // #7: G（保持第7名 -> 无变化）
  // #8: F（上期第6名 -> 下跌2名）
  // #9: H（上期第8名 -> 下跌1名）
  // #10: I（上期第9名 -> 下跌1名）
  // 跌出前十：J（上期第10名）
  const currentSymbols = ["A", "E", "B", "NEW1", "C", "D", "G", "F", "H", "I"];
  const currentRows = currentSymbols.map(makeRow);
  const droppedRows = [makeRow("J")];

  const { rankedTop, rankedDropped } = enrichRankChanges(currentRows, droppedRows, prevSnapshot);

  // #1 A: 未变
  assert.equal(rankedTop[0].symbol, "A");
  assert.equal(rankedTop[0].rank, 1);
  assert.equal(rankedTop[0].prevRank, 1);
  assert.equal(rankedTop[0].rankChange, null, "位置未变不标记");
  assert.equal(rankedTop[0].rankDelta, 0);

  // #2 E: 上升 (5 -> 2, +3)
  assert.equal(rankedTop[1].symbol, "E");
  assert.equal(rankedTop[1].rank, 2);
  assert.equal(rankedTop[1].prevRank, 5);
  assert.equal(rankedTop[1].rankChange, "up");
  assert.equal(rankedTop[1].rankDelta, 3);

  // #3 B: 下跌 (2 -> 3, -1)
  assert.equal(rankedTop[2].symbol, "B");
  assert.equal(rankedTop[2].rank, 3);
  assert.equal(rankedTop[2].prevRank, 2);
  assert.equal(rankedTop[2].rankChange, "down");
  assert.equal(rankedTop[2].rankDelta, -1);

  // #4 NEW1: 新进前十 (上期无 -> 上升)
  assert.equal(rankedTop[3].symbol, "NEW1");
  assert.equal(rankedTop[3].rank, 4);
  assert.equal(rankedTop[3].prevRank, null);
  assert.equal(rankedTop[3].rankChange, "up");
  assert.equal(rankedTop[3].rankDelta, null);

  // #7 G: 未变 (7 -> 7)
  assert.equal(rankedTop[6].symbol, "G");
  assert.equal(rankedTop[6].rank, 7);
  assert.equal(rankedTop[6].prevRank, 7);
  assert.equal(rankedTop[6].rankChange, null);
  assert.equal(rankedTop[6].rankDelta, 0);

  // 跌出的 J:
  assert.equal(rankedDropped.length, 1);
  assert.equal(rankedDropped[0].symbol, "J");
  assert.equal(rankedDropped[0].rank, null);
  assert.equal(rankedDropped[0].prevRank, 10);
  assert.equal(rankedDropped[0].rankChange, "down");
  assert.equal(rankedDropped[0].isDropped, true);
});
