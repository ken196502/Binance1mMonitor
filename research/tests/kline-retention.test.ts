import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pruneExpiredArchives, loadRecentCandlesFromDisk, DEFAULT_KLINE_RETENTION_HOURS } from "../../src/factor-data.ts";
import { KLINE_RETENTION_HOURS, KLINE_ROLLING_LIMIT, maybePruneArchives, resetPruneStateForTest } from "../../src/server.ts";
import { applyTradeToCandles } from "../../src/ws.ts";
import type { Candle } from "../../src/macd.ts";

test("48-hour minute candle retention: pruneExpiredArchives deletes full expired days at UTC 0:00 without line rewriting to protect disk", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kline-prune-"));
  try {
    await mkdir(path.join(dir, "live-1m"));
    await mkdir(path.join(dir, "live-boards"));

    const now = new Date("2026-11-08T12:00:00Z").getTime();
    const H = 3600_000;

    // 1. Completely expired file: 72 hours ago (2026-11-05)
    const t72 = now - 72 * H;
    const day72 = new Date(t72).toISOString().slice(0, 10).replaceAll("-", "");
    const file72_1m = path.join(dir, "live-1m", `BTCUSDT-${day72}.jsonl`);
    const file72_board = path.join(dir, "live-boards", `${day72}.jsonl`);
    await writeFile(file72_1m, JSON.stringify({ time: t72, open: 100, high: 101, low: 99, close: 100, volume: 1 }) + "\n");
    await writeFile(file72_board, JSON.stringify({ observedAt: t72, tickers: [{ symbol: "BTCUSDT", priceChangePercent: 1 }] }) + "\n");

    // 2. Boundary day file: 48 hours ago (2026-11-06)
    const tBoundary = now - 48 * H;
    const dayBoundary = new Date(tBoundary).toISOString().slice(0, 10).replaceAll("-", "");
    const fileBound_1m = path.join(dir, "live-1m", `BTCUSDT-${dayBoundary}.jsonl`);
    const fileBound_board = path.join(dir, "live-boards", `${dayBoundary}.jsonl`);
    await writeFile(fileBound_1m, JSON.stringify({ time: tBoundary, open: 102, high: 103, low: 101, close: 102, volume: 1 }) + "\n");
    await writeFile(fileBound_board, JSON.stringify({ observedAt: tBoundary, tickers: [{ symbol: "BTCUSDT", priceChangePercent: 2 }] }) + "\n");

    // 3. Valid recent file: 24 hours ago (2026-11-07)
    const t24 = now - 24 * H;
    const day24 = new Date(t24).toISOString().slice(0, 10).replaceAll("-", "");
    const file24_1m = path.join(dir, "live-1m", `BTCUSDT-${day24}.jsonl`);
    const file24_board = path.join(dir, "live-boards", `${day24}.jsonl`);
    await writeFile(file24_1m, JSON.stringify({ time: t24, open: 104, high: 105, low: 103, close: 104, volume: 1 }) + "\n");
    await writeFile(file24_board, JSON.stringify({ observedAt: t24, tickers: [{ symbol: "BTCUSDT", priceChangePercent: 3 }] }) + "\n");

    // Execute pruning for 2026-11-08: cutoffDay is 20261106
    const pruneResult = await pruneExpiredArchives(dir, 48, now);

    // Verify: 72h files (< 20261106) are deleted
    await assert.rejects(readFile(file72_1m), /ENOENT/);
    await assert.rejects(readFile(file72_board), /ENOENT/);
    assert.ok(pruneResult.deletedFiles.includes(file72_1m));
    assert.ok(pruneResult.deletedFiles.includes(file72_board));

    // Verify: Boundary files (20261106) are kept intact without rewriting (protecting disk endurance)
    const boundContent1m = await readFile(fileBound_1m, "utf8");
    assert.ok(boundContent1m.includes(String(tBoundary)));

    // Verify: 24h files (20261107) are untouched
    const content24_1m = await readFile(file24_1m, "utf8");
    assert.ok(content24_1m.includes(String(t24)));

    // When advancing to next day at UTC 0:00 (2026-11-09T00:00:00Z):
    // cutoffDay becomes 20261107, so 20261106 is now deleted as a whole file
    const nextUtcDay = new Date("2026-11-09T00:00:00Z").getTime();
    const pruneResultNext = await pruneExpiredArchives(dir, 48, nextUtcDay);
    await assert.rejects(readFile(fileBound_1m), /ENOENT/);
    assert.ok(pruneResultNext.deletedFiles.includes(fileBound_1m));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadRecentCandlesFromDisk retrieves up to 48 hours of clean candles from disk archive", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kline-load-"));
  try {
    await mkdir(path.join(dir, "live-1m"));
    const now = new Date("2026-11-08T12:00:00Z").getTime();
    const H = 3600_000;

    const day1 = new Date(now - 25 * H).toISOString().slice(0, 10).replaceAll("-", "");
    const day2 = new Date(now - 1 * H).toISOString().slice(0, 10).replaceAll("-", "");

    const c1: Candle = { time: now - 25 * H, open: 100, high: 101, low: 99, close: 100, volume: 10 };
    const c2: Candle = { time: now - 1 * H, open: 105, high: 106, low: 104, close: 105, volume: 20 };

    await writeFile(path.join(dir, "live-1m", `ETHUSDT-${day1}.jsonl`), JSON.stringify(c1) + "\n");
    await writeFile(path.join(dir, "live-1m", `ETHUSDT-${day2}.jsonl`), JSON.stringify(c2) + "\n");

    const loaded = await loadRecentCandlesFromDisk("ETHUSDT", now - 48 * H, now, dir);
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].time, c1.time);
    assert.equal(loaded[1].time, c2.time);

    // Range outside
    const loadedRecentOnly = await loadRecentCandlesFromDisk("ETHUSDT", now - 2 * H, now, dir);
    assert.equal(loadedRecentOnly.length, 1);
    assert.equal(loadedRecentOnly[0].time, c2.time);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("default retention and memory rolling limit default to 48 hours (2880 bars)", () => {
  assert.equal(DEFAULT_KLINE_RETENTION_HOURS, 48);
  assert.equal(KLINE_RETENTION_HOURS, 48);
  assert.equal(KLINE_ROLLING_LIMIT, 48 * 60 + 1);

  // In-memory trimming with KLINE_ROLLING_LIMIT
  const baseTime = Math.floor(1000000000 / 60_000) * 60_000;
  const candles: Candle[] = [];
  for (let i = 0; i < 2885; i++) {
    candles.push({ time: baseTime + i * 60_000, open: 100, high: 101, low: 99, close: 100, volume: 1 });
  }
  const tick = { symbol: "BTCUSDT", price: 100, qty: 1, time: baseTime + 2885 * 60_000 };
  const updated = applyTradeToCandles(candles, tick, KLINE_ROLLING_LIMIT);
  assert.equal(updated.length, 2881);
  assert.equal(updated[updated.length - 1].time, baseTime + 2885 * 60_000);
});

