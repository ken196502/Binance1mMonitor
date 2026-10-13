import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { atomicJson, digest, loadDataset } from './data.ts';
import { buildFrames } from './backtest.ts';
import { SUPPORT_MA_PERIODS } from '../src/macd.ts';
import { buildMinuteSignals } from './gainers-backtest.ts';
import { loadGainersMinutes, planGainersMinutes } from './gainers-data.ts';
import { MINUTE, type MinuteManifest } from './gainers-types.ts';
import { GpuWorker, writeGpuWindows, type GpuInfo } from './gpu.ts';
import { miningSearch, rewardRisk, validateMiningGrid, type MiningGrid } from './miner-core.ts';
import { hydrateMiningState, saveMiningState, type TrialShard } from './miner-state.ts';
import { attachFifteen, FIFTEEN_RULE, fifteenText, minuteText, type MiningParameters } from './fifteen.ts';
import { fetchFifteen, loadFifteen, planFifteen } from './fifteen-data.ts';
import { attachBtcFive, BTC_FIVE_RULE, btcFiveText } from './btc-five.ts';
import { fetchBtcFive, loadBtcFive, planBtcFive } from './btc-five-data.ts';
import { streakText } from './streak.ts';
import { createMiningSender, flushNotices, type MiningNotice } from './miner-notify.ts';

import { DEFAULT_ACCOUNT, validateAccount, backtestAccount, accountGpuParameters, accountTrainOrder, accountValidationOrder, accountQualified, accountDiscovery, type AccountOptions, type AccountMetrics, type AccountTrade, type AccountTrial, type EquityPoint } from './futures-account.ts';

const HELP = `M1 Pro / Apple Metal 超短线做空挖掘
npm run mine -- [选项]
npm run mine:btc5m -- [选项]   独立研究：涨幅榜1m + BTC 5m
--study gainers|btc5m  默认gainers沿用原研究；btc5m使用独立网格与输出目录
--btc-five-data DIR   原生BTCUSDT 5m缓存（默认 data/research/btc-5m-1day）
--fetch-btc-five      补取BTC 5m缓存，含300根预热；否则只读完整缓存
--data DIR            全市场小时缓存（默认 data/research/hourly-initial）
--minutes-data DIR    完整分钟缓存（默认 data/research/gainers-1m-archive-1day）
--out DIR             状态/报告目录（默认 reports/research/gainers-gpu-margin-no-ma-streak）
--grid FILE           默认 research/miner-grid-streak.json；btc5m使用 miner-grid-btc5m.json
                     btc5m输出默认 reports/research/gainers-gpu-margin-no-ma-btc5m
--max-trials N        预定搜索上限1..400000（默认400000）；超出时按状态和连阳/连阴分层抽样
--fifteen-data DIR    原生15m缓存（默认 data/research/gainers-15m-1day）
--fetch-fifteen       自动补取15m缓存，含300根预热；否则只读完整缓存
--batch N             每轮参数数 1..128（默认32）；顺序随机，遍历预定清单，不重复
--signal-batch N      GPU每块信号数 1..4096（默认1024），内存不足可降低
--rounds N            本次最多运行N轮；0=直到预定清单完成（默认0）
--min-trades N        训练最低笔数（默认100）；验证/测试至少ceil(N/3)
--min-net-rr N        扣费后目标盈亏比下限（默认3，且名义至少3）
--fee-bps N           单边手续费（默认5）
--slippage-bps N      单边滑点（默认2）
--leverage N          逐仓杠杆（默认10倍，1..125；模拟值，不校验交易所档位）
--margin-usdt N       每笔固定保证金（默认100 USDT）
--balance-usdt N      每个分段初始账户资金（默认1000 USDT）
--max-positions N     同时持仓上限（默认10，仍受可用资金限制）
--maintenance-margin-percent N   维持保证金率假设（默认0.5%）
--liquidation-fee-bps N           强平费假设（默认50bps）
--seed N              洗牌种子（默认42）
--python FILE         原生arm64 Python（默认 .venv-gpu/bin/python）
--device mps|cpu      默认mps；不可用即报错。cpu仅用于排错
--resume              从相同目录继续；拒绝不同数据/代码/参数，已完成不重测
--no-telegram         显式离线运行，消息仍存队列，之后可带 --resume 补发
--notify-only         只重试当前目录待发消息（无需GPU/行情），与 --no-telegram 互斥
--help

每轮只用训练数据找新的账户正收益纪录并播报“训练阶段发现”。完成预定清单后
固定训练前五，再验证选择一个，最终留出只测试一次；达标则播报成果。
每轮状态与待发消息原子落盘，失败自动重试；Ctrl-C 后用 --resume 继续。
入场：1m搭配同币15m或BTC 5m，各搜索DEA高/中/低与DIFF多/空；两个周期均必须无MA支撑（MA5/7/10/20/25/30/60/99/120）。
同币单仓、下一分钟入场、跳空开盘成交、同根不利退出优先。
`;

