import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { digest } from './data.ts';
import { plannedWickReward, type WickMetrics, type WickOrder, type WickTrade } from './wick-backtest.ts';
import type { WickStudy } from './wick-study.ts';
import type { Frame } from './types.ts';

const fmt = (n: number | null | undefined, digits = 3) => n == null ? '—' : n.toFixed(digits);
const iso = (n: number) => new Date(n).toISOString();
const csv = (rows: unknown[][]) => rows.map(r => r.map(v => `"${String(v ?? '').replaceAll('"', '""')}"`).join(',')).join('\n') + '\n';
const parameterKeys = ['holdMinutes', 'dayGainFraction', 'minGreenRatio', 'minConsecutiveGreenBars', 'maxUpperShadowRatio', 'exitX', 'exitN', 'exitM', 'firstTakeProfitPercent', 'firstStopLossPercent', 'finalTakeProfitPercent', 'finalStopLossPercent'] as const;
const metricKeys = ['signalCount', 'submitted', 'filled', 'fillRate', 'trades', 'wins', 'losses', 'breakevens', 'winRate', 'meanWinPercent', 'meanLossPercent', 'realizedRewardRisk', 'profitFactor', 'meanNetPercent', 'meanNetR', 'sumNetPercent', 'maxDrawdownPoints', 'missing', 'missingAfterFill', 'partialOrders', 'purged', 'skippedBusy', 'ambiguous', 'ignoredUnorderedTargets', 'firstTargetFinalStop', 'firstStopFinalTarget'] as const;

