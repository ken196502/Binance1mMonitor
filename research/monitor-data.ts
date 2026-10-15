import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { atomicJson, digest, validateBars } from './data.ts';
import { createArchiveClient } from './gainers-archive.ts';
import { DAY, HOUR, type Bar, type Dataset, type Frame } from './types.ts';
import { MINUTE, type MinutePlan } from './gainers-types.ts';

export const MONITOR_BOARDS = ['gainers', 'losers'] as const;
export type MonitorBoard = typeof MONITOR_BOARDS[number];
export const MONITOR_RULE = { version: 1, highWindow: 100, highRatio: 0.8, warmupMinutes: 1505, maxWindow: 1500, dailyWindow: 61, pinned: ['BTCUSDT', 'SOLUSDT'] } as const;

/** Replace pinned symbols before selecting the ten natural board members. */
export function monitorFrames(frames: Frame[], topN = 10): Frame[] {
  return frames.map((f) => ({ ...f, boards: { ...f.boards, ...Object.fromEntries(MONITOR_BOARDS.map((board) => [board,
    f.boards[board].filter((r) => !MONITOR_RULE.pinned.some((s) => s === r.symbol)).slice(0, topN).map((r, i) => ({ ...r, rank: i + 1 })),
  ])) } }));
}

export function planMonitorMinutes(hourly: Dataset, frames: Frame[], holdMinutes: number): MinutePlan {
  const ranges: MinutePlan['ranges'] = {};
  const onboard = new Map(hourly.manifest.contracts.map((c) => [c.symbol, c.onboardDate]));
  for (const f of frames) for (const board of MONITOR_BOARDS) for (const row of f.boards[board]) {
    (ranges[row.symbol] ??= []).push([Math.max(f.time - MONITOR_RULE.warmupMinutes * MINUTE, Math.floor((onboard.get(row.symbol) ?? 0) / MINUTE) * MINUTE),
      Math.min(hourly.manifest.end, f.time + HOUR + holdMinutes * MINUTE)]);
  }
  for (const [symbol, windows] of Object.entries(ranges)) {
    const merged: [number, number][] = [];
    for (const w of windows.sort((a, b) => a[0] - b[0])) {
      const prev = merged.at(-1);
      if (prev && w[0] <= prev[1]) prev[1] = Math.max(prev[1], w[1]);
      else merged.push([...w]);
    }
    ranges[symbol] = merged;
  }
  return { version: 1, hourlyHash: digest(Buffer.from(JSON.stringify(hourly.manifest))), topN: 10,
    highWindow: 100, warmupMinutes: MONITOR_RULE.warmupMinutes, maxHoldMinutes: holdMinutes,
    start: hourly.manifest.start, end: hourly.manifest.end, ranges };
}

