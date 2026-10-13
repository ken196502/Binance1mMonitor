import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { computeMacd } from '../../src/macd.ts';
import { BTC_FIVE, attachBtcFive, matchesBtcFive, type BtcFiveFeature } from '../btc-five.ts';
import { fetchBtcFive, loadBtcFive, planBtcFive } from '../btc-five-data.ts';
import { buildClosedFeatures, type MiningParameters } from '../fifteen.ts';
import { miningSearch, validateMiningGrid } from '../miner-core.ts';
import { DEFAULT_ACCOUNT, backtestAccount } from '../futures-account.ts';
import { MINUTE, type MinuteDataset, type MinuteSignal } from '../gainers-types.ts';
import { atomicJson } from '../data.ts';
import type { Bar } from '../types.ts';

const start = Date.UTC(2026, 0, 5);
const signal = (time = start, symbol = 'ALTUSDT'): MinuteSignal => ({ symbol, time, index: 0, rank: 1, boardTime: start,
  dea: 0.9, dif: 1, peakDea: 1, deaPeakRatio: 0.9, supportMa: null, streak: { direction: 'up', count: 3 } });
function bars(count = 650): Bar[] {
  return Array.from({ length: count }, (_, i) => {
    const price = 100 + Math.sin(i / 9) * 3 + i * 0.01;
    return [start + (i - 300) * BTC_FIVE, price, price, price, price, 1, 1];
  });
}
const base = { highRatio: [0.6, 0.8], holdMinutes: [1], stopLossPercent: [0.2], takeProfitPercent: [2] };

test('all ranked symbols use BTC 5m, with exact closed-bar alignment and no future leakage', () => {
  const btc = bars();
  const signals = [signal(start - MINUTE), signal(), signal(start, 'OTHERUSDT'), signal(start + 4 * MINUTE), signal(start + BTC_FIVE)];
  const candles = new Map([['BTCUSDT', btc], ['ALTUSDT', bars().map((b): Bar => [b[0], 5, 5, 5, 5, 1, 1])]]);
  const joined = attachBtcFive(signals, candles);
  assert.equal(joined[0].btcFive, null);
  assert.equal(joined[1].btcFive!.symbol, 'BTCUSDT');
  assert.equal(joined[1].btcFive!.closedAt, start);
  assert.deepEqual(joined[1].btcFive, joined[2].btcFive);
  assert.deepEqual(joined[1].btcFive, joined[3].btcFive);
  assert.equal(joined[4].btcFive!.closedAt, start + BTC_FIVE);
  const macd = computeMacd(btc.slice(0, 300).map((b) => b[4]));
  assert.ok(Math.abs(joined[1].btcFive!.dea - macd.dea.at(-1)!) < 1e-10);
  assert.ok(Math.abs(joined[1].btcFive!.dif - macd.dif.at(-1)!) < 1e-10);
  const future = structuredClone(btc);
  for (const b of future) if (b[0] >= start) for (let i = 1; i <= 4; i++) b[i] *= 2;
  const changed = attachBtcFive(signals, new Map([['BTCUSDT', future]]));
  assert.deepEqual(changed.slice(0, 4), joined.slice(0, 4));
  assert.notDeepEqual(changed[4].btcFive, joined[4].btcFive);
  assert.equal(attachBtcFive([signal()], new Map([['ALTUSDT', btc]]))[0].btcFive, null);
});

test('BTC gaps reject stale state and require a full 300-bar warmup again', () => {
  const btc = bars().filter((b) => b[0] !== start);
  const features = buildClosedFeatures(btc, BTC_FIVE);
  assert.ok(features.has(start));
  assert.equal(features.has(start + BTC_FIVE), false);
  assert.equal(features.has(start + 300 * BTC_FIVE), false);
  assert.ok(features.has(start + 301 * BTC_FIVE));
  const joined = attachBtcFive([signal(start + BTC_FIVE)], new Map([['BTCUSDT', btc]]))[0];
  assert.equal(matchesBtcFive(joined, { btcFiveDea: 'any', btcFiveDif: 'any' }), false);
});

