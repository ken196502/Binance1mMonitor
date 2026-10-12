import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { computeMacd } from '../../src/macd.ts';
import { FIFTEEN, attachFifteen, buildFifteenFeatures, deaLevel, matchesFifteen, type FifteenFeature, type MiningParameters } from '../fifteen.ts';
import { buildMinuteSignals, matchesMinuteEntry } from '../gainers-backtest.ts';
import { MINUTE, type MinuteSignal, type MinuteDataset } from '../gainers-types.ts';
import { miningGrid, validateMiningGrid } from '../miner-core.ts';
import { DEFAULT_ACCOUNT, backtestAccount } from '../futures-account.ts';
import { loadFifteen, planFifteen, type FifteenManifest } from '../fifteen-data.ts';
import { atomicJson, digest } from '../data.ts';
import type { Bar, Frame } from '../types.ts';

const start = Date.UTC(2026, 0, 5);
function bars(count = 650): Bar[] {
  return Array.from({ length: count }, (_, i) => {
    const price = 100 + Math.sin(i / 9) * 3 + i * 0.01;
    return [start + (i - 300) * FIFTEEN, price, price + 0.1, price, price, 1, 1];
  });
}
const signal = (time = start): MinuteSignal => ({ symbol: 'BTCUSDT', rank: 1, boardTime: start, time, index: 0,
  dif: 1, dea: 0.9, peakDea: 1, deaPeakRatio: 0.9, supportMa: null });

test('DEA levels partition zero, positive and negative values; 1m and 15m use the same semantics', () => {
  assert.equal(deaLevel(0.8, 1), 'high');
  assert.equal(deaLevel(0.799, 1), 'mid');
  assert.equal(deaLevel(0, 0), 'mid');
  assert.equal(deaLevel(-0.1, -0.1), 'low');
  assert.equal(deaLevel(0.7, 1, 0.6), 'high');
  for (const [dea, level] of [[0.9, 'high'], [0.1, 'mid'], [-1, 'low']] as const) {
    for (const direction of ['bull', 'bear'] as const) {
      const s = { ...signal(), dea, dif: dea + (direction === 'bull' ? 0 : -0.1) };
      assert.equal(matchesMinuteEntry(s, 0.8, { minuteDea: level, minuteDif: direction }), true);
      assert.equal(matchesMinuteEntry(s, 0.8, { minuteDea: level, minuteDif: direction === 'bull' ? 'bear' : 'bull' }), false);
      assert.equal(matchesMinuteEntry({ ...s, supportMa: 'ma120' }, 0.8, { minuteDea: 'any', minuteDif: 'any' }), false);
    }
  }
});

test('15m joins use the latest closed quarter-hour and never a forming/future bar', () => {
  const data = bars();
  const signals = [signal(start - MINUTE), signal(), signal(start + 14 * MINUTE), signal(start + FIFTEEN)];
  const original = attachFifteen(signals, new Map([['BTCUSDT', data]]));
  assert.equal(original[0].fifteen, null); // only 299 closed bars
  assert.equal(original[1].fifteen!.closedAt, start);
  assert.deepEqual(original[2].fifteen, original[1].fifteen);
  assert.equal(original[3].fifteen!.closedAt, start + FIFTEEN);
  const changed = structuredClone(data);
  for (const b of changed) if (b[0] >= start) for (let j = 1; j <= 4; j++) b[j] *= 2;
  const after = attachFifteen(signals, new Map([['BTCUSDT', changed]]));
  assert.deepEqual(after.slice(0, 3), original.slice(0, 3));
  assert.notDeepEqual(after[3].fifteen, original[3].fifteen);
  const macd = computeMacd(data.slice(0, 300).map((b) => b[4]));
  assert.ok(Math.abs(original[1].fifteen!.dea - macd.dea.at(-1)!) < 1e-10);
  assert.ok(Math.abs(original[1].fifteen!.dif - macd.dif.at(-1)!) < 1e-10);
});

test('15m missing bars cannot reuse stale snapshots and require 300 contiguous bars to rewarm', () => {
  const data = bars().filter((b) => b[0] !== start);
  const snapshots = buildFifteenFeatures(data);
  assert.ok(snapshots.has(start));
  assert.equal(snapshots.has(start + FIFTEEN), false);
  assert.equal(snapshots.has(start + 300 * FIFTEEN), false);
  assert.ok(snapshots.has(start + 301 * FIFTEEN));
  const joined = attachFifteen([signal(start + FIFTEEN)], new Map([['BTCUSDT', data]]))[0];
  assert.equal(joined.fifteen, null);
  assert.equal(matchesFifteen(joined, { fifteenDea: 'any', fifteenDif: 'any' }), false);
});

test('both cycles require no MA support, even with any DEA/DIFF; mismatched and stale features fail closed', () => {
  for (const level of ['high', 'mid', 'low'] as const) for (const direction of ['bull', 'bear'] as const) {
    const f: FifteenFeature = { closedAt: start, dea: level === 'low' ? -1 : 1, dif: 1, peakDea: 1, deaLevel: level, direction, supportMa: null };
    const s = { ...signal(), fifteen: f };
    const p = { fifteenDea: level, fifteenDif: direction };
    assert.equal(matchesFifteen(s, p), true);
    assert.equal(matchesFifteen({ ...s, fifteen: { ...f, direction: direction === 'bull' ? 'bear' : 'bull' } }, p), false);
    assert.equal(matchesFifteen({ ...s, fifteen: { ...f, supportMa: 'ma5' } }, { fifteenDea: 'any' }), false);
    assert.equal(matchesFifteen({ ...s, fifteen: { ...f, closedAt: start - FIFTEEN } }, p), false);
    assert.equal(matchesFifteen({ ...s, fifteen: null }, p), false);
  }
  const flat = bars(300).map((b): Bar => [b[0], 100, 100, 99, 100, 1, 1]);
  assert.equal(buildFifteenFeatures(flat).get(start)!.supportMa, null); // MA == close
  flat[299] = [flat[299][0], 100, 101, 99, 101, 1, 1];
  assert.ok(buildFifteenFeatures(flat).get(start)!.supportMa);
  flat[299] = [flat[299][0], 101, 101, 101, 101, 1, 1];
  assert.equal(buildFifteenFeatures(flat).get(start)!.supportMa, null);
});

