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
  let streakCount = 0;
  let streakDir: "up" | "down" | null = null;
  let diff1m: number | null = 1.0;
  let diff5m: number | null = -1.0;
  let supportMa: string | null = null;

  if (typeof arg1 === "boolean" || (arg1 === null && typeof arg2 === "boolean")) {
    // legacy call: row(high, bullish, symbol, streakCount, streakDir, weekChange, supportMa)
    symbol = typeof arg3 === "string" ? arg3 : `SYM${++n}`;
    streakCount = typeof arg4 === "number" ? arg4 : 0;
    streakDir = arg5 ?? null;
    supportMa = arg7 !== undefined ? arg7 : null;
  } else if (typeof arg1 === "string") {
    symbol = arg1;
    streakCount = typeof arg2 === "number" ? arg2 : 0;
    streakDir = arg3 ?? null;
    diff1m = arg4 !== undefined ? arg4 : 1.0;
    diff5m = arg5 !== undefined ? arg5 : -1.0;
    supportMa = arg6 !== undefined ? arg6 : null;
  } else {
    symbol = `SYM${++n}`;
  }

  return {
    symbol,
    lastPrice: 1,
    priceChangePercent: 0,
    quoteVolume: 1,
    state: "low-above",
    alert: false,
    bullish: true,
    high: true,
    diff1m,
    diff5m,
    diff15m: diff5m,
    supportMa,
    streakCount,
    streakDir,
  };
}

const countOf = (s?: { ok: boolean }) => (s?.ok ? 1 : 0);

// --- 0. formatStreak helper test ---------------------------------------------
assert.equal(formatStreak(3, "up"), "3连阳");
assert.equal(formatStreak(2, "down"), "2连阴");
assert.equal(formatStreak(1, "up"), "1连阳");
assert.equal(formatStreak(0, "up"), "");
assert.equal(formatStreak(3, null), "");
console.log("0. formatStreak 阳阴连数文案 ✓");

// --- 1. pickHighBull: filter !supportMa && diff1m > 0 && diff5m < 0 ---------
const testList = [
  row("MATCH1", 4, "up", 0.5, -0.3, null),      // match: no support, 1m > 0, 5m < 0
  row("HAS_MA", 0, null, 0.5, -0.3, "ma10"),    // no: has support
  row("DIFF1M_NEG", 0, null, -0.1, -0.3, null), // no: 1m <= 0
  row("DIFF1M_ZERO", 0, null, 0, -0.3, null),   // no: 1m == 0
  row("DIFF1M_NULL", 0, null, null, -0.3, null),// no: 1m is null
  row("DIFF5M_POS", 0, null, 0.5, 0.2, null),   // no: 5m >= 0
  row("DIFF5M_ZERO", 0, null, 0.5, 0, null),    // no: 5m == 0
  row("DIFF5M_NULL", 0, null, 0.5, null, null), // no: 5m is null
  row("MATCH2", 2, "down", 1.2, -0.8, null),    // match
  row("MATCH1", 4, "up", 0.5, -0.3, null),      // dupe
];
assert.deepEqual(pickHighBull(testList), ["MATCH1", "MATCH2"]);
const items = pickHighBullItems(testList);
assert.equal(items.length, 2);
assert.equal(items[0].symbol, "MATCH1");
assert.equal(items[0].streakCount, 4);
assert.equal(items[0].streakDir, "up");
console.log("1. pickHighBull + pickHighBullItems filter (无支撑 + 1m DIFF>0 + 5m DIFF<0) + dedupe ✓");

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

// --- 3. one board reaches 3 (gainers: 3) → alert sent with streak! -----------
const res2 = await a.check({
  gainers: [
    row(true, true, "BTCUSDT", 3, "up"),
    row(true, true, "ETHUSDT", 5, "down"),
    row(true, true, "SOLUSDT", 1, "up"),
  ],
  losers: [],
});
assert.equal(res2.summary.triggered, true);
assert.equal(res2.summary.gainers.count, 3);
assert.equal(countOf(res2.sent), 1);
assert.equal(received.length, 1);
assert.match(received[0].text, /告警/);
assert.match(received[0].text, /24h 涨幅榜.*3/);
assert.doesNotMatch(received[0].text, /24h 跌幅榜/);
assert.doesNotMatch(received[0].text, /24h 成交额榜/);
assert.match(received[0].text, /置顶标的/);
assert.match(received[0].text, /BTCUSDT<\/b><\/a> \(3连阳\)/);
assert.match(received[0].text, /ETHUSDT<\/b><\/a> \(5连阴\)/);
assert.match(received[0].text, /SOLUSDT<\/b><\/a> \(1连阳\)/);
assert.match(received[0].auth, /TESTTOKEN/);
console.log("3. gainers reaches 3 → alert sent only for gainers (未达标榜单不播报) with 置顶标的及阳阴连数 ✓");

