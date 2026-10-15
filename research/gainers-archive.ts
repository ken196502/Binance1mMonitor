import { inflateRawSync } from "node:zlib";
import { createBinanceClient } from "./client.ts";
import { digest, validateBars } from "./data.ts";
import { DAY, type Bar } from "./types.ts";
import { MINUTE } from "./gainers-types.ts";

export const ARCHIVE_BASE = "https://data.binance.vision";

/** Binance daily archives contain one CSV; never extract paths to the filesystem. */
export function decodeArchive(zip: Buffer, interval = MINUTE): Bar[] {
  let eocd = zip.length - 22;
  while (eocd >= Math.max(0, zip.length - 65557) && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0 || zip.readUInt32LE(eocd) !== 0x06054b50 || zip.readUInt16LE(eocd + 10) !== 1) throw new Error("归档必须包含一个 CSV 文件");
  const central = zip.readUInt32LE(eocd + 16);
  if (central + 46 > zip.length || zip.readUInt32LE(central) !== 0x02014b50) throw new Error("ZIP 中央目录无效");
  const method = zip.readUInt16LE(central + 10);
  const compressed = zip.readUInt32LE(central + 20), size = zip.readUInt32LE(central + 24);
  const local = zip.readUInt32LE(central + 42);
  if (size > 2_000_000 || local + 30 > central || zip.readUInt32LE(local) !== 0x04034b50) throw new Error("ZIP 文件大小或本地目录无效");
  const begin = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  if (begin + compressed > central) throw new Error("ZIP 内容越界");
  const payload = zip.subarray(begin, begin + compressed);
  const bytes = method === 0 ? payload : method === 8 ? inflateRawSync(payload, { maxOutputLength: 2_000_000 }) : null;
  if (!bytes || bytes.length !== size) throw new Error("ZIP 压缩格式或解压长度错误");
  const rows = bytes.toString("utf8").trim().split(/\r?\n/);
  if (rows[0].startsWith("open_time,")) rows.shift();
  const bars: Bar[] = rows.filter(Boolean).map((row) => {
    const c = row.split(",");
    if (c.length !== 12) throw new Error("归档 K 线 CSV 列数错误");
    return [Number(c[0]), Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4]), Number(c[5]), Number(c[7])];
  });
  validateBars(bars, interval);
  return bars;
}

export async function createArchiveClient(interval: '1m' | '1d' = '1m') {
  const client = await createBinanceClient(ARCHIVE_BASE);
  return {
    close: client.close,
    async candles(symbol: string, ranges: [number, number][], evidence: Record<string, string>): Promise<Bar[]> {
      const days = new Set<number>();
      for (const [start, end] of ranges) for (let day = Math.floor(start / DAY) * DAY; day < end; day += DAY) days.add(day);
      const bars: Bar[] = [];
      const periods = new Map<string, { begin: number; end: number; frequency: string }>();
      const now = new Date(), currentMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
      for (const day of [...days].sort((a, b) => a - b)) {
        const d = new Date(day);
        const monthly = interval === '1d' && day < currentMonth;
        const date = d.toISOString().slice(0, monthly ? 7 : 10);
        periods.set(date, monthly ? { begin: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1), frequency: 'monthly' }
          : { begin: day, end: day + DAY, frequency: 'daily' });
      }
      for (const [date, period] of periods) {
        const name = `${symbol}-${interval}-${date}.zip`;
        const endpoint = `/data/futures/um/${period.frequency}/klines/${encodeURIComponent(symbol)}/${interval}/${encodeURIComponent(name)}`;
        const checksum = String(await client.request(`${endpoint}.CHECKSUM`, "text")).trim().split(/\s+/)[0];
        const zip = await client.request(endpoint, "bytes") as Buffer;
        if (!/^[a-f0-9]{64}$/i.test(checksum) || digest(zip) !== checksum.toLowerCase()) throw new Error(`${name} 官方归档 SHA256 校验失败`);
        const daily = decodeArchive(zip, interval === '1d' ? DAY : MINUTE);
        if (daily.some((b) => b[0] < period.begin || b[0] >= period.end)) throw new Error(`${name} 数据不属于请求日期`);
        evidence[endpoint] = checksum.toLowerCase();
        bars.push(...daily.filter((c) => ranges.some(([a, b]) => c[0] >= a && c[0] < b)));
      }
      return bars;
    },
  };
}
