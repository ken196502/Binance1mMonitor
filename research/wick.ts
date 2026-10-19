import { parseArgs, isDeepStrictEqual } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { loadDataset } from './data.ts';
import { buildFrames } from './backtest.ts';
import { DAY, HOUR } from './types.ts';
import type { MinuteManifest } from './gainers-types.ts';
import { GAINERS_GRID } from './gainers-config.ts';
import { fetchGainersMinutes, loadGainersMinutes, planGainersMinutes } from './gainers-data.ts';
import { ARCHIVE_BASE } from './gainers-archive.ts';
import { validateWickConfig } from './wick-config.ts';
import { runWickStudy } from './wick-study.ts';
import { writeWickReport } from './wick-report.ts';

const HELP = `信号直接做空研究（两段平仓：先平50%，再平剩余全部）
npm run research -- wick --data DIR --minutes-data DIR --offline [选项]
npm run research:wick -- --data DIR --minutes-data DIR --offline [选项]
--data DIR                全市场小时缓存，必填
--minutes-data DIR        分钟缓存，默认 DATA/wick-1m
--config FILE             JSON配置；可只覆盖部分字段，见 research/wick-config.example.json
--start ISO --end ISO      整点UTC区间[start,end)，默认复用分钟缓存区间或小时区间
--days N                  与--start互斥；从end向前取N天
--offline                 仅读缓存，允许复用相同区间、更长退出覆盖的旧分钟缓存
--minute-source api|archive 默认archive（官方历史归档，SHA256校验）
--fetch-only              只准备行情
--out DIR                 报告根目录，写入DIR/wick，必须为空
--help

默认：历史涨幅前10、至少2连阳、累计涨幅≥24h涨幅/10、无任何MA支撑、
近30根1m hist>0严格超过80%。信号收盘确认后，按下一分钟开盘直接市价开空。
配置可调持仓、两段止盈止损、成本和训练样本门槛。
50%/100%是平仓比例：先平初始仓位50%，再平剩余100%；按整笔合并净收益统计胜率。
60/20/20时间切分，两段退出联合选参，选定参数留出一次；不下单、不发送通知。
`;

export async function runWickCommand(args: string[]) {
  const { values: v } = parseArgs({ args, strict: true, options: {
    data: { type: 'string' }, 'minutes-data': { type: 'string' }, config: { type: 'string' },
    start: { type: 'string' }, end: { type: 'string' }, days: { type: 'string' }, out: { type: 'string' },
    offline: { type: 'boolean' }, 'fetch-only': { type: 'boolean' }, 'minute-source': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (v.help) { console.log(HELP); return; }
  if (!v.data) throw new Error('wick 需要 --data 全市场小时缓存');
  if (v.offline && v['fetch-only']) throw new Error('offline 与 fetch-only 不能同时使用');
  if (v.start && v.days) throw new Error('start 与 days 不能同时使用');
  if (v['minute-source'] && !['api', 'archive'].includes(v['minute-source'])) throw new Error('minute-source 必须为api或archive');
  const c = validateWickConfig(v.config ? JSON.parse(await readFile(v.config, 'utf8')) : {});
  const out = path.resolve(v.out ?? `reports/research/wick-${new Date().toISOString().replaceAll(':', '-')}`, 'wick');
  // Fail before data downloads or backtesting if an existing report would be overwritten.
  if (!v['fetch-only']) {
    const entries = await readdir(out).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    if (entries.length) throw new Error(`报告目录非空，请使用新目录：${out}`);
  }
  const hourly = await loadDataset(path.resolve(v.data));
  const minuteDir = path.resolve(v['minutes-data'] ?? path.join(v.data, 'wick-1m'));
  const cached = await readFile(path.join(minuteDir, 'manifest.json'), 'utf8')
    .then(t => JSON.parse(t) as MinuteManifest).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  const date = (s: string) => {
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:00(?::00(?:\.000)?)?(?:Z|[+-]\d{2}:00))?$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(`${s.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== s.slice(0, 10)) throw new Error('日期需为有效UTC日期或带时区的整点ISO时间');
    return Date.parse(s);
  };
  if (v.days != null && (!Number.isFinite(Number(v.days)) || Number(v.days) <= 0 || Number(v.days) > 365)) throw new Error('days 需在(0,365]');
  const end = v.end ? date(v.end) : cached?.plan.end ?? hourly.manifest.end;
  const start = v.start ? date(v.start) : v.days ? end - Number(v.days) * DAY : cached?.plan.start ?? hourly.manifest.start;
  if (![start, end].every(t => Number.isFinite(t) && t % HOUR === 0) || start < hourly.manifest.start || end > hourly.manifest.end || start >= end) throw new Error('wick 区间需按小时对齐且在小时数据范围内');
  hourly.manifest = { ...hourly.manifest, start, end };
  const frames = buildFrames(hourly, c.topN, 1);
  const horizon = Math.max(...c.holdMinutes);
  const makePlan = (hold: number) => planGainersMinutes(hourly, frames, { topN: c.topN, highWindow: Math.max(100, c.indicatorWindow - 100), grid: { ...GAINERS_GRID, holdMinutes: [hold] } });
  let plan = makePlan(horizon);
  if (cached) {
    // Reconstruct from the hourly pool; never trust a hand-edited cached membership plan.
    const rebuilt = makePlan(cached.plan.maxHoldMinutes);
    if (cached.plan.maxHoldMinutes < horizon || !isDeepStrictEqual(cached.plan, rebuilt)) throw new Error('分钟缓存与区间/榜单不匹配或未覆盖持仓，请换分钟目录');
    plan = rebuilt;
  }
  if (!v.offline && !cached) await fetchGainersMinutes(minuteDir, plan, v['minute-source'] === 'api' ? hourly.manifest.source : ARCHIVE_BASE);
  const minute = await loadGainersMinutes(minuteDir, plan);
  if (v['fetch-only']) { console.log(`分批平仓研究行情已就绪：${minuteDir}`); return; }
  const study = runWickStudy(hourly.manifest, minute, frames, c);
  await writeWickReport(study, frames, out);
  const b = study.baseline.metrics;
  console.log(`全区间固定基准：${b.signalCount} 个信号，${b.filled} 次开仓，${b.skippedBusy} 个已有持仓跳过，${b.purged} 个边界剔除，${b.missing} 个缺失；完整交易 ${b.trades}，净胜率 ${b.winRate?.toFixed(2) ?? '—'}%，实际盈亏比 ${b.realizedRewardRisk?.toFixed(3) ?? '—'}`);
  const w = study.winner;
  console.log(w ? `两段平仓留出 ${w.test.trades} 笔，整笔净胜率 ${w.test.winRate?.toFixed(2) ?? '—'}%，实际盈亏比 ${w.test.realizedRewardRisk?.toFixed(3) ?? '—'}` : '训练/验证样本不足或存在缺失，未评价候选留出；全区间固定基准及信号分流见报告');
  console.log(`分批平仓研究报告：${path.join(out, 'report.md')}`);
}