// --- 4. check again with EXACT SAME symbols (BTC, ETH, SOL) → no repeated notification -
const res3 = await a.check({
  gainers: [row(true, true, "BTCUSDT"), row(true, true, "ETHUSDT"), row(true, true, "SOLUSDT")], // still BTC, ETH, SOL
  losers: [],
});
assert.equal(res3.summary.triggered, true);
assert.equal(res3.sent, undefined); // NOT sent!
assert.equal(received.length, 1);   // No new message
console.log("4. count and symbols unchanged → no duplicate notification (防骚扰) ✓");

// --- 4b. temporary dip below threshold (<3) then back to same coins → NO duplicate (榜币没变不重发)
const resDip = await a.check({
  gainers: [row(true, true, "BTCUSDT"), row(true, true, "ETHUSDT")], // 2 (< 3)
  losers: [],
  volume: [],
});
assert.equal(resDip.summary.triggered, false);
assert.equal(resDip.sent, undefined);

const resBack = await a.check({
  gainers: [
    row(true, true, "BTCUSDT", 4, "up"),
    row(true, true, "ETHUSDT", 6, "down"),
    row(true, true, "SOLUSDT", 2, "up"),
  ], // 3 coins, same as before!
  losers: [],
  volume: [],
});
assert.equal(resBack.summary.triggered, true);
assert.equal(resBack.sent, undefined); // 榜币没变，绝不重复播报！
assert.equal(received.length, 1);
console.log("4b. temporary dip and back to exact same coins → NO duplicate notification (榜币没变) ✓");

// --- 5. coins change in gainers (ADA, AVAX, DOT) → new notification sent! -----
const res4 = await a.check({
  gainers: [row(true, true, "ADAUSDT"), row(true, true, "AVAXUSDT"), row(true, true, "DOTUSDT")],
  losers: [],
  volume: [],
});
assert.equal(res4.summary.gainers.count, 3);
assert.equal(countOf(res4.sent), 1);
assert.equal(received.length, 2);
assert.match(received[1].text, /ADAUSDT/);
console.log("5. coins changed in gainers → new notification sent (榜币变了才发) ✓");

// --- 6. same coins (ADA, AVAX, DOT) again → NO notification -------------------
const res5 = await a.check({
  gainers: [row(true, true, "ADAUSDT", 2, "up"), row(true, true, "AVAXUSDT", 1, "down"), row(true, true, "DOTUSDT", 3, "up")],
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
  volume: [],
});
assert.equal(res7.summary.triggered, true);
assert.equal(countOf(res7.sent), 1);
assert.equal(received.length, 3);
assert.match(received[2].text, /告警/);
assert.match(received[2].text, /24h 跌幅榜.*3/);
console.log("8. re-trigger after recovery on losers → alert sent ✓");

// --- 9. clear & re-trigger with send failure → retries on next check ----------
a.resetState();
failNext = true;
// Trigger again with gainers: 3 (BTC, ETH, SOL)
const res8 = await a.check({
  gainers: [row(true, true, "BTCUSDT"), row(true, true, "ETHUSDT"), row(true, true, "SOLUSDT")], // 3
  losers: [],
});
assert.equal(res8.sent?.ok, false); // failed
assert.equal(received.length, 3);   // not recorded in fake
// Next check with gainers: 3 — must retry because previous send failed!
const res9 = await a.check({
  gainers: [row(true, true, "BTCUSDT"), row(true, true, "ETHUSDT"), row(true, true, "SOLUSDT")], // 3
  losers: [],
});
assert.equal(res9.sent?.ok, true); // succeeded!
assert.equal(received.length, 4);
assert.match(received[3].text, /24h 涨幅榜.*3/);
console.log("9. failed send retries on subsequent check until delivered ✓");

// --- 10. unconfigured telegram → explicit failure without crashing ------------
a.resetState();
delete process.env.TELEGRAM_BOT_TOKEN;
const res10 = await a.check({
  gainers: [row(true, true, "BTCUSDT"), row(true, true, "ETHUSDT"), row(true, true, "SOLUSDT")], // 3
  losers: [],
  volume: [],
});
assert.equal(res10.sent?.ok, false);
assert.equal(res10.sent?.error, "not configured");
assert.equal(received.length, 4);
console.log("10. missing telegram config → graceful warning, no crash ✓");

fake.close();
console.log("\n🎉 ALL TELEGRAM ALERT TESTS PASSED!");
