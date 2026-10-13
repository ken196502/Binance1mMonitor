import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GpuWorker, writeGpuWindows } from '../gpu.ts';
import { backtestMinutes } from '../gainers-backtest.ts';
import { MINUTE, type MinuteDataset, type MinuteSignal } from '../gainers-types.ts';
import type { Bar } from '../types.ts';
import { miningGrid } from '../miner-core.ts';

const python = path.resolve(process.env.GPU_PYTHON ?? '.venv-gpu/bin/python');
const device = process.env.GPU_TEST_DEVICE ?? 'mps';
const skip = !existsSync(python) && !process.env.GPU_REQUIRED;
const start = Date.UTC(2026, 0, 1), end = start + 120 * MINUTE;

function fixture() {
  let rng = 42;
  const random = () => { rng = (Math.imul(1664525, rng) + 1013904223) >>> 0; return rng / 4294967296; };
  const candles = new Map<string, Bar[]>();
  const signals: MinuteSignal[] = [];
  for (let symbolIndex = 0; symbolIndex < 4; symbolIndex++) {
    const symbol = `FIX${symbolIndex}USDT`;
    const bars: Bar[] = [];
    let price = symbolIndex === 3 ? 0.000004 : 100;
    for (let i = -1; i < 130; i++) {
      if (symbolIndex === 2 && i === 44) continue;
      const opening = price * (1 + (random() - 0.5) * 0.03);
      const close = opening * (1 + (random() - 0.5) * 0.005);
      const high = Math.max(opening, close) * (1 + random() * 0.009);
      const low = Math.min(opening, close) * (1 - random() * 0.04);
      bars.push([start + i * MINUTE, opening, high, low, close, 1, 1]);
      price = close;
    }
    if (symbolIndex === 0) {
      // Exact and near float32 thresholds; both touched, then a gap above stop.
      bars[1] = [start, 100, 100.2, 97, 100, 1, 1];
      bars[2] = [start + MINUTE, 100, 100.2 - 1e-8, 99.99, 100, 1, 1];
      bars[3] = [start + 2 * MINUTE, 102, 103, 90, 102, 1, 1];
    }
    candles.set(symbol, bars);
    bars.forEach((bar, index) => {
      const time = bar[0] + MINUTE;
      if (time >= start && time < end) signals.push({ symbol, rank: 1, time, index, boardTime: start, dif: 1, dea: 0.9, peakDea: 1, deaPeakRatio: 0.9, supportMa: null });
    });
  }
  signals.sort((a, b) => a.time - b.time || a.symbol.localeCompare(b.symbol));
  return { data: { candles } as MinuteDataset, signals };
}

test('real GPU first-touch results match scalar trades: gaps, ambiguity, costs, occupancy, precision, purge', { skip }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gainers-gpu-'));
  const worker = new GpuWorker(python);
  try {
    const { data, signals } = fixture();
    const parameters = miningGrid({ highRatio: [0.8, 0.95], holdMinutes: [3, 5, 15], stopLossPercent: [0.15, 0.2, 0.5], takeProfitPercent: [1.5, 3, 5] }, 7, 3, 42);
    const file = path.join(dir, 'windows.f32');
    await writeGpuWindows(file, data, signals, 15, end);
    const info = await worker.init(file, signals.length, 15, device);
    assert.equal(info.device, device);
    assert.equal(info.probe, 10416);
    let fallbacks = 0;
    for (let at = 0; at < parameters.length; at += 17) {
      const batch = parameters.slice(at, at + 17);
      const { offsets } = await worker.evaluate(batch, 37);
      for (const [i, p] of batch.entries()) {
        fallbacks += offsets[i].filter((x) => x === -1).length;
        assert.deepEqual(backtestMinutes(data, signals, p, start, end, 7, offsets[i]), backtestMinutes(data, signals, p, start, end, 7), JSON.stringify(p));
      }
    }
    assert.ok(fallbacks > 0, 'near-threshold paths must take exact replay');
    assert.throws(() => backtestMinutes(data, signals, parameters[0], start, end, 7, []));
    // No validation/holdout prices enter the training binary, even near boundary.
    const original = await readFile(file);
    for (const bars of data.candles.values()) for (const c of bars) if (c[0] >= end) for (let j = 1; j <= 4; j++) c[j] *= 100;
    await writeGpuWindows(file, data, signals, 15, end);
    assert.deepEqual(await readFile(file), original);
  } finally { worker.close(); await rm(dir, { recursive: true, force: true }); }
});

