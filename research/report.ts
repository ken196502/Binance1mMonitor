import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "./data.ts";
import { BOARD_NAMES, type Frame, type Metrics, type Study } from "./types.ts";

const number = (n: number | null, digits = 3) => n == null ? "—" : n.toFixed(digits);
const iso = (n: number) => new Date(n).toISOString();
const csv = (rows: unknown[][]) => rows.map((r) => r.map((v) => `"${String(v ?? "").replaceAll('"', '""')}"`).join(",")).join("\n") + "\n";
const parameterNames = ["holdHours", "minStreak", "volumeRatio", "weekFilter", "dayMovePercent", "highRatio", "stopLossPercent", "takeProfitPercent"] as const;

export async function writeReport(study: Study, directory: string, frames: Frame[]): Promise<void> {
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length) throw new Error(`报告目录非空，请指定新目录：${directory}`);
  const sources = await Promise.all(["types.ts", "data.ts", "client.ts", "backtest.ts", "search.ts", "report.ts", "cli.ts"].map((file) => readFile(fileURLToPath(new URL(file, import.meta.url)))));
  const engineSha256 = digest(Buffer.concat(sources));
  const { dataset: d, options: o, split: s, winner: w } = study;
  const lines = [
    `# ${BOARD_NAMES[study.board]}：独立做空策略研究`, "",
    `生成时间：${study.createdAt}；研究版本：${study.version}；随机种子：${o.seed}。`, "",
    "## 结果概览", "",
    w ? `最终留出测试：${w.test.trades} 笔交易，平均扣费净收益 ${number(w.test.meanNetPercent)}%，胜率 ${number(w.test.winRate, 1)}%。这是单笔统计，不是组合收益。${w.test.trades < o.minTrades ? " 测试样本数量较少，结果仅供描述。" : ""}` : "没有参数集达到训练与验证样本下限，未进入最终测试。", "",
    "## 研究范围", "",
    `本报告只研究每个历史时点的 **${study.board}** 前 ${o.topN} 名。排名从回测池内 ${d.symbols.length} 个合约的小时数据独立重建；本报告不跨榜去重、不合并选参或统计。`, "",
    `回测池为 ${d.universeAt} 获取的当前全部 USDT 永续合约。历史每个整点用之前 24 根已收盘小时线的收盘价/窗口首根开盘价计算涨跌幅，用 quoteVolume 之和计算 24h 成交额。排名随时间变化，不使用当前榜单回填过去。`, "",
    "**历史覆盖限制**：当前合约列表不含已退市币种，存在存活偏差。排名是该回测池内、整点对齐的历史 24h 榜单，不等于包含已退市合约的历史全市场逐 tick 榜单。新币有连续 24h 数据后才能入榜；技术策略另需 100 根连续小时线预热。", "",
    `行情来源：${d.source}；研究区间：[${iso(d.start)}, ${iso(d.end)})；预热起点：${iso(d.fetchStart)}。`, "",
    "| 本榜历史入选币种 | 入榜时点数 | K 线数 | 内部缺失小时 |",
    "|---|---|---|---|",
    ...study.membership.map((r) => `| ${r.symbol} | ${r.appearances} | ${d.files[r.symbol].bars} | ${d.files[r.symbol].gaps} |`), "",
    `共 ${study.coverage.frames} 个观察时点，具备完整 24h 历史的币种数范围 ${study.coverage.minSymbols}–${study.coverage.maxSymbols}；${study.coverage.incompleteFrames} 个时点存在数据覆盖不足。缺失样本不以零收益补齐。`, "",
    "## 策略与搜索方法", "",
    study.board === "gainers" ? "冲高衰竭：历史 24h 上涨达到阈值，DEA 为正且接近过去 100 根峰值，当根 MACD 死叉、阴线、量比与连阴数量满足参数。" :
      study.board === "losers" ? "弱势延续：历史 24h 下跌达到阈值，DIF < DEA，收盘跌破前 5 根低点，5h 动量为负，并满足量比和连阴参数。" :
        "放量转弱：历史滚动 24h 成交额至少 1 亿 USDT，DIF < DEA，5h 动量为负，并满足阴线量比与连阴参数。", "",
    "本 CLI 的技术指标与成交模拟均为 1h 周期，独立于监控服务的 1m MACD。可选周线过滤：涨幅榜要求本周涨幅为正，跌幅榜/成交额榜要求为负；周线按 UTC 周一开盘价计算。量比为当前已收盘小时成交量 / 前 20 小时均量。MACD 为 12/26/9。", "",
    `共执行 ${study.trials.length} 组不同参数；请求 ${o.rounds} 轮、每轮 ${o.trialsPerRound} 组。首轮随机采样，后续以训练前五名为中心变动参数，并保留全局探索。参数空间较小时按实际不同组合数结束。`, "",
    `训练区间：[${iso(s.start)}, ${iso(s.trainEnd)})；验证区间：[${iso(s.trainEnd)}, ${iso(s.validationEnd)})；最终测试：[${iso(s.validationEnd)}, ${iso(s.end)})。`, "",
    `仅训练结果参与多轮参数搜索；训练至少 ${o.minTrades} 笔的候选取前五名进入验证；验证至少 ${Math.max(1, Math.ceil(o.minTrades / 3))} 笔后按平均净收益选一个参数集；最终测试只评估该参数集一次。未用测试结果调参。`, "",
    "| 轮次 | 新参数组数 | 达到训练样本下限 | 训练最高平均净收益（仅描述） |",
    "|---|---|---|---|",
  ];
  for (let round = 1; round <= o.rounds; round++) {
    const trials = study.trials.filter((t) => t.round === round);
    const eligible = trials.filter((t) => t.train.trades >= o.minTrades);
    const best = eligible.length ? Math.max(...eligible.map((t) => t.train.meanNetPercent!)) : null;
    lines.push(`| ${round} | ${trials.length} | ${eligible.length} | ${number(best)}${best == null ? "" : "%"} |`);
  }
  lines.push("", "## 验证选出的参数与最终测试", "");
  if (!w) lines.push("**样本不足，未选出可进入最终测试的参数集。** 请扩大历史区间或检查数据覆盖；训练高收益不能替代验证样本。", "");
  else {
    lines.push(`选中参数：\`${JSON.stringify(w.parameters)}\``, "",
      "| 区间 | 交易数 | 胜率 % | 平均净收益 % | 收益因子 | 累加收益百分点回撤 | 缺失 | 边界剔除 |",
      "|---|---|---|---|---|---|---|---|");
    const metricRow = (label: string, m: Metrics) => `| ${label} | ${m.trades} | ${number(m.winRate, 1)} | ${number(m.meanNetPercent)} | ${m.profitFactor == null && m.trades && m.lossPercent === 0 ? "无亏损样本" : number(m.profitFactor)} | ${number(m.maxDrawdownPoints)} | ${m.missing} | ${m.purged} |`;
    lines.push(metricRow("训练", w.train), metricRow("验证", w.validation), metricRow("最终测试", w.test), "",
      w.test.trades === 0 ? "最终测试没有可结算交易，不能评价效果。" : w.test.meanNetPercent! > 0 ? "最终测试的平均净收益为正；仍需更多样本和独立时期检验，不能据此认定策略有效。" : "最终测试未观察到正的平均净收益，当前结果不支持该参数集的盈利假设。", "");
  }
  lines.push("## 训练候选（按平均净收益排序，非测试排名）", "",
    "| 参数 ID | 训练笔数 | 训练平均净收益 | 验证笔数 | 验证平均净收益 | 参数 |", "|---|---|---|---|---|---|");
  for (const t of [...study.trials].sort((a, b) => (b.train.meanNetPercent ?? -Infinity) - (a.train.meanNetPercent ?? -Infinity)).slice(0, 15)) {
    lines.push(`| ${t.id} | ${t.train.trades} | ${number(t.train.meanNetPercent)} | ${t.validation?.trades ?? "未入围"} | ${number(t.validation?.meanNetPercent ?? null)} | \`${JSON.stringify(t.parameters)}\` |`);
  }
  lines.push("", "## 成交与统计口径", "",
    `- 每 ${o.stepHours} 小时检查一次收盘信号；下一根 1h 开盘价模拟入场。每币每策略只持有一笔；不同币可同时持仓；离榜后已有持仓仍按原退出规则结算。`,
    `- 单边手续费 ${o.feeBps} bps + 滑点 ${o.slippageBps} bps，入场和出场分别按名义金额扣除。做空毛收益 = (入场价 − 出场价) / 入场价 × 100%。`,
    "- 止损/止盈为相对入场价的百分比，0 表示关闭；跳空按开盘价成交；同一根同时触及止损止盈时保守按止损先发生。最长持有期届满按收盘价退出。",
    "- 以最大持有期剔除跨训练/验证/测试边界的信号；退出前遇到 K 线缺口则记缺失，不参与收益统计。",
    "- 收益使用每笔相同名义金额；平均收益、胜率、收益因子描述单笔交易。累加收益百分点回撤按退出时点累加，不是可投资组合的资金回撤；未模拟资金占用、复利、资金费率或杠杆。",
    "- 多轮搜索存在多重检验偏差；最终测试次数仅一次，样本量和币种相关性均限制结论。", "",
    "## 可复现文件", "",
    "- `result.json`：回测池、K 线校验值、参数网格、时间切分、全部试验及最终测试明细。",
    "- `board-history.csv`：本榜逐历史时点的币种、排名、24h 涨跌幅、24h 成交额及周涨跌幅。",
    "- `trials.csv`：全部参数组的训练与验证指标。",
    "- `test-trades.csv`：最终测试逐笔记录，含本榜历史排名与触发时历史特征。",
    `- 研究源文件 SHA256：\`${engineSha256}\`。`, "");
  const trialRows: unknown[][] = [["id", "board", "round", ...parameterNames, "train_trades", "train_win_rate_pct", "train_mean_net_pct", "train_sum_net_points", "train_drawdown_points", "validation_trades", "validation_mean_net_pct"]];
  for (const t of study.trials) trialRows.push([t.id, t.board, t.round, ...parameterNames.map((k) => t.parameters[k]), t.train.trades, t.train.winRate, t.train.meanNetPercent, t.train.sumNetPercent, t.train.maxDrawdownPoints, t.validation?.trades, t.validation?.meanNetPercent]);
  const tradeRows: unknown[][] = [["board", "symbol", "historical_rank", "signal_open_utc", "entry_utc", "exit_utc", "entry_price", "exit_price", "reason", "gross_pct", "net_pct", "historical_day_change_pct", "historical_quote_volume", "historical_week_change_pct", "volume_ratio", "red_streak"]];
  for (const t of w?.testTrades ?? []) tradeRows.push([t.board, t.symbol, t.rank, iso(t.signalTime), iso(t.entryTime), iso(t.exitTime), t.entryPrice, t.exitPrice, t.reason, t.grossPercent, t.netPercent, t.observation.dayChange, t.observation.quoteVolume, t.observation.weekChange, t.observation.volumeRatio, t.observation.streak]);
  await writeFile(path.join(directory, "result.json"), JSON.stringify({ ...study, engineSha256 }, null, 2));
  await writeFile(path.join(directory, "trials.csv"), csv(trialRows));
  await writeFile(path.join(directory, "test-trades.csv"), csv(tradeRows));
  const boardRows: unknown[][] = [["time_utc", "board", "rank", "symbol", "change_24h_pct", "quote_volume_24h", "week_change_pct", "eligible_market_symbols"]];
  for (const frame of frames) for (const row of frame.boards[study.board]) boardRows.push([iso(frame.time), study.board, row.rank, row.symbol, row.dayChange, row.quoteVolume, row.weekChange, frame.eligibleSymbols]);
  await writeFile(path.join(directory, "board-history.csv"), csv(boardRows));
  await writeFile(path.join(directory, "report.md"), lines.join("\n"));
}