test('BTC grid independently crosses all states, ratios and signed streaks with reproducible sampling', () => {
  const input = { ...base, minuteDea: ['high', 'mid', 'low'], minuteDif: ['bull', 'bear'],
    btcFiveDea: ['high', 'mid', 'low'], btcFiveDif: ['bull', 'bear'], btcFiveHighRatio: [0.65, 0.9],
    minuteStreak: [0, 3, -5], btcFiveStreak: [0, 2, -4] };
  const full = miningSearch(input, 7, 3, 42);
  assert.equal(full.plan.possible, 900);
  assert.ok(full.plan.exhaustive);
  assert.equal(new Set(full.candidates.map((p) => [p.minuteDea, p.minuteDif, p.btcFiveDea, p.btcFiveDif].join('/'))).size, 36);
  assert.ok(full.candidates.every((p) => p.fifteenDea === undefined && p.fifteenStreak === undefined));
  assert.ok(full.candidates.some((p) => p.highRatio === 0.8 && p.btcFiveHighRatio === 0.65 && p.minuteStreak === 3 && p.btcFiveStreak === -4));
  assert.ok(full.candidates.filter((p) => p.btcFiveDea === 'low').every((p) => p.btcFiveHighRatio === 0.65));
  assert.ok(full.candidates.filter((p) => p.minuteDea === 'low').every((p) => p.highRatio === 0.6));
  const sampled = miningSearch(input, 7, 3, 42, 400);
  assert.deepEqual(sampled, miningSearch(input, 7, 3, 42, 400));
  assert.equal(sampled.plan.strata, 324);
  assert.equal(new Set(sampled.candidates.map((p) => JSON.stringify(p))).size, 400);
  assert.equal(new Set(sampled.candidates.map((p) => [p.minuteDea, p.minuteDif, p.btcFiveDea, p.btcFiveDif, p.minuteStreak, p.btcFiveStreak].join('/'))).size, 324);
  assert.throws(() => miningSearch(input, 7, 3, 42, 323), /至少/);
  for (const extra of [{ btcFiveHighRatio: [0] }, { btcFiveStreak: [1.5] }, { btcFiveDif: ['long'] }, { btcFiveDea: ['high', 'high'] }]) {
    assert.throws(() => validateMiningGrid({ ...base, ...extra }));
  }
  assert.throws(() => validateMiningGrid({ ...input, fifteenDea: ['any'] }), /独立研究/);
  assert.deepEqual(validateMiningGrid({ ...base, btcFiveStreak: [0] }).btcFiveDea, ['any']);
});