test('GPU handles empty training signals without fabricating results', { skip }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gainers-gpu-empty-'));
  const worker = new GpuWorker(python);
  try {
    const file = path.join(dir, 'empty.f32');
    await writeGpuWindows(file, { candles: new Map() } as MinuteDataset, [], 5, end);
    await worker.init(file, 0, 5, device);
    assert.deepEqual((await worker.evaluate([{ highRatio: 0.8, holdMinutes: 5, stopLossPercent: 0.2, takeProfitPercent: 2 }], 16)).offsets, [[]]);
  } finally { worker.close(); await rm(dir, { recursive: true, force: true }); }
});

test('MPS and scalar isolated accounts agree with liquidation thresholds, funding limits and equity paths', { skip }, async () => {
  const { DEFAULT_ACCOUNT, accountGpuParameters, backtestAccount } = await import('../futures-account.ts');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gainers-account-gpu-'));
  const worker = new GpuWorker(python);
  try {
    const { data, signals } = fixture();
    const file = path.join(dir, 'windows.f32');
    await writeGpuWindows(file, data, signals, 15, end);
    assert.equal((await worker.init(file, signals.length, 15, device)).device, device);
    const parameters = miningGrid({ highRatio: [0.8], holdMinutes: [3, 15], stopLossPercent: [0.2, 0.5], takeProfitPercent: [1.5, 5] }, 7, 3, 42);
    for (const leverage of [10, 125]) {
      const account = { ...DEFAULT_ACCOUNT, leverage, initialBalanceUSDT: 250, maxPositions: 2 };
      const { offsets } = await worker.evaluate(parameters.map((p) => accountGpuParameters(p, account)), 37);
      for (const [i, p] of parameters.entries()) {
        assert.deepEqual(backtestAccount(data, signals, p, start, end, account, offsets[i]), backtestAccount(data, signals, p, start, end, account));
      }
    }
  } finally { worker.close(); await rm(dir, { recursive: true, force: true }); }
});

test('MPS exit cache preserves all 36 dual-timeframe state filters and exact account results', { skip }, async () => {
  const { DEFAULT_ACCOUNT, accountGpuParameters, backtestAccount } = await import('../futures-account.ts');
  const { FIFTEEN } = await import('../fifteen.ts');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dual-timeframe-gpu-'));
  const worker = new GpuWorker(python);
  try {
    const { data, signals } = fixture();
    signals.forEach((s, i) => {
      const dea = [0.9, 0.1, -1][i % 3];
      s.dea = dea; s.dif = dea + (Math.floor(i / 3) % 2 ? -0.1 : 0);
      s.fifteen = { closedAt: Math.floor(s.time / FIFTEEN) * FIFTEEN,
        dea: [0.9, 0.1, -1][Math.floor(i / 6) % 3], dif: 1, peakDea: 1,
        deaLevel: (['high', 'mid', 'low'] as const)[Math.floor(i / 6) % 3],
        direction: Math.floor(i / 18) % 2 ? 'bear' : 'bull', supportMa: i % 7 ? null : 'ma120' };
    });
    const parameters = miningGrid({ highRatio: [0.8], holdMinutes: [3], stopLossPercent: [0.2], takeProfitPercent: [2],
      minuteDea: ['high', 'mid', 'low'], minuteDif: ['bull', 'bear'], fifteenDea: ['high', 'mid', 'low'], fifteenDif: ['bull', 'bear'] }, 7, 3, 42);
    const file = path.join(dir, 'windows.f32');
    await writeGpuWindows(file, data, signals, 3, end);
    await worker.init(file, signals.length, 3, device);
    const adjusted = parameters.map((p) => accountGpuParameters(p, DEFAULT_ACCOUNT));
    const result = await worker.evaluateCached(adjusted, 37);
    assert.equal(parameters.length, 36);
    assert.equal(result.computed, 1);
    let trades = 0;
    for (const [i, p] of parameters.entries()) {
      const gpu = backtestAccount(data, signals, p, start, end, DEFAULT_ACCOUNT, result.offsets[i]);
      assert.deepEqual(gpu, backtestAccount(data, signals, p, start, end, DEFAULT_ACCOUNT));
      assert.ok(gpu.trades.every((t) => t.fifteenSupportMa === null));
      trades += gpu.trades.length;
    }
    assert.ok(trades > 0);
    const cached = await worker.evaluateCached(adjusted, 37);
    assert.equal(cached.computed, 0);
    assert.deepEqual(cached.offsets, result.offsets);
    await worker.init(file, signals.length, 3, device);
    assert.equal((await worker.evaluateCached(adjusted, 37)).computed, 1);
  } finally { worker.close(); await rm(dir, { recursive: true, force: true }); }
});

