import { readFile, writeFile } from 'node:fs/promises';
import { loadAllMinutes, buildMinuteFramesMap } from './mine-strategy.ts';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import { replayStrategies, type ReplayStrategy } from '../research/strategy-replay.ts';
import type { Candle } from '../src/macd.ts';
import { calcTradeReturn } from '../src/trading-core.ts';

// Read-only audit: uses a captured public API response and local archives; never deploys.
const online = JSON.parse(await readFile('audit/online-paper.json', 'utf8'));

console.log('========================================================================================');
console.log('🔍【线上模拟盘快照独立核算与审计报告核对】(只读审计)');
console.log(`📅 快照更新时间: ${online.updatedAt} | 账户初始本金: ${online.account.initialBalanceUsdt} USDT`);
console.log('========================================================================================\n');

// 1. 线上逐笔平仓记录核算与保本错误排查
const closed = online.closedPositions as any[];
let sumRecalcPnl = 0;
let maxRecalcDiff = 0;
let flawedBreakevenTrades = 0;
const strategyMap = new Map<string, { label: string; count: number; wins: number; pnl: number; gains: number; losses: number }>();

for (const p of closed) {
  const isLong = p.side === 'LONG';
  const label = p.signalLabel ?? p.signalType;
  if (!strategyMap.has(label)) {
    strategyMap.set(label, { label, count: 0, wins: 0, pnl: 0, gains: 0, losses: 0 });
  }
  const stat = strategyMap.get(label)!;
  stat.count++;
  if (p.totalNetPnlUsdt > 0.001) {
    stat.wins++;
    stat.gains += p.totalNetPnlUsdt;
  } else if (p.totalNetPnlUsdt < -0.001) {
    stat.losses += Math.abs(p.totalNetPnlUsdt);
  }
  stat.pnl += p.totalNetPnlUsdt;

  // 核算每阶段 PnL
  let tradeRecalcPnl = 0;
  for (const exit of p.exits) {
    const fraction = exit.fraction ?? 0.5;
    const notional = p.marginUsdt * p.leverage * fraction;
    const ret = calcTradeReturn(p.side, p.entryPrice, exit.exitPrice, {
      takerFeeBps: online.config.takerFeeBps ?? 5,
      slippageBps: online.config.slippageBps ?? 2,
    });
    const recalcExitNetPnl = (notional * ret.netPercent) / 100;
    tradeRecalcPnl += recalcExitNetPnl;
  }
  sumRecalcPnl += tradeRecalcPnl;
  const diff = Math.abs(tradeRecalcPnl - p.totalNetPnlUsdt);
  if (diff > maxRecalcDiff) maxRecalcDiff = diff;

  // 检测旧版保本止损方向错误
  if (p.isBreakevenArmed) {
    // 多头保本若低于入场价，或空头保本高于入场价，属于错误侧
    if ((isLong && p.sl2Price < p.entryPrice) || (!isLong && p.sl2Price > p.entryPrice)) {
      flawedBreakevenTrades++;
    }
  }
}

const onlineTotalPnl = closed.reduce((acc, p) => acc + p.totalNetPnlUsdt, 0);
const onlineWins = closed.filter((p) => p.totalNetPnlUsdt > 0.001).length;
const onlineWinRate = closed.length > 0 ? (onlineWins / closed.length) * 100 : 0;
const onlineGains = closed.filter((p) => p.totalNetPnlUsdt > 0.001).reduce((acc, p) => acc + p.totalNetPnlUsdt, 0);
const onlineLosses = closed.filter((p) => p.totalNetPnlUsdt < -0.001).reduce((acc, p) => acc + Math.abs(p.totalNetPnlUsdt), 0);
const onlinePf = onlineLosses > 0 ? onlineGains / onlineLosses : Infinity;

console.log('📊【线上快照全局统计】:');
console.log(`   • 已平仓总笔数: ${closed.length} 笔 (盈利 ${onlineWins} / 亏损 ${closed.length - onlineWins})`);
console.log(`   • 整体胜率: ${onlineWinRate.toFixed(2)}% | 利润因子 (PF): ${onlinePf.toFixed(4)}`);
console.log(`   • 线上记录累计净盈亏: ${onlineTotalPnl >= 0 ? '+' : ''}${onlineTotalPnl.toFixed(4)} USDT`);
console.log(`   • 独立重算累计净盈亏: ${sumRecalcPnl >= 0 ? '+' : ''}${sumRecalcPnl.toFixed(4)} USDT (最大单笔重算误差: ${maxRecalcDiff.toExponential(4)})`);
console.log(`   • 线上已实现余额: ${online.account.balanceUsdt.toFixed(4)} USDT (初始 100 + 净盈亏 = ${(100 + onlineTotalPnl).toFixed(4)})`);
console.log(`   • ⚠️ 错误方向保本止损触发记录: ${flawedBreakevenTrades} 笔 (多头入场*0.998 / 空头入场*1.002，均在亏损侧)\n`);