interface Round { gpuComputed?: number; round: number; trials: number; gpuSeconds: number; scalarChecks: number; accountReturnPercent: number }
interface State {
  version: 4; fingerprint: string; config: Record<string, unknown>; createdAt: string;
  status: 'mining' | 'complete'; next: number; trials: AccountTrial[]; rounds: Round[];
  bestNotified: number | null; notices: MiningNotice[]; gpu?: GpuInfo;
  winner?: { trialId: string; parameters: MiningParameters; train: AccountMetrics; validation: AccountMetrics; test: AccountMetrics; testTrades: AccountTrade[]; testEquity: EquityPoint[]; qualified: boolean } | null;
  completedAt?: string; trialShards?: TrialShard[]; validations?: Record<string, AccountMetrics>;
}
const iso = (n: number) => new Date(n).toISOString();
const fmt = (n: number | null) => n == null ? '—' : n.toFixed(4);
const parameterText = (p: MiningParameters, cost: number) => `${minuteText(p)}｜1m高位比 ${p.highRatio}｜持有≤${p.holdMinutes}分钟｜止损 ${p.stopLossPercent}%｜止盈 ${p.takeProfitPercent}%｜净目标盈亏比 ${rewardRisk(p, cost).net.toFixed(2)}:1${p.fifteenDea !== undefined ? `｜${fifteenText(p)}` : ''}${p.btcFiveDea !== undefined ? `｜${btcFiveText(p)}` : ''}`;
const metricText = (m: AccountMetrics) => `${m.trades}笔，账户净收益 ${fmt(m.netPnlUSDT)} USDT (${fmt(m.accountReturnPercent)}%)，账户期末 ${fmt(m.finalBalanceUSDT)} USDT，净值回撤 ${fmt(m.maxEquityDrawdownPercent)}%，强平 ${m.liquidations}，资金不足跳过 ${m.skippedFunds}`;
const accountText = (o: AccountOptions) => `逐仓 ${o.leverage}倍｜每笔保证金 ${o.marginPerTradeUSDT} USDT｜名义仓位 ${o.marginPerTradeUSDT * o.leverage} USDT｜初始资金 ${o.initialBalanceUSDT} USDT`;
function notice(state: State, id: string, text: string) {
  if (!state.notices.some((n) => n.id === id)) state.notices.push({ id, text: `${text}\n研究ID ${state.fingerprint.slice(0, 12)} / ${id}`, attempts: 0, nextAttemptAt: 0 });
}

