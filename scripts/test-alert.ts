// Behavioral test for src/alert.ts + src/telegram.ts.
// Runs a local fake Telegram Bot API and asserts the alerter's state machine end to end:
//   - Trigger condition: any of the 2 leaderboards has >= 3 DEA high and DIFF bullish
//   - State memory & deduplication: only notify when counts change; do not repeat on unchanged checks
//   - Delivery retries on failures
//   - Recovery notification when all drop below threshold
//
// Run manually:
//   npx tsx scripts/test-alert.ts

import http from "node:http";
import assert from "node:assert";

// --- fake Telegram API -------------------------------------------------------
const received: { text: string; auth: string }[] = [];
let failNext = false;
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = req.url ?? "";
    if (!url.startsWith("/botTESTTOKEN/sendMessage")) {
      res.writeHead(404).end('{"ok":false}');
      return;
    }
    if (failNext) {
      failNext = false;
      res.writeHead(500).end('{"ok":false,"description":"injected failure"}');
      return;
    }
    const payload = JSON.parse(body);
    received.push({ text: payload.text, auth: url.slice(4, 13) });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true,"result":{"message_id":1}}');
  });
});
await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
const port = (fake.address() as { port: number }).port;

process.env.TELEGRAM_BOT_TOKEN = "TESTTOKEN";
process.env.TELEGRAM_CHAT_ID = "42";
process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${port}`;
process.env.TG_ALERT_MIN = "3";
process.env.TG_REPEAT_MINUTES = "0";
process.env.TG_SEND_RECOVERY = "true";

const { pickHighBull, pickHighBullItems, formatStreak, TelegramAlerter } = await import("../src/alert.ts");
import type { Row } from "../src/types.ts";

// --- helpers -----------------------------------------------------------------
let n = 0;
function row(
  symbol?: string,
  streakCount = 2,
  streakDir: "up" | "down" | null = "up",
  streakGainPercent = 1.5,
  greenBarRatio30 = 0.85,
  supportMa: string | null = null,
  priceChangePercent = 5.0,
): Row {
  const sym = symbol ?? `SYM${++n}`;
  return {
    symbol: sym,
    lastPrice: 85,
    priceChangePercent,
    quoteVolume: 1,
    state: "low-above",
    alert: false,
    bullish: true,
    high: true,
    supportMa,
    streakCount,
    streakDir,
    streakGainPercent,
    greenBarRatio30,
    greenBarCount30: Math.round(greenBarRatio30 * 30),
  };
}

const countOf = (s?: { ok: boolean }) => (s?.ok ? 1 : 0);

// --- 0. formatStreak helper test ---------------------------------------------
assert.equal(formatStreak(3, "up"), "3连阳");
assert.equal(formatStreak(2, "down"), "2连阴");
assert.equal(formatStreak(1, "up"), ""); // 只有1根不算"连"，不展示
assert.equal(formatStreak(1, "down"), "");
assert.equal(formatStreak(0, "up"), "");
assert.equal(formatStreak(3, null), "");
console.log("0. formatStreak 阳阴连数文案 (≥2 才展示) ✓");

// --- 1. pickHighBull: filter !supportMa && streak=up && streakCount>=2 && streakGainPercent>=24h涨幅/10 && greenBarRatio30>0.8
const testList = [
  row("MATCH_UP_1", 3, "up", 1.5, 0.85, null, 10),      // match: 24h=10% (minGain=1.0%), up, 3 bars, +1.5%, green 85%
  row("MATCH_UP_2", 2, "up", 2.0, 0.90, null, 15),      // match: 24h=15% (minGain=1.5%), up, 2 bars, +2.0%, green 90%
  row("MISMATCH_DOWN", 3, "down", 1.5, 0.85, null, 10), // no: 连阴
  row("MISMATCH_STREAK_1", 1, "up", 1.5, 0.85, null, 10),// no: 只有1根
  row("MISMATCH_LOW_GAIN", 2, "up", 1.2, 0.85, null, 20),// no: 24h=20% (minGain=2.0%), 连阳涨幅 1.2% < 2.0%
  row("MISMATCH_HAS_MA", 2, "up", 1.5, 0.85, "ma10", 10),// no: has support
  row("MISMATCH_LOW_GREEN", 2, "up", 1.5, 0.75, null, 10),// no: green ratio 75% <= 80%
  row("MISMATCH_EQUAL_GREEN", 2, "up", 1.5, 0.80, null, 10),// no: green ratio 80% <= 80% (>80% required)
  row("MATCH_UP_1", 3, "up", 1.5, 0.85, null, 10),      // dupe
];
assert.deepEqual(pickHighBull(testList), ["MATCH_UP_1", "MATCH_UP_2"]);
const items = pickHighBullItems(testList);
assert.equal(items.length, 2);
assert.equal(items[0].symbol, "MATCH_UP_1");
assert.equal(items[0].streakCount, 3);
assert.equal(items[0].streakDir, "up");
assert.equal(items[0].streakGainPercent, 1.5);
assert.equal(items[0].greenBarRatio30, 0.85);
assert.equal(items[1].symbol, "MATCH_UP_2");
console.log("1. pickHighBull + pickHighBullItems filter (连阳且涨幅达标(24h涨幅/10) + 无MA支撑 + 近30根1m绿柱>80%) + dedupe ✓");

// --- 2. below threshold on gainers (< 3) → no alert --------------------------
const a = new TelegramAlerter();
const res1 = await a.check({
  gainers: [row("G1"), row("G2")], // 2
});
assert.equal(res1.summary.triggered, false);
assert.equal(res1.sent, undefined);
assert.equal(received.length, 0);
console.log("2. gainers below threshold (< 3) → no alert sent ✓");

// --- 2b. pinned symbols in gainers do NOT count towards board threshold ------
const resPinnedOnly = await a.check({
  gainers: [
    row("BTCUSDT", 3, "up", 2.0),
    row("SOLUSDT", 2, "up", 1.5),
    row("ETHUSDT", 3, "up", 2.5),
  ],
});
// 即使总行数有3且均满足指标，置顶标的(BTC, SOL)被排除，涨幅榜自然币种仅1个(< 3)，不触发告警
assert.equal(resPinnedOnly.summary.gainers.count, 1);
assert.equal(resPinnedOnly.summary.triggered, false);
assert.equal(resPinnedOnly.sent, undefined);
assert.equal(received.length, 0);
console.log("2b. pinned symbols excluded from leaderboard count (< 3) → no alert sent ✓");

// --- 3. gainers reaches 3 (unpinned) → alert sent with new fields! -----------
const res2 = await a.check({
  gainers: [
    row("BTCUSDT", 3, "up", 2.0),
    row("SOLUSDT", 2, "up", 1.5),
    row("ETHUSDT", 4, "up", 2.5, 0.9, null, 12.34),
    row("ADAUSDT", 2, "up", 1.2, 0.85, null, 8.5),
    row("DOTUSDT", 3, "up", 3.0, 0.88, null, 6.2),
  ],
  pinned: [
    row("BTCUSDT", 3, "up", 2.0, 0.9, null, 3.12),
    row("SOLUSDT", 2, "up", 1.5, 0.85, null, 2.45),
  ],
});
assert.equal(res2.summary.triggered, true);
assert.equal(res2.summary.gainers.count, 3);
assert.deepEqual(res2.summary.gainers.symbols, ["ETHUSDT", "ADAUSDT", "DOTUSDT"]);
assert.equal(countOf(res2.sent), 1);
assert.equal(received.length, 1);
assert.match(received[0].text, /24h涨幅榜告警/);
assert.match(received[0].text, /↑↑涨幅榜\(24h\)↑↑.*3/);
assert.doesNotMatch(received[0].text, /跌幅榜/);
assert.match(received[0].text, /置顶标的/);
assert.match(received[0].text, /BTCUSDT/);
assert.match(received[0].text, /SOLUSDT/);
assert.match(received[0].text, /ETHUSDT/);
assert.match(received[0].text, /24h: \+12\.34%/);
assert.match(received[0].text, /连阳数: 4/);
assert.match(received[0].text, /连阳涨幅: \+2\.50%/);
assert.match(received[0].text, /1m30upR: 27\/30 \(90\.0%\)/);
// 验证涨幅榜区域不包含置顶标的
const gainersPart = received[0].text.split("↑↑涨幅榜(24h)↑↑")[1] ?? "";
assert.doesNotMatch(gainersPart, /BTCUSDT/);
assert.doesNotMatch(gainersPart, /SOLUSDT/);
assert.match(received[0].auth, /TESTTOKEN/);
console.log("3. gainers reaches 3 (excluding pinned) → alert sent with 币种、24h涨幅、连阳数、连阳涨幅、1m30upR ✓");

// --- 4. check again with EXACT SAME symbols (ETH, ADA, DOT) → no repeated notification -
const res3 = await a.check({
  gainers: [row("ETHUSDT"), row("ADAUSDT"), row("DOTUSDT")],
  pinned: [row("BTCUSDT"), row("SOLUSDT")],
});
assert.equal(res3.summary.triggered, true);
assert.equal(res3.sent, undefined); // NOT sent!
assert.equal(received.length, 1);   // No new message
console.log("4. count and symbols unchanged → no duplicate notification (防骚扰) ✓");

// --- 4b. temporary dip below threshold (<3) then back to same coins → NO duplicate (榜币没变不重发)
const resDip = await a.check({
  gainers: [row("ETHUSDT"), row("ADAUSDT")], // 2 (< 3)
  pinned: [row("BTCUSDT"), row("SOLUSDT")],
});
assert.equal(resDip.summary.triggered, false);
assert.equal(resDip.sent, undefined);

const resBack = await a.check({
  gainers: [row("ETHUSDT"), row("ADAUSDT"), row("DOTUSDT")], // 3 coins, same as before!
  pinned: [row("BTCUSDT"), row("SOLUSDT")],
});
assert.equal(resBack.summary.triggered, true);
assert.equal(resBack.sent, undefined); // 榜币没变，绝不重复播报！
assert.equal(received.length, 1);
console.log("4b. temporary dip and back to exact same coins → NO duplicate notification (榜币没变) ✓");

// --- 5. coins change in gainers (AVAX, LINK, NEAR) → new notification sent! ---
const res4 = await a.check({
  gainers: [row("AVAXUSDT"), row("LINKUSDT"), row("NEARUSDT")],
  pinned: [row("BTCUSDT"), row("SOLUSDT")],
});
assert.equal(res4.summary.gainers.count, 3);
assert.equal(countOf(res4.sent), 1);
assert.equal(received.length, 2);
assert.match(received[1].text, /AVAXUSDT/);
console.log("5. coins changed in gainers → new notification sent (榜币变了才发) ✓");

// --- 6. same coins (AVAX, LINK, NEAR) again → NO notification -----------------
const res5 = await a.check({
  gainers: [row("AVAXUSDT", 3, "up", 1.8), row("LINKUSDT", 2, "up", 1.2), row("NEARUSDT", 4, "up", 2.2)],
  pinned: [row("BTCUSDT"), row("SOLUSDT")],
});
assert.equal(res5.sent, undefined);
assert.equal(received.length, 2);
console.log("6. same coins with updated streak → NO duplicate notification ✓");

// --- 7. condition clears (all drop to 0) → state reset -----------------------
const res6 = await a.check({
  gainers: [],
});
assert.equal(res6.summary.triggered, false);
assert.equal(res6.sent, undefined);
assert.equal(received.length, 2);
assert.equal(a.getLastNotifiedCounts(), null);
console.log("7. condition clears to 0 → state reset ✓");

// --- 8. re-trigger after recovery (PEPE, DOGE, SHIB) → alert sent! -----------
const res7 = await a.check({
  gainers: [row("PEPEUSDT"), row("DOGEUSDT"), row("SHIBUSDT")], // 3
  pinned: [row("BTCUSDT"), row("SOLUSDT")],
});
assert.equal(res7.summary.triggered, true);
assert.equal(countOf(res7.sent), 1);
assert.equal(received.length, 3);
assert.match(received[2].text, /PEPEUSDT/);
console.log("8. re-trigger after recovery on gainers → alert sent ✓");

// --- 9. clear & re-trigger with send failure → retries on next check ----------
a.resetState();
failNext = true;
// Trigger again with gainers: 3
const res8 = await a.check({
  gainers: [row("ETHUSDT"), row("ADAUSDT"), row("DOTUSDT")],
  pinned: [row("BTCUSDT"), row("SOLUSDT")],
});
assert.equal(res8.sent?.ok, false); // failed
assert.equal(received.length, 3);   // not recorded in fake
// Next check with gainers: 3 — must retry because previous send failed!
const res9 = await a.check({
  gainers: [row("ETHUSDT"), row("ADAUSDT"), row("DOTUSDT")],
  pinned: [row("BTCUSDT"), row("SOLUSDT")],
});
assert.equal(res9.sent?.ok, true); // succeeded!
assert.equal(received.length, 4);
assert.match(received[3].text, /↑↑涨幅榜\(24h\)↑↑.*3/);
console.log("9. failed send retries on subsequent check until delivered ✓");

// --- 10. unconfigured telegram → explicit failure without crashing ------------
a.resetState();
delete process.env.TELEGRAM_BOT_TOKEN;
const res10 = await a.check({
  gainers: [row("ETHUSDT"), row("ADAUSDT"), row("DOTUSDT")],
  pinned: [row("BTCUSDT"), row("SOLUSDT")],
});
assert.equal(res10.sent?.ok, false);
assert.equal(res10.sent?.error, "not configured");
assert.equal(received.length, 4);
console.log("10. missing telegram config → graceful warning, no crash ✓");

fake.close();
console.log("\n🎉 ALL TELEGRAM ALERT TESTS PASSED!");