export async function writeWickReport(s: WickStudy, frames: Frame[], directory: string) {
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length) throw new Error(`报告目录非空，请使用新目录：${directory}`);
  const files = ['wick-config.ts', 'wick-signals.ts', 'wick-backtest.ts', 'wick-study.ts', 'wick-report.ts', 'wick.ts', 'cli.ts', 'backtest.ts', 'types.ts', 'gainers-types.ts', 'gainers-data.ts', 'gainers-archive.ts', 'data.ts', 'client.ts', '../src/macd.ts', '../src/alert-rule.ts'];
  const sourceHashes = Object.fromEntries(await Promise.all(files.map(async f => [f, digest(await readFile(new URL(f, import.meta.url)))])));
  const engineSha256 = digest(Buffer.from(JSON.stringify(sourceHashes)));
  const c = s.config, w = s.winner, training = s.trainingReplay;
  const lines = ['# 涨幅榜信号直接做空：先平50%，再平剩余全部', '',
    '**同一笔仓位两段平仓：第一段平初始仓位50%；第二段平剩余仓位100%（即初始仓位另50%），累计平仓100%。**',
    '第一段按极小止盈/极小止损退出；第一段完成后，剩余仓位按大止盈/小止损退出。两段止盈止损均相对原始入场价，不重置入场价，不自动移到保本。胜率和盈亏比按整笔合并净收益计算。', '',
    `区间 [${iso(s.split.start)}, ${iso(s.split.end)})；候选信号 ${s.signals.length}；预定参数 ${s.trials.length} 组。`, '',
    '## 信号与直接开仓', '',
    `历史24h涨幅榜前 ${c.topN} 名，24h涨幅 >0 且 ≥${c.minDayChangePercent}%；至少 ${c.minStreakCount} 连阳。连阳累计涨幅=(最后close/连阳第一根open−1)×100%，阈值 ${c.gainMode === 'day-fraction' ? `当时24h涨幅×${(c.dayGainFractions ?? [c.dayGainFraction ?? 0.05]).join('/')}` : `${c.minStreakGainPercent}%`}。`,
    `MA${(c.supportMaPeriods ?? [3, 5, 10, 15, 20]).join('/')} 均不满足已收盘信号线 low < MA < close；最后一根阳线上影短于柱体${(c.maxUpperShadowRatios ?? [c.maxUpperShadowRatio ?? 0.3]).map(r => (r * 100).toFixed(0) + '%').join('/')}；最近30根已收盘1m的 hist=2×(DIF−DEA)>0 占比严格 >${(c.minGreenRatios ?? [c.minGreenRatio ?? 0.5]).map(r => (r * 100).toFixed(0) + '%').join('/')}，且末尾${(c.consecutiveGreenBars ?? [c.minConsecutiveGreenBars ?? 7]).join('/')}根MACD柱全绿(hist>0)。每分钟仅使用最近${c.indicatorWindow}根已收盘线，与监控默认200根缓存含一根形成线的口径对应；缺口后重新预热；无额外死叉或柱体衰减过滤。`,
    '信号收盘确认后立即市价开空，分钟回测按下一分钟开盘价入场；不等待价格上冲，没有挂单偏移、有效期或撤单过滤。开盘跳空仍正常开仓，止盈止损以实际入场基准价计算。',
    '同币只持一笔，第一段平仓后剩余仓位继续占用，全部退出后可再次入场。持仓期间每个满足条件的分钟仍计为信号，单独记录未重复开仓数量。', '',
    '## 两段执行和费用', '',
    '第一段触及止盈或止损都只平50%，第二段关闭剩余全部。价格一次穿过两段阈值可在同分钟完成两段。最长期限按入场分钟起算，不因第一段平仓重置；到期关闭所有剩余仓位。',
    '入场即在分钟开盘，随后该分钟高低价可触发退出。第一段盘中止损后，同分钟第二段止盈也需收盘证明在止损之后到达；第一段止盈后向下继续穿透可成交第二段止盈。先处理已知开盘跳空，盘中双触按止损优先；仍无法排序的有利触价不记盈利。',
    '两段退出均模拟触发后市价减仓；开盘已越过阈值则按开盘成交，盘中按触发价加成本。假设减仓和保护单立即生效。',
    `入场和各段退出均按taker ${c.takerFeeBps} bps、滑点 ${c.slippageBps} bps计费。入场全仓费用仅计一次，退出按实际数量和退出价格计算。分段明细的入场费用及滑点按50/50分摊，整笔相加不重复扣费。价位采用未扣成本的开盘/触发价格，滑点作为单独成本。`, '',
    '## 整笔交易结果', '',
    '| 区间 | 信号 | 开仓 | 持仓中跳过 | 跨段剔除 | 完整交易 | 净胜率% | 95%区间% | 平均盈利% | 平均亏损% | 实际盈亏比 | PF | 净期望% |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  const row = (label: string, m: WickMetrics) => `| ${label} | ${m.signalCount} | ${m.filled} | ${m.skippedBusy} | ${m.purged} | ${m.trades} | ${fmt(m.winRate, 1)} | ${m.winRate95?.map(n => fmt(n, 1)).join('–') ?? '—'} | ${fmt(m.meanWinPercent)} | ${fmt(m.meanLossPercent)} | ${fmt(m.realizedRewardRisk)} | ${fmt(m.profitFactor)} | ${fmt(m.meanNetPercent)} |`;
  lines.push(row('全区间固定基准（探索）', s.baseline.metrics));
  lines.push(row(w ? '训练' : '训练探索最高均值（未通过选参）', training.metrics));
  if (w) { lines.push(row('验证', w.validation)); lines.push(row('留出', w.test)); }
  lines.push('', `全区间固定基准参数（运行前确定的首组）：\`${JSON.stringify(s.baseline.parameters)}\`；不参与选参或策略有效性验证。`);
  lines.push('', `${w ? '选定' : '探索行对应'} ${training.trialId}：\`${JSON.stringify(training.parameters)}\`。`,
    w ? (!w.sufficientTest ? '留出样本不足或有数据缺失，不能评价策略有效。' : w.test.meanNetPercent! > 0 ? '本段净期望为正，仍需新时期验证。' : '本段净期望不为正，本次结果不支持该参数盈利。')
      : `训练/验证样本不足或存在缺失，没有参数通过门槛，未评价候选参数的留出；全区间固定基准仅用于此次试跑。训练至少要求${c.minTrades}笔完整交易且无缺失，当前探索结果不能作为策略有效的证据。`);
  lines.push('', '## 信号筛选数量核对', '',
    `按顺序筛选：榜内且历史足够的分钟 ${s.signalAudit.rankedMinutes} → 连阳达标 ${s.signalAudit.bullishStreakMinutes} → 连阳涨幅达标 ${s.signalAudit.gainQualifiedMinutes} → 无MA支撑 ${s.signalAudit.noMaMinutes} → 满足最宽阈值的基础候选池 ${s.signalAudit.matchedMinutes}。各参数组合在此候选池上动态过滤（24h涨幅比例、30根绿柱占比、末尾连续绿柱数及上影线比例）。`,
    '以上按币种×已收盘分钟计数，同一分钟监控刷新多次只算一次；这与Telegram发送次数、榜内实时排名变化并不等价。');
  const baseline = s.baseline.metrics;
  lines.push('', `全区间固定基准：第一段止盈 ${baseline.firstExits.target}、止损 ${baseline.firstExits.stop}、超时 ${baseline.firstExits.timeout}；第二段止盈 ${baseline.exits.target}、止损 ${baseline.exits.stop}、超时 ${baseline.exits.timeout}。`,
    `基准 ${baseline.trades} 笔完整交易中有 ${baseline.ambiguous} 笔存在同分钟止盈止损双触，按止损优先；${baseline.ignoredUnorderedTargets} 笔忽略先后不明的有利触价。该结果是保守分钟回测，需更细粒度数据判定真实先后。`);
  const m = w?.test ?? training.metrics;
  lines.push('', `${w ? '留出' : '探索训练'}第一段：止盈 ${m.firstExits.target}，止损 ${m.firstExits.stop}，超时 ${m.firstExits.timeout}；第二段：止盈 ${m.exits.target}，止损 ${m.exits.stop}，超时 ${m.exits.timeout}。先止盈后止损 ${m.firstTargetFinalStop} 笔，先止损后止盈 ${m.firstStopFinalTarget} 笔。`,
    `缺失 ${m.missing}（成交后 ${m.missingAfterFill}，仅完成第一段 ${m.partialOrders}），跨段剔除 ${m.purged}；双触 ${m.ambiguous}，忽略先后不明的有利触价 ${m.ignoredUnorderedTargets}。`);
  if (c.exitXs && c.exitNs && c.exitMs) {
    lines.push('', '## 预定动态退出方案（按典型24h涨幅20%基准测算四种净结果）', '',
      '| x（第一段分母） | n（第二段止损倍数） | m（第二段止盈倍数） | 基准TP1/SL1% | 基准SL2% | 基准TP2% | 两段止盈% | 两段止损% | 先盈后损% | 先损后盈% |',
      '|---|---|---|---|---|---|---|---|---|---|');
    const seen = new Set<string>();
    for (const exitX of c.exitXs) {
      for (const exitN of c.exitNs) {
        for (const exitM of c.exitMs) {
          const key = `${exitX}/${exitN}/${exitM}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const r = plannedWickReward({ holdMinutes: c.holdMinutes[0], exitX, exitN, exitM }, c, 20);
          const sl1 = 20 / exitX, sl2 = 20 * exitN / exitX, tp2 = 20 * exitM / exitX;
          lines.push(`| ${exitX} | ${exitN} | ${exitM} | ${fmt(sl1, 2)} | ${fmt(sl2, 2)} | ${fmt(tp2, 2)} | ${fmt(r.bothTargetsNetPercent)} | ${fmt(r.bothStopsNetPercent)} | ${fmt(r.firstTargetFinalStopNetPercent)} | ${fmt(r.firstStopFinalTargetNetPercent)} |`);
        }
      }
    }
  } else if (c.exitPlans) {
    lines.push('', '## 预定退出方案与四种净结果', '',
      '| 第一段TP/SL%（平50%） | 第二段TP/SL%（平剩余全部） | 两段止盈% | 两段止损% | 先盈后损% | 先损后盈% |',
      '|---|---|---|---|---|---|');
    for (const e of c.exitPlans) {
      const r = plannedWickReward({ ...e, holdMinutes: c.holdMinutes[0] }, c);
      lines.push(`| ${e.firstTakeProfitPercent}/${e.firstStopLossPercent} | ${e.finalTakeProfitPercent}/${e.finalStopLossPercent} | ${fmt(r.bothTargetsNetPercent)} | ${fmt(r.bothStopsNetPercent)} | ${fmt(r.firstTargetFinalStopNetPercent)} | ${fmt(r.firstStopFinalTargetNetPercent)} |`);
    }
  }
  lines.push('', '四种结果以初始仓位名义金额计算，含费用、不含跳空和超时。第一段止盈并不保证整笔盈利；分批退出不能套用单一止盈/止损两结果的保本胜率。', '',
    '## 统计与样本', '',
    '每笔净收益=50%×第一段价格收益+50%×第二段价格收益−入场全仓费用−两段按实际数量计的退出费用与滑点。两段只算一笔；净胜率=合并净收益>0的完整交易数/完整交易数。实际盈亏比=平均整笔净盈利/平均整笔净亏损绝对值，PF=净盈利总额/净亏损总额，无相关样本时记—。净期望为每笔合并净收益均值。',
    '每段信号数=开仓尝试数+已有持仓跳过数+跨段剔除数；开仓尝试数=成功开仓数+入场行情缺失数。只完成第一段后缺数据的订单保留已实现明细，但不计完整交易胜负。95%为Wilson区间，未调整币种和连续信号相关性。netR分母为50%×第一段止损幅度+50%×第二段止损幅度。累加收益回撤不是账户净值回撤。',
    `训练 [${iso(s.split.start)}, ${iso(s.split.trainEnd)})，验证 [${iso(s.split.trainEnd)}, ${iso(s.split.validationEnd)})，留出 [${iso(s.split.validationEnd)}, ${iso(s.split.end)})。训练至少${c.minTrades}笔且无缺失，按净期望取前五；验证至少${Math.ceil(c.minTrades / 3)}笔且无缺失后选一个，同分看更低回撤；只评价选定参数的留出。两个阶段作为一套参数联合选择。`,
    '在看退出行情之前按开仓+完整持仓期限剔除跨段信号。不会因第一段提前平仓而缩短样本保护期。', '',
    '## 数据与复现', '',
    `小时池 ${s.hourly.symbols.length} 币，${frames.length} 个整点，其中 ${frames.filter(f => f.eligibleSymbols < s.hourly.symbols.length).length} 个整点覆盖不全；分钟文件 ${Object.keys(s.minute.files).length} 个，计划缺失 ${Object.values(s.minute.files).reduce((n, f) => n + f.missingMinutes, 0)} 分钟。`,
    '历史24h榜按前24根已收盘小时线每小时重建；当前存活合约池存在存活偏差，复用已研究过的历史不算新的独立验证。未模拟杠杆、账户资金约束、强平、历史资金费率与逐笔撮合。这里只输出研究报告。',
    `小时计划SHA256 ${s.minute.plan.hourlyHash}；分钟清单SHA256 ${digest(Buffer.from(JSON.stringify(s.minute)))}；代码SHA256 ${engineSha256}。`,
    'result.json含参数、版本、数据清单、源代码哈希和逐笔记录；summary.csv/trials.csv为整笔统计；baseline/train/test-trades.csv为完整交易；baseline/train/test-orders.csv为开仓与剩余仓位；baseline/train/test-exits.csv为各段数量、累计平仓比例和费用（含数据缺失订单的已完成段）；signals.csv/board-history.csv用于复核条件。', '');
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({ ...s, sourceHashes, engineSha256 }, null, 2));
  const trials: unknown[][] = [['id', ...parameterKeys, ...['train', 'validation'].flatMap(k => metricKeys.map(m => `${k}_${m}`))]];
  for (const t of s.trials) trials.push([t.id, ...parameterKeys.map(k => t.parameters[k]), ...metricKeys.map(k => t.train[k]), ...metricKeys.map(k => t.validation?.[k])]);
  const summary: unknown[][] = [['split', 'trial', ...metricKeys, 'winRate95Low', 'winRate95High']];
  const addSummary = (split: string, id: string, metrics: WickMetrics) => summary.push([split, id, ...metricKeys.map(k => metrics[k]), ...(metrics.winRate95 ?? [null, null])]);
  addSummary('full-fixed-baseline-exploratory', 'baseline', s.baseline.metrics);
  addSummary(w ? 'train' : 'train-exploratory-unqualified', training.trialId, training.metrics);
  if (w) { addSummary('validation', w.trialId, w.validation); addSummary('test', w.trialId, w.test); }
  const ledger = async (split: string, tt: WickTrade[], oo: WickOrder[]) => {
    const trades: unknown[][] = [['symbol', 'signal_utc', 'entry_minute_utc', 'exit_minute_close_utc', 'entry_price', 'weighted_exit_price', 'first_reason', 'final_reason', 'gross_pct', 'entry_fee_pct', 'exit_fee_pct', 'slippage_pct', 'net_pct', 'net_r', 'ambiguous', 'ignored_unordered_target']];
    for (const t of tt) trades.push([t.signal.symbol, iso(t.signal.time), iso(t.entryTime), iso(t.exitTime), t.entryPrice, t.exitPrice, t.exits[0].reason, t.reason, t.grossPercent, t.entryFeePercent, t.exitFeePercent, t.slippagePercent, t.netPercent, t.netR, t.ambiguous, t.ignoredUnorderedTarget]);
    const orders: unknown[][] = [['symbol', 'signal_utc', 'entry_price', 'status', 'resolved_utc', 'entry_minute_utc', 'remaining_fraction', 'entry_fee_pct']];
    const exits: unknown[][] = [['symbol', 'signal_utc', 'order_status', 'stage', 'fraction_of_initial', 'cumulative_closed_pct', 'exit_minute_close_utc', 'exit_price', 'reason', 'gross_contribution_pct', 'allocated_entry_fee_pct', 'exit_fee_pct', 'slippage_pct', 'net_contribution_pct']];
    for (const o of oo) {
      orders.push([o.signal.symbol, iso(o.signal.time), o.entryPrice, o.status, iso(o.resolvedAt), o.entryTime == null ? null : iso(o.entryTime), o.remainingFraction, o.entryFeePercent]);
      for (const e of o.exits) exits.push([o.signal.symbol, iso(o.signal.time), o.status, e.stage, e.fraction, e.cumulativeClosedPercent, iso(e.exitTime), e.exitPrice, e.reason, e.grossPercent, e.entryFeePercent, e.exitFeePercent, e.slippagePercent, e.netPercent]);
    }
    for (const [name, rows] of Object.entries({ trades, orders, exits })) await writeFile(path.join(directory, `${split}-${name}.csv`), csv(rows));
  };
  await ledger('baseline', s.baseline.trades, s.baseline.orders);
  await ledger('train', training.trades, training.orders);
  await ledger('test', w?.testTrades ?? [], w?.testOrders ?? []);
  const signals: unknown[][] = [['symbol', 'signal_utc', 'rank', 'board_utc', 'day_change_pct', 'close', 'streak_count', 'streak_gain_pct', 'required_gain_pct', 'green_count_30', 'green_ratio_30', 'consecutive_green_bars', 'upper_shadow_ratio', 'hist', 'previous_hist', 'support_ma']];
  for (const v of s.signals) signals.push([v.symbol, iso(v.time), v.rank, iso(v.boardTime), v.dayChangePercent, v.close, v.streakCount, v.streakGainPercent, v.requiredGainPercent, v.greenCount, v.greenRatio, v.consecutiveGreenBars, v.upperShadowRatio, v.hist, v.previousHist, v.supportMa]);
  const boards: unknown[][] = [['time_utc', 'rank', 'symbol', 'day_change_pct', 'eligible_symbols']];
  for (const f of frames) for (const r of f.boards.gainers) boards.push([iso(f.time), r.rank, r.symbol, r.dayChange, f.eligibleSymbols]);
  for (const [name, rows] of Object.entries({ trials, summary, signals, 'board-history': boards })) await writeFile(path.join(directory, `${name}.csv`), csv(rows));
  await writeFile(path.join(directory, 'report.md'), lines.join('\n'));
}