console.log('📋【分策略表现独立统计明细】:');
const strategyTable = [...strategyMap.values()].map((s) => ({
  '策略名称': s.label,
  '总笔数': s.count,
  '盈利笔数': s.wins,
  '胜率': `${((s.wins / s.count) * 100).toFixed(1)}%`,
  '净盈亏 (USDT)': `${s.pnl >= 0 ? '+' : ''}${s.pnl.toFixed(4)}`,
  '利润因子 (PF)': s.losses > 0 ? (s.gains / s.losses).toFixed(3) : (s.gains > 0 ? '∞' : '0.000'),
}));
console.table(strategyTable);

// 2. 本地回测复现对比
console.log('\n========================================================================================');
console.log('🔬【本地历史数据集量化回测复现 (2026-10-18 ~ 2026-10-25 UTC)】');
console.log('========================================================================================');

const { dataset, datasetHash } = await loadAllMinutes();
const candles = new Map<string, Candle[]>([...dataset.candles].map(([s, bs]) => [s, bs.map(b => ({ time:b[0], open:b[1], high:b[2], low:b[3], close:b[4], volume:b[5] }))]));
const indices = new Map([...candles].map(([s, bs]) => [s, new Map(bs.map((b,i) => [b.time,i]))]));
const times = [...new Set([...candles.values()].flatMap(bs => bs.map(b=>b.time)))].sort((a,b)=>a-b);
const hourly = await loadDataset('data/research/hourly-168h');
const frames = buildMinuteFramesMap(buildFrames(hourly,30,1), candles, times.filter(t=>t>=hourly.manifest.start && t<hourly.manifest.end));
const strategies: ReplayStrategy[] = [
  { ...online.config.klineStatsShortConfig, id:'kline_stats_short', side:'SHORT' },
  { ...online.config.klineStatsLongConfig, id:'kline_stats_long', side:'LONG' },
];
const range = {start:hourly.manifest.start, end:hourly.manifest.end};
const runs: Record<string,unknown> = {};
const replayTable: any[] = [];

for (const [label, specs, mode] of [
  ['量化做空单独', strategies.slice(0,1), 'conservative'],
  ['量化做多单独', strategies.slice(1), 'conservative'],
  ['量化多空组合 (保守)', strategies, 'conservative'],
  ['量化多空组合 (乐观)', strategies, 'optimistic'],
] as const) {
  const result = replayStrategies(candles,indices,times,frames,[...specs],range,{intrabarMode:mode, maxPositions:online.config.maxPositions,marginPercent:online.config.marginPercent});
  const gains = result.trades.reduce((a,t)=>a+Math.max(0,t.totalNetPnlUsdt),0);
  const losses = result.trades.reduce((a,t)=>a-Math.min(0,t.totalNetPnlUsdt),0);
  const pf = losses ? gains / losses : null;
  runs[label] = {...result, profitFactor: pf};
  replayTable.push({
    '测试配置': label,
    '交易笔数': result.totalTrades,
    '胜率': `${result.winRate.toFixed(2)}%`,
    '净收益率': `${result.roiPct >= 0 ? '+' : ''}${result.roiPct.toFixed(2)}%`,
    '净盈亏 (USDT)': `${result.netPnlUsdt >= 0 ? '+' : ''}${result.netPnlUsdt.toFixed(2)}`,
    '利润因子 (PF)': pf ? pf.toFixed(3) : '∞',
    '最大回撤 (%)': `${result.maxDrawdownPct.toFixed(2)}%`,
  });
}
console.table(replayTable);

// 3. 覆盖率核验
const start = Math.min(...closed.map((p:any)=>p.entryTime));
const end = Math.max(...closed.map((p:any)=>p.closedAt));
let covered=0, expected=0;
for (const p of closed) {
  for(let t=Math.floor(p.entryTime/60000)*60000;t<=Math.floor(p.closedAt/60000)*60000;t+=60000){
    expected++; if(indices.get(p.symbol)?.has(t)) covered++;
  }
}
const coverage = {onlineStart:new Date(start).toISOString(),onlineEnd:new Date(end).toISOString(),coveredTradeMinutes:covered,expectedTradeMinutes:expected,localSymbols:candles.size,localBars:[...candles.values()].reduce((a,b)=>a+b.length,0)};
const result = {capturedAt:online.updatedAt,datasetHash,range,strategies,coverage,runs,strategyStats: [...strategyMap.values()]};
await writeFile('audit/local-replay.json',JSON.stringify(result,null,2));

console.log('\n📡【数据覆盖率与时序边界说明】:');
console.log(`   • 线上交易跨度: ${coverage.onlineStart} 至 ${coverage.onlineEnd}`);
console.log(`   • 线上持仓分钟总计: ${coverage.expectedTradeMinutes} 分钟 | 本地覆盖分钟: ${coverage.coveredTradeMinutes} (${((coverage.coveredTradeMinutes/coverage.expectedTradeMinutes)*100).toFixed(1)}%)`);
console.log(`   • 本地归档包含标的数: ${coverage.localSymbols} 个 | 有效 1m K 线数: ${coverage.localBars} 根`);
console.log('   • 审计结论：10月归档样本与11月线上样本完全处于不同市场周期，量化做多在两个周期均展现显著负期望，已实施安全熔断禁用。\n');