test("Docker deployment storage support: pruneExpiredArchives also prunes signals directory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "docker-storage-prune-"));
  try {
    const researchDir = path.join(dir, "research");
    const signalsDir = path.join(dir, "signals");
    await mkdir(path.join(researchDir, "live-1m"), { recursive: true });
    await mkdir(path.join(researchDir, "live-boards"), { recursive: true });
    await mkdir(signalsDir, { recursive: true });

    const now = new Date("2026-11-08T12:00:00Z").getTime();
    const H = 3600_000;

    const t72 = now - 72 * H;
    const day72 = new Date(t72).toISOString().slice(0, 10).replaceAll("-", "");
    const oldSignal = path.join(signalsDir, `${day72}.jsonl`);
    await writeFile(oldSignal, JSON.stringify({ time: t72, symbol: "BTCUSDT", type: "MACD" }) + "\n");

    const t24 = now - 24 * H;
    const day24 = new Date(t24).toISOString().slice(0, 10).replaceAll("-", "");
    const recentSignal = path.join(signalsDir, `${day24}.jsonl`);
    await writeFile(recentSignal, JSON.stringify({ time: t24, symbol: "BTCUSDT", type: "MACD" }) + "\n");

    const pruneRes = await pruneExpiredArchives(researchDir, 48, now, [signalsDir]);

    assert.ok(pruneRes.deletedFiles.includes(oldSignal), "Old signal file must be pruned");
    await assert.rejects(readFile(oldSignal), /ENOENT/);

    const keptContent = await readFile(recentSignal, "utf8");
    assert.ok(keptContent.includes("BTCUSDT"), "Recent signal file must be kept");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("maybePruneArchives executes cleanup only once per UTC day (at UTC 0:00), avoiding disk wear", async () => {
  resetPruneStateForTest();
  const dir = await mkdtemp(path.join(tmpdir(), "utc0-prune-"));
  try {
    await mkdir(path.join(dir, "live-1m"));
    const oldFile = path.join(dir, "live-1m", "BTCUSDT-20261105.jsonl");
    await writeFile(oldFile, "{}\n");

    // First call on Nov 8: executes prune
    const tNov8_10am = new Date("2026-11-08T10:00:00Z").getTime();
    await maybePruneArchives(tNov8_10am, dir);
    await assert.rejects(readFile(oldFile), /ENOENT/);

    // Create another file that would be deleted if prune ran
    const anotherOld = path.join(dir, "live-1m", "BTCUSDT-20261104.jsonl");
    await writeFile(anotherOld, "{}\n");

    // Second call on same UTC day (Nov 8 18:00): should NOT run prune
    const tNov8_6pm = new Date("2026-11-08T18:00:00Z").getTime();
    await maybePruneArchives(tNov8_6pm, dir);
    // File remains because no prune executed within the same UTC day
    const stillThere = await readFile(anotherOld, "utf8");
    assert.equal(stillThere, "{}\n");

    // Crossing into Nov 9 at UTC 00:01: prune executes and cleans the file
    const tNov9_0am = new Date("2026-11-09T00:01:00Z").getTime();
    await maybePruneArchives(tNov9_0am, dir);
    await assert.rejects(readFile(anotherOld), /ENOENT/);
  } finally {
    resetPruneStateForTest();
    await rm(dir, { recursive: true, force: true });
  }
});