export interface DailyPlan { start: number; end: number; hourlyHash: string; ranges: Record<string, [number, number]> }
export interface DailyManifest {
  version: 1; interval: '1d'; plan: DailyPlan; source: string; fetchedAt: string;
  files: Record<string, { file: string; sha256: string; bars: number; missingBars: number }>;
  archiveChecksums: Record<string, string>;
}
export function planMonitorDaily(hourly: Dataset, symbols: string[]): DailyPlan {
  const { start, end, contracts } = hourly.manifest;
  const onboard = new Map(contracts.map((c) => [c.symbol, c.onboardDate]));
  return { start, end, hourlyHash: digest(Buffer.from(JSON.stringify(hourly.manifest))), ranges: Object.fromEntries([...symbols].sort().map((s) => [s, [
    Math.max(Math.floor(start / DAY) * DAY - 61 * DAY, Math.floor((onboard.get(s) ?? 0) / DAY) * DAY),
    Math.floor(end / DAY) * DAY,
  ]])) };
}
async function dailyBars(directory: string, m: DailyManifest, symbol: string): Promise<Bar[]> {
  const f = m.files[symbol];
  if (!f || f.file !== `${symbol}.json.gz`) throw new Error(`${symbol} 缺少日线缓存`);
  const bytes = await readFile(path.join(directory, f.file));
  if (digest(bytes) !== f.sha256) throw new Error(`${symbol} 日线SHA256错误`);
  const bars: unknown = JSON.parse(gunzipSync(bytes).toString());
  validateBars(bars, DAY);
  const [start, end] = m.plan.ranges[symbol];
  if (bars.length !== f.bars || bars.some((b) => b[0] < start || b[0] >= end) || f.missingBars !== (end - start) / DAY - bars.length) throw new Error(`${symbol} 日线范围或数量错误`);
  return bars;
}
export async function loadMonitorDaily(directory: string, plan: DailyPlan) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')) as DailyManifest;
  if (manifest.version !== 1 || manifest.interval !== '1d' || !isDeepStrictEqual(manifest.plan, plan)) throw new Error('日线计划不匹配，请使用新目录');
  const candles = new Map<string, Bar[]>();
  for (const symbol of Object.keys(plan.ranges)) candles.set(symbol, await dailyBars(directory, manifest, symbol));
  return { manifest, candles };
}
/** Full UTC days only; the source hourly manifest is included in the daily plan hash. */
export function dailyFromHours(bars: Bar[]): Map<number, Bar> {
  const result = new Map<number, Bar>();
  for (let i = 0; i + 23 < bars.length; i++) {
    const first = bars[i];
    if (first[0] % DAY) continue;
    const day = bars.slice(i, i + 24);
    if (day.some((b, j) => b[0] !== first[0] + j * HOUR)) continue;
    result.set(first[0], [first[0], first[1], Math.max(...day.map((b) => b[2])), Math.min(...day.map((b) => b[3])), day[23][4],
      day.reduce((n, b) => n + b[5], 0), day.reduce((n, b) => n + b[6], 0)]);
    i += 23;
  }
  return result;
}
export async function fetchMonitorDaily(directory: string, plan: DailyPlan, log = console.log, hourly?: Dataset) {
  if (hourly && digest(Buffer.from(JSON.stringify(hourly.manifest))) !== plan.hourlyHash) throw new Error('日线复用的小时缓存不匹配');
  await mkdir(directory, { recursive: true });
  let m: DailyManifest | undefined;
  for (const file of ['manifest.json', 'partial.json']) {
    try { m = JSON.parse(await readFile(path.join(directory, file), 'utf8')); break; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  if (m && (m.version !== 1 || m.interval !== '1d' || !isDeepStrictEqual(m.plan, plan))) throw new Error('日线缓存计划不匹配');
  m ??= { version: 1, interval: '1d', plan, source: 'https://data.binance.vision + verified complete hourly days', fetchedAt: new Date().toISOString(), files: {}, archiveChecksums: {} };
  await atomicJson(path.join(directory, 'partial.json'), m);
  const client = await createArchiveClient('1d');
  try {
    for (const [i, symbol] of Object.keys(plan.ranges).entries()) {
      if (m.files[symbol]) { await dailyBars(directory, m, symbol); continue; }
      const range = plan.ranges[symbol];
      const local = dailyFromHours(hourly?.candles.get(symbol) ?? []);
      const bars: Bar[] = [], missing: [number, number][] = [];
      for (let day = range[0]; day < range[1]; day += DAY) {
        const bar = local.get(day);
        if (bar) bars.push(bar);
        else if (missing.at(-1)?.[1] === day) missing.at(-1)![1] = day + DAY;
        else missing.push([day, day + DAY]);
      }
      bars.push(...await client.candles(symbol, missing, m.archiveChecksums));
      bars.sort((a, b) => a[0] - b[0]); validateBars(bars, DAY);
      const file = `${symbol}.json.gz`, bytes = gzipSync(JSON.stringify(bars));
      await writeFile(path.join(directory, `${file}.tmp`), bytes);
      await rename(path.join(directory, `${file}.tmp`), path.join(directory, file));
      m.files[symbol] = { file, sha256: digest(bytes), bars: bars.length, missingBars: (range[1] - range[0]) / DAY - bars.length };
      await atomicJson(path.join(directory, 'partial.json'), m);
      log(`[1d ${i + 1}/${Object.keys(plan.ranges).length}] ${symbol}: ${bars.length}根`);
    }
    await atomicJson(path.join(directory, 'manifest.json'), m);
  } finally { await client.close(); }
}
