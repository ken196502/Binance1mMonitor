import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fetchDataset, loadDataset } from "./data.ts";
import { buildFrames } from "./backtest.ts";
import { DEFAULT_GRID, runStudy, validateGrid, validateOptions } from "./search.ts";
import { writeReport } from "./report.ts";
import { BOARDS, HOUR, type Board, type Manifest, type SearchOptions } from "./types.ts";

const HELP = `独立做空策略研究 CLI

用法：npm run research -- <gainers|fetch|backtest|run> [选项]

gainers   当前研究：历史涨幅榜 + 1m DEA高位/DIF多头做空，小止损大止盈
          只用这两个 1m 条件入场，不要求死叉、阴线、量比或周线过滤
          必填 --data；自动补分钟数据后回测。--offline 可仅用缓存
          默认3轮×20组；止损0.2/0.3/0.5%，止盈1.5/2/3/5%，至少3R
--minutes-data DIR                gainers 的分钟缓存目录
--minute-source api|archive       gainers 分钟来源（默认 api）；archive 为官方历史归档
--high-window N                   gainers 的 DEA 高位窗口（默认100根1m）
--offline                         gainers 仅使用本地分钟缓存
--fetch-only                      gainers 仅补取分钟数据

原小时级研究命令（保留复现旧报告）：

fetch     获取 Binance 当前全部 USDT 永续合约的历史 1h K 线并缓存
backtest  离线重建历史 24h 榜单，分榜多轮参数回测、生成报告
run       获取数据后执行回测与报告

--board gainers|losers|volume|all   研究榜单（默认 all）；all 运行三个独立研究
--top N                           每个历史榜单前 N（默认 10）
--days N                          历史天数（默认 30；与 --start 互斥）
--start ISO --end ISO              时间范围 [start,end)，需按整小时对齐
--data DIR                        全市场小时数据目录（backtest 必填）
--out DIR                         报告根目录，分别保存到 DIR/<board>/
--rounds N                        参数搜索轮数（默认 3）
--trials N                        每轮新参数数（默认 24）
--grid FILE                       参数网格 JSON（research/grid.example.json）
--seed N                          随机种子（默认 42）
--min-trades N                    训练最少交易数（默认 20）
--step N                          信号检查间隔，小时（默认 1）
--train-ratio N                   训练比例（默认 0.6）
--validation-ratio N              验证比例（默认 0.2；剩余为最终测试）
--fee-bps N --slippage-bps N       单边费用与滑点（默认 5 / 2）
--help                            显示帮助

示例：
npm run research -- gainers --data data/research/hourly-initial --minutes-data data/research/gainers-1m-initial --out reports/gainers-1m
npm run research -- run --days 30 --rounds 3 --trials 24 --data data/hourly --out reports/study-01
npm run research -- backtest --board gainers --data data/hourly --out reports/gainers-rerun --seed 43

数据池覆盖当前全部 USDT 永续；历史排名仅使用当时已收盘的 24 根小时 K 线。
三榜独立产生样本、调参和报告；同币跨榜不去重。研究不启动服务或发送通知。
`;

