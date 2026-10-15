import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AccountMetrics, AccountResult, AccountTrial } from './futures-account.ts';
import { accountTrainOrder } from './futures-account.ts';
import type { MiningParameters } from './fifteen.ts';
import type { TrialShard } from './miner-state.ts';
import type { GpuInfo } from './gpu.ts';

export interface MonitorState {
  version: 1; fingerprint: string; config: Record<string, unknown>; createdAt: string;
  status: 'mining' | 'complete'; next: number; trials: AccountTrial[]; trialShards?: TrialShard[];
  validations?: Record<string, AccountMetrics>; gpu?: GpuInfo;
  rounds: { round: number; trials: number; seconds: number; scalarChecks: number }[];
  baseline: { parameters: MiningParameters; train: AccountMetrics; validation?: AccountMetrics; test?: AccountMetrics };
  winner?: { trialId: string; parameters: MiningParameters; train: AccountMetrics; validation: AccountMetrics; test: AccountResult; qualified: boolean } | null;
  completedAt?: string;
}
const num = (n: number | null | undefined) => n == null ? '—' : n.toFixed(3);
const metricRow = (name: string, m: AccountMetrics) => `|${name}|${m.trades}|${num(m.accountReturnPercent)}|${num(m.maxEquityDrawdownPercent)}|${num(m.winRate)}|${num(m.profitFactor)}|${m.missing}|${m.liquidations}|`;
const metricHeader = ['|阶段|笔数|账户收益%|净值回撤%|胜率%|PF|缺失|强平|', '|---|---|---|---|---|---|---|---|'];
export function monitorParameterText(p: MiningParameters) {
  const entry = p.monitorMode === 'baseline' ? '当前播报基线：5m中 + (1m中且≥2连阳 / 1m低且≥2连阴)，回撤>4%'
    : `1m DIFF ${p.diff1mLevel} / 5m DIFF ${p.diff5mLevel} / 连续${p.minuteStreak} / 高点回撤>${p.minDrawdownPercent}%`;
  return `${entry}；高位比${p.highRatio}/${p.fiveHighRatio}；持有≤${p.holdMinutes}m，止损${p.stopLossPercent}%，止盈${p.takeProfitPercent}%`;
}
function csv(rows: Record<string, unknown>[], keys: string[]) {
  const quote = (v: unknown) => `"${String(v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : v).replaceAll('"', '""')}"`;
  return [keys.map(quote).join(','), ...rows.map((r) => keys.map((k) => quote(r[k])).join(','))].join('\n') + '\n';
}
export async function writeMonitorReport(directory: string, s: MonitorState) {
  const lines = [`# ${s.config.board === 'gainers' ? '涨幅榜' : '跌幅榜'}：同币 1m + 5m DIFF 做空挖掘`, '',
    `状态 ${s.status}；进度 ${s.next}/${s.config.total}；设备 ${s.gpu?.device ?? '待初始化'}；创建 ${s.createdAt}。`,
    `研究指纹 ${s.fingerprint}。`, '',
    'DIFF严格指MACD柱体2×(DIF−DEA)。最近100根窗口，高=正柱且≥比例×峰值；中=非负且未达高；低=负柱。',
    '两周期均属于交易币种自身，5m由连续、完整、UTC对齐的1m聚合；只使用决策时刻已收盘的5m。缺口后重启300根预热。',
    '固定过滤：1m无MA支撑（5/7/10/20/25/30/60/99/120，严格low<MA<close），60D上涨；要求1500根连续分钟历史。新币日线不足61根时按已知上市日起的完整历史比较，缺日不通过。',
    '本研究在每分钟收盘采样，用该收盘价和截至该分钟的1500根已收盘最高价判断回撤，下一分钟开盘入场。线上使用实时现价和包含正在形成线的高点，二者采样时刻不同。',
    '每整点用全市场小时行情重建24h榜，剔除BTC/SOL后取前十。涨跌榜独立账户和选参；不模拟秒级榜单变更、跌出榜留存、≥3币触发门槛及播报去重，因此这是单币条件研究。', '',
    `区间与切分：${JSON.stringify(s.config.split)}。60/20/20按时间划分，按最长持仓事前剔除跨段入场。`,
    `账户：${JSON.stringify(s.config.account)}。每段独立重置；同币单仓、无冷却；费用按杠杆后名义金额计算。`,
    '跳空开盘成交，同根双触先不利退出；强平用成交价OHLC近似，不含资金费与真实盘口。使用当前合约池存在存活偏差；历史包含此前观察过的时期，留出不等于全新独立样本。', '',
    `数据覆盖：${JSON.stringify(s.config.coverage)}。`,
    `预定搜索：${JSON.stringify(s.config.search)}。抽样在观察收益前完成；只搜索训练集。训练前五参与验证，选一个最终留出。训练至少${s.config.minTrades}笔，验证/留出至少${Math.ceil(Number(s.config.minTrades) / 3)}笔。`,
    `网格：${JSON.stringify(s.config.grid)}。连续阈值正N=至少N连阳，负N=至少N连阴，0=不限。`, '',
    '## 预先固定的播报条件基线', '', monitorParameterText(s.baseline.parameters), '',
    '基线的持有15分钟、止损0.3%、止盈2%是预先固定的回测退出设置，线上播报没有下单或退出规则。', '', ...metricHeader,
    metricRow('训练', s.baseline.train),
    ...(s.baseline.validation ? [metricRow('验证', s.baseline.validation)] : []),
    ...(s.baseline.test ? [metricRow('留出', s.baseline.test)] : []), '',
    '## 训练前十（不读取验证/留出排序）', '',
    '|ID|入场及退出参数|笔数|账户收益%|净值回撤%|', '|---|---|---|---|---|',
    ...s.trials.filter((t) => t.train.valid && t.train.trades >= Number(s.config.minTrades)).sort(accountTrainOrder).slice(0, 10)
      .map((t) => `|${t.id}|${monitorParameterText(t.parameters)}|${t.train.trades}|${num(t.train.accountReturnPercent)}|${num(t.train.maxEquityDrawdownPercent)}|`), '',
    '## 最终选参', '',
  ];
  if (s.winner) {
    lines.push(monitorParameterText(s.winner.parameters), '', s.winner.qualified ? '通过本次三段样本与收益门槛。' : '未通过全部研究门槛。', '', ...metricHeader,
      metricRow('训练', s.winner.train), metricRow('验证', s.winner.validation), metricRow('留出', s.winner.test.metrics));
  } else lines.push(s.status === 'complete' ? '没有达到训练/验证样本门槛的候选。' : '挖掘进行中，验证和最终留出尚未使用。');
  lines.push('', 'state.json与带SHA256的trials分片保存断点。每轮首组和最佳组逐笔核对GPU/CPU结果；resume拒绝变化的代码、数据、网格或账户设置。', '');
  await writeFile(path.join(directory, 'report.md'), lines.join('\n'));
  const rows = s.trials.map((t) => ({ id: t.id, round: t.round, ...t.parameters, ...t.train, validation: t.validation }));
  await writeFile(path.join(directory, 'trials.csv'), csv(rows, Object.keys(rows[0] ?? { id: '', round: '', parameters: '' })));
  if (s.status === 'complete') {
    const trades = s.winner?.test.trades ?? [], equity = s.winner?.test.equity ?? [];
    await writeFile(path.join(directory, 'test-trades.csv'), csv(trades as unknown as Record<string, unknown>[], Object.keys(trades[0] ?? { symbol: '', entryTime: '', exitTime: '' })));
    await writeFile(path.join(directory, 'test-equity.csv'), csv(equity as unknown as Record<string, unknown>[], Object.keys(equity[0] ?? { time: '', equityUSDT: '' })));
  }
}
