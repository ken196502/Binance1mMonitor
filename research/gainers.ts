import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadDataset } from "./data.ts";
import { buildFrames } from "./backtest.ts";
import { GAINERS_GRID, validateGainersGrid, validateGainersOptions } from "./gainers-config.ts";
import { fetchGainersMinutes, loadGainersMinutes, planGainersMinutes } from "./gainers-data.ts";
import { runGainersStudy } from "./gainers-backtest.ts";
import { writeGainersReport } from "./gainers-report.ts";
import { ARCHIVE_BASE } from "./gainers-archive.ts";
import { DAY, HOUR } from "./types.ts";
import type { GainersOptions } from "./gainers-types.ts";

export async function runGainersCommand(v: Record<string, string | boolean | undefined>) {
  if (!v.data) throw new Error("gainers 需指定 --data 全市场小时数据目录，用于重建历史涨幅榜");
  if (v.board && v.board !== "gainers") throw new Error("gainers 命令只研究涨幅榜");
  if (v.step != null) throw new Error("gainers 每分钟检查一次信号，不接受 step");
  if (v.start && v.days) throw new Error("start 与 days 不能同时指定");
  if (v["minute-source"] && !["api", "archive"].includes(String(v["minute-source"]))) throw new Error("minute-source 必须是 api 或 archive");
  if (v.offline && v["fetch-only"]) throw new Error("offline 与 fetch-only 不能同时指定");
  const n = (key: string, value: number) => {
    if (v[key] != null && !String(v[key]).trim()) throw new Error(`${key} 不能为空`);
    return Number(v[key] ?? value);
  };
  const options: GainersOptions = {
    topN: n("top", 10), highWindow: n("high-window", 100), rounds: n("rounds", 3), trialsPerRound: n("trials", 20), seed: n("seed", 42), minTrades: n("min-trades", 100),
    trainRatio: n("train-ratio", 0.6), validationRatio: n("validation-ratio", 0.2), feeBps: n("fee-bps", 5), slippageBps: n("slippage-bps", 2),
    grid: v.grid ? validateGainersGrid(JSON.parse(await readFile(String(v.grid), "utf8"))) : structuredClone(GAINERS_GRID),
  };
  validateGainersOptions(options);
  const hourly = await loadDataset(path.resolve(String(v.data)));
  const end = v.end ? Date.parse(String(v.end)) : hourly.manifest.end;
  const start = v.start ? Date.parse(String(v.start)) : v.days ? end - n("days", 1) * DAY : hourly.manifest.start;
  if (![start, end].every((t) => Number.isFinite(t) && t % HOUR === 0) || start < hourly.manifest.start || end > hourly.manifest.end || start >= end) throw new Error("研究区间需按小时对齐且在小时数据范围内");
  hourly.manifest = { ...hourly.manifest, start, end };
  const frames = buildFrames(hourly, options.topN, 1);
  const plan = planGainersMinutes(hourly, frames, options);
  const minuteDirectory = path.resolve(String(v["minutes-data"] ?? path.join(String(v.data), "gainers-1m")));
  if (!v.offline) await fetchGainersMinutes(minuteDirectory, plan, v["minute-source"] === "archive" ? ARCHIVE_BASE : hourly.manifest.source);
  if (v["fetch-only"]) return;
  const minute = await loadGainersMinutes(minuteDirectory, plan);
  const study = runGainersStudy(hourly, minute, frames, options);
  const out = path.resolve(String(v.out ?? `reports/gainers-1m/${new Date().toISOString().replaceAll(":", "-")}`), "gainers");
  await writeGainersReport(study, frames, out);
  console.log(`gainers 1m 报告：${path.join(out, "report.md")}；${study.trials.length} 组参数；最终测试 ${study.winner?.test.trades ?? 0} 笔`);
}
