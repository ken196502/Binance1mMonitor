import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createBinanceClient } from './client.ts';
import { atomicJson, digest, validateBars } from './data.ts';
import { HOUR, type Bar, type Dataset, type Frame } from './types.ts';
import { MINUTE, type MinuteDataset, type MinuteManifest, type MinutePlan } from './gainers-types.ts';
import { getRank1Watchlist } from './peak-rebound-signals.ts';

export function planWatchlistMinutes(
  hourly: Dataset,
  frames: Frame[],
  options: { warmupMinutes?: number; maxHoldMinutes?: number; watchWindowHours?: number } = {},
): MinutePlan {
  const warmupMinutes = options.warmupMinutes ?? 300;
  const maxHoldMinutes = options.maxHoldMinutes ?? 60;
  const watchWindowHours = options.watchWindowHours ?? 48;
  const watchlist = getRank1Watchlist(frames);

  const ranges: MinutePlan['ranges'] = {};
  for (const [symbol, info] of watchlist) {
    const rangeStart = Math.max(hourly.manifest.fetchStart, info.firstRank1Time - warmupMinutes * MINUTE);
    const rangeEnd = Math.min(
      hourly.manifest.end + maxHoldMinutes * MINUTE,
      info.lastRank1Time + (watchWindowHours + 2) * HOUR,
    );
    ranges[symbol] = [[rangeStart, rangeEnd]];
  }

  return {
    version: 1,
    hourlyHash: digest(Buffer.from(JSON.stringify(hourly.manifest))),
    topN: 1,
    highWindow: 100,
    warmupMinutes,
    maxHoldMinutes,
    start: hourly.manifest.start,
    end: hourly.manifest.end,
    ranges,
  };
}

export async function fetchWatchlistMinutes(
  directory: string,
  plan: MinutePlan,
  base = 'https://fapi.binance.com',
  log = console.log,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  let cached: MinuteManifest | null = null;
  for (const name of ['manifest.json', 'partial.json']) {
    try {
      cached = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }

  const manifest: MinuteManifest = cached ?? {
    version: 1,
    interval: '1m',
    source: base,
    fetchedAt: new Date().toISOString(),
    plan,
    files: {},
  };
  await atomicJson(path.join(directory, 'partial.json'), manifest);

  const symbols = Object.keys(plan.ranges).sort();
  const client = await createBinanceClient(base);

  try {
    for (const [i, symbol] of symbols.entries()) {
      const file = `${symbol}.json.gz`;
      if (manifest.files[symbol]) {
        const filePath = path.join(directory, file);
        try {
          const bytes = await readFile(filePath);
          if (digest(bytes) === manifest.files[symbol].sha256) {
            log(`[${i + 1}/${symbols.length}] ${symbol} 分钟缓存已就绪`);
            continue;
          }
        } catch {}
      }

      const bars: Bar[] = [];
      for (const [start, end] of plan.ranges[symbol]) {
        let cursor = start;
        while (cursor < end) {
          const payload = (await client.request(
            `/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&startTime=${cursor}&endTime=${end - 1}&limit=1000`,
          )) as unknown[];

          if (!Array.isArray(payload)) throw new Error(`${symbol} 分钟行情格式错误`);
          if (!payload.length) break;

          const batch: Bar[] = payload.map((c: any) => [
            Number(c[0]),
            Number(c[1]),
            Number(c[2]),
            Number(c[3]),
            Number(c[4]),
            Number(c[5]),
            Number(c[7]),
          ]);
          validateBars(batch, MINUTE);
          bars.push(...batch);
          cursor = batch.at(-1)![0] + MINUTE;
        }
      }

      validateBars(bars, MINUTE);
      const bytes = gzipSync(JSON.stringify(bars));
      await writeFile(path.join(directory, `${file}.tmp`), bytes);
      await rename(path.join(directory, `${file}.tmp`), path.join(directory, file));

      const expectedBars = plan.ranges[symbol].reduce((sum, [a, b]) => sum + (b - a) / MINUTE, 0);
      manifest.files[symbol] = {
        file,
        sha256: digest(bytes),
        bars: bars.length,
        missingMinutes: Math.max(0, expectedBars - bars.length),
      };
      await atomicJson(path.join(directory, 'partial.json'), manifest);
      log(`[${i + 1}/${symbols.length}] ${symbol}: ${bars.length} 根 1m K线缓存完成`);
    }

    await atomicJson(path.join(directory, 'manifest.json'), manifest);
  } finally {
    await client.close();
  }
}

export async function loadWatchlistMinutes(directory: string, plan: MinutePlan): Promise<MinuteDataset> {
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')) as MinuteManifest;
  const candles = new Map<string, Bar[]>();

  for (const [symbol, ranges] of Object.entries(plan.ranges)) {
    const file = manifest.files[symbol];
    if (!file || file.file !== `${symbol}.json.gz`) throw new Error(`${symbol} 分钟文件缺失`);
    const bytes = await readFile(path.join(directory, file.file));
    if (digest(bytes) !== file.sha256) throw new Error(`${symbol} 分钟数据 SHA256 校验失败`);
    const bars: unknown = JSON.parse(gunzipSync(bytes).toString('utf8'));
    validateBars(bars, MINUTE);
    candles.set(symbol, bars);
  }

  return { manifest, candles };
}