test('MPS cached exits agree with scalar accounts for independent streak lengths, directions and 15m thresholds', { skip }, async () => {
  const { DEFAULT_ACCOUNT, accountGpuParameters, backtestAccount } = await import('../futures-account.ts');
  const { FIFTEEN } = await import('../fifteen.ts');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'streak-gpu-'));
  const worker = new GpuWorker(python);
  try {
    const { data, signals } = fixture();
    signals.forEach((s, i) => {
      s.streak = { count: i % 5 + 1, direction: i % 2 ? 'up' : 'down' };
      s.fifteen = { closedAt: Math.floor(s.time / FIFTEEN) * FIFTEEN, dea: 0.7, dif: 0.9, peakDea: 1,
        deaLevel: 'mid', direction: 'bull', supportMa: i % 7 ? null : 'ma120',
        streak: { count: i % 4 + 1, direction: Math.floor(i / 2) % 2 ? 'up' : 'down' } };
    });
    const parameters = miningGrid({ highRatio:[0.8], holdMinutes:[3], stopLossPercent:[0.2], takeProfitPercent:[2],
      minuteDea:['high'],minuteDif:['bull'],fifteenDea:['high','mid'],fifteenDif:['bull'],fifteenHighRatio:[0.65,0.9],
      minuteStreak:[0,3,-5],fifteenStreak:[0,2,-4] },7,3,42);
    const file=path.join(dir,'windows.f32');
    await writeGpuWindows(file,data,signals,3,end);
    await worker.init(file,signals.length,3,device);
    const result=await worker.evaluateCached(parameters.map(p=>accountGpuParameters(p,DEFAULT_ACCOUNT)),37);
    assert.equal(result.computed,1);
    let filled=0;
    for (const [i,p] of parameters.entries()) {
      const gpu=backtestAccount(data,signals,p,start,end,DEFAULT_ACCOUNT,result.offsets[i]);
      assert.deepEqual(gpu,backtestAccount(data,signals,p,start,end,DEFAULT_ACCOUNT));
      if(p.minuteStreak && p.fifteenStreak) filled+=gpu.trades.length;
      assert.ok(gpu.trades.every(t=>!p.minuteStreak || t.minuteStreakCount!>=Math.abs(p.minuteStreak)));
      assert.ok(gpu.trades.every(t=>!p.fifteenStreak || t.fifteenStreakCount!>=Math.abs(p.fifteenStreak)));
    }
    assert.ok(filled>0);
  } finally { worker.close(); await rm(dir,{recursive:true,force:true}); }
});

test('BTC 5m market filter produces identical MPS and CPU accounts for ranked altcoins', { skip }, async () => {
  const { DEFAULT_ACCOUNT, accountGpuParameters, backtestAccount } = await import('../futures-account.ts');
  const { BTC_FIVE } = await import('../btc-five.ts');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'btc-five-gpu-'));
  const worker = new GpuWorker(python);
  try {
    const { data, signals } = fixture();
    signals.forEach((s, i) => {
      s.streak = { direction: 'up', count: 3 };
      s.btcFive = i % 11 === 0 ? null : { symbol: 'BTCUSDT', closedAt: Math.floor(s.time / BTC_FIVE) * BTC_FIVE,
        dea: 0.7, dif: 0.9, peakDea: 1, deaLevel: 'mid', direction: 'bull', supportMa: i % 7 === 0 ? 'ma5' : null,
        streak: { direction: 'down', count: 4 } };
    });
    const parameters = miningGrid({ highRatio: [0.8], holdMinutes: [3, 15], stopLossPercent: [0.2], takeProfitPercent: [2],
      minuteDea: ['high'], minuteDif: ['bull'], minuteStreak: [0, 3, -3], btcFiveDea: ['high', 'mid'], btcFiveDif: ['bull'],
      btcFiveHighRatio: [0.65, 0.9], btcFiveStreak: [0, 2, -4] }, 7, 3, 42);
    const file = path.join(dir, 'windows.f32');
    await writeGpuWindows(file, data, signals, 15, end);
    await worker.init(file, signals.length, 15, device);
    const result = await worker.evaluateCached(parameters.map((p) => accountGpuParameters(p, DEFAULT_ACCOUNT)), 37);
    let filled = 0;
    for (const [i, p] of parameters.entries()) {
      const gpu = backtestAccount(data, signals, p, start, end, DEFAULT_ACCOUNT, result.offsets[i]);
      assert.deepEqual(gpu, backtestAccount(data, signals, p, start, end, DEFAULT_ACCOUNT));
      filled += gpu.trades.length;
      assert.ok(gpu.trades.every((t) => t.symbol !== 'BTCUSDT' && t.btcFiveSymbol === 'BTCUSDT' && t.btcFiveSupportMa === null));
    }
    assert.ok(filled > 0);
  } finally { worker.close(); await rm(dir, { recursive: true, force: true }); }
});
