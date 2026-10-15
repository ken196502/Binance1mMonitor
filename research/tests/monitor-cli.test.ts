import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { atomicJson, digest } from '../data.ts';
import { buildFrames } from '../backtest.ts';
import { monitorFrames, planMonitorDaily, planMonitorMinutes } from '../monitor-data.ts';
import { dataset, history, START } from './helpers.ts';
import { DAY, HOUR, type Bar } from '../types.ts';
import { MINUTE } from '../gainers-types.ts';

test('new CLI runs both boards on MPS, checkpoints before holdout, resumes and refuses changed parameters', {
  skip: !existsSync(path.resolve('.venv-gpu/bin/python')) && !process.env.GPU_REQUIRED, timeout: 60000,
}, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'monitor-cli-'));
  try {
    const dataDir = path.join(dir, 'hourly'), cache = path.join(dir, 'cache'), out = path.join(dir, 'out');
    for (const d of [dataDir, path.join(cache, '1m'), path.join(cache, '1d')]) await mkdir(d, { recursive: true });
    const h = dataset(); h.manifest.end = START + 3 * HOUR;
    h.candles.set('AAAUSDT', history(h.manifest.fetchStart, h.manifest.end));
    const hb = h.candles.get('AAAUSDT')!, bytes = gzipSync(JSON.stringify(hb));
    h.manifest.files.AAAUSDT = { file: 'AAAUSDT.json.gz', sha256: digest(bytes), bars: hb.length, gaps: 0, first: hb[0][0], last: hb.at(-1)![0] };
    await writeFile(path.join(dataDir, 'AAAUSDT.json.gz'), bytes); await atomicJson(path.join(dataDir, 'manifest.json'), h.manifest);
    const plan = planMonitorMinutes(h, monitorFrames(buildFrames(h, 12, 1)), 15);
    const [from, to] = plan.ranges.AAAUSDT[0];
    const minute: Bar[] = Array.from({ length: (to - from) / MINUTE }, (_, i) => {
      const price = 120 - i * i * 0.00002;
      return [from + i * MINUTE, price + 0.001, price + 0.001, price - 0.001, price, 1, 1];
    });
    const mb = gzipSync(JSON.stringify(minute));
    await writeFile(path.join(cache, '1m/AAAUSDT.json.gz'), mb);
    await atomicJson(path.join(cache, '1m/manifest.json'), { version: 1, interval: '1m', source: 'fixture', fetchedAt: new Date().toISOString(), plan,
      files: { AAAUSDT: { file: 'AAAUSDT.json.gz', sha256: digest(mb), bars: minute.length, missingMinutes: 0 } } });
    const dp = planMonitorDaily(h, ['AAAUSDT']);
    const daily: Bar[] = Array.from({ length: (dp.ranges.AAAUSDT[1] - dp.ranges.AAAUSDT[0]) / DAY }, (_, i) => [dp.ranges.AAAUSDT[0] + i * DAY, 100 + i, 100 + i, 100 + i, 100 + i, 1, 1]);
    const db = gzipSync(JSON.stringify(daily));
    await writeFile(path.join(cache, '1d/AAAUSDT.json.gz'), db);
    await atomicJson(path.join(cache, '1d/manifest.json'), { version: 1, interval: '1d', source: 'fixture', fetchedAt: new Date().toISOString(), plan: dp,
      files: { AAAUSDT: { file: 'AAAUSDT.json.gz', sha256: digest(db), bars: daily.length, missingBars: 0 } }, archiveChecksums: {} });
    const gridFile = path.join(dir, 'grid.json');
    await atomicJson(gridFile, { highRatio: [0.8], fiveHighRatio: [0.8], diff1mLevel: ['low'], diff5mLevel: ['low'], minuteStreak: [0, -2], minDrawdownPercent: [2],
      holdMinutes: [1, 2], stopLossPercent: [0.2], takeProfitPercent: [2] });
    const args = ['--data', dataDir, '--cache', cache, '--out', out, '--start', new Date(START).toISOString(), '--end', new Date(h.manifest.end).toISOString(),
      '--grid', gridFile, '--max-trials', '4', '--batch', '1', '--min-trades', '1', '--board', 'all', '--device', process.env.GPU_TEST_DEVICE ?? 'mps'];
    const cli = async (extra: string[]) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'research/monitor-miner.ts', ...args, ...extra], { stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HIGH_RATIO: '0.8', HIGH_WINDOW: '100' } });
      let output = ''; child.stdout.on('data', (b) => { output += b; }); child.stderr.on('data', (b) => { output += b; });
      const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      return { code, output };
    };
    const partial = await cli(['--rounds', '1']); assert.equal(partial.code, 0, partial.output);
    for (const board of ['gainers', 'losers']) {
      const s = JSON.parse(await readFile(path.join(out, board, 'state.json'), 'utf8'));
      assert.equal(s.next, 1); assert.equal(s.status, 'mining'); assert.equal(s.baseline.test, undefined);
      assert.equal(s.gpu.device, process.env.GPU_TEST_DEVICE ?? 'mps'); assert.deepEqual(s.validations, {});
    }
    const complete = await cli(['--resume']); assert.equal(complete.code, 0, complete.output);
    const snapshots = new Map<string, string>();
    for (const board of ['gainers', 'losers']) {
      const file = path.join(out, board, 'state.json'), bytes = await readFile(file, 'utf8'), s = JSON.parse(bytes);
      snapshots.set(file, bytes); assert.equal(s.next, 4); assert.equal(s.status, 'complete');
      assert.ok(s.winner?.test.trades.length > 0); assert.equal(s.winner.test.trades[0].board, board);
      assert.ok(s.baseline.test); assert.ok(s.trialShards.length > 1);
      assert.match(await readFile(path.join(out, board, 'test-trades.csv'), 'utf8'), /diff1mLevel/);
    }
    assert.equal((await cli(['--resume'])).code, 0);
    for (const [f, bytes] of snapshots) assert.equal(await readFile(f, 'utf8'), bytes);
    const changed = await cli(['--resume', '--seed', '43']);
    assert.equal(changed.code, 1); assert.match(changed.output, /拒绝混合续跑/);
    // Simulate a run interrupted before its second board was ever initialized.
    await rm(path.join(out, 'losers'), { recursive: true });
    assert.equal((await cli(['--resume'])).code, 0);
    assert.equal(JSON.parse(await readFile(path.join(out, 'losers/state.json'), 'utf8')).status, 'complete');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
