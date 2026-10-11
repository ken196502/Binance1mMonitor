import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { digest } from "./data.ts";
import { shortReturn } from "./backtest.ts";
import type { Frame, Metrics } from "./types.ts";
import type { GainersStudy } from "./gainers-types.ts";

const number = (n: number | null | undefined, digits = 3) => n == null ? "—" : n.toFixed(digits);
const iso = (n: number) => new Date(n).toISOString();
const csv = (rows: unknown[][]) => rows.map((r) => r.map((v) => `"${String(v ?? "").replaceAll('"', '""')}"`).join(",")).join("\n") + "\n";
const parameterNames = ["highRatio", "holdMinutes", "stopLossPercent", "takeProfitPercent"] as const;

export async function writeGainersReport(study: GainersStudy, frames: Frame[], directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length) throw new Error(`报告目录非空，请指定新目录：${directory}`);
  const files = ["types.ts", "data.ts", "client.ts", "backtest.ts", "cli.ts", "gainers.ts", "gainers-types.ts", "gainers-config.ts", "gainers-data.ts", "gainers-archive.ts", "gainers-backtest.ts", "gainers-report.ts"];
  const sourceHashes = Object.fromEntries(await Promise.all(files.map(async (file) => [file, digest(await readFile(new URL(file, import.meta.url)))])));
  const engineSha256 = digest(Buffer.from(JSON.stringify(sourceHashes)));
  const { hourly: h, minute: m, options: o, winner: w, split: s } = study;
  const membership = new Map<string, number>();
  for (const f of frames) for (const row of f.boards.gainers) membership.set(row.symbol, (membership.get(row.symbol) ?? 0) + 1);
  const minuteFiles = Object.values(m.files);
  const eligible = frames.map((f) => f.eligibleSymbols);
  const combinations = o.grid.highRatio.length * o.grid.holdMinutes.length * o.grid.stopLossPercent.reduce((sum, stop) => sum + o.grid.takeProfitPercent.filter((take) => take / stop >= 3).length, 0);
  const lines = [
    "# Gainers：1m DEA 高位 + DIF 多头做空研究", "",
    w ? `最终留出测试 ${w.test.trades} 笔；平均净收益 ${number(w.test.meanNetPercent)}%；扣费胜率 ${number(w.test.winRate, 1)}%。` : "没有参数达到训练和验证样本下限，未进入最终测试。", "",
    w && w.test.trades ? (w.test.meanNetPercent! > 0 ? "本次留出段平均净收益为正，仍需新的独立时期验证。" : "本次留出段平均净收益不为正，当前结果不支持该参数集的盈利假设。") : "没有可用于评价效果的最终测试交易。",
    "这是等名义金额的单笔交易统计，不是组合资金收益。", "",
    `生成时间：${study.createdAt}；策略：${study.strategy}；随机种子：${o.seed}。`, "",
    "## 入场与退出", "",
    `只研究历史涨幅榜前 ${o.topN} 名。每分钟收盘后，MACD(12,26,9) 的 **DEA > 0、DEA ≥ highRatio × 最近 ${o.highWindow} 根已收盘 1m DEA 峰值（含当根）、DIF ≥ DEA** 即可做空。高位判断和多头状态是全部指标入场条件。`, "",
    "不要求死叉、阴线、连阴、量比、周涨幅或额外的日涨幅门槛。DIF 等于 DEA 也算多头。下一根分钟线开盘入场；同币同时一笔，其他币可同时持仓；退出后下一分钟条件仍满足即可重入，没有冷却期。离榜不强制平仓。", "",
    `小止损网格 ${o.grid.stopLossPercent.join(" / ")}%；大止盈网格 ${o.grid.takeProfitPercent.join(" / ")}%；仅搜索止盈/止损 ≥ 3 的组合。最长持有 ${o.grid.holdMinutes.join(" / ")} 分钟；DEA 高位比例 ${o.grid.highRatio.join(" / ")}。`, "",
    `单边手续费 ${o.feeBps} bps + 滑点 ${o.slippageBps} bps；入场、出场分别按各自名义金额扣费。毛收益 = (入场价 − 出场价) / 入场价 × 100%。`, "",
    "止盈止损基于 1m OHLC：开盘越过阈值按开盘价退出；同根内同时触及两侧时止损优先，记为顺序不明；持有期到期按最后一分钟收盘退出。成交成本采用固定费率模型，未模拟订单簿或真实止损成交。", "",
    "## 数据与历史榜单", "",
    `小时数据来源 ${h.source}；分钟数据来源 ${m.source}。研究区间 [${iso(h.start)}, ${iso(h.end)})。当前合约池获取时间 ${h.universeAt}，共 ${h.symbols.length} 个 USDT 永续合约。`, "",
    "历史每个整点 t，用回测池各币之前 24 根已收盘小时线，即 [t−24h, t)，计算 (窗口末 close / 窗口首 open − 1) × 100% 并降序排名；当前小时内沿用该榜单，下一整点刷新。没有用当前榜单回填历史。分钟数据只补取历史入榜窗口、指标预热及退出窗口，排名的基础池仍是全部合约。", "",
    `共 ${frames.length} 个整点、${membership.size} 个历史入榜币种；整点具备连续 24h 数据的币种数 ${eligible.length ? Math.min(...eligible) : 0}–${eligible.length ? Math.max(...eligible) : 0}；${eligible.filter((n) => n < h.symbols.length).length} 个时点未覆盖池内全部币种。`, "",
    `小时 K 线 ${Object.values(h.files).reduce((n, f) => n + f.bars, 0)} 根；分钟 K 线 ${minuteFiles.reduce((n, f) => n + f.bars, 0)} 根；请求窗口内缺失 ${minuteFiles.reduce((n, f) => n + f.missingMinutes, 0)} 分钟。每个连续分钟片段预热 ${m.plan.warmupMinutes} 根，缺口后重置指标并重新预热；不插值、不填零。候选分钟信号共 ${study.signalCount} 条（尚未按持仓占用、分段或具体参数过滤）。`, "",
    "合约池来自当前仍在交易的 USDT 永续，缺少历史已退市币种，存在存活偏差。榜单是本池内整点重建结果，并非逐分钟刷新或完整历史全市场榜单。", "",
    "## 多轮参数搜索", "",
    `请求 ${o.rounds} 轮 × ${o.trialsPerRound} 组，实际运行 ${study.trials.length} 个不同组合；网格中符合盈亏比条件的组合共 ${combinations} 个。首轮随机探索，后续围绕训练前五名变动参数并保留全局探索。`, "",
    `训练 [${iso(s.start)}, ${iso(s.trainEnd)})；验证 [${iso(s.trainEnd)}, ${iso(s.validationEnd)})；最终测试 [${iso(s.validationEnd)}, ${iso(s.end)})。`, "",
    `搜索只使用训练区间。训练至少 ${o.minTrades} 笔的候选按平均净收益取前五名进入验证；验证至少 ${Math.ceil(o.minTrades / 3)} 笔，再按平均净收益选择一个参数集，均值相同优先较低回撤。最终测试只运行该参数集一次。`, "",
    "每组参数按其最大持有期剔除跨区间边界的信号，避免提前看退出结果决定是否纳入；缺失退出行情的交易排除并计数。历史指标可以使用区间之前的数据预热。", "",
    "| 轮次 | 新组合 | 满足训练样本下限 | 训练最高平均净收益 % |", "|---|---|---|---|",
  ];
  for (let round = 1; round <= o.rounds; round++) {
    const trials = study.trials.filter((t) => t.round === round);
    const valid = trials.filter((t) => t.train.trades >= o.minTrades);
    lines.push(`| ${round} | ${trials.length} | ${valid.length} | ${number(valid.length ? Math.max(...valid.map((t) => t.train.meanNetPercent!)) : null)} |`);
  }
  if (w) {
    const p = w.parameters;
    const win = shortReturn(100, 100 - p.takeProfitPercent, o.feeBps + o.slippageBps).netPercent;
    const loss = -shortReturn(100, 100 + p.stopLossPercent, o.feeBps + o.slippageBps).netPercent;
    lines.push("", "## 验证选定的参数", "", `参数 ID：${w.trialId}；\`${JSON.stringify(p)}\`。`, "",
      `名义盈亏比 ${number(p.takeProfitPercent / p.stopLossPercent, 2)}:1；无跳空、仅止盈/止损情形下，扣费盈利 ${number(win)}%、亏损 ${number(loss)}%，净盈亏比 ${number(win / loss, 2)}:1，理论保本胜率 ${number(loss / (win + loss) * 100, 2)}%。实际包含超时退出和跳空，不能直接套用此胜率。`, "",
      "| 区间 | 笔数 | 胜率 % | 平均净收益 % | 收益因子 | 最差单笔 % | 累加收益百分点回撤 | 缺失 | 边界剔除 |", "|---|---|---|---|---|---|---|---|---|");
    const row = (label: string, metric: Metrics) => `| ${label} | ${metric.trades} | ${number(metric.winRate, 1)} | ${number(metric.meanNetPercent)} | ${metric.profitFactor == null && metric.trades && metric.lossPercent === 0 ? "无亏损样本" : number(metric.profitFactor)} | ${number(metric.worstTradePercent)} | ${number(metric.maxDrawdownPoints)} | ${metric.missing} | ${metric.purged} |`;
    lines.push(row("训练", w.train), row("验证", w.validation), row("最终测试", w.test), "", "### 最终测试退出分布", "", "| 原因 | 笔数 | 占比 % | 平均净收益 % |", "|---|---|---|---|");
    for (const reason of ["stop", "target", "timeout"] as const) {
      const trades = w.testTrades.filter((t) => t.reason === reason);
      lines.push(`| ${{ stop: "止损", target: "止盈", timeout: "超时" }[reason]} | ${trades.length} | ${number(w.test.trades ? trades.length / w.test.trades * 100 : null, 1)} | ${number(trades.length ? trades.reduce((sum, t) => sum + t.netPercent, 0) / trades.length : null)} |`);
    }
    lines.push("", `其中 ${w.testTrades.filter((t) => t.ambiguous).length} 笔在退出分钟内同时触及止盈止损，按止损计；测试覆盖 ${new Set(w.testTrades.map((t) => t.symbol)).size} 个币种。${w.test.trades < o.minTrades ? "测试笔数少于训练样本下限，结果仅供描述。" : ""}`);
  }
  lines.push("", "## 训练候选（非测试排名）", "", "| 参数 ID | 训练笔数 | 训练平均净收益 % | 验证笔数 | 验证平均净收益 % | 参数 |", "|---|---|---|---|---|---|");
  for (const t of [...study.trials].sort((a, b) => (b.train.meanNetPercent ?? -Infinity) - (a.train.meanNetPercent ?? -Infinity)).slice(0, 15)) {
    lines.push(`| ${t.id} | ${t.train.trades} | ${number(t.train.meanNetPercent)} | ${t.validation?.trades ?? "未入围"} | ${number(t.validation?.meanNetPercent)} | \`${JSON.stringify(t.parameters)}\` |`);
  }
  lines.push("", "## 解释边界与复现", "",
    "- 累加收益百分点回撤按等名义交易的退出时点累加，不是组合资金回撤；未模拟资金占用、复利、杠杆和资金费率。",
    "- 币种与连续重入交易可能高度相关，多轮选参存在多重检验偏差。此报告仅保证本次搜索不读测试结果；若同一历史区间此前已用于研究，不能把它当成从未观察过的独立样本。",
    "- `result.json` 保存数据清单、代码哈希、全部试验和最终测试；`trials.csv` 保存全部参数的训练/验证指标；`test-trades.csv` 保存逐笔交易及 1m 入场指标；`board-history.csv` 保存逐整点历史涨幅榜。",
    `- 小时清单 SHA256：\`${m.plan.hourlyHash}\`；分钟清单 SHA256：\`${digest(Buffer.from(JSON.stringify(m)))}\`；研究代码索引 SHA256：\`${engineSha256}\`。逐源文件哈希见 result.json。`, "");
  const trials: unknown[][] = [["id", "round", ...parameterNames, "train_trades", "train_win_rate_pct", "train_mean_net_pct", "train_drawdown_points", "train_missing", "train_purged", "validation_trades", "validation_mean_net_pct"]];
  for (const t of study.trials) trials.push([t.id, t.round, ...parameterNames.map((k) => t.parameters[k]), t.train.trades, t.train.winRate, t.train.meanNetPercent, t.train.maxDrawdownPoints, t.train.missing, t.train.purged, t.validation?.trades, t.validation?.meanNetPercent]);
  const trades: unknown[][] = [["symbol", "historical_rank", "board_utc", "signal_close_utc", "entry_utc", "exit_utc", "entry_price", "exit_price", "reason", "ambiguous_minute", "gross_pct", "net_pct", "dif_1m", "dea_1m", "peak_dea_1m", "dea_peak_ratio"]];
  for (const t of w?.testTrades ?? []) trades.push([t.symbol, t.rank, iso(t.boardTime), iso(t.signal.time), iso(t.entryTime), iso(t.exitTime), t.entryPrice, t.exitPrice, t.reason, t.ambiguous, t.grossPercent, t.netPercent, t.signal.dif, t.signal.dea, t.signal.peakDea, t.signal.deaPeakRatio]);
  const boards: unknown[][] = [["time_utc", "board", "rank", "symbol", "change_24h_pct", "quote_volume_24h", "eligible_market_symbols"]];
  for (const f of frames) for (const row of f.boards.gainers) boards.push([iso(f.time), "gainers", row.rank, row.symbol, row.dayChange, row.quoteVolume, f.eligibleSymbols]);
  await writeFile(path.join(directory, "result.json"), JSON.stringify({ ...study, sourceHashes, engineSha256 }, null, 2));
  await writeFile(path.join(directory, "trials.csv"), csv(trials));
  await writeFile(path.join(directory, "test-trades.csv"), csv(trades));
  await writeFile(path.join(directory, "board-history.csv"), csv(boards));
  await writeFile(path.join(directory, "report.md"), lines.join("\n"));
}
