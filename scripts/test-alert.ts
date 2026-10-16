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
  arg1?: any,
  arg2?: any,
  arg3?: any,
  arg4?: any,
  arg5?: any,
  arg6?: any,
  arg7?: any,
): Row {
  let symbol: string;
  let streakCount = 2;
  let streakDir: "up" | "down" | null = "up";
  let diff1mLevel: "high" | "mid" | "low" | null = "mid";
  let diff5mLevel: "high" | "mid" | "low" | null = "mid";
  let supportMa: string | null = null;

  if (typeof arg1 === "boolean" || (arg1 === null && typeof arg2 === "boolean")) {
    // legacy call: row(high, bullish, symbol, streakCount, streakDir, weekChange, supportMa)
    symbol = typeof arg3 === "string" ? arg3 : `SYM${++n}`;
    streakCount = typeof arg4 === "number" ? arg4 : 2;
    streakDir = arg5 ?? "up";
    diff1mLevel = streakDir === "down" ? "low" : "mid";
    diff5mLevel = "mid";
    supportMa = arg7 !== undefined ? arg7 : null;
  } else if (typeof arg1 === "string") {
    symbol = arg1;
    streakCount = typeof arg2 === "number" ? arg2 : 2;
    streakDir = arg3 ?? "up";
    diff1mLevel = arg4 !== undefined ? arg4 : (streakDir === "down" ? "low" : "mid");
    diff5mLevel = arg5 !== undefined ? arg5 : "mid";
    supportMa = arg6 !== undefined ? arg6 : null;
  } else {
    symbol = `SYM${++n}`;
  }

  return {
    symbol,
    lastPrice: 85,
    priceChangePercent: 0,
    quoteVolume: 1,
    state: "low-above",
    alert: false,
    bullish: true,
    high: true,
    diff1m: 0.1,
    diff1mLevel,
    diff5m: 0.1,
    diff5mLevel,
    diff15m: 0.1,
    diff15mLevel: diff5mLevel,
    change60d: "up",
    max1500: 100,
    maxHour: 100,
    hourFirstClose: 100,
    hourFirstLow: 100,
    supportMa,
    streakCount,
    streakDir,
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

// --- 1. pickHighBull: filter !supportMa && ((1m=mid && streak=up) || (1m=low && streak=down)) && 5m=mid && lastPrice < max1500 * 0.96 && lastPrice < hourFirstLow * 0.9
const testList = [
  row("MATCH_MID_UP", 4, "up", "mid", "mid", null),     // match: no support, 1m mid, 5m mid, 4连阳, price 85 < 100*0.96 && 85 < 100*0.9
  row("MATCH_LOW_DOWN", 2, "down", "low", "mid", null), // match: no support, 1m low, 5m mid, 2连阴, price 85 < 100*0.96 && 85 < 100*0.9
  row("MISMATCH_MID_DOWN", 3, "down", "mid", "mid", null), // no: 1m mid but 连阴
  row("MISMATCH_LOW_UP", 3, "up", "low", "mid", null),     // no: 1m low but 连阳
  row("STREAK_ONE_UP", 1, "up", "mid", "mid", null),       // no: 只有1根阳线，不算连
  row("STREAK_ONE_DOWN", 1, "down", "low", "mid", null),   // no: 只有1根阴线，不算连
  row("HAS_MA", 2, "up", "mid", "mid", "ma10"),            // no: has support
  row("DIFF1M_HIGH", 2, "up", "high", "mid", null),        // no: 1m is high
  row("DIFF5M_HIGH", 2, "up", "mid", "high", null),        // no: 5m is high
  row("DIFF5M_LOW", 2, "up", "mid", "low", null),          // no: 5m is low
  { ...row("PRICE_TOO_HIGH", 2, "up", "mid", "mid", null), lastPrice: 97, max1500: 100, hourFirstLow: 100 }, // no: 97 >= 100 * 0.96
  { ...row("PRICE_EQUAL_HIGH", 2, "up", "mid", "mid", null), lastPrice: 96, max1500: 100, hourFirstLow: 100 }, // no: 96 >= 100 * 0.96
  { ...row("PRICE_NO_MAX1500", 2, "up", "mid", "mid", null), lastPrice: 85, max1500: null, hourFirstLow: 100 }, // no: no max1500
  { ...row("PRICE_HOUR_TOO_HIGH", 2, "up", "mid", "mid", null), lastPrice: 88, max1500: 100, hourFirstLow: 96 }, // no: 88 >= 96 * 0.9 (86.4)
  { ...row("PRICE_HOUR_EQUAL_HIGH", 2, "up", "mid", "mid", null), lastPrice: 86.4, max1500: 100, hourFirstLow: 96 }, // no: 86.4 >= 96 * 0.9
  { ...row("PRICE_NO_MAXHOUR", 2, "up", "mid", "mid", null), lastPrice: 85, max1500: 100, hourFirstLow: null }, // no: no hourFirstLow
  row("MATCH_MID_UP", 4, "up", "mid", "mid", null),        // dupe
];
assert.deepEqual(pickHighBull(testList), ["MATCH_MID_UP", "MATCH_LOW_DOWN"]);
const items = pickHighBullItems(testList);
assert.equal(items.length, 2);
assert.equal(items[0].symbol, "MATCH_MID_UP");
assert.equal(items[0].streakCount, 4);
assert.equal(items[0].streakDir, "up");
assert.equal(items[1].symbol, "MATCH_LOW_DOWN");
console.log("1. pickHighBull + pickHighBullItems filter (无支撑+1m中+5m中+连阳 或 无支撑+1m低+5m中+连阴 + 现价<max1500*0.96 + 现价<hourFirstLow*0.9) + dedupe ✓");

// --- 2. below threshold on both boards (< 3) → no alert ---------------------
const a = new TelegramAlerter();
const res1 = await a.check({
  gainers: [row(true, true), row(true, true)], // 2
  losers: [row(true, true)],                   // 1
});
assert.equal(res1.summary.triggered, false);
assert.equal(res1.sent, undefined);
assert.equal(received.length, 0);
console.log("2. all boards below threshold (< 3) → no alert sent ✓");

// --- 2b. pinned symbols in gainers do NOT count towards board threshold ------
const resPinnedOnly = await a.check({
  gainers: [
    row(true, true, "BTCUSDT", 3, "up"),
    row(true, true, "SOLUSDT", 2, "up"),
    row(true, true, "ETHUSDT", 5, "down"),
  ],
  losers: [],
});
// 即使总行数有3且均满足指标，置顶标的(BTC, SOL)被排除，涨幅榜自然币种仅1个(< 3)，不触发告警
assert.equal(resPinnedOnly.summary.gainers.count, 1);
assert.equal(resPinnedOnly.summary.triggered, false);
assert.equal(resPinnedOnly.sent, undefined);
assert.equal(received.length, 0);
console.log("2b. pinned symbols excluded from leaderboard count (< 3) → no alert sent ✓");

// --- 3. one board reaches 3 (gainers: 3 unpinned) → alert sent with streak! --
const res2 = await a.check({
  gainers: [
    row(true, true, "BTCUSDT", 3, "up"),
    row(true, true, "SOLUSDT", 2, "up"),
    row(true, true, "ETHUSDT", 5, "down"),
    row(true, true, "ADAUSDT", 2, "up"),
    row(true, true, "DOTUSDT", 3, "up"),
  ],
  pinned: [
    row(true, true, "BTCUSDT", 3, "up"),
    row(true, true, "SOLUSDT", 2, "up"),
  ],
  losers: [],
});
assert.equal(res2.summary.triggered, true);
assert.equal(res2.summary.gainers.count, 3);
assert.deepEqual(res2.summary.gainers.symbols, ["ETHUSDT", "ADAUSDT", "DOTUSDT"]);
assert.equal(countOf(res2.sent), 1);
assert.equal(received.length, 1);
assert.match(received[0].text, /告警/);
assert.match(received[0].text, /↑↑涨幅榜\(24h\)↑↑.*3/);
assert.doesNotMatch(received[0].text, /24h跌幅榜/);
assert.doesNotMatch(received[0].text, /24h 成交额榜/);
assert.match(received[0].text, /置顶标的/);
assert.match(received[0].text, /BTCUSDT<\/b><\/a> \(3连阳\)/);
assert.match(received[0].text, /SOLUSDT<\/b><\/a> \(2连阳\)/);
assert.match(received[0].text, /ETHUSDT<\/b><\/a> \(5连阴/);
assert.match(received[0].text, /ADAUSDT<\/b><\/a> \(2连阳/);
assert.match(received[0].text, /DOTUSDT<\/b><\/a> \(3连阳/);
// 验证涨幅榜区域不包含置顶标的
const gainersPart = received[0].text.split("↑↑涨幅榜(24h)↑↑")[1] ?? "";
assert.doesNotMatch(gainersPart, /BTCUSDT/);
assert.doesNotMatch(gainersPart, /SOLUSDT/);
assert.match(received[0].auth, /TESTTOKEN/);
console.log("3. gainers reaches 3 (excluding pinned) → alert sent only for gainers with 置顶标的及阳阴连数 ✓");

// --- 4. check again with EXACT SAME symbols (ETH, ADA, DOT) → no repeated notification -
const res3 = await a.check({
  gainers: [row(true, true, "ETHUSDT"), row(true, true, "ADAUSDT"), row(true, true, "DOTUSDT")],
  pinned: [row(true, true, "BTCUSDT"), row(true, true, "SOLUSDT")],
  losers: [],
});
assert.equal(res3.summary.triggered, true);
assert.equal(res3.sent, undefined); // NOT sent!
assert.equal(received.length, 1);   // No new message
console.log("4. count and symbols unchanged → no duplicate notification (防骚扰) ✓");

// --- 4b. temporary dip below threshold (<3) then back to same coins → NO duplicate (榜币没变不重发)
const resDip = await a.check({
  gainers: [row(true, true, "ETHUSDT"), row(true, true, "ADAUSDT")], // 2 (< 3)
  pinned: [row(true, true, "BTCUSDT"), row(true, true, "SOLUSDT")],
  losers: [],
  volume: [],
});
assert.equal(resDip.summary.triggered, false);
assert.equal(resDip.sent, undefined);

const resBack = await a.check({
  gainers: [
    row(true, true, "ETHUSDT", 6, "down"),
    row(true, true, "ADAUSDT", 2, "up"),
    row(true, true, "DOTUSDT", 4, "up"),
  ], // 3 coins, same as before!
  pinned: [row(true, true, "BTCUSDT", 4, "up"), row(true, true, "SOLUSDT", 2, "up")],
  losers: [],
  volume: [],
});
assert.equal(resBack.summary.triggered, true);
assert.equal(resBack.sent, undefined); // 榜币没变，绝不重复播报！
assert.equal(received.length, 1);
console.log("4b. temporary dip and back to exact same coins → NO duplicate notification (榜币没变) ✓");

// --- 5. coins change in gainers (AVAX, LINK, NEAR) → new notification sent! ---
const res4 = await a.check({
  gainers: [row(true, true, "AVAXUSDT"), row(true, true, "LINKUSDT"), row(true, true, "NEARUSDT")],
  pinned: [row(true, true, "BTCUSDT"), row(true, true, "SOLUSDT")],
  losers: [],
  volume: [],
});
assert.equal(res4.summary.gainers.count, 3);
assert.equal(countOf(res4.sent), 1);
assert.equal(received.length, 2);
assert.match(received[1].text, /AVAXUSDT/);
console.log("5. coins changed in gainers → new notification sent (榜币变了才发) ✓");

// --- 6. same coins (AVAX, LINK, NEAR) again → NO notification -----------------
const res5 = await a.check({
  gainers: [row(true, true, "AVAXUSDT", 2, "up"), row(true, true, "LINKUSDT", 1, "down"), row(true, true, "NEARUSDT", 3, "up")],
  pinned: [row(true, true, "BTCUSDT"), row(true, true, "SOLUSDT")],
  losers: [],
  volume: [],
});
assert.equal(res5.sent, undefined);
assert.equal(received.length, 2);
console.log("6. same coins with updated streak → NO duplicate notification ✓");

// --- 7. condition clears (all drop to 0) → no recovery message ----------------
const res6 = await a.check({
  gainers: [],
  losers: [],
  volume: [],
});
assert.equal(res6.summary.triggered, false);
assert.equal(res6.sent, undefined); // 不发送解除通知
assert.equal(received.length, 2);
assert.equal(a.getLastNotifiedCounts(), null);
console.log("7. condition clears to 0 → state reset without recovery broadcast ✓");

// --- 8. re-trigger after recovery on losers (PEPE, DOGE, SHIB) → alert sent! --
const res7 = await a.check({
  gainers: [],
  losers: [row(true, true, "PEPEUSDT"), row(true, true, "DOGEUSDT"), row(true, true, "SHIBUSDT")], // 3
  pinned: [row(true, true, "BTCUSDT"), row(true, true, "SOLUSDT")],
  volume: [],
});
assert.equal(res7.summary.triggered, true);
assert.equal(countOf(res7.sent), 1);
assert.equal(received.length, 3);
assert.match(received[2].text, /告警/);
assert.match(received[2].text, /↘︎↘︎跌幅榜\(24h\)↘︎↘︎.*3/);
console.log("8. re-trigger after recovery on losers → alert sent ✓");

// --- 9. clear & re-trigger with send failure → retries on next check ----------
a.resetState();
failNext = true;
// Trigger again with gainers: 3
const res8 = await a.check({
  gainers: [row(true, true, "ETHUSDT"), row(true, true, "ADAUSDT"), row(true, true, "DOTUSDT")],
  pinned: [row(true, true, "BTCUSDT"), row(true, true, "SOLUSDT")],
  losers: [],
});
assert.equal(res8.sent?.ok, false); // failed
assert.equal(received.length, 3);   // not recorded in fake
// Next check with gainers: 3 — must retry because previous send failed!
const res9 = await a.check({
  gainers: [row(true, true, "ETHUSDT"), row(true, true, "ADAUSDT"), row(true, true, "DOTUSDT")],
  pinned: [row(true, true, "BTCUSDT"), row(true, true, "SOLUSDT")],
  losers: [],
});
assert.equal(res9.sent?.ok, true); // succeeded!
assert.equal(received.length, 4);
assert.match(received[3].text, /↑↑涨幅榜\(24h\)↑↑.*3/);
console.log("9. failed send retries on subsequent check until delivered ✓");

// --- 10. unconfigured telegram → explicit failure without crashing ------------
a.resetState();
delete process.env.TELEGRAM_BOT_TOKEN;
const res10 = await a.check({
  gainers: [row(true, true, "ETHUSDT"), row(true, true, "ADAUSDT"), row(true, true, "DOTUSDT")],
  pinned: [row(true, true, "BTCUSDT"), row(true, true, "SOLUSDT")],
  losers: [],
  volume: [],
});
assert.equal(res10.sent?.ok, false);
assert.equal(res10.sent?.error, "not configured");
assert.equal(received.length, 4);
console.log("10. missing telegram config → graceful warning, no crash ✓");

fake.close();
console.log("\n🎉 ALL TELEGRAM ALERT TESTS PASSED!");
