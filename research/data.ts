import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { DAY, HOUR, type Bar, type Contract, type Dataset, type Manifest } from "./types.ts";
import { createBinanceClient } from "./client.ts";

export function weekStart(time: number): number {
  const date = new Date(time);
  return Math.floor(time / DAY) * DAY - ((date.getUTCDay() + 6) % 7) * DAY;
}
export const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
export async function atomicJson(file: string, value: unknown): Promise<void> {
  await writeFile(`${file}.tmp`, JSON.stringify(value, null, 2));
  await rename(`${file}.tmp`, file);
}
export function validateBars(value: unknown, interval = HOUR): asserts value is Bar[] {
  if (!Array.isArray(value)) throw new Error("K 线文件必须是数组");
  let previous = -Infinity;
  for (const c of value) {
    if (!Array.isArray(c) || c.length !== 7 || !c.every(Number.isFinite) ||
      c[0] % interval !== 0 || c[0] <= previous || Math.min(...c.slice(1, 5)) <= 0 ||
      c[5] < 0 || c[6] < 0 || c[2] < Math.max(c[1], c[3], c[4]) || c[3] > Math.min(c[1], c[4])) {
      throw new Error("K 线包含无效价格、时间、重复或乱序记录");
    }
    previous = c[0];
  }
}
export function parseSymbols(value: string[]): string[] {
  const symbols = [...new Set(value.map((s) => s.trim().toUpperCase()))].sort();
  if (!symbols.length || symbols.some((s) => !/^[\p{L}\p{N}]{1,40}USDT$/u.test(s))) {
    throw new Error("币种列表必须是 USDT 永续代码，例如 BTCUSDT,ETHUSDT");
  }
  return symbols;
}

export interface FetchOptions {
  directory: string;
  start: number;
  end: number;
  base?: string;
}

