import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { createBinanceClient } from "./client.ts";
import { ARCHIVE_BASE, createArchiveClient } from "./gainers-archive.ts";
import { atomicJson, digest, validateBars } from "./data.ts";
import { HOUR, type Bar, type Dataset, type Frame } from "./types.ts";
import { MINUTE, type GainersOptions, type MinuteDataset, type MinuteManifest, type MinutePlan } from "./gainers-types.ts";

export function planGainersMinutes(hourly: Dataset, frames: Frame[], options: Pick<GainersOptions, "topN" | "highWindow" | "grid">): MinutePlan {
  const warmupMinutes = Math.max(300, options.highWindow + 100);
  const maxHoldMinutes = Math.max(...options.grid.holdMinutes);
  const ranges: MinutePlan["ranges"] = {};
  for (const frame of frames) for (const row of frame.boards.gainers) {
    (ranges[row.symbol] ??= []).push([
      frame.time - warmupMinutes * MINUTE,
      Math.min(hourly.manifest.end, frame.time + HOUR + maxHoldMinutes * MINUTE),
    ]);
  }
  for (const [symbol, windows] of Object.entries(ranges)) {
    const merged: [number, number][] = [];
    for (const window of windows.sort((a, b) => a[0] - b[0])) {
      const previous = merged.at(-1);
      if (previous && window[0] <= previous[1]) previous[1] = Math.max(previous[1], window[1]);
      else merged.push([...window]);
    }
    ranges[symbol] = merged;
  }
  return { version: 1, hourlyHash: digest(Buffer.from(JSON.stringify(hourly.manifest))),
    topN: options.topN, highWindow: options.highWindow, warmupMinutes, maxHoldMinutes,
    start: hourly.manifest.start, end: hourly.manifest.end, ranges };
}

export async function fetchGainersMinutes(directory: string, plan: MinutePlan, base: string, log = console.log): Promise<void> {
  await mkdir(directory, { recursive: true });
  let cached: MinuteManifest | null = null;
  for (const name of ["manifest.json", "partial.json"]) {
    try { cached = JSON.parse(await readFile(path.join(directory, name), "utf8")); break; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  if (cached && (cached.version !== 1 || cached.interval !== "1m" || cached.source !== base || JSON.stringify(cached.plan) !== JSON.stringify(plan))) {
    throw new Error("分钟缓存与当前小时数据/榜单/预热/持有期计划不一致，请使用新的 --minutes-data 目录");
  }
  const manifest: MinuteManifest = cached ?? { version: 1, interval: "1m", source: base, fetchedAt: new Date().toISOString(), plan, files: {} };
  await atomicJson(path.join(directory, "partial.json"), manifest);
  const symbols = Object.keys(plan.ranges).sort();
  const expected = Object.values(plan.ranges).flat().reduce((n, [a, b]) => n + (b - a) / MINUTE, 0);
  log(`补取 gainers 分钟行情：${symbols.length} 个历史入榜币种，约 ${expected} 根 1m K 线（含预热与退出窗口）`);
  const archive = base === ARCHIVE_BASE ? await createArchiveClient() : null;
  const client = archive ? null : await createBinanceClient(base);
  try {
    for (const [i, symbol] of symbols.entries()) {
      const file = `${symbol}.json.gz`;
      if (manifest.files[symbol]) {
        if (manifest.files[symbol].file !== file || digest(await readFile(path.join(directory, file))) !== manifest.files[symbol].sha256) throw new Error(`${symbol} 分钟缓存校验失败`);
        log(`[${i + 1}/${symbols.length}] ${symbol} 分钟缓存已就绪`);
        continue;
      }
      const bars: Bar[] = archive ? await archive.candles(symbol, plan.ranges[symbol], manifest.archiveChecksums ??= {}) : [];
      if (!archive) for (const [start, end] of plan.ranges[symbol]) {
        let cursor = start;
        while (cursor < end) {
          const payload = await client!.request(`/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&startTime=${cursor}&endTime=${end - 1}&limit=1000`);
          if (!Array.isArray(payload)) throw new Error(`${symbol} 分钟行情格式错误`);
          if (!payload.length) break;
          const batch: Bar[] = payload.map((c: unknown[]) => [Number(c[0]), Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4]), Number(c[5]), Number(c[7])]);
          validateBars(batch, MINUTE);
          if (batch[0][0] < cursor || batch.at(-1)![0] >= end) throw new Error(`${symbol} 分钟行情超出请求区间`);
          bars.push(...batch);
          cursor = batch.at(-1)![0] + MINUTE;
        }
      }
      validateBars(bars, MINUTE);
      const bytes = gzipSync(JSON.stringify(bars));
      await writeFile(path.join(directory, `${file}.tmp`), bytes);
      await rename(path.join(directory, `${file}.tmp`), path.join(directory, file));
      const expectedBars = plan.ranges[symbol].reduce((sum, [a, b]) => sum + (b - a) / MINUTE, 0);
      manifest.files[symbol] = { file, sha256: digest(bytes), bars: bars.length, missingMinutes: expectedBars - bars.length };
      await atomicJson(path.join(directory, "partial.json"), manifest);
      log(`[${i + 1}/${symbols.length}] ${symbol}: ${bars.length} 根，计划窗口缺失 ${expectedBars - bars.length} 分钟`);
    }
    await atomicJson(path.join(directory, "manifest.json"), manifest);
  } finally { await (archive ?? client)!.close(); }
}

export async function loadGainersMinutes(directory: string, plan: MinutePlan): Promise<MinuteDataset> {
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as MinuteManifest;
  if (manifest.version !== 1 || manifest.interval !== "1m" || JSON.stringify(manifest.plan) !== JSON.stringify(plan)) throw new Error("分钟数据与当前研究计划不匹配");
  const candles = new Map<string, Bar[]>();
  for (const [symbol, ranges] of Object.entries(plan.ranges)) {
    const file = manifest.files[symbol];
    if (!file || file.file !== `${symbol}.json.gz`) throw new Error(`${symbol} 分钟文件缺失`);
    const bytes = await readFile(path.join(directory, file.file));
    if (digest(bytes) !== file.sha256) throw new Error(`${symbol} 分钟数据 SHA256 校验失败`);
    const bars: unknown = JSON.parse(gunzipSync(bytes).toString("utf8"));
    validateBars(bars, MINUTE);
    if (bars.length !== file.bars || bars.some((c) => !ranges.some(([a, b]) => c[0] >= a && c[0] < b))) throw new Error(`${symbol} 分钟数据范围错误`);
    candles.set(symbol, bars);
  }
  return { manifest, candles };
}
