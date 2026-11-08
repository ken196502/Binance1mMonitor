import { factorRanges, type FactorWindows } from "./factor-settings.ts";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle } from "./macd.ts";
import type { Ticker24h } from "./binance.ts";
import type { MinuteBoard } from "./strategy-replay.ts";
import { FACTOR_MAX_DATA_AGE_MS, MINUTE_MS } from "./factor-policy.ts";

export const DEFAULT_KLINE_RETENTION_HOURS = 48;
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve("data");
export const DEFAULT_RESEARCH_ROOT = process.env.RESEARCH_DATA_DIR
  ? path.resolve(process.env.RESEARCH_DATA_DIR)
  : path.join(DATA_DIR, "research");
export const DEFAULT_SIGNALS_DIR = process.env.SIGNALS_DATA_DIR
  ? path.resolve(process.env.SIGNALS_DATA_DIR)
  : path.join(DATA_DIR, "signals");

export interface PruneResult {
  deletedFiles: string[];
  trimmedFiles: string[];
  prunedLines: number;
}

export interface FactorDataset {
  candles: Map<string, Candle[]>;
  boards: Map<number, MinuteBoard>;
  times: number[];
  indices: Map<string, Map<number, number>>;
  dataAsOf: number;
  datasetHash: string;
}
export interface BoardSnapshot { observedAt: number; tickers: Ticker24h[] }

/** Archive the actual monitored board, including symbols without minute history. */
export async function persistFactorBoard(tickers: Ticker24h[], observedAt: number, root = DEFAULT_RESEARCH_ROOT): Promise<void> {
  const dir = path.join(root, "live-boards");
  await mkdir(dir, { recursive: true });
  const day = new Date(observedAt).toISOString().slice(0, 10).replaceAll("-", "");
  await appendFile(path.join(dir, `${day}.jsonl`), JSON.stringify({ observedAt, tickers }) + "\n");
}

/** A snapshot observed during a minute becomes usable at the NEXT minute open. */
export function buildFactorBoards(snapshots: BoardSnapshot[], times: number[]): Map<number, MinuteBoard> {
  const sorted = [...snapshots].sort((a, b) => a.observedAt - b.observedAt);
  const result = new Map<number, MinuteBoard>();
  let i = 0;
  let latest: BoardSnapshot | undefined;
  for (const time of times) {
    while (i < sorted.length && sorted[i].observedAt < time) latest = sorted[i++];
    const board: MinuteBoard = new Map();
    if (latest && time - latest.observedAt <= 2 * MINUTE_MS) {
      latest.tickers.forEach((t, rank) => board.set(t.symbol, {
        rank: rank + 1, dayChange: t.priceChangePercent, high24h: t.highPrice, low24h: t.lowPrice,
      }));
    }
    // Empty frames deliberately stop stale rankings being carried forward by replay.
    result.set(time, board);
  }
  return result;
}

async function readRecentLines(dir: string, from: number, until: number): Promise<unknown[]> {
  let files: string[];
  try { files = await readdir(dir); } catch (error: any) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const firstDay = new Date(from).toISOString().slice(0, 10).replaceAll("-", "");
  const lastDay = new Date(until).toISOString().slice(0, 10).replaceAll("-", "");
  const rows: unknown[] = [];
  for (const file of files.sort()) {
    const match = file.match(/^(?:([A-Z0-9]+)-)?(\d{8})\.jsonl$/);
    if (!match || match[2] < firstDay || match[2] > lastDay) continue;
    const lines = (await readFile(path.join(dir, file), "utf8")).split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        const row = JSON.parse(lines[i]);
        rows.push(match[1] ? { ...row, symbol: match[1] } : row);
      } catch {
        if (i !== lines.length - 1) throw new Error(`行情归档损坏: ${file}:${i + 1}`);
      }
    }
  }
  return rows;
}

