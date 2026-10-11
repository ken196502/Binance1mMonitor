import { backtest, buildFrames } from "./backtest.ts";
import { HOUR, type Board, type Dataset, type Grid, type Parameters, type SearchOptions, type Study, type Trial, type Winner } from "./types.ts";

export const DEFAULT_GRID: Grid = {
  holdHours: [1, 3, 6, 12, 24], minStreak: [1, 2, 3], volumeRatio: [0.8, 1.2, 1.5, 2],
  weekFilter: [false, true], dayMovePercent: [0, 3, 6], highRatio: [0.7, 0.8, 0.9],
  stopLossPercent: [0, 0.5, 1, 2], takeProfitPercent: [0, 1, 2, 4],
};
const keys = Object.keys(DEFAULT_GRID) as (keyof Parameters)[];

export function validateGrid(value: unknown): Grid {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("参数网格必须是 JSON 对象");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((k) => !keys.includes(k as keyof Parameters))) throw new Error("参数网格包含未知字段");
  for (const key of keys) {
    const values = input[key];
    if (!Array.isArray(values) || !values.length || values.length > 100 || new Set(values).size !== values.length) throw new Error(`参数网格 ${key} 需要非空、不重复的数组（最多 100 项）`);
    for (const v of values) {
      const valid = key === "weekFilter" ? typeof v === "boolean" :
        typeof v === "number" && Number.isFinite(v) && v >= 0 &&
        (key === "holdHours" ? Number.isInteger(v) && v >= 1 && v <= 1440 :
          key === "minStreak" ? Number.isInteger(v) && v >= 1 && v <= 20 :
          key === "highRatio" ? v > 0 && v <= 1 : key === "takeProfitPercent" ? v < 100 : v <= 100);
      if (!valid) throw new Error(`参数网格 ${key} 包含无效值`);
    }
  }
  return input as unknown as Grid;
}

export function validateOptions(o: SearchOptions): void {
  for (const [name, max] of [["topN", 100], ["stepHours", 24], ["rounds", 10], ["trialsPerRound", 500], ["minTrades", 10000]] as const) {
    if (!Number.isInteger(o[name]) || o[name] < 1 || o[name] > max) throw new Error(`${name} 必须为 1–${max} 的整数`);
  }
  if (!Number.isInteger(o.seed) || o.seed < 0 || o.seed > 0xffffffff) throw new Error("seed 必须为 0–4294967295 的整数");
  if (![o.trainRatio, o.validationRatio].every((v) => Number.isFinite(v) && v > 0) || o.trainRatio + o.validationRatio >= 1) throw new Error("训练/验证比例必须 > 0，且合计 < 1");
  if (![o.feeBps, o.slippageBps].every((v) => Number.isFinite(v) && v >= 0 && v <= 100)) throw new Error("手续费、滑点需为 0–100 bps/边");
  validateGrid(o.grid);
}

function randomGenerator(seed: number) {
  return () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
}
function activeKeys(board: Board) {
  return keys.filter((k) => !(k === "highRatio" && board !== "gainers") && !(k === "dayMovePercent" && board === "volume"));
}
function canonical(p: Parameters, board: Board): Parameters {
  return { ...p, highRatio: board === "gainers" ? p.highRatio : 0, dayMovePercent: board === "volume" ? 0 : p.dayMovePercent };
}
function trainOrder(a: Trial, b: Trial): number {
  return (b.train.meanNetPercent ?? -Infinity) - (a.train.meanNetPercent ?? -Infinity) ||
    a.train.maxDrawdownPoints - b.train.maxDrawdownPoints || a.id.localeCompare(b.id);
}

