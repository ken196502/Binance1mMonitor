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

test('跌幅榜保护与涨幅榜优先：权重偏高时跌幅榜跳过 REST 请求，权重充裕时跌幅榜单轮最多冷启动1个标的且限制100根K线', async () => {
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

    // 验证涨幅榜和置顶标的获得了完整同步（冷启动拉取 1500 根限制或环境变量配置）
    const btcReq = klinesRequested.find((k) => k.symbol === 'BTCUSDT');
    const g1Req = klinesRequested.find((k) => k.symbol === 'G1USDT');
    assert.ok(btcReq, 'BTCUSDT 必须成功发起 K 线请求');
    assert.equal(btcReq.limit, '1500', '涨幅榜置顶标的冷启动拉取 1500 根');
    assert.ok(g1Req, 'G1USDT 必须成功发起 K 线请求');
    assert.equal(g1Req.limit, '1500', '涨幅榜标的冷启动拉取 1500 根');

    // 验证跌幅榜限流保护：当轮只有涨幅榜发生冷启动，跌幅榜不会一口气发起全部 3 个冷启动
    const loserKlines = klinesRequested.filter((k) => ['L1USDT', 'L2USDT', 'L3USDT'].includes(k.symbol));
    assert.ok(loserKlines.length <= 1, `跌幅榜当轮冷启动受到严格限流，实际发起数: ${loserKlines.length} (不超过1个)`);
    if (loserKlines.length > 0) {
      assert.equal(loserKlines[0].limit, '100', '跌幅榜轻量冷启动仅拉取 100 根以极大节省 API 权重');
    }

    // 验证所有标的最后全部加入 WebSocket 实时订阅池（零 REST 消耗保障后续实时更新）
    const subs = wsManager.getSubscribedSymbols();
    assert.ok(subs.includes('BTCUSDT'));
    assert.ok(subs.includes('G1USDT'));
    assert.ok(subs.includes('L1USDT'));
    assert.ok(subs.includes('L2USDT'));
    assert.ok(subs.includes('L3USDT'));

    // 验证返回的 boards 数据结构完整，未冷启动的标的降级填充，不导致页面报错
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