export async function loadFactorDataset(now: number, root = DEFAULT_RESEARCH_ROOT, windows?: Partial<FactorWindows>): Promise<FactorDataset> {
  const cutoff = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const from = factorRanges(cutoff, windows).earliestStart - 500 * MINUTE_MS;
  const [rawCandles, rawBoards] = await Promise.all([
    readRecentLines(path.join(root, "live-1m"), from, cutoff),
    readRecentLines(path.join(root, "live-boards"), from, cutoff),
  ]);
  const bySymbol = new Map<string, Map<number, Candle>>();
  let candleEnd = 0;
  for (const raw of rawCandles) {
    const b = raw as Candle & { symbol: string };
    if (![b.time, b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) ||
      b.time % MINUTE_MS !== 0 || b.time < from || b.time + MINUTE_MS > cutoff ||
      b.low <= 0 || b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close)) continue;
    const map = bySymbol.get(b.symbol) ?? new Map<number, Candle>();
    map.set(b.time, { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
    bySymbol.set(b.symbol, map);
    candleEnd = Math.max(candleEnd, b.time + MINUTE_MS);
  }
  const snapshots = (rawBoards as BoardSnapshot[]).filter(b => Number.isFinite(b.observedAt) &&
    b.observedAt >= from && b.observedAt < cutoff && Array.isArray(b.tickers) && b.tickers.length > 0 &&
    b.tickers.every(t => typeof t.symbol === "string" && Number.isFinite(t.priceChangePercent)));
  const boardEnd = snapshots.reduce((max, b) => Math.max(max, Math.ceil(b.observedAt / MINUTE_MS) * MINUTE_MS), 0);
  const dataAsOf = Math.min(candleEnd, boardEnd, cutoff);
  if (!candleEnd || !boardEnd || now - dataAsOf > FACTOR_MAX_DATA_AGE_MS) throw new Error("近期行情或实际榜单不足/过期，等待归档积累");
  const candles = new Map<string, Candle[]>();
  const indices = new Map<string, Map<number, number>>();
  const timeSet = new Set<number>();
  const hash = createHash("sha256");
  for (const symbol of [...bySymbol.keys()].sort()) {
    const list = [...bySymbol.get(symbol)!.values()].filter(b => b.time + MINUTE_MS <= dataAsOf).sort((a, b) => a.time - b.time);
    candles.set(symbol, list);
    indices.set(symbol, new Map(list.map((b, i) => { timeSet.add(b.time); return [b.time, i]; })));
    hash.update(symbol + JSON.stringify(list));
  }
  const times = [...timeSet].sort((a, b) => a - b);
  const boards = buildFactorBoards(snapshots, times);
  for (const [time, board] of boards) hash.update(JSON.stringify([time, [...board]]));
  return { candles, indices, times, boards, dataAsOf, datasetHash: hash.digest("hex").slice(0, 16) };
}

export async function pruneExpiredArchives(
  root = DEFAULT_RESEARCH_ROOT,
  retentionHours = DEFAULT_KLINE_RETENTION_HOURS,
  now = Date.now(),
  extraDirs: string[] = [DEFAULT_SIGNALS_DIR],
): Promise<PruneResult> {
  const retentionMs = retentionHours * 3600_000;
  const cutoffTime = now - retentionMs;
  const cutoffDay = new Date(cutoffTime).toISOString().slice(0, 10).replaceAll("-", "");

  const result: PruneResult = {
    deletedFiles: [],
    trimmedFiles: [],
    prunedLines: 0,
  };

  const targets = [
    { dir: path.join(root, "live-1m") },
    { dir: path.join(root, "live-boards") },
    ...extraDirs.map((dir) => ({ dir })),
  ];

  for (const { dir } of targets) {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (e: any) {
      if (e.code === "ENOENT") continue;
      throw e;
    }

    for (const file of files) {
      const match = file.match(/^(?:([A-Z0-9]+)-)?(\d{8})\.jsonl$/);
      if (!match) continue;
      const fileDay = match[2];
      const filePath = path.join(dir, file);

      // 仅整天文件清理：早于 cutoffDay 的完整天文件直接删除，不在日内做逐行重写，保护磁盘寿命
      if (fileDay < cutoffDay) {
        try {
          await unlink(filePath);
          result.deletedFiles.push(filePath);
        } catch {}
      }
    }
  }

  return result;
}

export async function loadRecentCandlesFromDisk(
  symbol: string,
  from: number,
  until = Date.now(),
  root = DEFAULT_RESEARCH_ROOT,
): Promise<Candle[]> {
  const dir = path.join(root, "live-1m");
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error: any) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const firstDay = new Date(from).toISOString().slice(0, 10).replaceAll("-", "");
  const lastDay = new Date(until).toISOString().slice(0, 10).replaceAll("-", "");
  const matchingFiles = files
    .filter(f => {
      const match = f.match(new RegExp(`^${symbol}-(\\d{8})\\.jsonl$`));
      return match && match[1] >= firstDay && match[1] <= lastDay;
    })
    .sort();

  const candles: Candle[] = [];
  const seenTimes = new Set<number>();
  for (const file of matchingFiles) {
    try {
      const content = await readFile(path.join(dir, file), "utf8");
      const lines = content.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const c = JSON.parse(line) as Candle;
          if (c.time >= from && c.time <= until && !seenTimes.has(c.time) &&
            [c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) &&
            c.low > 0 && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close)) {
            seenTimes.add(c.time);
            candles.push(c);
          }
        } catch {}
      }
    } catch {}
  }
  candles.sort((a, b) => a.time - b.time);
  return candles;
}