function date(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:00(?::00(?:\.000)?)?(?:Z|[+-]\d{2}:00))?$/.test(value)) throw new Error(`日期必须带时区并按小时对齐：${value}`);
  const n = Date.parse(value);
  const day = value.slice(0, 10);
  if (!Number.isFinite(n) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day || n % HOUR !== 0) throw new Error(`无效日期：${value}`);
  return n;
}
async function main() {
  const strings = ["board", "top", "days", "start", "end", "data", "out", "rounds", "trials", "grid", "seed", "min-trades", "step", "train-ratio", "validation-ratio", "fee-bps", "slippage-bps", "minutes-data", "minute-source", "high-window"];
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true,
    options: Object.fromEntries([...strings.map((name) => [name, { type: "string" as const }]), ...["help", "offline", "fetch-only"].map((name) => [name, { type: "boolean" as const }])]) });
  const v = values as Record<string, string | boolean | undefined>;
  if (v.help || !positionals.length) { console.log(HELP); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || !["gainers", "fetch", "backtest", "run"].includes(command)) throw new Error("命令必须是 gainers、fetch、backtest 或 run");
  if (command === "gainers") {
    const { runGainersCommand } = await import("./gainers.ts");
    await runGainersCommand(v);
    return;
  }
  if (["minutes-data", "minute-source", "high-window", "offline", "fetch-only"].some((k) => v[k] != null)) throw new Error("分钟策略参数仅适用于 gainers 命令");
  const get = (key: string, fallback: string) => String(v[key] ?? fallback);
  const numeric = (key: string, fallback: string) => {
    const value = get(key, fallback);
    if (!value.trim()) throw new Error(`${key} 不能为空`);
    return Number(value);
  };
  const board = get("board", "all");
  if (board !== "all" && !BOARDS.includes(board as Board)) throw new Error("board 必须为 gainers、losers、volume 或 all");
  const boards: Board[] = board === "all" ? [...BOARDS] : [board as Board];
  const tag = new Date().toISOString().replaceAll(":", "-");
  if (command === "backtest" && !v.data) throw new Error("离线 backtest 必须指定 --data 数据目录");
  if (command === "backtest" && ["days", "start", "end"].some((k) => v[k] != null)) throw new Error("backtest 使用数据清单的时间范围，不能指定 days/start/end");
  const directory = path.resolve(get("data", `data/research/${tag}`));
  const outRoot = path.resolve(get("out", `reports/research/${tag}`));
  const options: SearchOptions = {
    topN: numeric("top", "10"), stepHours: numeric("step", "1"), rounds: numeric("rounds", "3"), trialsPerRound: numeric("trials", "24"), seed: numeric("seed", "42"), minTrades: numeric("min-trades", "20"),
    trainRatio: numeric("train-ratio", "0.6"), validationRatio: numeric("validation-ratio", "0.2"), feeBps: numeric("fee-bps", "5"), slippageBps: numeric("slippage-bps", "2"),
    grid: v.grid ? validateGrid(JSON.parse(await readFile(String(v.grid), "utf8"))) : structuredClone(DEFAULT_GRID),
  };
  validateOptions(options);
  if (v.start && v.days) throw new Error("--start 与 --days 不能同时指定");
  const days = numeric("days", "30");
  if (!Number.isFinite(days) || days <= 0 || days > 365) throw new Error("days 需为 (0,365]");
  let end = v.end ? date(String(v.end)) : Math.floor(Date.now() / HOUR) * HOUR;
  let start = v.start ? date(String(v.start)) : end - Math.round(days * 24) * HOUR;
  if (command !== "backtest" && !v.start && !v.end && !v.days) {
    for (const file of ["manifest.json", "partial.json"]) {
      try {
        const m = JSON.parse(await readFile(path.join(directory, file), "utf8")) as Manifest;
        start = m.start; end = m.end; break;
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
  }
  console.log(`全市场小时数据：${directory}；独立研究任务：${boards.join(", ")}`);
  if (command !== "backtest") await fetchDataset({ directory, start, end });
  if (command === "fetch") return;
  const dataset = await loadDataset(directory);
  console.log("根据每个历史时点的前 24 根小时 K 线重建榜单…");
  const frames = buildFrames(dataset, options.topN, options.stepHours);
  let failures = 0;
  for (const b of boards) {
    try {
      const study = runStudy(dataset, b, options, console.log, frames);
      const destination = path.join(outRoot, b);
      await writeReport(study, destination, frames);
      console.log(`${b} 报告：${path.join(destination, "report.md")}；参数组 ${study.trials.length}；最终测试交易 ${study.winner?.test.trades ?? 0}`);
    } catch (e) {
      failures++;
      console.error(`[${b}] ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (failures) throw new Error(`${failures} 个独立研究任务失败，其他任务的成功报告已保留`);
}

main().catch((e: unknown) => {
  console.error(`[research] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
