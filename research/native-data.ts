import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createBinanceClient } from './client.ts';
import { atomicJson, digest, parseSymbols, validateBars } from './data.ts';
import type { Bar } from './types.ts';

export interface NativeRule { interval: '5m' | '15m'; milliseconds: number; warmupBars: number; fetchFlag: string }
export interface NativePlan { start: number; end: number; fetchStart: number; symbols: string[] }
export interface NativeManifest {
  version: 1; interval: NativeRule['interval']; source: string; fetchedAt: string; plan: NativePlan;
  files: Record<string, { file: string; sha256: string; bars: number; missingBars: number }>;
}
export function planNative(rule: NativeRule, start: number, end: number, symbols: string[]): NativePlan {
  if (![start, end].every((v) => Number.isFinite(v) && v % rule.milliseconds === 0) || start >= end) throw new Error(`${rule.interval} 区间必须对齐且 start < end`);
  return { start, end, fetchStart: start - rule.warmupBars * rule.milliseconds, symbols: parseSymbols(symbols) };
}
async function readManifest(file: string): Promise<NativeManifest | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
}
function checkManifest(rule: NativeRule, m: NativeManifest, plan: NativePlan) {
  if (m.version !== 1 || m.interval !== rule.interval || !isDeepStrictEqual(m.plan, plan) || !m.files ||
      Object.keys(m.files).some((s) => !plan.symbols.includes(s))) throw new Error(`${rule.interval} 缓存计划不同或无效，请使用新目录`);
}
async function readBars(rule: NativeRule, directory: string, m: NativeManifest, symbol: string): Promise<Bar[]> {
  const record = m.files[symbol];
  if (!record || record.file !== `${symbol}.json.gz`) throw new Error(`${symbol} 缺少${rule.interval}文件或路径无效`);
  const bytes = await readFile(path.join(directory, record.file));
  if (digest(bytes) !== record.sha256) throw new Error(`${symbol} ${rule.interval} SHA256 校验失败`);
  const bars: unknown = JSON.parse(gunzipSync(bytes).toString('utf8'));
  validateBars(bars, rule.milliseconds);
  if (bars.length !== record.bars || bars.some((b) => b[0] < m.plan.fetchStart || b[0] >= m.plan.end)
      || record.missingBars !== (m.plan.end - m.plan.fetchStart) / rule.milliseconds - bars.length) throw new Error(`${symbol} ${rule.interval}清单数量或区间不一致`);
  return bars;
}
export async function loadNative(rule: NativeRule, directory: string, plan: NativePlan) {
  const manifest = await readManifest(path.join(directory, 'manifest.json'));
  if (!manifest) throw new Error(`缺少完整${rule.interval}缓存；先用 ${rule.fetchFlag} 补取`);
  checkManifest(rule, manifest, plan);
  const candles = new Map<string, Bar[]>();
  for (const symbol of plan.symbols) candles.set(symbol, await readBars(rule, directory, manifest, symbol));
  return { manifest, candles };
}
/** Native interval bars; no interpolation from sparse 1m data. Per-symbol resumable cache. */
export async function fetchNative(rule: NativeRule, directory: string, plan: NativePlan, log = console.log) {
  if (plan.end > Math.floor(Date.now() / rule.milliseconds) * rule.milliseconds) throw new Error(`${rule.interval} 结束时间不得包含未收盘线`);
  await mkdir(directory, { recursive: true });
  const source = (process.env.BINANCE_BASE ?? 'https://fapi.binance.com').replace(/\/$/, '');
  const cached = await readManifest(path.join(directory, 'manifest.json')) ?? await readManifest(path.join(directory, 'partial.json'));
  const m: NativeManifest = cached ?? { version: 1, interval: rule.interval, source, fetchedAt: new Date().toISOString(), plan, files: {} };
  checkManifest(rule, m, plan);
  if (m.source !== source) throw new Error(`${rule.interval}缓存来源不同`);
  const client = await createBinanceClient(source);
  try {
    for (const [i, symbol] of plan.symbols.entries()) {
      if (m.files[symbol]) { await readBars(rule, directory, m, symbol); continue; }
      const bars: Bar[] = [];
      let cursor = plan.fetchStart;
      while (cursor < plan.end) {
        const payload = await client.request(`/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${rule.interval}&startTime=${cursor}&endTime=${plan.end - 1}&limit=499`);
        if (!Array.isArray(payload)) throw new Error(`${symbol} ${rule.interval}响应格式错误`);
        if (!payload.length) break;
        const batch: Bar[] = payload.map((c) => [Number(c[0]), Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4]), Number(c[5]), Number(c[7])]);
        validateBars(batch, rule.milliseconds);
        if (batch[0][0] < cursor || batch.at(-1)![0] >= plan.end) throw new Error(`${symbol} ${rule.interval}返回范围错误`);
        bars.push(...batch); cursor = batch.at(-1)![0] + rule.milliseconds;
      }
      validateBars(bars, rule.milliseconds);
      const file = `${symbol}.json.gz`, bytes = gzipSync(JSON.stringify(bars));
      await writeFile(path.join(directory, `${file}.tmp`), bytes);
      await rename(path.join(directory, `${file}.tmp`), path.join(directory, file));
      m.files[symbol] = { file, sha256: digest(bytes), bars: bars.length, missingBars: (plan.end - plan.fetchStart) / rule.milliseconds - bars.length };
      await atomicJson(path.join(directory, 'partial.json'), m);
      log(`[${rule.interval} ${i + 1}/${plan.symbols.length}] ${symbol} ${bars.length}根，缺失${m.files[symbol].missingBars}根`);
    }
    await atomicJson(path.join(directory, 'manifest.json'), m);
  } finally { await client.close(); }
}
