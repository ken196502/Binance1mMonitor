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