test('account applies BTC state before margin reservation, while trading the ranked symbol and recording BTC evidence', () => {
  const f: BtcFiveFeature = { symbol: 'BTCUSDT', closedAt: start, dea: 0.7, dif: 0.9, peakDea: 1,
    deaLevel: 'mid', direction: 'bull', supportMa: null, streak: { direction: 'down', count: 4 } };
  const s = { ...signal(), btcFive: f };
  const p: MiningParameters = { highRatio: 0.8, holdMinutes: 1, stopLossPercent: 0.2, takeProfitPercent: 2,
    minuteDea: 'high', minuteDif: 'bull', minuteStreak: 3, btcFiveDea: 'mid', btcFiveDif: 'bull', btcFiveHighRatio: 0.9, btcFiveStreak: -4 };
  const data = { candles: new Map([['ALTUSDT', [[start - MINUTE, 100, 100, 100, 100, 1, 1], [start, 100, 100, 98, 99, 1, 1]]]]) } as MinuteDataset;
  const result = backtestAccount(data, [s], p, start, start + MINUTE, DEFAULT_ACCOUNT);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].symbol, 'ALTUSDT');
  assert.equal(result.trades[0].btcFiveSymbol, 'BTCUSDT');
  assert.equal(result.trades[0].btcFiveClosedAt, start);
  assert.equal(result.trades[0].btcFiveDeaLevel, 'mid');
  assert.equal(result.trades[0].btcFiveStreakCount, 4);
  assert.equal(result.trades[0].fifteenClosedAt, undefined);
  for (const change of [{ btcFiveHighRatio: 0.65 }, { btcFiveDif: 'bear' as const }, { btcFiveStreak: 3 }, { minuteStreak: -3 }]) {
    assert.equal(backtestAccount(data, [s], { ...p, ...change }, start, start + MINUTE, DEFAULT_ACCOUNT).trades.length, 0);
  }
  for (const changed of [{ ...s, supportMa: 'ma120' }, { ...s, btcFive: null },
    { ...s, btcFive: { ...f, supportMa: 'ma5' } }, { ...s, btcFive: { ...f, closedAt: start - BTC_FIVE } },
    { ...s, btcFive: { ...f, closedAt: start + BTC_FIVE } }]) {
    const rejected = backtestAccount(data, [changed], { ...p, btcFiveDea: 'any', btcFiveDif: 'any' }, start, start + MINUTE, DEFAULT_ACCOUNT);
    assert.equal(rejected.trades.length, 0);
    assert.equal(rejected.metrics.maxLockedMarginUSDT, 0);
  }
});

test('BTC native 5m download paginates only BTC and verifies interval, plan, hash and missing bars offline', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'btc-five-cache-'));
  const plan = planBtcFive(start, start + 350 * BTC_FIVE);
  assert.equal(plan.fetchStart, start - 300 * BTC_FIVE);
  assert.deepEqual(plan.symbols, ['BTCUSDT']);
  const requests: URL[] = [];
  const fake = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost'); requests.push(url);
    const from = Number(url.searchParams.get('startTime')), to = Number(url.searchParams.get('endTime'));
    const selected = bars().filter((b) => b[0] >= from && b[0] <= to).slice(0, Number(url.searchParams.get('limit')));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(selected.map((b) => [...b.slice(0, 6), b[0] + BTC_FIVE - 1, b[6]])));
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const env = { BINANCE_BASE: `http://127.0.0.1:${(fake.address() as { port: number }).port}`, PROXY: '', BINANCE_PROXY: '', NO_PROXY: '*', no_proxy: '*' };
  const previous = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    await fetchBtcFive(directory, plan, () => {});
    assert.equal(requests.length, 2);
    assert.ok(requests.every((u) => u.searchParams.get('symbol') === 'BTCUSDT' && u.searchParams.get('interval') === '5m'));
    const loaded = await loadBtcFive(directory, plan);
    assert.equal(loaded.candles.get('BTCUSDT')!.length, 650);
    await fetchBtcFive(directory, plan, () => {});
    assert.equal(requests.length, 2);
    await assert.rejects(loadBtcFive(directory, { ...plan, symbols: ['ALTUSDT'] }), /BTCUSDT/);
    await assert.rejects(loadBtcFive(directory, { ...plan, end: plan.end + BTC_FIVE }), /计划/);
    const file = path.join(directory, 'manifest.json');
    await atomicJson(file, { ...loaded.manifest, interval: '15m' });
    await assert.rejects(loadBtcFive(directory, plan), /计划/);
    loaded.manifest.files.BTCUSDT.missingBars = 1;
    await atomicJson(file, loaded.manifest);
    await assert.rejects(loadBtcFive(directory, plan), /清单/);
    loaded.manifest.files.BTCUSDT.missingBars = 0;
    await atomicJson(file, loaded.manifest);
    const candleFile = path.join(directory, 'BTCUSDT.json.gz');
    await writeFile(candleFile, (await readFile(candleFile)).subarray(0, 10));
    await assert.rejects(loadBtcFive(directory, plan), /SHA256/);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await new Promise<void>((resolve) => fake.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
