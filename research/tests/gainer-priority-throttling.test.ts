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

test('涨幅榜优先与跌幅榜同步：涨幅榜先完成冷启动；权重充裕时跌幅榜正常同步完整K线', async () => {
  resetBackoffForTest();
  resetCandleCacheForTest();
  setCachedCryptoSymbolsForTest(new Set(['BTCUSDT', 'G1USDT', 'L1USDT', 'L2USDT', 'L3USDT']));

  const klinesRequested: { symbol: string; limit: string | null }[] = [];

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const symbol = url.searchParams.get('symbol') ?? '';

    if (url.pathname === '/fapi/v1/klines') {
      const limit = url.searchParams.get('limit');
      klinesRequested.push({ symbol, limit });
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
        { symbol: 'L2USDT', lastPrice: 3, priceChangePercent: -12, quoteVolume: 700 },
        { symbol: 'L3USDT', lastPrice: 4, priceChangePercent: -15, quoteVolume: 600 },
      ],
    };

    const boards = await buildBoards(tops, pinned);

    // 验证涨幅榜和置顶标的获得了完整同步（冷启动拉取 1500 根）
    const btcIdx = klinesRequested.findIndex((k) => k.symbol === 'BTCUSDT');
    const g1Idx = klinesRequested.findIndex((k) => k.symbol === 'G1USDT');
    assert.ok(btcIdx !== -1, 'BTCUSDT 必须成功发起 K 线请求');
    assert.equal(klinesRequested[btcIdx].limit, '1500', '涨幅榜置顶标的冷启动拉取 1500 根');
    assert.ok(g1Idx !== -1, 'G1USDT 必须成功发起 K 线请求');
    assert.equal(klinesRequested[g1Idx].limit, '1500', '涨幅榜标的冷启动拉取 1500 根');

    // 验证跌幅榜在涨幅榜完成后正常发起冷启动拉取，且时序上在涨幅榜之后
    const l1Idx = klinesRequested.findIndex((k) => k.symbol === 'L1USDT');
    assert.ok(l1Idx !== -1, '权重充裕时跌幅榜正常发起 K 线拉取');
    assert.ok(g1Idx < l1Idx, '时序上绝对优先涨幅榜：涨幅榜先拉完，跌幅榜随后拉取');
    assert.equal(klinesRequested[l1Idx].limit, '1500', '跌幅榜拉取完整 1500 根以支持 5m DIFF 指标计算');

    // 验证所有标的最后全部加入 WebSocket 实时订阅池
    const subs = wsManager.getSubscribedSymbols();
    assert.ok(subs.includes('BTCUSDT'));
    assert.ok(subs.includes('G1USDT'));
    assert.ok(subs.includes('L1USDT'));
    assert.ok(subs.includes('L2USDT'));
    assert.ok(subs.includes('L3USDT'));

    // 验证返回的 boards 数据结构完整
    assert.equal(boards.pinned.length, 1);
    assert.equal(boards.gainers.length, 1);
    assert.equal(boards.losers.length, 3);
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

test('跌幅榜受限降级：当已用权重达到阈值(>=1400)时，跌幅榜跳过 REST 请求并安全降级', async () => {
  resetBackoffForTest();
  resetCandleCacheForTest();
  setCachedCryptoSymbolsForTest(new Set(['BTCUSDT', 'G1USDT', 'L1USDT']));

  const klinesRequested: string[] = [];

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    // 模拟 Binance 返回已用权重 1500（超过安全阈值 1400）
    res.setHeader('x-mbx-used-weight-1m', '1500');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const symbol = url.searchParams.get('symbol') ?? '';

    if (url.pathname === '/fapi/v1/klines') {
      klinesRequested.push(symbol);
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

    const boards = await buildBoards(tops, pinned);

    // 涨幅榜标的与置顶标的必须同步
    assert.ok(klinesRequested.includes('BTCUSDT'));
    assert.ok(klinesRequested.includes('G1USDT'));

    // 跌幅榜因权重达到 1500 (>=1400 阈值) 应跳过 REST K 线请求
    assert.ok(!klinesRequested.includes('L1USDT'), '权重超标时跌幅榜必须跳过 REST K 线请求');

    // 跌幅榜通过降级对象正常返回，不崩掉
    assert.equal(boards.losers.length, 1);
    assert.equal(boards.losers[0].symbol, 'L1USDT');
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
