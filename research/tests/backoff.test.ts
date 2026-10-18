import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { getBackoffStatus, resetBackoffForTest, fetch24hTickers } from '../../src/binance.ts';

test('proactive backoff triggers when x-mbx-used-weight-1m exceeds safe threshold', async () => {
  resetBackoffForTest();
  assert.equal(getBackoffStatus().active, false);
  assert.equal(getBackoffStatus().usedWeight1m, 0);

  let currentWeight = 100;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('x-mbx-used-weight-1m', String(currentWeight));
    res.writeHead(200);
    res.end(JSON.stringify([{ symbol: 'BTCUSDT', lastPrice: '50000', priceChangePercent: '1.5', quoteVolume: '1000' }]));
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const oldBase = process.env.BINANCE_BASE;
  process.env.BINANCE_BASE = `http://127.0.0.1:${port}`;

  try {
    // 1. Normal request with weight 100 -> no backoff
    currentWeight = 100;
    const tickers = await fetch24hTickers();
    assert.equal(tickers.length, 1);
    assert.equal(getBackoffStatus().active, false);
    assert.equal(getBackoffStatus().usedWeight1m, 100);

    // 2. High weight (1850 >= default 1800 threshold) -> triggers proactive backoff
    currentWeight = 1850;
    await fetch24hTickers();
    assert.equal(getBackoffStatus().active, true);
    assert.equal(getBackoffStatus().usedWeight1m, 1850);
    assert.match(getBackoffStatus().reason, /主动避让防429/);

    // 3. Next request while backoff is active is proactively blocked
    await assert.rejects(
      async () => {
        await fetch24hTickers();
      },
      /主动避让防429/
    );
  } finally {
    resetBackoffForTest();
    process.env.BINANCE_BASE = oldBase;
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('HTTP 418 and 451 record alert state once and deduplicate subsequent occurrences', async () => {
  const { getStatusAlertedForTest, notifyStatusAnomaly } = await import('../../src/binance.ts');
  resetBackoffForTest();

  const alertedMap = getStatusAlertedForTest();
  assert.equal(alertedMap.has(418), false);
  assert.equal(alertedMap.has(451), false);

  // 1. Test 418 first alert
  await notifyStatusAnomaly(418, 'IP banned until 1700000000');
  assert.equal(alertedMap.get(418), true);

  // 2. Second alert for 418 does nothing extra and remains true
  await notifyStatusAnomaly(418, 'IP banned until 1700000000');
  assert.equal(alertedMap.get(418), true);

  // 3. Test 451 first alert
  await notifyStatusAnomaly(451, 'Service unavailable from restricted jurisdiction');
  assert.equal(alertedMap.get(451), true);

  // 4. Second alert for 451 does not duplicate
  await notifyStatusAnomaly(451, 'Service unavailable from restricted jurisdiction');
  assert.equal(alertedMap.get(451), true);

  resetBackoffForTest();
  assert.equal(alertedMap.has(418), false);
  assert.equal(alertedMap.has(451), false);
});

test('formatBannedUntil correctly formats both 10-digit (seconds) and 13-digit (ms) timestamps without 1970', async () => {
  const { formatBannedUntil } = await import('../../src/binance.ts');

  // 10-digit seconds: 1700000000 -> 2023-11-15 (UTC+8)
  const formatted10 = formatBannedUntil('IP banned until 1700000000');
  assert.doesNotMatch(formatted10, /1970/);
  assert.match(formatted10, /2023/);

  // 13-digit milliseconds: 1700000000000 -> 2023-11-15 (UTC+8)
  const formatted13 = formatBannedUntil('IP banned until 1700000000000');
  assert.doesNotMatch(formatted13, /1970/);
  assert.match(formatted13, /2023/);
});

test('HTTP 418/451 alerted status is cleared when request succeeds (解封)', async () => {
  const { getStatusAlertedForTest, setBackoffUntilForTest, fetch24hTickers } = await import('../../src/binance.ts');
  resetBackoffForTest();

  let statusCode = 418;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (statusCode === 418) {
      res.writeHead(418);
      res.end(JSON.stringify({ code: -1003, msg: 'IP banned until 1700000000' }));
    } else {
      res.writeHead(200);
      res.end(JSON.stringify([{ symbol: 'BTCUSDT', lastPrice: '50000', priceChangePercent: '1.5', quoteVolume: '1000' }]));
    }
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const oldBase = process.env.BINANCE_BASE;
  process.env.BINANCE_BASE = `http://127.0.0.1:${port}`;

  try {
    // 1. First request triggers HTTP 418, setting alerted state
    await assert.rejects(async () => {
      await fetch24hTickers();
    }, /418/);
    const alertedMap = getStatusAlertedForTest();
    assert.equal(alertedMap.get(418), true);

    // 2. Simulate backoff cooling period expiring, and Binance API unbanning (returns 200 OK)
    setBackoffUntilForTest(0);
    statusCode = 200;

    const tickers = await fetch24hTickers();
    assert.equal(tickers.length, 1);

    // 3. alerted state should now be cleared
    assert.equal(alertedMap.size, 0);
    assert.equal(alertedMap.has(418), false);
  } finally {
    resetBackoffForTest();
    process.env.BINANCE_BASE = oldBase;
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('HTTP 418 严格遵从币安指定的 banned until 时间戳，不被 300s 提前截断导致提前请求死循环', async () => {
  const { fetch24hTickers, getBackoffStatus } = await import('../../src/binance.ts');
  resetBackoffForTest();

  // 模拟币安返回 15 分钟后的封禁时间戳 (900 秒)
  const futureBanTs = Date.now() + 900 * 1000;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(418);
    res.end(JSON.stringify({ code: -1003, msg: `Way too many requests; IP banned until ${futureBanTs}` }));
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const oldBase = process.env.BINANCE_BASE;
  process.env.BINANCE_BASE = `http://127.0.0.1:${port}`;

  try {
    await assert.rejects(async () => {
      await fetch24hTickers();
    }, /418/);

    const backoff = getBackoffStatus();
    assert.equal(backoff.active, true);
    assert.equal(backoff.is418, true);

    // 验证：避让时间必须 >= 900 秒，绝对不能被 Math.min(..., 300) 截断为 300 秒！
    const remainingSec = Math.ceil((backoff.backoffUntil - Date.now()) / 1000);
    assert.ok(remainingSec >= 890, `避让时间必须严格覆盖币安封禁时间戳(约900s)，实际剩余: ${remainingSec}s`);
  } finally {
    resetBackoffForTest();
    process.env.BINANCE_BASE = oldBase;
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('HTTP 418 发生时，buildBoards 立即跳过剩余 REST 请求并不阻塞，秒级完成并降级填充', async () => {
  const { buildBoards, resetCandleCacheForTest, wsManager } = await import('../../src/server.ts');
  const { setCachedCryptoSymbolsForTest } = await import('../../src/binance.ts');
  resetBackoffForTest();
  resetCandleCacheForTest();
  setCachedCryptoSymbolsForTest(new Set(['BTCUSDT', 'G1USDT', 'G2USDT', 'L1USDT']));

  const banTs = Date.now() + 600 * 1000;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(418);
    res.end(JSON.stringify({ code: -1003, msg: `IP banned until ${banTs}` }));
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const oldBase = process.env.BINANCE_BASE;
  process.env.BINANCE_BASE = `http://127.0.0.1:${port}`;

  const startTime = Date.now();
  try {
    const pinned = [{ symbol: 'BTCUSDT', lastPrice: 60000, priceChangePercent: 2, quoteVolume: 10000 }];
    const tops = {
      gainers: [
        { symbol: 'G1USDT', lastPrice: 10, priceChangePercent: 15, quoteVolume: 2000 },
        { symbol: 'G2USDT', lastPrice: 20, priceChangePercent: 12, quoteVolume: 1500 },
      ],
      losers: [],
    };

    const boards = await buildBoards(tops, pinned);
    const duration = Date.now() - startTime;

    // 验证：绝对不能像以前那样每个标的等待 120 秒导致 40+ 分钟死锁，必须秒级立即返回（< 2000ms）
    assert.ok(duration < 2000, `418 发生时 buildBoards 必须立即返回，实际耗时: ${duration}ms`);
    assert.equal(boards.pinned.length, 1);
    assert.equal(boards.gainers.length, 2);
    assert.equal(boards.gainers[0].state, 'n/a');
  } finally {
    resetBackoffForTest();
    resetCandleCacheForTest();
    wsManager.close();
    process.env.BINANCE_BASE = oldBase;
    await new Promise<void>((r) => server.close(() => r()));
  }
});

