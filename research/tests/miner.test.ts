import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { summarize } from '../backtest.ts';
import { acquireMiningLock } from '../miner.ts';
import { miningGrid, positive, rewardRisk, trainingDiscovery } from '../miner-core.ts';
import { flushNotices, createMiningSender, type MiningNotice } from '../miner-notify.ts';
import type { MinuteTrial } from '../gainers-types.ts';

const grid = { highRatio: [0.8], holdMinutes: [3, 5], stopLossPercent: [0.2, 0.5], takeProfitPercent: [0.6, 1.5, 5] };
test('mining grid enforces net RR as well as nominal RR, deterministic without duplicates', () => {
  const a = miningGrid(grid, 7, 3, 42);
  assert.deepEqual(a, miningGrid(grid, 7, 3, 42));
  assert.equal(new Set(a.map((p) => JSON.stringify(p))).size, a.length);
  assert.ok(a.every((p) => rewardRisk(p, 7).net >= 3 && rewardRisk(p, 7).nominal >= 3));
  assert.ok(!a.some((p) => p.takeProfitPercent === 0.6));
  assert.throws(() => miningGrid({ ...grid, holdMinutes: [120] }, 7, 3, 42), /60/);
  assert.throws(() => miningGrid({ ...grid, takeProfitPercent: [0.6] }, 7, 3, 42), /没有/);
  assert.equal(miningGrid({ ...grid, stopLossPercent: [0.2], takeProfitPercent: [0.6] }, 0, 3, 42).length, 2);
});

test('discoveries require sample count, positive net mean, no missing trades and a new record', () => {
  const metrics = summarize([{ exitTime: 1, netPercent: 2 }, { exitTime: 2, netPercent: -0.6 }]);
  const trial: MinuteTrial = { id: '1', round: 1, parameters: miningGrid(grid, 7, 3, 42)[0], train: metrics, validation: null };
  assert.equal(positive(metrics, 3), false);
  assert.equal(positive({ ...metrics, missing: 1 }, 2), false);
  assert.equal(trainingDiscovery([trial], 2, null), trial);
  assert.equal(trainingDiscovery([trial], 2, metrics.meanNetPercent), null);
  assert.equal(trainingDiscovery([{ ...trial, train: { ...metrics, meanNetPercent: -0.01 } }], 2, null), null);
});

test('durable outbox retries failed messages, respects backoff, and never resends acknowledged ones', async () => {
  const notices: MiningNotice[] = [{ id: 'a', text: '发现', attempts: 0, nextAttemptAt: 0 }];
  let saves = 0, sends = 0;
  const save = async () => { saves++; };
  await flushNotices(notices, async () => { sends++; return { ok: false, error: 'rate limit', retryAfterSeconds: 60 }; }, save, 1000);
  assert.equal(notices[0].nextAttemptAt, 61000);
  const success = async () => { sends++; return { ok: true as const, messageId: 123 }; };
  await flushNotices(notices, success, save, 60000);
  assert.equal(sends, 1);
  // Simulate process restart by serializing the durable state.
  const resumed: MiningNotice[] = JSON.parse(JSON.stringify(notices));
  await flushNotices(resumed, success, save, 61000);
  assert.equal(resumed[0].messageId, 123);
  await flushNotices(resumed, success, save, 1000000);
  assert.equal(sends, 2); assert.equal(saves, 2);
});

test('Telegram checks API JSON acknowledgement, not just HTTP 200; uses plain text payload', async () => {
  const saved = { ...process.env };
  let ok = false;
  const payloads: any[] = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    payloads.push(JSON.parse(text));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(ok ? { ok: true, result: { message_id: 789 } } : { ok: false }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  Object.assign(process.env, { TELEGRAM_API_BASE: `http://127.0.0.1:${port}`, TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: 'test-chat', NO_PROXY: '*', no_proxy: '*' });
  delete process.env.PROXY; delete process.env.BINANCE_PROXY;
  const sender = createMiningSender();
  try {
    assert.equal((await sender.send('训练<发现>')).ok, false);
    ok = true;
    assert.deepEqual(await sender.send('成果'), { ok: true, messageId: 789 });
    assert.equal(payloads[0].text, '训练<发现>');
    assert.equal(payloads[0].parse_mode, undefined);
  } finally {
    await sender.close(); await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('exclusive mining lock rejects a live owner and recovers only a missing PID', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'miner-lock-'));
  try {
    const release = await acquireMiningLock(dir);
    await assert.rejects(acquireMiningLock(dir), /运行中/);
    await release();
    // macOS pid_max is well below this number.
    await writeFile(path.join(dir, 'miner.lock'), '2147483647');
    const nextRelease = await acquireMiningLock(dir); await nextRelease();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a Telegram rate limit holds later notices across separate flush calls', async () => {
  const notices: MiningNotice[] = ['first', 'second'].map((id) => ({ id, text: id, attempts: 0, nextAttemptAt: 0 }));
  let sends = 0;
  const send = async () => { sends++; return { ok: false as const, error: '429', retryAfterSeconds: 30 }; };
  await flushNotices(notices, send, async () => {}, 1000);
  await flushNotices(notices, send, async () => {}, 2000);
  assert.equal(sends, 1);
  assert.equal(notices[1].attempts, 0);
});

test('sharded checkpoints commit batches and notices together, retain validation, detect corruption', async () => {
  const { saveMiningState, hydrateMiningState } = await import('../miner-state.ts');
  const { readFile } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'miner-shards-'));
  try {
    const trial = { id: 'first', round: 1, parameters: {}, train: { trades: 10 }, validation: null } as any;
    const state = { version: 4, next: 1, trials: [trial], notices: [{ id: 'a', sentAt: null }] };
    await saveMiningState(dir, state);
    const checkpoint = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(checkpoint.trials, undefined);
    assert.equal(checkpoint.trialShards.length, 1);
    // A crash before committing a later shard must not pull its rows into a resume.
    await writeFile(path.join(dir, 'trials-1-2.json'), '[{}]');
    const restored = await hydrateMiningState(dir, checkpoint);
    assert.equal(restored.trials.length, 1);
    restored.trials[0].validation = { trades: 4 };
    restored.trials.push({ ...trial, id: 'second' }); restored.next = 2;
    restored.notices[0].sentAt = 'acknowledged';
    await saveMiningState(dir, restored);
    const reloaded = await hydrateMiningState(dir, JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')));
    assert.equal(reloaded.trials.length, 2);
    assert.equal(reloaded.trials[0].validation.trades, 4);
    assert.equal(reloaded.notices[0].sentAt, 'acknowledged');
    await writeFile(path.join(dir, reloaded.trialShards[0].file), '[]');
    await assert.rejects(hydrateMiningState(dir, reloaded), /SHA256/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