test('expanded 1m signal builder retains low/bear entries excluded by legacy high/bull mode', () => {
  const candles: Bar[] = Array.from({ length: 311 }, (_, i) => [i * MINUTE, 100 - i * 0.01, 100 - i * 0.01, 100 - i * 0.01, 100 - i * 0.01, 1, 1]);
  const data = { candles: new Map([['BTCUSDT', candles]]), manifest: { plan: { start: 300 * MINUTE, end: 310 * MINUTE, warmupMinutes: 300 } } } as MinuteDataset;
  const frames = [{ time: 300 * MINUTE, boards: { gainers: [{ symbol: 'BTCUSDT', rank: 1 }] } }] as Frame[];
  assert.equal(buildMinuteSignals(data, frames, 100, 0.6).length, 0);
  const expanded = buildMinuteSignals(data, frames, 100, 0.6, true);
  assert.equal(expanded.length, 10);
  assert.ok(expanded.every((s) => matchesMinuteEntry(s, 0.8, { minuteDea: 'low', minuteDif: 'bear' })));
});

test('dual-cycle grid covers all 36 state pairs and removes only irrelevant low-DEA thresholds', () => {
  const base = { highRatio: [0.6, 0.8], holdMinutes: [5], stopLossPercent: [0.2], takeProfitPercent: [2] };
  const input = { ...base, minuteDea: ['high', 'mid', 'low'], minuteDif: ['bull', 'bear'], fifteenDea: ['high', 'mid', 'low'], fifteenDif: ['bull', 'bear'] };
  const grid = miningGrid(input, 7, 3, 42);
  assert.equal(grid.length, 60);
  assert.equal(new Set(grid.map((p) => [p.minuteDea, p.minuteDif, p.fifteenDea, p.fifteenDif].join('/'))).size, 36);
  assert.deepEqual(grid, miningGrid(input, 7, 3, 42));
  assert.ok(grid.filter((p) => p.minuteDea === 'low').every((p) => p.highRatio === 0.6));
  assert.equal(miningGrid(base, 7, 3, 42).length, 2); // legacy grid preserved
  assert.throws(() => validateMiningGrid({ ...base, fifteenMa: ['support'] }));
  assert.throws(() => validateMiningGrid({ ...base, minuteDif: ['long'] }));
  assert.throws(() => validateMiningGrid({ ...base, fifteenDea: ['high', 'high'] }));
});

test('account entry applies both timeframe states before reserving margin and records 15m evidence', () => {
  const candles: Bar[] = [[start - MINUTE, 100, 100, 100, 100, 1, 1], [start, 100, 100, 98, 99, 1, 1]];
  const data = { candles: new Map([['BTCUSDT', candles]]) } as MinuteDataset;
  const p: MiningParameters = { highRatio: 0.8, holdMinutes: 1, stopLossPercent: 0.2, takeProfitPercent: 2, minuteDea: 'low', minuteDif: 'bear', fifteenDea: 'mid', fifteenDif: 'bull' };
  const s = { ...signal(), dea: -1, dif: -2, fifteen: { closedAt: start, dea: 0.1, dif: 0.2, peakDea: 1, deaLevel: 'mid', direction: 'bull', supportMa: null } as FifteenFeature };
  const result = backtestAccount(data, [s], p, start, start + MINUTE, DEFAULT_ACCOUNT);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].fifteenClosedAt, start);
  assert.equal(result.trades[0].fifteenSupportMa, null);
  assert.equal(backtestAccount(data, [s], { ...p, minuteDif: 'bull' }, start, start + MINUTE, DEFAULT_ACCOUNT).trades.length, 0);
  assert.equal(backtestAccount(data, [{ ...s, fifteen: { ...s.fifteen, supportMa: 'ma120' } }], p, start, start + MINUTE, DEFAULT_ACCOUNT).trades.length, 0);
});

test('15m cache verifies plan, exact interval, file hash and missing-bar accounting', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fifteen-cache-'));
  try {
    const plan = planFifteen(start, start + FIFTEEN, ['BTCUSDT']);
    const bytes = gzipSync(JSON.stringify(bars(301)));
    const manifest: FifteenManifest = { version: 1, interval: '15m', source: 'fixture', fetchedAt: new Date().toISOString(), plan,
      files: { BTCUSDT: { file: 'BTCUSDT.json.gz', sha256: digest(bytes), bars: 301, missingBars: 0 } } };
    await writeFile(path.join(directory, 'BTCUSDT.json.gz'), bytes);
    await atomicJson(path.join(directory, 'manifest.json'), manifest);
    assert.equal((await loadFifteen(directory, plan)).candles.get('BTCUSDT')!.length, 301);
    await assert.rejects(loadFifteen(directory, { ...plan, end: start + 2 * FIFTEEN }), /计划/);
    manifest.files.BTCUSDT.missingBars = 1;
    await atomicJson(path.join(directory, 'manifest.json'), manifest);
    await assert.rejects(loadFifteen(directory, plan), /清单/);
    await writeFile(path.join(directory, 'BTCUSDT.json.gz'), (await readFile(path.join(directory, 'BTCUSDT.json.gz'))).subarray(0, 10));
    await assert.rejects(loadFifteen(directory, plan), /SHA256/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