/** Standalone public-data client. Never imports the HTTP server or Telegram. */
export async function fetchDataset(options: FetchOptions, log = console.log): Promise<Manifest> {
  const { start, end, directory } = options;
  if (![start, end].every((n) => Number.isFinite(n) && n % HOUR === 0) || start >= end || end > Math.floor(Date.now() / HOUR) * HOUR) {
    throw new Error("数据区间必须按小时对齐，start < end，且 end 不晚于最近收盘时刻");
  }
  const base = (options.base ?? process.env.BINANCE_BASE ?? "https://fapi.binance.com").replace(/\/$/, "");
  const client = await createBinanceClient(base);
  const { request } = client;
  try {
    const fetchStart = Math.min(start - 100 * HOUR, weekStart(start));
    await mkdir(directory, { recursive: true });
    let cached: Manifest | null = null;
    for (const file of ["manifest.json", "partial.json"]) {
      try { cached = JSON.parse(await readFile(path.join(directory, file), "utf8")); break; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    if (cached && (cached.version !== 1 || cached.interval !== "1h" || cached.start !== start || cached.end !== end || cached.source !== base || cached.fetchStart !== fetchStart)) {
      throw new Error("数据目录已属于不同周期、时间范围或来源，请使用新目录");
    }
    let contracts: Contract[] | undefined = cached?.contracts;
    let universeAt = cached?.universeAt;
    if (!contracts) {
      const info = await request("/fapi/v1/exchangeInfo") as { symbols?: { symbol: string; status: string; contractType: string; quoteAsset: string; onboardDate: number }[] };
      if (!Array.isArray(info.symbols)) throw new Error("exchangeInfo 返回格式错误");
      contracts = info.symbols.filter((s) => s.status === "TRADING" && s.contractType === "PERPETUAL" && s.quoteAsset === "USDT")
        .map((s) => ({ symbol: s.symbol, onboardDate: Number(s.onboardDate) || 0 })).sort((a, b) => a.symbol.localeCompare(b.symbol));
      universeAt = new Date().toISOString();
    }
    const symbols = parseSymbols(contracts.map((s) => s.symbol));
    const manifest: Manifest = cached ?? { version: 1, source: base, start, end, fetchStart,
      fetchedAt: new Date().toISOString(), interval: "1h", universeAt: universeAt!, contracts, symbols, files: {} };
    // Freeze the entire current contract pool before paging through history.
    await atomicJson(path.join(directory, "partial.json"), manifest);
    log(`回测池：Binance 当前全部 ${symbols.length} 个 USDT 永续合约，小时 K 线`);
    log(`获取 ${symbols.length} 个币种，${new Date(start).toISOString()} → ${new Date(end).toISOString()}；含 24h/周线预热数据`);
    for (const [index, symbol] of symbols.entries()) {
      if (manifest.files[symbol]) {
        if (manifest.files[symbol].file !== `${symbol}.json.gz`) throw new Error(`${symbol} 缓存路径错误`);
        const bytes = await readFile(path.join(directory, manifest.files[symbol].file));
        if (digest(bytes) !== manifest.files[symbol].sha256) throw new Error(`${symbol} 缓存校验失败，请使用新目录重新获取`);
        log(`[${index + 1}/${symbols.length}] ${symbol} 使用缓存`);
        continue;
      }
      const bars: Bar[] = [];
      let cursor = fetchStart;
      while (cursor < end) {
        const payload = await request(`/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=1h&startTime=${cursor}&endTime=${end - 1}&limit=499`);
        if (!Array.isArray(payload)) throw new Error(`${symbol} K 线返回格式错误`);
        if (!payload.length) break;
        const batch: Bar[] = payload.map((c: unknown[]) => [Number(c[0]), Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4]), Number(c[5]), Number(c[7])]);
        validateBars(batch);
        if (batch[0][0] < cursor || batch.at(-1)![0] >= end) throw new Error(`${symbol} 返回了请求区间外的 K 线`);
        bars.push(...batch);
        cursor = batch.at(-1)![0] + HOUR;
      }
      validateBars(bars);
      const file = `${symbol}.json.gz`;
      const bytes = gzipSync(JSON.stringify(bars));
      await writeFile(path.join(directory, `${file}.tmp`), bytes);
      await rename(path.join(directory, `${file}.tmp`), path.join(directory, file));
      manifest.files[symbol] = { file, sha256: digest(bytes), bars: bars.length,
        gaps: bars.reduce((sum, c, i) => sum + (i > 0 ? (c[0] - bars[i - 1][0]) / HOUR - 1 : 0), 0),
        first: bars[0]?.[0] ?? null, last: bars.at(-1)?.[0] ?? null };
      await atomicJson(path.join(directory, "partial.json"), manifest);
      log(`[${index + 1}/${symbols.length}] ${symbol}: ${bars.length} 根，内部缺口 ${manifest.files[symbol].gaps} 小时`);
    }
    await atomicJson(path.join(directory, "manifest.json"), manifest);
    return manifest;
  } finally {
    await client.close();
  }
}

export async function loadDataset(directory: string): Promise<Dataset> {
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as Manifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.symbols) || !manifest.files ||
    ![manifest.start, manifest.end, manifest.fetchStart].every((n) => Number.isFinite(n) && n % HOUR === 0) ||
    manifest.fetchStart > manifest.start - DAY || manifest.start >= manifest.end ||
    manifest.interval !== "1h" || !Array.isArray(manifest.contracts) ||
    !Number.isFinite(Date.parse(manifest.universeAt))) throw new Error("数据清单格式错误");
  const symbols = parseSymbols(manifest.symbols);
  if (symbols.length !== manifest.symbols.length) throw new Error("币种池包含重复项");
  if (manifest.contracts.length !== symbols.length || manifest.contracts.some((r) => !symbols.includes(r.symbol)) ||
    new Set(manifest.contracts.map((r) => r.symbol)).size !== symbols.length) throw new Error("合约信息与币种列表不一致");
  const candles = new Map<string, Bar[]>();
  for (const symbol of symbols) {
    const record = manifest.files[symbol];
    if (!record || record.file !== `${symbol}.json.gz`) throw new Error(`${symbol} 数据文件缺失或路径错误`);
    const bytes = await readFile(path.join(directory, record.file));
    if (digest(bytes) !== record.sha256) throw new Error(`${symbol} SHA256 校验失败`);
    const bars: unknown = JSON.parse(gunzipSync(bytes).toString("utf8"));
    validateBars(bars);
    if (bars.length !== record.bars || bars.some((b) => b[0] < manifest.fetchStart || b[0] >= manifest.end)) throw new Error(`${symbol} 数据范围与清单不符`);
    candles.set(symbol, bars);
  }
  return { manifest, candles };
}
