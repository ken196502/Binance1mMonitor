// Behavioral test: 验证 24h 涨幅榜警告已彻底移除，只保留模拟交易 Telegram 播报。
//
// Run manually:
//   npx tsx scripts/test-alert.ts

import http from "node:http";
import assert from "node:assert";

// --- fake Telegram API -------------------------------------------------------
const received: { text: string; auth: string }[] = [];
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = req.url ?? "";
    if (!url.startsWith("/botTESTTOKEN/sendMessage")) {
      res.writeHead(404).end('{"ok":false}');
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

const { formatStreak } = await import("../src/alert.ts");
const alertModule = await import("../src/alert.ts");
const { PaperTradingEngine } = await import("../src/paper-trading.ts");

// 1. 验证 TelegramAlerter 在 alert.ts 中已被彻底删除
assert.equal((alertModule as any).TelegramAlerter, undefined, "24h涨幅榜告警器 TelegramAlerter 必须彻底删除");
console.log("1. TelegramAlerter 已彻底删除 ✓");

// 2. formatStreak 辅助文案保持正常
assert.equal(formatStreak(3, "up"), "3连阳");
assert.equal(formatStreak(2, "down"), "2连阴");
assert.equal(formatStreak(1, "up"), "");
console.log("2. formatStreak 辅助函数正常 ✓");

// 3. 验证模拟交易 Telegram 播报仍然保留并能正常触发发送
const engine = new PaperTradingEngine({ storageFile: null });
const now = Date.now();
const candle = { time: now - 60_000, open: 100, high: 101, low: 99, close: 100, volume: 1 };
const signal = { candle, streakCount: 2, amp30Percent: 3, upperShadowRatio: 0.1, greenRatio: 0.8, consecutiveGreenBars: 5 };

const pos = engine.openPosition({
  symbol: "BTCUSDT",
  entryPrice: 100,
  entryTime: now,
  dayChangePercent: 15,
  signal,
  signalType: "streak",
});

// 等待异步开仓 Telegram 通知送达
for (let i = 0; i < 20 && received.length < 1; i++) {
  await new Promise((r) => setTimeout(r, 50));
}

assert.equal(received.length, 1, "开仓应触发 1 条模拟交易通知");
assert.match(received[0].text, /模拟交易/);
assert.match(received[0].text, /BTCUSDT/);
assert.doesNotMatch(received[0].text, /24h涨幅榜告警/);
console.log("3. 模拟交易 Telegram 开仓播报正常触发 ✓");

// 触发平仓
engine.onTick({ symbol: "BTCUSDT", price: pos.tp2Price, qty: 1, time: now + 60_000 });

// 等待异步平仓 Telegram 通知送达
for (let i = 0; i < 20 && received.length < 2; i++) {
  await new Promise((r) => setTimeout(r, 50));
}

assert.ok(received.length >= 2, "平仓应触发模拟交易通知");
assert.match(received[received.length - 1].text, /模拟交易/);
assert.doesNotMatch(received[received.length - 1].text, /24h涨幅榜告警/);
console.log("4. 模拟交易 Telegram 平仓播报正常触发 ✓");

// 确认所有接收到的消息中均不存在 24h 涨幅榜告警
for (const msg of received) {
  assert.ok(!msg.text.includes("24h涨幅榜告警"), "不得出现任何 24h 涨幅榜告警");
}
console.log("5. 确认无任何 24h 涨幅榜告警产生 ✓");

fake.close();
console.log("\n🎉 ALL TESTS PASSED: 24h涨幅榜警告已删，仅保留模拟交易播报！");
