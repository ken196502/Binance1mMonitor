// 回归测试：Binance @trade 流会混入 p="0" 的无效成交，若并入 K 线会把该根 low/close
// 打成 0 且永久损坏（tick.price < 0 恒为 false），进而把图表价格轴拉到 0，
// 并把 0 喂进 MACD/均线（告警口径）。这里锁死三条行为：
//   1) 无效 tick 不建柱、不改柱
//   2) 有效 tick 正常建柱/推进，low 不会被 0 污染
//   3) 历史遗留的坏柱（low=0 / 整根为 0）会被清洗掉

import { applyTradeToCandles, sanitizeCandles, isValidTick, type TradeTick } from "../src/ws.ts";
import type { Candle } from "../src/macd.ts";

const T0 = 1_700_000_000_000 - (1_700_000_000_000 % 60_000); // 对齐整分钟

function bar(time: number, close: number): Candle {
  return { time, open: close, high: close, low: close, close, volume: 1 };
}
function tick(price: number, time: number, qty = 1): TradeTick {
  return { symbol: "BTCUSDT", price, qty, time };
}

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

console.log("isValidTick");
check("拒绝 price=0", !isValidTick(tick(0, T0)));
check("拒绝负数 price", !isValidTick(tick(-1, T0)));
check("拒绝 NaN price", !isValidTick(tick(Number.NaN, T0)));
check("拒绝 time=0", !isValidTick(tick(100, 0)));
check("接受正常 tick", isValidTick(tick(100, T0, 2)));

console.log("applyTradeToCandles: 无效 tick 不应建柱");
{
  const candles = [bar(T0 - 60_000, 100)];
  const out = applyTradeToCandles(candles, tick(0, T0));
  check("柱子数量不变", out.length === 1, `got ${out.length}`);
  check("没有新建 low=0 的柱", out.every((c) => c.low > 0));
  check("原数据未被污染", out[0].low === 100, `low=${out[0].low}`);
}

console.log("applyTradeToCandles: 无效 tick 不应把 close 打成 0");
{
  const candles = [bar(T0, 100)];
  const out = applyTradeToCandles(candles, tick(0, T0));
  check("close 仍为 100", out[0].close === 100, `close=${out[0].close}`);
  check("low 仍为 100", out[0].low === 100, `low=${out[0].low}`);
}

console.log("applyTradeToCandles: 先来坏 tick、再来正常 tick（真实场景）");
{
  const candles = [bar(T0 - 60_000, 100)];
  const afterBad = applyTradeToCandles(candles, tick(0, T0)); // 占位帧先到
  const afterGood = applyTradeToCandles(afterBad, tick(105, T0 + 500));
  check("正常 tick 仍能建柱", afterGood.length === 2, `got ${afterGood.length}`);
  const last = afterGood[afterGood.length - 1];
  check("新柱 low > 0", last.low > 0, `low=${last.low}`);
  check("新柱 close = 105", last.close === 105, `close=${last.close}`);
  check("新柱 high >= close", last.high >= last.close, `high=${last.high}`);
}

console.log("applyTradeToCandles: 同分钟内价格下探不会低于 0");
{
  let candles = [bar(T0 - 60_000, 100)];
  candles = applyTradeToCandles(candles, tick(120, T0));
  candles = applyTradeToCandles(candles, tick(90, T0 + 1000));
  candles = applyTradeToCandles(candles, tick(0, T0 + 2000)); // 占位帧
  candles = applyTradeToCandles(candles, tick(95, T0 + 3000));
  const last = candles[candles.length - 1];
  check("low 被 90 正确更新", last.low === 90, `low=${last.low}`);
  check("占位帧未把 close 清零", last.close === 95, `close=${last.close}`);
  check("high 被 120 正确更新", last.high === 120, `high=${last.high}`);
}

console.log("sanitizeCandles: 修复历史遗留的坏柱");
{
  const dirty: Candle[] = [
    { time: T0 - 120_000, open: 100, high: 110, low: 0, close: 105, volume: 1 }, // low=0
    { time: T0 - 60_000, open: 105, high: 115, low: 100, close: 110, volume: 1 }, // 正常
    { time: T0, open: 0, high: 0, low: 0, close: 0, volume: 0 }, // 整根为 0
  ];
  const clean = sanitizeCandles(dirty);
  check("整根为 0 的柱被丢弃", clean.length === 2, `got ${clean.length}`);
  check("low=0 被夹回合法区间", clean[0].low === 100, `low=${clean[0].low}`);
  check("正常柱未被破坏", clean[1].close === 110 && clean[1].low === 100);
  check("所有柱子 OHLC > 0", clean.every((c) => Math.min(c.open, c.high, c.low, c.close) > 0));
  check("high 不低于 open/close", clean.every((c) => c.high >= Math.max(c.open, c.close)));
  check("low 不高于 open/close", clean.every((c) => c.low <= Math.min(c.open, c.close)));
}

console.log("sanitizeCandles: 干净数据原样返回（保持引用，避免无谓拷贝）");
{
  const good: Candle[] = [bar(T0 - 60_000, 100), bar(T0, 101)];
  const out = sanitizeCandles(good);
  check("返回同一数组引用", out === good);
  check("返回同一元素引用", out[0] === good[0]);
}

console.log("applyTradeToCandles: 自动清洗历史坏柱");
{
  const dirty: Candle[] = [
    { time: T0 - 60_000, open: 100, high: 110, low: 0, close: 105, volume: 1 },
  ];
  const out = applyTradeToCandles(dirty, tick(108, T0));
  check("建了新柱", out.length === 2, `got ${out.length}`);
  check("没有残留 low<=0 的柱", out.every((c) => c.low > 0), JSON.stringify(out.map((c) => c.low)));
}

console.log("applyTradeToCandles: maxBars 修剪仍生效");
{
  // 空数组不会被 WS 灌满（首根必须来自 REST 冷启动），所以先用一根打底
  let candles: Candle[] = [bar(T0 - 60_000, 99)];
  for (let i = 0; i < 10; i++) candles = applyTradeToCandles(candles, tick(100 + i, T0 + i * 60_000), 5);
  check("长度被限制为 5", candles.length === 5, `got ${candles.length}`);
  check("保留的是最新的 5 根", candles[candles.length - 1].time === T0 + 9 * 60_000);
}

console.log("applyTradeToCandles: 空数组不自行灌数据（首根只能来自 REST 冷启动）");
{
  const out = applyTradeToCandles([], tick(100, T0));
  check("仍为空", out.length === 0, `got ${out.length}`);
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 个用例失败`);
process.exit(failures === 0 ? 0 : 1);
