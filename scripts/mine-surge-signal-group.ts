import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import type { MinuteDataset } from '../research/gainers-types.ts';
import type { SignalGroupSubStrategy } from '../research/surge-signal-group-types.ts';
import { scanSignalGroup } from '../research/surge-signal-group.ts';
import { backtestGroupSignals } from '../research/surge-signal-group-backtest.ts';

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
  console.log('========================================================================================');
  console.log('🏗️【信号组重构研究】以 24h 涨幅榜 X 分钟内涨幅 24h/N 为基底，构建 MACD/均线因子多策略信号组');
  console.log('========================================================================================\n');

  console.log('载入全市场 168 小时历史行情与 1m K 线数据...');
  const hourly = await loadDataset(path.resolve('data/research/hourly-168h'));
  const frames = buildFrames(hourly, 10, 1);
  const minuteData = await loadAllMinutes();
  console.log(`成功载入 ${minuteData.candles.size} 个标的，总计 ${Array.from(minuteData.candles.values()).reduce((s, b) => s + b.length, 0)} 根 1m K 线。\n`);

  // 定义 4 个基于共同基底的差异化因子做空子策略
  const subStrategyConfigs: SignalGroupSubStrategy[] = [
    // 子策略 1：【冲高极度乖离】(Impulse Extreme MA Extension)
    // 基底：3m 冲高 >= 24h/3.5, 24h>=20%
    // 因子：偏离 MA30 >= 1.5% + MACD 绿柱超饱和 >= 65%
    {
      id: 'sub_extreme_dev',
      name: '冲高极度乖离',
      description: '极速 3m 爆发且价格脱离 MA30 均线拉扯极限，捕捉流动性瞬间真空的均值回归',
      baseImpulse: {
        topN: 10,
        minDayChange: 20,
        windowMinutes: 3,
        nFactor: 3.5,
        minAbsoluteSurge: 4.0,
        surgeMode: 'trough-to-close',
      },
      maFactors: {
        requireMaDeviation: true,
        deviationPeriod: 30,
        minDeviationPercent: 1.5,
      },
      macdFactors: {
        requireGreenExhaustion: true,
        greenWindow: 20,
        minGreenRatio: 0.65,
      },
      exitParams: { holdMinutes: 20, exitX: 30, exitN: 2.0, exitM: 2.0 },
    },

    // 子策略 2：【冲高顶背离】(Impulse Bearish Divergence)
    // 基底：5m 冲高 >= 24h/8.0, 24h>=15%
    // 因子：价格刷新 10~120 根前高但 MACD Hist 与 DIF 双重顶背离 + MA [3,7,15] 悬空
    {
      id: 'sub_divergence',
      name: '冲高顶背离',
      description: '5m 脉冲突破前高，但 MACD 量能出现严重顶背离且均线悬空，捕捉诱多假突破见顶',
      baseImpulse: {
        topN: 10,
        minDayChange: 15,
        windowMinutes: 5,
        nFactor: 8.0,
        minAbsoluteSurge: 3.0,
        surgeMode: 'trough-to-close',
      },
      maFactors: {
        requireNoMaSupport: true,
        supportPeriods: [3, 7, 15],
      },
      macdFactors: {
        requireDivergence: true,
        divergenceLookbackMin: 10,
        divergenceLookbackMax: 120,
        requireDoubleDivergence: true,
      },
      exitParams: { holdMinutes: 15, exitX: 50, exitN: 1.5, exitM: 3.0 },
    },

    // 子策略 3：【冲高动能拐头】(Impulse Momentum Rollover)
    // 基底：5m 冲高 >= 24h/4.0, 24h>=20%
    // 因子：MACD Hist 高位拐头下倾 + 当根 K 线收阴破 MA5 阻击 (Close < MA5 < High)
    {
      id: 'sub_rollover',
      name: '冲高动能拐头',
      description: '5m 爆发冲高后首根 K 线滞涨收阴且刺破 MA5 收回，MACD 柱体出现峰值拐头确认',
      baseImpulse: {
        topN: 10,
        minDayChange: 20,
        windowMinutes: 5,
        nFactor: 4.0,
        minAbsoluteSurge: 4.0,
        surgeMode: 'trough-to-close',
      },
      maFactors: {
        requireMaResistance: true,
        resistanceMaPeriod: 5,
      },
      macdFactors: {
        requireHistRollover: true,
        minHistBarsPositive: 2,
      },
      exitParams: { holdMinutes: 20, exitX: 35, exitN: 2.0, exitM: 2.0 },
    },

    // 子策略 4：【顺势反抽均线压制】(Impulse Trend MA Resistance)
    // 基底：10m 冲高 >= 24h/5.0, 24h>=15%
    // 因子：MA15 < MA30 (空头排列) + MA30 向下倾斜 + 冲高遭遇 MA15 压制 (Close < MA15 < High)
    {
      id: 'sub_trend_ceiling',
      name: '顺势反抽均线压制',
      description: '在大级别空头排列下，10m 反弹急冲诱多遭遇 MA15 天花板压制，顺应主空趋势开空',
      baseImpulse: {
        topN: 10,
        minDayChange: 15,
        windowMinutes: 10,
        nFactor: 5.0,
        minAbsoluteSurge: 3.5,
        surgeMode: 'trough-to-close',
      },
      maFactors: {
        requireBearishAlignment: true,
        requireMaSlopeDown: true,
        requireMaResistance: true,
        resistanceMaPeriod: 15,
        trendFastPeriod: 15,
        trendSlowPeriod: 30,
      },
      macdFactors: {
        requireGreenExhaustion: false,
      },
      exitParams: { holdMinutes: 30, exitX: 35, exitN: 2.0, exitM: 3.0 },
    },
  ];

  // 1. 先对各个子策略独立分别回测
  console.log('========================================================================================');
  console.log('🔍【单策略独立回测评估】检验每个因子组合的独立胜率与盈利能力');
  console.log('========================================================================================\n');

  console.log('| 子策略代号 | 子策略名称 | 核心基底与因子组合 | 独立交易 | 胜率(%) | 盈亏比(PF) | 净收益(%) | 最大回撤(%) |');
  console.log('| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: |');

  for (const strat of subStrategyConfigs) {
    const singleSignals = scanSignalGroup(minuteData, frames, [strat], 20);
    const { metrics } = backtestGroupSignals(minuteData, singleSignals);

    const desc = strat.id === 'sub_extreme_dev'
      ? '3m≥24h/3.5 + 偏离MA30≥1.5% + MACD绿柱超饱和'
      : strat.id === 'sub_divergence'
      ? '5m≥24h/8 + MACD双重顶背离 + MA悬空'
      : strat.id === 'sub_rollover'
      ? '5m≥24h/4 + MACD柱高位拐头 + MA5阻击'
      : '10m≥24h/5 + MA15<MA30空头排列 + MA15压制';

    console.log(
      `| ${strat.id.padEnd(16)} | ${strat.name.padEnd(14)} | ${desc.padEnd(35)} | ${metrics.totalTrades.toString().padStart(8)} | ${metrics.winRate.toFixed(1)}% | ${metrics.profitFactor ? metrics.profitFactor.toFixed(2) : '∞'} | +${metrics.netPnlPercent.toFixed(2)}% | ${metrics.maxDrawdownPercent.toFixed(2)}% |`,
    );
  }

  // 2. 信号组整合统一回测 (Signal Group Ensemble)
  console.log('\n========================================================================================');
  console.log('🤝【信号组联合回测】四策略协同运行 (共享 24h/N 冲高基底，严格同币互斥防重)');
  console.log('========================================================================================\n');

  const groupSignals = scanSignalGroup(minuteData, frames, subStrategyConfigs, 20);
  const { metrics: groupMetrics, trades: groupTrades } = backtestGroupSignals(minuteData, groupSignals);

  console.log(`📊【信号组全局总体表现】:`);
  console.log(`  • 总交易笔数: ${groupMetrics.totalTrades} 笔`);
  console.log(`  • 总体综合胜率: ${groupMetrics.winRate.toFixed(1)}% (${groupMetrics.winCount} 胜 ${groupMetrics.lossCount} 负)`);
  if (groupMetrics.winRate95) {
    console.log(`  • 威尔逊 95% 置信区间: [${groupMetrics.winRate95[0].toFixed(1)}%, ${groupMetrics.winRate95[1].toFixed(1)}%]`);
  }
  console.log(`  • 盈利因子 (Profit Factor): ${groupMetrics.profitFactor ? groupMetrics.profitFactor.toFixed(2) : '∞'}`);
  console.log(`  • 累计净收益率 (Net PnL): +${groupMetrics.netPnlPercent.toFixed(2)}%`);
  console.log(`  • 最大回撤 (Max Drawdown): ${groupMetrics.maxDrawdownPercent.toFixed(2)}%`);
  console.log(`  • 平均单笔收益: +${groupMetrics.meanTradePercent.toFixed(2)}%\n`);

  console.log('📈【各子策略在信号组内的贡献分布】:');
  console.log('| 子策略代号 | 子策略名称 | 触发笔数 | 战绩(胜/负) | 胜率(%) | 净贡献收益(%) | 盈亏比(PF) |');
  console.log('| :--- | :--- | :---: | :---: | :---: | :---: | :---: |');
  for (const [id, stat] of Object.entries(groupMetrics.bySubStrategy)) {
    console.log(
      `| ${id.padEnd(16)} | ${stat.name.padEnd(14)} | ${stat.trades.toString().padStart(8)} | ${stat.wins}胜${stat.losses}负 | ${stat.winRate.toFixed(1)}% | +${stat.netPnl.toFixed(2)}% | ${stat.profitFactor ? stat.profitFactor.toFixed(2) : '∞'} |`,
    );
  }

  console.log('\n📋【信号组前 15 笔交易明细样例】:');
  console.log('| 序号 | 触发子策略 | 币种 | 入场时间 (UTC) | 24h% | 冲高% | 持仓(分) | 净收益% | 结果 | 退出原因 |');
  console.log('| :---: | :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- |');
  groupTrades.slice(0, 15).forEach((t, i) => {
    const res = t.netPercent > 0 ? '✅ 盈利' : '❌ 亏损';
    const exits = t.exits.map((e) => e.reason).join('/');
    console.log(
      `| ${(i + 1).toString().padStart(4)} | ${t.subStrategyName.padEnd(12)} | ${t.symbol.padEnd(8)} | ${new Date(t.entryTime).toISOString().slice(5, 16)} | ${t.dayChangePercent.toFixed(1).padStart(5)}% | ${t.surgePercent.toFixed(1).padStart(5)}% | ${t.durationMinutes.toString().padStart(6)} | ${t.netPercent.toFixed(2).padStart(6)}% | ${res} | ${exits} |`,
    );
  });
}

main().catch(console.error);
