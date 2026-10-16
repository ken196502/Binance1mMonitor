import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { resetBackoffForTest, setCachedCryptoSymbolsForTest } from '../../src/binance.ts';
import { wsManager } from '../../src/ws.ts';
import { buildBoards, resetCandleCacheForTest } from '../../src/server.ts';
import type { Ticker24h, TickerTops } from '../../src/binance.ts';

function dummyCandles(count = 50) {
  const now = Date.now();
  const res: any[] = [];
  for (let i = 0; i < count; i++) {
    const t = now - (count - i) * 60000;
    res.push([t, '100', '105', '95', '102', '1000', t + 59999]);
  }
  return res;
}

test('确保涨幅榜先同步；遇到429立即停止并开启已同步标的订阅；解除429后同步跌幅榜并重新订阅全部', async () => {
  resetBackoffForTest();
  resetCandleCacheForTest();
  setCachedCryptoSymbolsForTest(new Set(['BTCUSDT', 'G1USDT', 'L1USDT']));

  let g1Count = 0;

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const symbol = url.searchParams.get('symbol') ?? '';

    if (url.pathname === '/fapi/v1/klines') {
      // 模拟 G1USDT 首次请求触发 429
      if (symbol === 'G1USDT' && g1Count === 0) {
        g1Count++;
        res.setHeader('retry-after', '1'); // 1秒冷静期
        res.writeHead(429);
        res.end(JSON.stringify({ code: -1003, msg: 'Too many requests' }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify(dummyCandles(50)));
      return;
    }

    res.writeHead(200);
    res.end(JSON.stringify([]));
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const oldBase = process.env.BINANCE_BASE;
  process.env.BINANCE_BASE = `http://127.0.0.1:${port}`;

  try {
    const pinned: Ticker24h[] = [
      { symbol: 'BTCUSDT', lastPrice: 60000, priceChangePercent: 2, quoteVolume: 10000 },
    ];
    const tops: TickerTops = {
      gainers: [
        { symbol: 'G1USDT', lastPrice: 10, priceChangePercent: 15, quoteVolume: 2000 },
      ],
      losers: [
        { symbol: 'L1USDT', lastPrice: 2, priceChangePercent: -10, quoteVolume: 800 },
      ],
    };

    const boardPromise = buildBoards(tops, pinned);

    // 等待 BTC 成功，G1 触发 429 并暂停
    await new Promise((r) => setTimeout(r, 350));

    // 验证：检测到 429 停止时，立即开启订阅已完成的 BTCUSDT
    const subscribedMid = wsManager.getSubscribedSymbols();
    assert.ok(subscribedMid.includes('BTCUSDT'), '应当已订阅 BTCUSDT');
    assert.ok(!subscribedMid.includes('G1USDT'), '429 失败的 G1USDT 尚未同步完成，不应在初次订阅中');
    assert.ok(!subscribedMid.includes('L1USDT'), '429 期间不应提前订阅跌幅榜 L1USDT');

    // 等待整个 buildBoards 完成（经历 1 秒冷静期后补齐 G1，并同步 L1，然后重新订阅全部）
    const boards = await boardPromise;

    // 验证最终数据结构
    assert.equal(boards.pinned.length, 1);
    assert.equal(boards.gainers.length, 1);
    assert.equal(boards.losers.length, 1);

    // 验证最终已重新订阅全部标的
    const subscribedFinal = wsManager.getSubscribedSymbols();
    assert.ok(subscribedFinal.includes('BTCUSDT'), '最终应当包含 BTCUSDT');
    assert.ok(subscribedFinal.includes('G1USDT'), '最终应当包含 G1USDT');
    assert.ok(subscribedFinal.includes('L1USDT'), '最终应当包含 L1USDT');
  } finally {
    resetBackoffForTest();
    resetCandleCacheForTest();
    wsManager.close();
    if (oldBase === undefined) {
      delete process.env.BINANCE_BASE;
    } else {
      process.env.BINANCE_BASE = oldBase;
    }
    server.closeAllConnections?.();
    server.closeIdleConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
