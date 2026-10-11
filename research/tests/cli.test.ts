import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BOARDS, HOUR, type Study } from "../types.ts";
import { loadDataset } from "../data.ts";
import { history, OPTIONS, START } from "./helpers.ts";

async function cli(args: string[], base: string) {
  const child = spawn(process.execPath, ["--import", "tsx", "research/cli.ts", ...args], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BINANCE_BASE: base, PROXY: "", BINANCE_PROXY: "", HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "", NO_PROXY: "*", no_proxy: "*" },
  });
  let output = "";
  child.stdout.on("data", (b) => { output += b; });
  child.stderr.on("data", (b) => { output += b; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  return { code, output };
}

test("CLI downloads the full hourly pool once, reconstructs three separate histories and reruns offline", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "short-cli-test-"));
  const counts = { catalogs: 0, klines: new Map<string, number>() };
  const bars = history();
  const fake = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname.endsWith("exchangeInfo")) {
      counts.catalogs++;
      res.end(JSON.stringify({ symbols: ["AAAUSDT", "BBBUSDT"].map((symbol) => ({ symbol, status: "TRADING", quoteAsset: "USDT", contractType: "PERPETUAL" })) }));
    } else if (url.pathname.endsWith("klines")) {
      assert.equal(url.searchParams.get("interval"), "1h");
      const symbol = url.searchParams.get("symbol")!;
      counts.klines.set(symbol, (counts.klines.get(symbol) ?? 0) + 1);
      const from = Number(url.searchParams.get("startTime")), to = Number(url.searchParams.get("endTime"));
      const selected = bars.filter((c) => c[0] >= from && c[0] <= to).slice(0, Number(url.searchParams.get("limit")));
      res.end(JSON.stringify(selected.map((c) => [...c.slice(0, 6), c[0] + HOUR - 1, c[6]])));
    } else res.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  const data = path.join(directory, "data"), out = path.join(directory, "reports");
  const grid = path.join(directory, "grid.json");
  await writeFile(grid, JSON.stringify(OPTIONS.grid));
  const options = ["--top", "1", "--rounds", "3", "--trials", "4", "--min-trades", "1", "--grid", grid];
  try {
    const result = await cli(["run", "--board", "all", "--start", new Date(START).toISOString(),
      "--end", new Date(START + 600 * HOUR).toISOString(), "--data", data, "--out", out, ...options], base);
    assert.equal(result.code, 0, result.output);
    assert.equal(counts.catalogs, 1); // Full pool acquired once; each board uses its own history.
    assert.equal(counts.klines.get("AAAUSDT"), counts.klines.get("BBBUSDT")!);
    for (const board of BOARDS) {
      const dataset = await loadDataset(data);
      assert.equal(dataset.manifest.interval, "1h");
      assert.deepEqual(dataset.manifest.symbols, ["AAAUSDT", "BBBUSDT"]);
      const study = JSON.parse(await readFile(path.join(out, board, "result.json"), "utf8")) as Study;
      assert.equal(study.trials.length, 12);
      assert.ok(study.trials.every((t) => t.board === board));
      assert.equal(study.board, board);
      assert.deepEqual((await readdir(path.join(out, board))).sort(), ["board-history.csv", "report.md", "result.json", "test-trades.csv", "trials.csv"]);
      const report = await readFile(path.join(out, board, "report.md"), "utf8");
      assert.match(report, /之前 24 根已收盘小时线/);
      assert.match(report, /不跨榜去重/);
    }
    const countBefore = [...counts.klines];
    const resumed = await cli(["fetch", "--data", data], base);
    assert.equal(resumed.code, 0, resumed.output);
    assert.equal(counts.catalogs, 1);
    assert.deepEqual([...counts.klines], countBefore);
    await new Promise<void>((resolve) => fake.close(() => resolve()));
    const offlineOut = path.join(directory, "offline");
    const offline = await cli(["backtest", "--board", "volume", "--data", data, "--out", offlineOut, ...options], "http://127.0.0.1:1");
    assert.equal(offline.code, 0, offline.output);
    const onlineStudy = JSON.parse(await readFile(path.join(out, "volume", "result.json"), "utf8"));
    const offlineStudy = JSON.parse(await readFile(path.join(offlineOut, "volume", "result.json"), "utf8"));
    assert.deepEqual(offlineStudy.trials, onlineStudy.trials);
    assert.deepEqual(offlineStudy.winner, onlineStudy.winner);
    const invalid = await cli(["backtest", "--board", "volume", "--data", data, "--rounds", "0"], "http://127.0.0.1:1");
    assert.equal(invalid.code, 1);
    const bytesPath = path.join(data, "AAAUSDT.json.gz");
    await writeFile(bytesPath, "corrupt");
    await assert.rejects(loadDataset(data), /SHA256/);
  } finally {
    if (fake.listening) await new Promise<void>((resolve) => fake.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI help does not start services, and unknown flags fail", async () => {
  const help = await cli(["--help"], "http://127.0.0.1:1");
  assert.equal(help.code, 0);
  assert.match(help.output, /三个独立研究/);
  assert.equal((await cli(["run", "--unknown"], "http://127.0.0.1:1")).code, 1);
  assert.equal((await cli(["run", "--start", "2025-02-30", "--end", "2025-03-05"], "http://127.0.0.1:1")).code, 1);
});