/** Exclusive owner PID. Stale locks are removed only after checking the process. */
export async function acquireMiningLock(directory: string) {
  const file = path.join(directory, 'miner.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = await open(file, 'wx');
      await fd.writeFile(String(process.pid)); await fd.close();
      return async () => { if ((await readFile(file, 'utf8').catch(() => '')) === String(process.pid)) await rm(file, { force: true }); };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(await readFile(file, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('任务锁写入中或损坏；请核查 miner.lock');
      try { process.kill(pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') { await rm(file); continue; }
        throw error;
      }
      throw new Error(`此目录已有运行中的挖掘进程 PID ${pid}`);
    }
  }
  throw new Error('无法取得挖掘锁');
}

function companionFamilyRows(s: State): string[] {
  const grid = s.config.grid as MiningGrid;
  const deaKey = grid.btcFiveDea ? 'btcFiveDea' : 'fifteenDea';
  const difKey = grid.btcFiveDea ? 'btcFiveDif' : 'fifteenDif';
  const rows: string[] = [];
  for (const minuteDea of grid.minuteDea ?? ['high']) for (const minuteDif of grid.minuteDif ?? ['bull'])
    for (const dea of grid[deaKey] ?? []) for (const dif of grid[difKey] ?? []) {
      const trials = s.trials.filter((t) => (t.parameters.minuteDea ?? 'high') === minuteDea && (t.parameters.minuteDif ?? 'bull') === minuteDif
        && t.parameters[deaKey] === dea && t.parameters[difKey] === dif);
      const eligible = trials.filter((t) => t.train.valid && t.train.trades >= Number(s.config.minTrades)).sort(accountTrainOrder);
      const best = eligible[0];
      rows.push(`|${minuteDea}|${minuteDif}|${dea}|${dif}|${trials.length}|${eligible.length}|${best?.train.trades ?? '—'}|${fmt(best?.train.accountReturnPercent ?? null)}|`);
    }
  return rows;
}

function streakFamilyRows(s: State): string[] {
  const g = s.config.grid as MiningGrid;
  const streakKey = g.btcFiveDea ? 'btcFiveStreak' : 'fifteenStreak';
  const groups = new Map<string, { count: number; eligible: number; best?: AccountTrial }>();
  for (const t of s.trials) {
    const key = `${t.parameters.minuteStreak ?? 0}/${t.parameters[streakKey] ?? 0}`;
    const group = groups.get(key) ?? { count: 0, eligible: 0 }; group.count++;
    if (t.train.valid && t.train.trades >= Number(s.config.minTrades)) {
      group.eligible++;
      if (!group.best || accountTrainOrder(t, group.best) < 0) group.best = t;
    }
    groups.set(key, group);
  }
  return (g.minuteStreak ?? [0]).flatMap((minute) => (g[streakKey] ?? [0]).map((fifteen) => {
    const group = groups.get(`${minute}/${fifteen}`);
    return `|${streakText(minute)}|${streakText(fifteen)}|${group?.count ?? 0}|${group?.eligible ?? 0}|${fmt(group?.best?.train.accountReturnPercent ?? null)}|`;
  }));
}

async function writeReport(out: string, s: State, total: number) {
  const cost = Number(s.config.costBps), account = s.config.account as AccountOptions;
  const btc = !!s.config.btcFiveRule, companion = btc ? 'BTC 5m' : '15m';
  const lines = [btc ? '# 涨幅榜 1m + BTC 5m：GPU 逐仓合约账户挖掘' : '# M1 Pro GPU：逐仓合约账户挖掘', '',
    `状态：${s.status}；进度 ${s.next}/${total}；设备 ${s.gpu?.device ?? '—'}；PyTorch ${s.gpu?.torch ?? '—'}。`,
    `研究 ID：${s.fingerprint}；创建 ${s.createdAt}。`, '',
    `搜索计划：${JSON.stringify(s.config.search ?? { exhaustive: true, possible: total })}。exhaustive=false 表示分层抽样，完成仅指预先固定的清单已跑完。`, '',
    accountText(account), '',
    '|搜索维度|候选值|', '|---|---|',
    ...Object.entries(s.config.grid as MiningGrid).map(([key, values]) => `|${({ highRatio: 'DEA高位比例', holdMinutes: '持仓分钟', stopLossPercent: '止损%', takeProfitPercent: '止盈%', minuteDea: '1m DEA档位', minuteDif: '1m DIFF方向', fifteenDea: '15m DEA档位', fifteenDif: '15m DIFF方向', fifteenHighRatio: '15m高位比例', minuteStreak: '1m连续阈值', fifteenStreak: '15m连续阈值', btcFiveDea: 'BTC 5m DEA档位', btcFiveDif: 'BTC 5m DIFF方向', btcFiveHighRatio: 'BTC 5m高位比例', btcFiveStreak: 'BTC 5m连续阈值' } as Record<string, string>)[key]}|${values.join(' / ')}|`), '',
    `同时持仓上限 ${account.maxPositions}；开仓需有保证金及开仓成本，平仓后释放余额。每个训练/验证/留出分段独立从 ${account.initialBalanceUSDT} USDT 开始，三段收益不能相加当成连续账户收益。`,
    `每边手续费+滑点 ${cost} bps，均按杠杆后的实际名义金额计算。固定每笔保证金，盈利不自动扩大下一笔仓位。`, '',
    '## 入场、退出和账户模型', '',
    (s.config.grid as MiningGrid).minuteDea ? '历史每整点涨幅前十；1m MACD(12,26,9)，DEA高/中/低与DIFF多/空均参与搜索；无MA支撑是硬性条件。下一分钟开盘做空，同币单仓，无冷却。' : '历史每整点涨幅前十；1m DEA高位、DIF≥DEA且无MA支撑。下一分钟开盘做空，同币单仓，无冷却。',
    `无 MA 支撑：MA${SUPPORT_MA_PERIODS.join('/')} 均不满足信号分钟的 low < MA < close；均线含当根已收盘close，等于边界不算支撑。与监控共用计算函数，至少具备120根连续历史，缺口后重新预热。`,
    '开盘跳空按开盘价成交；开盘同时越过止损和强平线按强平处理。分钟内连续触碰时，止损与强平选择先到达的较近阈值；与止盈同根双触时先处理不利退出。',
    `逐仓维持保证金率假设 ${account.maintenanceMarginPercent}%；强平费假设 ${account.liquidationFeeBps} bps。强平价=入场价×(1+1/杠杆)/(1+维持保证金率+预估平仓成本率)。不自动追加保证金。强平损失限于该仓保证金，开仓成本另计，穿仓缺口单列。`,
    '**强平使用成交价OHLC代替标记价格，固定维持保证金率不代表币安各币种实际阶梯；未导入历史资金费、精度/最小下单量及强平保险基金规则。此为明确假设下的合约模拟。**',
    '账户净值=可用余额+锁定保证金+未实现盈亏；回撤按分钟收盘和入场扣费时点计算，不能覆盖分钟内全部浮亏。同分钟资金冲突按币种代码排序，不能借用本分钟尚未实现的盈利。持仓缺行情则标为无效，禁止作为成果。', '',
    `数据覆盖：${JSON.stringify(s.config.coverage)}。时间切分：${JSON.stringify(s.config.split)}（UTC毫秒，60/20/20）。`,
    `训练样本至少 ${s.config.minTrades}，验证/测试至少 ${Math.ceil(Number(s.config.minTrades) / 3)}。按账户净收益率选参，同收益优先较小账户净值回撤；成果要求三段均正收益、无缺失、无强平。`,
    'GPU批量计算包含强平阈值的首次退出，同一退出参数在训练集内复用GPU结果；CPU执行双周期入场过滤与时间资金账本。每轮首组和最佳组核对完整CPU结果。所有轮次只搜索训练集，完成后固定训练前五进入验证，选一个进入最终留出。', '',
    ...(s.config.fifteenRule || s.config.btcFiveRule ? [
      `## ${companion} 叠加维度`, '',
      `${companion} MACD(12,26,9)，原生K线连续300根预热，最近100根DEA峰值。高位=DEA>0且DEA≥独立高位比例×峰值；中位=DEA≥0且未达高位；低位=DEA<0。DIFF≥DEA为多头，DIFF<DEA为空头。`,
      `1m和${companion}的DEA、DIFF、高位比例和连续阈值独立组合。某周期低位或不限DEA时，只去除该周期无效的高位比例重复项。`,
      `两个周期均必须无MA支撑：MA5/7/10/20/25/30/60/99/120全部不满足各自已收盘线 low < MA < close。any仅放开DEA/DIFF，仍要求MA无支撑。`,
      btc ? '所有涨幅榜币种共用BTCUSDT 5m，不要求BTC在榜。入场t精确关联floor(t/5m)×5m时收盘的BTC线：10:04用10:00收盘线，10:05用10:05收盘线。交易与盈亏仍属于榜内币种。'
        : '15m使用交易币种自身数据。入场t关联floor(t/15m)×15m时收盘的线：10:14用10:00收盘线，10:15用10:15收盘线。',
      '不使用正在形成的线。缺失或预热不足直接排除，缺口后重新预热。',
      `${companion}覆盖：${JSON.stringify(btc ? s.config.btcFiveCoverage : s.config.fifteenCoverage)}。`, '',
      '### 各组合训练集比较（不读取验证/留出收益）', '',
      `|1m DEA|1m DIFF|${companion} DEA|${companion} DIFF|搜索组数|训练≥门槛组数|足量训练最佳笔数|足量训练最佳账户收益%|`, '|---|---|---|---|---|---|---|---|',
      ...companionFamilyRows(s), '',
    ] : []),
    ...(s.config.grid && ((s.config.grid as MiningGrid).minuteStreak || (s.config.grid as MiningGrid).fifteenStreak || (s.config.grid as MiningGrid).btcFiveStreak) ? [
      '## 独立连阳/连阴组合', '',
      '正N=至少N连阳，负N=至少N连阴，0=不限；两个周期分别取值后做笛卡尔积，不要求相等，也不禁止相等。阳线close>open，阴线close<open；十字星、方向变化或缺口中断。计数包含当根已收盘线，监控与研究共用consecutiveStreakAt。',
      `候选数超过max-trials时，按DEA/DIFF双周期状态×1m连续阈值×${companion}连续阈值分层等额抽样；每层内对阈值/持仓/止损/止盈组合无放回抽取。抽样在加载收益前由固定种子确定，未运行的组合不计作已验证。`, '',
      `|1m连续条件|${companion}连续条件|已运行组数|足量训练组数|足量训练最佳账户收益%|`, '|---|---|---|---|---|',
      ...streakFamilyRows(s), '',
    ] : []),
    '## GPU轮次', '', '|轮次|新参数|GPU秒|CPU复核组|训练最高账户收益%|', '|---|---|---|---|---|',
    ...s.rounds.map((r) => `|${r.round}|${r.trials}|${r.gpuSeconds.toFixed(3)}|${r.scalarChecks}|${fmt(r.accountReturnPercent)}|`), '',
    '## 最终候选', '',
  ];
  if (s.winner) {
    const w = s.winner, rr = rewardRisk(w.parameters, cost), notional = account.marginPerTradeUSDT * account.leverage;
    lines.push(parameterText(w.parameters, cost), '',
      `正常止盈净赚约 ${(notional * rr.gain / 100).toFixed(4)} USDT（保证金收益 ${(rr.gain * account.leverage).toFixed(4)}%）；正常止损净亏约 ${(notional * rr.loss / 100).toFixed(4)} USDT（保证金损失 ${(rr.loss * account.leverage).toFixed(4)}%）。此估计不含跳空或提前强平。`,
      `结果：${w.qualified ? '通过本次合约模拟研究门槛，需新独立时期验证' : '未通过全部研究门槛'}。`, '',
      '|阶段|成交笔数|账户期末USDT|账户净收益USDT|账户收益%|平均每笔保证金收益%|账户净值回撤%|资金不足跳过|强平|', '|---|---|---|---|---|---|---|---|---|',
      ...(['train', 'validation', 'test'] as const).map((k) => { const m = w[k]; return `|${k}|${m.trades}|${fmt(m.finalBalanceUSDT)}|${fmt(m.netPnlUSDT)}|${fmt(m.accountReturnPercent)}|${fmt(m.meanMarginReturnPercent)}|${fmt(m.maxEquityDrawdownPercent)}|${m.skippedFunds}|${m.liquidations}|`; }), '',
      '|阶段|胜率%|PF|最高同时持仓|最大锁定保证金USDT|总成本USDT|缺失|边界剔除|持仓上限跳过|', '|---|---|---|---|---|---|---|---|---|',
      ...(['train', 'validation', 'test'] as const).map((k) => { const m = w[k]; return `|${k}|${fmt(m.winRate)}|${fmt(m.profitFactor)}|${m.maxConcurrentPositions}|${fmt(m.maxLockedMarginUSDT)}|${fmt(m.totalCostsUSDT)}|${m.missing}|${m.purged}|${m.skippedPositionLimit}|`; }), '');
  } else lines.push(s.status === 'complete' ? '没有达到训练/验证最低有效样本数的候选。' : '尚未完成搜索，最终留出尚未使用。', '');
  lines.push('## 成果播报与复现', '',
    '此前价格收益报告没有杠杆、保证金及资金约束；本版本按合约账户重新选参和结算。原报告的一天行情已被观察，不构成新独立验证。当前合约池有存活偏差；目标盈亏比不是包含跳空和超时的实际盈亏比。',
    `Telegram：${s.notices.filter((n) => n.sentAt).length} 条已确认，${s.notices.filter((n) => !n.sentAt).length} 条待发。消息中明确杠杆、保证金、初始资金、账户收益、回撤和强平。`,
    'state.json 保存账户参数、代码指纹及带SHA256的trials-起点-终点.json分片索引；分片保存每组训练结果，validations保存入围验证结果；trials.csv 保存每组账户结果；test-trades.csv 保存逐笔保证金、名义金额、费用与盈亏；test-equity.csv 保存留出账户净值。', '');
  await writeFile(path.join(out, 'report.md'), lines.join('\n'));
  await writeFile(path.join(out, 'trials.csv'), ['id,round,highRatio,holdMinutes,stopLossPercent,takeProfitPercent,minuteDea,minuteDif,fifteenDea,fifteenDif,fifteenHighRatio,minuteStreak,fifteenStreak,btcFiveDea,btcFiveDif,btcFiveHighRatio,btcFiveStreak,trainTrades,trainAccountReturnPercent,trainDrawdownPercent,trainSkippedFunds,trainLiquidations,validationTrades,validationAccountReturnPercent',
    ...s.trials.map((t) => [t.id, t.round, t.parameters.highRatio, t.parameters.holdMinutes, t.parameters.stopLossPercent, t.parameters.takeProfitPercent, t.parameters.minuteDea, t.parameters.minuteDif, t.parameters.fifteenDea, t.parameters.fifteenDif, t.parameters.fifteenHighRatio, t.parameters.minuteStreak, t.parameters.fifteenStreak, t.parameters.btcFiveDea, t.parameters.btcFiveDif, t.parameters.btcFiveHighRatio, t.parameters.btcFiveStreak, t.train.trades, t.train.accountReturnPercent, t.train.maxEquityDrawdownPercent, t.train.skippedFunds, t.train.liquidations, t.validation?.trades, t.validation?.accountReturnPercent].join(','))].join('\n') + '\n');
  const tradeKeys: (keyof AccountTrade)[] = ['symbol', 'entryTime', 'exitTime', 'entryPrice', 'exitPrice', 'reason', 'leverage', 'marginUSDT', 'notionalUSDT', 'quantity', 'liquidationPrice', 'grossPnlUSDT', 'entryCostUSDT', 'exitCostUSDT', 'liquidationFeeUSDT', 'insuranceShortfallUSDT', 'netPnlUSDT', 'marginReturnPercent', 'netPercent', 'ambiguous', 'supportMa', 'minuteDea', 'minuteDif', 'minuteDeaLevel', 'minuteDirection', 'fifteenClosedAt', 'fifteenDea', 'fifteenDif', 'fifteenDeaLevel', 'fifteenDirection', 'fifteenSupportMa', 'minuteStreakCount', 'minuteStreakDirection', 'fifteenStreakCount', 'fifteenStreakDirection', 'btcFiveSymbol', 'btcFiveClosedAt', 'btcFiveDea', 'btcFiveDif', 'btcFiveDeaLevel', 'btcFiveDirection', 'btcFiveSupportMa', 'btcFiveStreakCount', 'btcFiveStreakDirection'];
  await writeFile(path.join(out, 'test-trades.csv'), [tradeKeys.join(','), ...(s.winner?.testTrades ?? []).map((t) => tradeKeys.map((k) => k === 'entryTime' || k === 'exitTime' ? iso(t[k]) : t[k]).join(','))].join('\n') + '\n');
  const equityKeys: (keyof EquityPoint)[] = ['time', 'phase', 'freeUSDT', 'lockedMarginUSDT', 'unrealizedPnlUSDT', 'equityUSDT', 'positions'];
  await writeFile(path.join(out, 'test-equity.csv'), [equityKeys.join(','), ...(s.winner?.testEquity ?? []).map((point) => equityKeys.map((k) => k === 'time' ? iso(point.time) : point[k]).join(','))].join('\n') + '\n');
}

export async function main(args = process.argv.slice(2)) {
  const strings = ['study', 'btc-five-data', 'max-trials', 'fifteen-data', 'data', 'minutes-data', 'out', 'grid', 'batch', 'signal-batch', 'rounds', 'min-trades', 'min-net-rr', 'fee-bps', 'slippage-bps', 'seed', 'python', 'device', 'leverage', 'margin-usdt', 'balance-usdt', 'max-positions', 'maintenance-margin-percent', 'liquidation-fee-bps'];
  const booleans = ['fetch-btc-five', 'fetch-fifteen', 'resume', 'no-telegram', 'notify-only', 'help'];
  const parsed = parseArgs({ args, strict: true, options: Object.fromEntries([
    ...strings.map((k) => [k, { type: 'string' as const }]), ...booleans.map((k) => [k, { type: 'boolean' as const }]),
  ]) });
  const values = parsed.values as Record<string, string | boolean | undefined>;
  if (values.help) { console.log(HELP); return; }
  const str = (k: string, d: string) => String(values[k] ?? d);
  const num = (k: string, d: number, min: number, max: number, integer = true) => {
    const n = Number(values[k] ?? d);
    if (!String(values[k] ?? d).trim() || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new Error(`${k} 必须为 ${min}..${max}${integer ? ' 的整数' : ''}`);
    return n;
  };
  const study = str('study', 'gainers');
  if (!['gainers', 'btc5m'].includes(study)) throw new Error('study 必须为 gainers 或 btc5m');
  const btcStudy = study === 'btc5m';
  if ((btcStudy && (values['fetch-fifteen'] || values['fifteen-data'])) || (!btcStudy && (values['fetch-btc-five'] || values['btc-five-data']))) throw new Error('请使用当前研究对应的缓存选项');
  const out = path.resolve(str('out', btcStudy ? 'reports/research/gainers-gpu-margin-no-ma-btc5m' : 'reports/research/gainers-gpu-margin-no-ma-streak'));
  if (values['notify-only'] && values['no-telegram']) throw new Error('notify-only 与 no-telegram 互斥');
  const batch = num('batch', 32, 1, 128), signalBatch = num('signal-batch', 1024, 1, 4096);
  const rounds = num('rounds', 0, 0, 100000), minTrades = num('min-trades', 100, 1, 100000);
  const minNetRR = num('min-net-rr', 3, 3, 100, false), seed = num('seed', 42, 0, 0xffffffff);
  const fee = num('fee-bps', 5, 0, 100, false), slippage = num('slippage-bps', 2, 0, 100, false), cost = fee + slippage;
  const account: AccountOptions = {
    initialBalanceUSDT: num('balance-usdt', DEFAULT_ACCOUNT.initialBalanceUSDT, 0.01, 1e9, false),
    marginPerTradeUSDT: num('margin-usdt', DEFAULT_ACCOUNT.marginPerTradeUSDT, 0.01, 1e9, false),
    leverage: num('leverage', DEFAULT_ACCOUNT.leverage, 1, 125), maxPositions: num('max-positions', DEFAULT_ACCOUNT.maxPositions, 1, 100),
    maintenanceMarginPercent: num('maintenance-margin-percent', DEFAULT_ACCOUNT.maintenanceMarginPercent, 0, 10, false),
    liquidationFeeBps: num('liquidation-fee-bps', DEFAULT_ACCOUNT.liquidationFeeBps, 0, 500, false), costBps: cost,
  };
  validateAccount(account);
  const device = str('device', 'mps');
  if (!['mps', 'cpu'].includes(device)) throw new Error('device 必须是 mps 或 cpu');
  await mkdir(out, { recursive: true });
  const unlock = await acquireMiningLock(out);
  let sender: ReturnType<typeof createMiningSender> | undefined;
  let worker: GpuWorker | undefined;
  let stopping = false;
  const stop = () => { stopping = true; console.log('收到停止请求，将保存当前轮次后退出。'); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    sender = values['no-telegram'] ? undefined : createMiningSender();
    const stateFile = path.join(out, 'state.json');
    let state: State | undefined;
    try {
      state = JSON.parse(await readFile(stateFile, 'utf8'));
    }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (state?.version === 4) state = await hydrateMiningState(out, state);
    if (values['notify-only']) {
      if (!state || ![3, 4].includes(state.version)) throw new Error('没有可补发的研究状态');
      await flushNotices(state.notices, sender!.send, () => state!.version === 4 ? saveMiningState(out, state!) : atomicJson(stateFile, state));
      await writeReport(out, state, Number(state.config.total));
      const pending = state.notices.filter((n) => !n.sentAt);
      console.log(`补发后：${pending.length} 条待发`);
      if (pending.length) process.exitCode = 2;
      return;
    }
    if (state && !values.resume) throw new Error('输出目录已有研究，请加 --resume 或使用新目录');
    if (!state && values.resume) throw new Error('找不到可续跑的 state.json');
    const dataDir = path.resolve(str('data', 'data/research/hourly-initial'));
    const minuteDir = path.resolve(str('minutes-data', 'data/research/gainers-1m-archive-1day'));
    const grid = validateMiningGrid(JSON.parse(await readFile(str('grid', fileURLToPath(new URL(btcStudy ? './miner-grid-btc5m.json' : './miner-grid-streak.json', import.meta.url))), 'utf8')));
    if (btcStudy !== !!grid.btcFiveDea) throw new Error('BTC 5m 网格需搭配 --study btc5m；该研究必须包含BTC 5m维度');
    const search = miningSearch(grid, cost, minNetRR, seed, num('max-trials', 400000, 1, 400000));
    const candidates = search.candidates;
    const horizon = Math.max(...grid.holdMinutes);
    console.log('校验完整小时/分钟缓存，重建历史涨幅榜…');
    const hourly = await loadDataset(dataDir);
    const manifest = JSON.parse(await readFile(path.join(minuteDir, 'manifest.json'), 'utf8')) as MinuteManifest;
    const plan = manifest.plan;
    if (!plan || plan.topN !== 10 || plan.highWindow !== 100 || plan.maxHoldMinutes < horizon || plan.start < hourly.manifest.start || plan.end > hourly.manifest.end) throw new Error('分钟缓存需为前十/100根高位窗口，并覆盖本次持有期及小时研究区间');
    hourly.manifest = { ...hourly.manifest, start: plan.start, end: plan.end };
    const frames = buildFrames(hourly, 10, 1);
    const rebuilt = planGainersMinutes(hourly, frames, { topN: 10, highWindow: 100, grid: { ...grid, holdMinutes: [plan.maxHoldMinutes] } });
    const minute = await loadGainersMinutes(minuteDir, rebuilt);
    let signals = buildMinuteSignals(minute, frames, 100, Math.min(...grid.highRatio), grid.minuteDea !== undefined);
    let fifteenData: Awaited<ReturnType<typeof loadFifteen>> | undefined;
    const fifteenDir = path.resolve(str('fifteen-data', 'data/research/gainers-15m-1day'));
    if (grid.fifteenDea) {
      const plan15 = planFifteen(plan.start, plan.end, [...minute.candles.keys()]);
      if (values['fetch-fifteen']) await fetchFifteen(fifteenDir, plan15);
      fifteenData = await loadFifteen(fifteenDir, plan15);
      signals = attachFifteen(signals, fifteenData.candles);
    }
    let btcFiveData: Awaited<ReturnType<typeof loadBtcFive>> | undefined;
    const btcFiveDir = path.resolve(str('btc-five-data', 'data/research/btc-5m-1day'));
    if (btcStudy) {
      const plan5 = planBtcFive(plan.start, plan.end);
      if (values['fetch-btc-five']) await fetchBtcFive(btcFiveDir, plan5);
      btcFiveData = await loadBtcFive(btcFiveDir, plan5);
      signals = attachBtcFive(signals, btcFiveData.candles);
    }
    const start = plan.start, end = plan.end, duration = (end - start) / MINUTE;
    const trainEnd = start + Math.floor(duration * 0.6) * MINUTE;
    const validationEnd = trainEnd + Math.floor(duration * 0.2) * MINUTE;
    if (Math.min(trainEnd - start, validationEnd - trainEnd, end - validationEnd) < horizon * MINUTE) throw new Error('每段需覆盖最大持有期');
    const trainingSignals = signals.filter((s) => s.time >= start && s.time < trainEnd);
    const sources = ['btc-five.ts', 'btc-five-data.ts', 'native-data.ts', 'streak.ts', 'miner-state.ts', 'fifteen.ts', 'fifteen-data.ts', 'client.ts', 'miner.ts', '../src/macd.ts', 'gainers-types.ts', 'types.ts', 'futures-account.ts', 'miner-core.ts', 'miner-notify.ts', 'gpu.ts', 'gpu/worker.py', 'gpu/requirements.txt', 'gainers-backtest.ts', 'gainers-config.ts', 'gainers-data.ts', 'backtest.ts', 'data.ts'];
    const hashes: Record<string, string> = {};
    for (const file of sources) hashes[file] = digest(await readFile(new URL(file, import.meta.url)));
    const referencePath = 'reports/research/gainers-high-bull-1day/gainers/report.md';
    const referenceBytes = await readFile(referencePath).catch((e) => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    });
    const config = { grid, search: search.plan, total: candidates.length, seed, minTrades, minNetRR, costBps: cost, feeBps: fee, slippageBps: slippage,
      device, batch, account, entryRule: { noMaSupport: true, periods: SUPPORT_MA_PERIODS, supportCondition: 'signal.low < SMA(close) < signal.close' }, selectionMetric: 'accountReturnPercent', split: { start, trainEnd, validationEnd, end }, sourceHashes: hashes,
      reference: { path: referencePath, sha256: referenceBytes ? digest(referenceBytes) : null },
      coverage: { poolSymbols: hourly.manifest.symbols.length, boardHours: frames.length, minuteSymbols: minute.candles.size,
        minuteBars: [...minute.candles.values()].reduce((n, bars) => n + bars.length, 0),
        missingMinutes: Object.values(manifest.files).reduce((n, f) => n + f.missingMinutes, 0) },
      hourlyHash: digest(Buffer.from(JSON.stringify(hourly.manifest))), minuteHash: digest(Buffer.from(JSON.stringify(manifest))),
      ...(fifteenData ? { fifteenRule: { ...FIFTEEN_RULE, highRatio: grid.fifteenHighRatio ?? [FIFTEEN_RULE.highRatio], noMaSupport: true }, fifteenDir,
        fifteenHash: digest(Buffer.from(JSON.stringify(fifteenData.manifest))),
        fifteenCoverage: { symbols: fifteenData.candles.size, bars: [...fifteenData.candles.values()].reduce((n, a) => n + a.length, 0),
          missingBars: Object.values(fifteenData.manifest.files).reduce((n, f) => n + f.missingBars, 0),
          joinedSignals: signals.filter((s) => s.fifteen).length, unavailableSignals: signals.filter((s) => !s.fifteen).length,
          noSupportSignals: signals.filter((s) => s.fifteen?.supportMa === null).length,
          trainingNoSupport: trainingSignals.filter((s) => s.fifteen?.supportMa === null).length } } : {}),
      ...(btcFiveData ? { study, btcFiveRule: { ...BTC_FIVE_RULE, highRatio: grid.btcFiveHighRatio ?? [BTC_FIVE_RULE.highRatio], noMaSupport: true }, btcFiveDir,
        btcFiveHash: digest(Buffer.from(JSON.stringify(btcFiveData.manifest))),
        btcFiveCoverage: { symbols: btcFiveData.candles.size, bars: [...btcFiveData.candles.values()].reduce((n, a) => n + a.length, 0),
          missingBars: Object.values(btcFiveData.manifest.files).reduce((n, f) => n + f.missingBars, 0),
          joinedSignals: signals.filter((s) => s.btcFive).length, unavailableSignals: signals.filter((s) => !s.btcFive).length,
          noSupportSignals: signals.filter((s) => s.btcFive?.supportMa === null).length,
          trainingNoSupport: trainingSignals.filter((s) => s.btcFive?.supportMa === null).length } } : {}),
      signalCount: signals.length, trainingSignals: trainingSignals.length, dataDir, minuteDir };
    const fingerprint = digest(Buffer.from(JSON.stringify(config)));
    if (state && (state.version !== 4 || state.fingerprint !== fingerprint)) throw new Error('数据、代码或挖掘参数已变化，拒绝混合续跑；请使用新输出目录');
    state ??= { version: 4, fingerprint, config, createdAt: new Date().toISOString(), status: 'mining', next: 0, trials: [], rounds: [], bestNotified: null, notices: [] };
    const s = state;
    const entryLabel = (btcStudy ? '涨幅榜1m+BTC5m无MA支撑' : grid.fifteenDea ? '1m+15m双周期无MA支撑' : '1m无MA支撑') + (grid.minuteStreak || grid.fifteenStreak || grid.btcFiveStreak ? '·独立连阳/连阴组合' : '');
    const save = () => saveMiningState(out, s);
    const flush = async () => {
      if (sender) await flushNotices(s.notices, sender.send, save);
      const failed = s.notices.find((n) => !n.sentAt && n.lastError);
      if (failed) console.error(`TG待重试：${failed.lastError}；事件 ${failed.id}`);
    };
    await save();
    await flush();
    if (s.status === 'complete') {
      await writeReport(out, s, candidates.length);
      console.log(`此研究已完成，未重跑搜索或留出测试：${out}/report.md`);
      if (sender && s.notices.some((n) => !n.sentAt)) process.exitCode = 2;
      return;
    }
    const windowFile = path.join(out, 'training.f32');
    await writeGpuWindows(windowFile, minute, trainingSignals, horizon, trainEnd);
    worker = new GpuWorker(path.resolve(str('python', '.venv-gpu/bin/python')));
    const info = await worker.init(windowFile, trainingSignals.length, horizon, device);
    if (s.gpu && s.gpu.torch !== info.torch) throw new Error('PyTorch版本变化，请用新目录重新研究');
    s.gpu = info;
    notice(s, 'started', `GPU做空挖掘已启动·${entryLabel}\n设备 ${info.device} / PyTorch ${info.torch}\n${iso(start)} → ${iso(end)}\n${candidates.length}/${search.plan.possible}组参数（${search.plan.exhaustive ? '全量' : '分层抽样'}，种子${seed}）；1–60分钟；净目标盈亏比≥${minNetRR}:1\n${accountText(account)}\n1m连续阈值 ${JSON.stringify(grid.minuteStreak ?? [0])}；${btcStudy ? 'BTC 5m' : '15m'}连续阈值 ${JSON.stringify((btcStudy ? grid.btcFiveStreak : grid.fifteenStreak) ?? [0])}；正数连阳/负数连阴/0不限，独立组合。\n${btcStudy ? '涨幅榜1m与BTC 5m各自DEA高/中/低 × DIFF多/空；仅用已收盘线；两个周期均无MA支撑。' : grid.fifteenDea ? '1m、15m各自DEA高/中/低 × DIFF多/空；仅用已收盘线；1m与15m均无MA支撑。' : '1m无MA支撑。'}按账户收益重新选参。强平为成交价代理模型，未导入资金费。`);
    await save(); await flush();
    console.log(`设备 ${info.device}；训练信号 ${trainingSignals.length}；有效参数 ${candidates.length}；从第 ${s.next + 1} 组继续`);
    let addedRounds = 0;
    while (s.next < candidates.length && !stopping && (!rounds || addedRounds < rounds)) {
      const parameters = candidates.slice(s.next, s.next + batch);
      const result = await worker.evaluateCached(parameters.map((p) => accountGpuParameters(p, account)), signalBatch);
      if (result.offsets.length !== parameters.length) throw new Error('GPU返回批次长度错误');
      const round = s.rounds.length + 1;
      const evaluations = parameters.map((p, i) => backtestAccount(minute, trainingSignals, p, start, trainEnd, account, result.offsets[i]));
      const batchTrials: AccountTrial[] = parameters.map((p, i) => ({ id: `gpu-${String(s.next + i + 1).padStart(6, '0')}`, round, parameters: p, train: evaluations[i].metrics, validation: null }));
      const best = [...batchTrials].sort(accountTrainOrder)[0];
      const checkIndices = new Set([0, batchTrials.indexOf(best)]);
      for (const i of checkIndices) {
        const scalar = backtestAccount(minute, trainingSignals, parameters[i], start, trainEnd, account);
        if (!isDeepStrictEqual(scalar, evaluations[i])) throw new Error(`GPU/CPU逐笔不一致，停止，轮次未提交：${batchTrials[i].id}`);
      }
      s.trials.push(...batchTrials); s.next += parameters.length;
      s.rounds.push({ round, trials: parameters.length, gpuSeconds: result.seconds, gpuComputed: result.computed, scalarChecks: checkIndices.size, accountReturnPercent: best.train.accountReturnPercent });
      const discovery = accountDiscovery(batchTrials, minTrades, s.bestNotified);
      if (discovery) {
        // Always independently replay any result that will be announced.
        const replay = backtestAccount(minute, trainingSignals, discovery.parameters, start, trainEnd, account).metrics;
        if (!isDeepStrictEqual(replay, discovery.train)) throw new Error('成果复核不一致，停止播报');
        s.bestNotified = discovery.train.accountReturnPercent;
        notice(s, `train-${discovery.id}`, `做空挖掘·${entryLabel}·训练阶段发现（尚未留出验证）\n第${round}轮 / ${discovery.id}\n${parameterText(discovery.parameters, cost)}\n${accountText(account)}\n训练：${metricText(discovery.train)}\n账户训练正收益新纪录；强平用成交价代理、未导入资金费，尚需独立验证。`);
      }
      await save(); await flush();
      if (round === 1 || round % 64 === 0 || discovery) await writeReport(out, s, candidates.length);
      console.log(`第${round}轮 ${s.next}/${candidates.length}，GPU ${result.seconds.toFixed(3)}s，训练账户最佳 ${fmt(best.train.accountReturnPercent)}%，CPU逐笔复核 ${checkIndices.size}组`);
      addedRounds++;
    }
    worker.close(); worker = undefined;
    if (s.next === candidates.length && !stopping) {
      const shortlist = s.trials.filter((t) => t.train.valid && t.train.trades >= minTrades).sort(accountTrainOrder).slice(0, 5);
      for (const t of shortlist) t.validation = backtestAccount(minute, signals, t.parameters, trainEnd, validationEnd, account).metrics;
      const minEvaluation = Math.ceil(minTrades / 3);
      const selected = shortlist.filter((t) => t.validation!.valid && t.validation!.trades >= minEvaluation).sort(accountValidationOrder)[0];
      s.winner = null;
      if (selected) {
        const test = backtestAccount(minute, signals, selected.parameters, validationEnd, end, account);
        s.winner = { trialId: selected.id, parameters: selected.parameters, train: selected.train, validation: selected.validation!, test: test.metrics, testTrades: test.trades, testEquity: test.equity,
          qualified: accountQualified(selected.train, minTrades) && accountQualified(selected.validation!, minEvaluation) && accountQualified(test.metrics, minEvaluation) };
      }
      s.status = 'complete'; s.completedAt = new Date().toISOString();
      const w = s.winner;
      notice(s, 'completed', `做空挖掘完成·${entryLabel}·${w?.qualified ? '达到研究成果门槛' : '未获得通过全部门槛的策略'}\n${s.next}/${search.plan.possible}组参数 / ${s.rounds.length}轮（${search.plan.exhaustive ? '全量' : '预定分层抽样完成'}）\n${accountText(account)}\n${w ? `${parameterText(w.parameters, cost)}\n训练：${metricText(w.train)}\n验证：${metricText(w.validation)}\n历史留出：${metricText(w.test)}` : '训练或验证样本不足。'}\n本次已计入杠杆、保证金和资金占用。强平用成交价代理、未导入资金费；原报告区间已被观察，需新独立时期验证。\n报告 ${out}/report.md`);
      await save();
    }
    // Retry transient failures at completion; longer rate limits remain durable.
    for (let i = 0; sender && i < 3 && !stopping && s.notices.some((n) => !n.sentAt); i++) {
      const due = s.notices.find((n) => !n.sentAt)!.nextAttemptAt;
      if (due - Date.now() > 15_000) break;
      if (due > Date.now()) await new Promise((resolve) => setTimeout(resolve, due - Date.now()));
      await flush();
    }
    await writeReport(out, s, candidates.length);
    console.log(`${s.status === 'complete' ? '挖掘完成' : '已保存断点，使用相同参数加 --resume 继续'}：${out}/report.md`);
    if (sender && s.notices.some((n) => !n.sentAt)) { console.error('尚有TG消息待发；使用 --notify-only 补发，详见 state.json'); process.exitCode = 2; }
  } finally {
    worker?.close();
    await sender?.close();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    await unlock();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => { console.error(`[miner] ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
}