export function runStudy(dataset: Dataset, board: Board, options: SearchOptions, log = console.log, preparedFrames?: ReturnType<typeof buildFrames>): Study {
  validateOptions(options);
  const { start, end } = dataset.manifest;
  const durationHours = (end - start) / HOUR;
  const trainEnd = start + Math.floor(durationHours * options.trainRatio) * HOUR;
  const validationEnd = trainEnd + Math.floor(durationHours * options.validationRatio) * HOUR;
  if (Math.min(trainEnd - start, validationEnd - trainEnd, end - validationEnd) < Math.max(...options.grid.holdHours) * HOUR) {
    throw new Error("每个训练/验证/测试区间至少要覆盖最大持有期，请扩大数据区间或缩小 holdHours 网格");
  }
  log(`研究历史 ${board} 榜，MACD/周线/量比全部基于已收盘小时数据…`);
  const frames = preparedFrames ?? buildFrames(dataset, options.topN, options.stepHours);
  if (!frames.some((f) => f.eligibleSymbols > 0)) throw new Error("没有可研究的历史样本：需要连续 24h 预热 K 线");
  const cost = options.feeBps + options.slippageBps;
  const rng = randomGenerator(options.seed);
  const trials: Trial[] = [];
  let winner: Winner | null = null;
  {
    const seen = new Set<string>();
    const boardTrials: Trial[] = [];
    const dimensions = activeKeys(board);
    for (let round = 1; round <= options.rounds; round++) {
      const elites = boardTrials.filter((t) => t.train.trades >= options.minTrades).sort(trainOrder).slice(0, 5);
      let added = 0;
      for (let attempt = 0; added < options.trialsPerRound && attempt < options.trialsPerRound * 100; attempt++) {
        const values = Object.fromEntries(keys.map((k) => [k, options.grid[k][Math.floor(rng() * options.grid[k].length)]])) as unknown as Parameters;
        let p = values;
        if (elites.length && attempt % 4 !== 0) {
          p = { ...elites[Math.floor(rng() * elites.length)].parameters };
          // Later rounds search neighbors of training winners, while retaining global exploration.
          for (let i = 0; i < 2; i++) {
            const key = dimensions[Math.floor(rng() * dimensions.length)];
            Object.assign(p, { [key]: values[key] });
          }
        }
        p = canonical(p, board);
        const signature = JSON.stringify(p);
        if (seen.has(signature)) continue;
        seen.add(signature);
        const train = backtest(dataset, frames, board, p, start, trainEnd, cost).metrics;
        boardTrials.push({ id: `${board}-r${round}-${added + 1}`, board, round, parameters: p, train, validation: null });
        added++;
      }
      log(`${board} 第 ${round}/${options.rounds} 轮：${added} 组新参数（仅训练区间）`);
      if (!added) break;
    }
    const shortlist = boardTrials.filter((t) => t.train.trades >= options.minTrades).sort(trainOrder).slice(0, 5);
    for (const trial of shortlist) trial.validation = backtest(dataset, frames, board, trial.parameters, trainEnd, validationEnd, cost).metrics;
    const validationMin = Math.max(1, Math.ceil(options.minTrades / 3));
    const selected = shortlist.filter((t) => t.validation!.trades >= validationMin).sort((a, b) =>
      b.validation!.meanNetPercent! - a.validation!.meanNetPercent! || a.validation!.maxDrawdownPoints - b.validation!.maxDrawdownPoints || a.id.localeCompare(b.id))[0];
    if (selected) {
      const result = backtest(dataset, frames, board, selected.parameters, validationEnd, end, cost);
      winner = { trialId: selected.id, board, parameters: selected.parameters, train: selected.train,
        validation: selected.validation!, test: result.metrics, testTrades: result.trades };
    }
    trials.push(...boardTrials);
  }
  return {
    version: 1, createdAt: new Date().toISOString(), board, dataset: dataset.manifest, options,
    split: { start, trainEnd, validationEnd, end },
    coverage: { frames: frames.length, minSymbols: Math.min(...frames.map((f) => f.eligibleSymbols)),
      maxSymbols: Math.max(...frames.map((f) => f.eligibleSymbols)),
      incompleteFrames: frames.filter((f) => f.eligibleSymbols < dataset.manifest.symbols.length).length },
    trials, winner,
    membership: [...frames.reduce((counts, f) => {
      for (const o of f.boards[board]) counts.set(o.symbol, (counts.get(o.symbol) ?? 0) + 1);
      return counts;
    }, new Map<string, number>())].map(([symbol, appearances]) => ({ symbol, appearances })).sort((a, b) => b.appearances - a.appearances || a.symbol.localeCompare(b.symbol)),
  };
}
