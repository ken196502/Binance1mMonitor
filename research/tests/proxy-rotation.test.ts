import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { rotateProxyNode, currentProxyNode, markProxyNodeBad, badProxyNodeCount, resetProxyNodesForTest } from '../../src/proxyNode.ts';

/**
 * mihomo 健康检查的回归防线。
 *
 * 背景：mihomo 的 health-check 只测连通性/延迟，不校验 HTTP 状态码，所以被
 * Binance 以 451 拒绝的节点依然会被标为 alive 并留在 PROXY 组上（实测 v1.19.32）。
 * 应用必须自己识别「当前节点不通」并换节点，下面用假的 Clash API 验证这段逻辑。
 */

type MockState = {
  current: string;
  nodes: string[];
};

async function withMockMihomo<T>(state: MockState, fn: () => Promise<T>): Promise<T> {
  resetProxyNodesForTest();
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const name = decodeURIComponent((req.url ?? '').split('/').filter(Boolean)[1] ?? '');

    // GET /providers/proxies
    if (req.url === '/providers/proxies') {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          providers: {
            sub1: {
              proxies: state.nodes.map((n) => ({ name: n, alive: true, type: 'vless' })),
            },
          },
        }),
      );
      return;
    }

    // GET /proxies/ACTIVE
    if (req.method === 'GET' && name === 'ACTIVE') {
      res.writeHead(200);
      res.end(JSON.stringify({ now: state.current }));
      return;
    }

    // PUT /proxies/ACTIVE
    if (req.method === 'PUT' && name === 'ACTIVE') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const picked = JSON.parse(body).name as string;
          if (!state.nodes.includes(picked)) {
            res.writeHead(400);
            res.end('{}');
            return;
          }
          state.current = picked;
          res.writeHead(204);
          res.end();
        } catch {
          res.writeHead(400);
          res.end('{}');
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('{}');
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const oldApi = process.env.MIHOMO_API_URL;
  process.env.MIHOMO_API_URL = `http://127.0.0.1:${port}`;
  try {
    return await fn();
  } finally {
    process.env.MIHOMO_API_URL = oldApi;
    await new Promise<void>((r) => server.close(() => r()));
    resetProxyNodesForTest();
  }
}

test('rotation moves off a 451 node onto a different candidate', async () => {
  const state: MockState = { current: 'node-bad-1', nodes: ['node-bad-1', 'node-good-2', 'node-good-3'] };
  await withMockMihomo(state, async () => {
    const picked = await rotateProxyNode();
    assert.ok(picked, 'should have rotated to a candidate');
    assert.notEqual(picked, 'node-bad-1');
    assert.equal(state.current, picked);
  });
});

test('the failing node is blacklisted and never handed out again', async () => {
  const state: MockState = { current: 'node-bad-1', nodes: ['node-bad-1', 'node-bad-2'] };
  await withMockMihomo(state, async () => {
    await rotateProxyNode(); // node-bad-1 fails -> excluded, lands on node-bad-2
    assert.equal(state.current, 'node-bad-2');
    assert.equal(badProxyNodeCount(), 1);

    const picked = await rotateProxyNode(); // now node-bad-2 fails too
    // Both real nodes are bad; PROXY/MANUAL/ACTIVE groups are not valid targets.
    assert.ok(picked === null || !['node-bad-1', 'node-bad-2'].includes(picked));
  });
});

test('group names (PROXY/MANUAL/ACTIVE) are never blacklisted or selected', async () => {
  const state: MockState = { current: 'PROXY', nodes: ['PROXY', 'MANUAL', 'ACTIVE', 'node-real'] };
  await withMockMihomo(state, async () => {
    const picked = await rotateProxyNode();
    assert.equal(picked, 'node-real');
    // PROXY is a group, not a node: blacklisting it would disable the fallback.
    assert.equal(badProxyNodeCount(), 0);
  });
});

test('subscription info placeholders are filtered out of candidates', async () => {
  const state: MockState = {
    current: 'node-current',
    nodes: [
      '说明-来源: AIO 精选',
      '剩余流量：100GB',
      '到期时间：2026-12-31',
      '官网：https://example.com',
      'node-current',
      'node-real',
    ],
  };
  await withMockMihomo(state, async () => {
    const picked = await rotateProxyNode();
    assert.equal(picked, 'node-real');
  });
});

test('rotation reports failure gracefully when mihomo is unreachable', async () => {
  resetProxyNodesForTest();
  const oldApi = process.env.MIHOMO_API_URL;
  // Port 1 is reserved and refuses connections.
  process.env.MIHOMO_API_URL = 'http://127.0.0.1:1';
  try {
    assert.equal(await rotateProxyNode(), null);
    assert.equal(await currentProxyNode(), null);
  } finally {
    process.env.MIHOMO_API_URL = oldApi;
    resetProxyNodesForTest();
  }
});

test('markProxyNodeBad ignores group names', async () => {
  resetProxyNodesForTest();
  markProxyNodeBad('PROXY');
  markProxyNodeBad('MANUAL');
  markProxyNodeBad('DIRECT');
  markProxyNodeBad('node-1');
  assert.equal(badProxyNodeCount(), 1);
  resetProxyNodesForTest();
});