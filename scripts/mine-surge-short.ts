import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import type { MinuteDataset } from '../research/gainers-types.ts';
import { buildSurgeShortSignals } from '../research/surge-short-signals.ts';
import { backtestSurgeShort } from '../research/surge-short-backtest.ts';
import type { SurgeShortScanConfig, SurgeShortExitConfig } from '../research/surge-short-types.ts';

async function loadAllMinutes(): Promise<MinuteDataset> {
  const dir1 = path.resolve('data/research/staged-1m-20261020-20261023');
  const dir2 = path.resolve('data/research/peak-rebound-1m-168h');
  const candles = new Map<string, any[]>();

  for (const dir of [dir1, dir2]) {
    try {
      const files = await readdir(dir);
      for (const f of files) {
        if (f.endsWith('.json.gz')) {
          const sym = f.replace('.json.gz', '');
          const bytes = await readFile(path.join(dir, f));
          const bars = JSON.parse(gunzipSync(bytes).toString('utf8'));
          candles.set(sym, bars);
        }
      }
    } catch {}
  }

  return {
    manifest: {
      version: 1,
      interval: '1m',
      source: 'Binance',
      fetchedAt: new Date().toISOString(),
      plan: {} as any,
      files: {},
    },
    candles,
  };
}

async function main() {
  console.log('================================================================');
  console.log('🔬【新研究】24h涨幅榜: x分钟内上涨达 24h涨幅/N 做空策略系统性挖掘');
  console.log('================================================================\n');

  console.log('正在载入 168 小时全市场小时数据与全部 1m 历史分钟 K 线...');
  const hourly = await loadDataset(path.resolve('data/research/hourly-168h'));
  const frames = buildFrames(hourly, 10, 1);
  const minuteData = await loadAllMinutes();

  console.log(`载入成功: 覆盖 ${minuteData.candles.size} 个涨幅榜标的，共 ${Array.from(minuteData.candles.values()).reduce((s, b) => s + b.length, 0)} 根 1m K 线。\n`);

  // 第一阶段：基础参数空间扫描 (x, N, surgeMode)
  console.log('--- 阶段 1：探索 (x 分钟, N 倍数) 信号频率与基础表现 (动态退出 X=35, N=2.0, M=2.0, 30m) ---');

  const xList = [2, 3, 5, 8, 10, 15, 20, 30];
  const nList = [2, 3, 4, 5, 6, 8, 10, 12, 15];
  const defaultExit: SurgeShortExitConfig = {
    holdMinutes: 30,
    exitType: 'two-stage-dynamic',
    exitX: 35,
    exitN: 2.0,
    exitM: 2.0,
  };

  interface ResultRow {
    x: number;
    n: number;
    mode: string;
    filter: string;
    trades: number;
    winRate: number;
    profitFactor: number | null;
    netPnl: number;
    maxDd: number;
    exitConfig: SurgeShortExitConfig;
  }

  const results: ResultRow[] = [];

  for (const x of xList) {
    for (const n of nList) {
      const scanConfig: SurgeShortScanConfig = {
        topN: 10,
        minDayChange: 10,
        windowMinutes: x,
        nFactor: n,
        surgeMode: 'trough-to-close',
        requireRedCandle: false,
        minUpperShadow: 0,
        cooldownMinutes: 15,
      };

      const signals = buildSurgeShortSignals(minuteData, frames, scanConfig);
      if (signals.length < 3) continue;

      const { metrics } = backtestSurgeShort(minuteData, signals, defaultExit);
      if (metrics.totalTrades >= 3) {
        results.push({
          x,
          n,
          mode: 'trough-to-close',
          filter: 'raw',
          trades: metrics.totalTrades,
          winRate: metrics.winRate,
          profitFactor: metrics.profitFactor,
          netPnl: metrics.netPnlPercent,
          maxDd: metrics.maxDrawdownPercent,
          exitConfig: defaultExit,
        });
      }
    }
  }

  // 按胜率降序排序打印 Top 15
  results.sort((a, b) => b.winRate - a.winRate || (b.profitFactor ?? 0) - (a.profitFactor ?? 0));

  console.log('| x(分钟) | N(倍数) | 阈值公式 | 交易笔数 | 胜率(%) | 盈亏比(PF) | 累计净收益(%) | 最大回撤(%) |');
  console.log('| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |');
  for (const r of results.slice(0, 15)) {
    console.log(
      `| ${r.x.toString().padEnd(7)} | ${r.n.toString().padEnd(7)} | 24h/${r.n} | ${r.trades.toString().padStart(8)} | ${r.winRate.toFixed(1)}% | ${r.profitFactor ? r.profitFactor.toFixed(2) : '∞'} | ${r.netPnl.toFixed(2)}% | ${r.maxDd.toFixed(2)}% |`,
    );
  }

  // 第二阶段：测试不同过滤器 (形态确认：收阴、上影线) 对胜率的提升
  console.log('\n--- 阶段 2：形态过滤器对比研究 (探索是否加 上影线/收阴 能够大幅提升胜率) ---');

  const filterConfigs = [
    { name: '纯涨幅(无过滤)', red: false, shadow: 0 },
    { name: '冲高受阻(当根收阴)', red: true, shadow: 0 },
    { name: '长上影线(影线≥15%)', red: false, shadow: 0.15 },
    { name: '双重确认(收阴+影线≥15%)', red: true, shadow: 0.15 },
  ];

  const filterResults: ResultRow[] = [];
  // 选取阶段 1 中代表性的 (x, n) 组合测试
  const selectedPairs = [
    { x: 3, n: 8 },
    { x: 5, n: 6 },
    { x: 5, n: 8 },
    { x: 10, n: 4 },
    { x: 10, n: 5 },
    { x: 15, n: 3 },
    { x: 15, n: 4 },
    { x: 30, n: 3 },
  ];

  for (const pair of selectedPairs) {
    for (const f of filterConfigs) {
      const scanConfig: SurgeShortScanConfig = {
        topN: 10,
        minDayChange: 10,
        windowMinutes: pair.x,
        nFactor: pair.n,
        surgeMode: 'trough-to-close',
        requireRedCandle: f.red,
        minUpperShadow: f.shadow,
        cooldownMinutes: 15,
      };

      const signals = buildSurgeShortSignals(minuteData, frames, scanConfig);
      if (signals.length < 3) continue;

      const { metrics } = backtestSurgeShort(minuteData, signals, defaultExit);
      if (metrics.totalTrades >= 3) {
        filterResults.push({
          x: pair.x,
          n: pair.n,
          mode: 'trough-to-close',
          filter: f.name,
          trades: metrics.totalTrades,
          winRate: metrics.winRate,
          profitFactor: metrics.profitFactor,
          netPnl: metrics.netPnlPercent,
          maxDd: metrics.maxDrawdownPercent,
          exitConfig: defaultExit,
        });
      }
    }
  }

  filterResults.sort((a, b) => b.winRate - a.winRate || (b.profitFactor ?? 0) - (a.profitFactor ?? 0));

  console.log('| x(分) | N(倍) | 过滤条件 | 交易笔数 | 胜率(%) | 盈亏比(PF) | 累计净收益(%) | 最大回撤(%) |');
  console.log('| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |');
  for (const r of filterResults.slice(0, 20)) {
    console.log(
      `| ${r.x.toString().padStart(4)} | ${r.n.toString().padStart(4)} | ${r.filter.padEnd(22)} | ${r.trades.toString().padStart(8)} | ${r.winRate.toFixed(1)}% | ${r.profitFactor ? r.profitFactor.toFixed(2) : '∞'} | ${r.netPnl.toFixed(2)}% | ${r.maxDd.toFixed(2)}% |`,
    );
  }

  // 第三阶段：退出机制网格挖掘 (Dynamic vs Fixed vs Proportional)
  console.log('\n--- 阶段 3：退出机制与持仓时效深入网格挖掘 ---');
  
  // 选出表现最佳的信号配置
  const bestSignalConfig: SurgeShortScanConfig = {
    topN: 10,
    minDayChange: 10,
    windowMinutes: 10,
    nFactor: 4,
    surgeMode: 'trough-to-close',
    requireRedCandle: true,
    minUpperShadow: 0.15,
    cooldownMinutes: 15,
  };

  const signals = buildSurgeShortSignals(minuteData, frames, bestSignalConfig);
  console.log(`基准最优信号配置 (x=10m, N=4, 收阴+影线): 生成 ${signals.length} 个独立开仓信号`);

  const exitVariants: SurgeShortExitConfig[] = [
    // 动态两段式
    { holdMinutes: 15, exitType: 'two-stage-dynamic', exitX: 35, exitN: 2.0, exitM: 1.5 },
    { holdMinutes: 15, exitType: 'two-stage-dynamic', exitX: 35, exitN: 2.0, exitM: 2.0 },
    { holdMinutes: 30, exitType: 'two-stage-dynamic', exitX: 35, exitN: 2.0, exitM: 1.5 },
    { holdMinutes: 30, exitType: 'two-stage-dynamic', exitX: 35, exitN: 2.0, exitM: 2.0 },
    { holdMinutes: 30, exitType: 'two-stage-dynamic', exitX: 50, exitN: 1.5, exitM: 3.0 },
    { holdMinutes: 45, exitType: 'two-stage-dynamic', exitX: 35, exitN: 2.0, exitM: 2.0 },
    // 冲高比例式
    { holdMinutes: 30, exitType: 'surge-proportional', surgeTpRatio: 0.5, surgeSlRatio: 0.5 },
    { holdMinutes: 30, exitType: 'surge-proportional', surgeTpRatio: 0.7, surgeSlRatio: 0.5 },
    // 固定止盈止损
    { holdMinutes: 30, exitType: 'fixed-tp-sl', takeProfitPercent: 3.0, stopLossPercent: 2.0 },
    { holdMinutes: 30, exitType: 'fixed-tp-sl', takeProfitPercent: 4.0, stopLossPercent: 2.5 },
  ];

  console.log('| 退出方案 | 持仓(分) | 详细参数 | 交易笔数 | 胜率(%) | 盈亏比(PF) | 净收益(%) | 止盈/止损/超时 |');
  console.log('| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |');
  for (const ev of exitVariants) {
    const { metrics } = backtestSurgeShort(minuteData, signals, ev);
    let desc = '';
    if (ev.exitType === 'two-stage-dynamic') desc = `X=${ev.exitX}, N=${ev.exitN}, M=${ev.exitM}`;
    else if (ev.exitType === 'surge-proportional') desc = `TP=${ev.surgeTpRatio}x, SL=${ev.surgeSlRatio}x`;
    else desc = `TP=${ev.takeProfitPercent}%, SL=${ev.stopLossPercent}%`;

    const exitDetail = `${metrics.exitReasons['target'] ?? 0}/${metrics.exitReasons['stop'] ?? 0}/${metrics.exitReasons['timeout'] ?? 0}`;
    console.log(
      `| ${ev.exitType.padEnd(18)} | ${ev.holdMinutes.toString().padStart(6)} | ${desc.padEnd(20)} | ${metrics.totalTrades.toString().padStart(8)} | ${metrics.winRate.toFixed(1)}% | ${metrics.profitFactor ? metrics.profitFactor.toFixed(2) : '∞'} | ${metrics.netPnlPercent.toFixed(2)}% | ${exitDetail.padStart(14)} |`,
    );
  }
}

main().catch(console.error);
