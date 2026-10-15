import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import {
  isUtcMidnightPeak,
  getSymbolJitter,
  canFetchTrend60d,
  recordTrend60dFetch,
  resetTrend60dQuotaForTest,
  getNextUtcMidnight,
  fetch60dTrend,
  getTrend60dCacheForTest,
  resetTrend60dCacheForTest,
  resetBackoffForTest,
} from '../../src/binance.ts';

test('isUtcMidnightPeak correctly identifies the UTC 00:00 boundary window', () => {
  // 2026-10-15 00:00:00 UTC = 1792022400000 ms
  const midnightUtc = Date.UTC(2026, 9, 15, 0, 0, 0, 0);

  // Exactly at UTC 00:00:00
  assert.equal(isUtcMidnightPeak(midnightUtc), true);

  // 30 seconds before midnight (23:59:30 UTC)
  assert.equal(isUtcMidnightPeak(midnightUtc - 30 * 1000), true);

  // 50 seconds before midnight (23:59:10 UTC)
  assert.equal(isUtcMidnightPeak(midnightUtc - 50 * 1000), true);

  // 1 minute after midnight (00:01:00 UTC)
  assert.equal(isUtcMidnightPeak(midnightUtc + 60 * 1000), true);

  // 1 minute 59 seconds after midnight (00:01:59 UTC)
  assert.equal(isUtcMidnightPeak(midnightUtc + 119 * 1000), true);

  // 2 minutes 5 seconds after midnight (00:02:05 UTC) -> safe, peak passed
  assert.equal(isUtcMidnightPeak(midnightUtc + 125 * 1000), false);

  // 5 minutes before midnight (23:55:00 UTC) -> safe
  assert.equal(isUtcMidnightPeak(midnightUtc - 300 * 1000), false);

  // Midday 12:00:00 UTC -> safe
  assert.equal(isUtcMidnightPeak(midnightUtc + 12 * 3600 * 1000), false);
});

test('getSymbolJitter returns deterministic, bounded jitter for symbols', () => {
  const maxJitter = 45 * 60 * 1000;
  const btcJitter = getSymbolJitter('BTCUSDT', maxJitter);
  const ethJitter = getSymbolJitter('ETHUSDT', maxJitter);
  const solJitter = getSymbolJitter('SOLUSDT', maxJitter);

  assert.ok(btcJitter >= 0 && btcJitter < maxJitter);
  assert.ok(ethJitter >= 0 && ethJitter < maxJitter);
  assert.ok(solJitter >= 0 && solJitter < maxJitter);

  // Deterministic: repeated calls return identical values
  assert.equal(getSymbolJitter('BTCUSDT', maxJitter), btcJitter);
  assert.equal(getSymbolJitter('ETHUSDT', maxJitter), ethJitter);

  // Distinct symbols get different jitters
  assert.notEqual(btcJitter, ethJitter);
});

test('canFetchTrend60d enforces per-minute rate quota to smooth requests', () => {
  resetTrend60dQuotaForTest();
  const testTime = 1700000000000;

  // First request in minute allowed
  assert.equal(canFetchTrend60d(testTime), true);
  recordTrend60dFetch();

  // Second request in minute allowed
  assert.equal(canFetchTrend60d(testTime), true);
  recordTrend60dFetch();

  // Third request in same minute rejected by quota
  assert.equal(canFetchTrend60d(testTime), false);

  // Next minute (60s later) quota resets
  assert.equal(canFetchTrend60d(testTime + 60000), true);
});

test('fetch60dTrend avoids REST calls during peak midnight when cached data exists', async () => {
  resetTrend60dCacheForTest();
  resetBackoffForTest();

  let requestCount = 0;
  const server = http.createServer((req, res) => {
    requestCount++;
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify([]));
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const oldBase = process.env.BINANCE_BASE;
  process.env.BINANCE_BASE = `http://127.0.0.1:${port}`;

  try {
    const cacheMap = getTrend60dCacheForTest();
    // Simulate cached trend whose nextUtcMidnight is in the past (expired)
    cacheMap.set('BTCUSDT', {
      trend: 'up',
      nextUtcMidnight: 1000,
    });

    // Mock Date.now to be at UTC 00:00:30 (in peak window)
    const midnightUtc = Date.UTC(2026, 9, 15, 0, 0, 30, 0);
    const realDateNow = Date.now;
    Date.now = () => midnightUtc;

    try {
      const trend = await fetch60dTrend('BTCUSDT');
      // Must return existing cached trend without firing any REST request
      assert.equal(trend, 'up');
      assert.equal(requestCount, 0, 'No HTTP request should be fired during UTC midnight peak');
    } finally {
      Date.now = realDateNow;
    }
  } finally {
    resetTrend60dCacheForTest();
    resetBackoffForTest();
    process.env.BINANCE_BASE = oldBase;
    await new Promise<void>((r) => server.close(() => r()));
  }
});
