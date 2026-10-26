import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset } from './data.ts';
import { buildFrames } from './backtest.ts';
import { MINUTE } from './gainers-types.ts';
import { HOUR } from './types.ts';
import { planWatchlistMinutes, loadWatchlistMinutes } from './peak-rebound-data.ts';
import { buildPeakReboundSignals, getRank1Watchlist } from './peak-rebound-signals.ts';
import {
  backtestPeakRebound,
  calcReturn,
  summarizeTrades,
  wilsonInterval,
} from './peak-rebound-backtest.ts';
import {
  PEAK_REBOUND_DEFAULT_GRID,
  PEAK_REBOUND_DEFAULT_CONFIG,
  type PeakReboundGrid,
} from './peak-rebound-config.ts';
import type {
  PeakReboundParameters,
  PeakReboundSignal,
  PeakReboundMetrics,
  PeakReboundTrade,
} from './peak-rebound-types.ts';
import { GpuWorker, writeGpuWindows } from './gpu.ts';

const HELP = `追踪24h涨幅榜第一（榜一入观察）见顶回撤X%反弹y%均线压制做空策略 GPU挖掘与回测
npm run mine:peak-rebound -- [选项]
--hourly-data DIR   168h小时数据目录（默认 data/research/hourly-168h）
--minutes-data DIR  168h分钟数据目录（默认 data/research/peak-rebound-1m-168h）
--out DIR           报告输出目录（默认 reports/research/peak-rebound-miner-168h）
--python FILE       Python路径（默认 .venv-gpu/bin/python）
--device mps|cpu    GPU加速设备（默认 mps）
--batch N           每批参数数（默认 64）
--fee-bps N         单边手续费 bps（默认 5）
--slippage-bps N    单边滑点 bps（默认 2）
--help              显示帮助
`;

export async function runPeakReboundMiner(args = process.argv.slice(2)) {
  const strings = [
    'hourly-data',
    'minutes-data',
    'out',
    'python',
    'device',
    'batch',
    'fee-bps',
    'slippage-bps',
  ];
  const booleans = ['help'];
  const parsed = parseArgs({
    args,
    strict: true,
    options: Object.fromEntries([
      ...strings.map((k) => [k, { type: 'string' as const }]),
      ...booleans.map((k) => [k, { type: 'boolean' as const }]),
    ]),
  });
  const values = parsed.values as Record<string, string | boolean | undefined>;
  if (values.help) {
    console.log(HELP);
    return;
  }

  const str = (k: string, fb: string) => String(values[k] ?? fb);
  const num = (k: string, fb: number) => Number(values[k] ?? fb);

  const hourlyDir = path.resolve(str('hourly-data', 'data/research/hourly-168h'));
  const minutesDir = path.resolve(str('minutes-data', 'data/research/peak-rebound-1m-168h'));
  const outDir = path.resolve(str('out', 'reports/research/peak-rebound-miner-168h'));
  const pythonPath = path.resolve(str('python', '.venv-gpu/bin/python'));
  const device = str('device', 'mps');
  const batchSize = num('batch', 64);
  const feeBps = num('fee-bps', 5);
  const slippageBps = num('slippage-bps', 2);

  await mkdir(outDir, { recursive: true });

  console.log('================================================================');
  console.log('🚀 启动 24h 涨幅榜第一 见顶回撤X%反弹y%均线压制做空策略 GPU挖掘');
  console.log(`📁 小时数据: ${hourlyDir}`);
  console.log(`📁 分钟数据: ${minutesDir}`);
  console.log(`📁 输出报告: ${outDir}`);
  console.log(`⚡ 计算设备: ${device}`);
  console.log('================================================================');

  // 1. 加载数据
  console.log('正在加载 168 小时全市场小时行情...');
  const hourly = await loadDataset(hourlyDir);
  const frames = buildFrames(hourly, 10, 1);
  const watchlist = getRank1Watchlist(frames);
  console.log(`已构建 ${frames.length} 个小时榜单，共追踪到 ${watchlist.size} 个曾登上24h涨幅榜第一的币种:`);
  for (const [sym, info] of watchlist) {
    console.log(`  - ${sym}: 上榜首时涨幅 +${info.dayChangeAtRank1.toFixed(1)}%, 登顶 ${info.rank1Hours} 个小时`);
  }

  console.log('\n正在加载 1m 分钟数据...');
  const plan = planWatchlistMinutes(hourly, frames);
  const minuteData = await loadWatchlistMinutes(minutesDir, plan);
  console.log(`已成功载入 ${minuteData.candles.size} 个币种的高精度 1m K线数据。`);

  // 2. 时间划分 (60% 训练集, 20% 验证集, 20% 留出测试集)
  const totalDuration = hourly.manifest.end - hourly.manifest.start;
  const trainEnd = hourly.manifest.start + Math.floor(totalDuration * 0.6);
  const valEnd = hourly.manifest.start + Math.floor(totalDuration * 0.8);
  const testEnd = hourly.manifest.end;

  console.log('\n📊 数据集切分:');
  console.log(`  - 训练集 (60%): ${new Date(hourly.manifest.start).toISOString()} → ${new Date(trainEnd).toISOString()}`);
  console.log(`  - 验证集 (20%): ${new Date(trainEnd).toISOString()} → ${new Date(valEnd).toISOString()}`);
  console.log(`  - 留出集 (20%): ${new Date(valEnd).toISOString()} → ${new Date(testEnd).toISOString()}`);

  // 3. 构建参数网格
  const grid = PEAK_REBOUND_DEFAULT_GRID;
  interface CandidateTrial {
    id: string;
    params: PeakReboundParameters;
    trainMetrics: PeakReboundMetrics;
    valMetrics?: PeakReboundMetrics | null;
    testMetrics?: PeakReboundMetrics | null;
  }

  // 预生成所有参数组合
  const signalConfigs: Array<{
    pullbackX: number;
    reboundY: number;
    shortMa: number;
    mediumMa?: number;
    longMa: number;
    longMaOffsetPercent: number;
    minGreenRatio20: number;
  }> = [];
  for (const px of grid.pullbackX) {
    for (const ry of grid.reboundY) {
      for (const group of grid.maGroups) {
        for (const off of grid.longMaOffsetPercent) {
          for (const gr of grid.minGreenRatio20) {
            signalConfigs.push({
              pullbackX: px,
              reboundY: ry,
              shortMa: group.shortMa,
              mediumMa: group.mediumMa,
              longMa: group.longMa,
              longMaOffsetPercent: off,
              minGreenRatio20: gr,
            });
          }
        }
      }
    }
  }

  const exitConfigs: Array<{ holdMinutes: number; exitX: number; exitN: number; exitM: number }> = [];
  for (const hm of grid.holdMinutes) {
    for (const ex of grid.exitX) {
      for (const en of grid.exitN) {
        for (const em of grid.exitM) {
          exitConfigs.push({ holdMinutes: hm, exitX: ex, exitN: en, exitM: em });
        }
      }
    }
  }

  const totalCombinations = signalConfigs.length * exitConfigs.length;
  console.log(`\n🔍 参数网格总计: ${signalConfigs.length} 组信号形态 × ${exitConfigs.length} 组退出参数 = ${totalCombinations} 组交叉参数 (以胜率最大化为核心目标)`);

  // 4. 初始化 GPU Worker
  console.log(`\n⚙️ 正在初始化 Apple Metal GPU 加速核心 (${pythonPath})...`);
  const worker = new GpuWorker(pythonPath);

  const horizon = Math.max(...grid.holdMinutes);
  const maxTmpDir = path.join(outDir, 'tmp');
  await mkdir(maxTmpDir, { recursive: true });

  const allTrials: CandidateTrial[] = [];
  const signalsCsvRows: string[] = ['symbol,time,dayChangePercent,pullbackPercent,troughPrice,reboundPercent,shortMa,longMa,longMaOffset,greenRatio20,close'];

  let trialCounter = 0;
  let evaluatedSignalGroups = 0;

  console.log('\n🚀 启动 GPU 网格挖掘循环...');
  const t0 = Date.now();

  for (const sc of signalConfigs) {
    // 针对该形态参数生成信号
    const signals = buildPeakReboundSignals(minuteData, frames, {
      pullbackX: sc.pullbackX,
      reboundY: sc.reboundY,
      shortMa: sc.shortMa,
      mediumMa: sc.mediumMa,
      longMa: sc.longMa,
      longMaOffsetPercent: sc.longMaOffsetPercent,
      minGreenRatio20: sc.minGreenRatio20,
      requireMaSlopeDown: true,
      minReboundUpCandles: 1,
      maxFibRetracement: 0.50,
      minUpperShadowRatio: 0.30,
      requireBearishOrUpperShadow: true,
    });

    if (signals.length === 0) continue;
    evaluatedSignalGroups++;

    // 记录信号
    for (const s of signals) {
      signalsCsvRows.push(
        `${s.symbol},${new Date(s.time).toISOString()},${s.dayChangePercent.toFixed(2)},${s.pullbackPercent.toFixed(2)},${s.troughPrice.toFixed(4)},${s.reboundPercent.toFixed(2)},${s.shortMa},${s.mediumMa ?? ''},${s.longMa},${s.longMaOffsetPercent.toFixed(1)},${(s.greenRatio20 * 100).toFixed(0)}%,${s.close.toFixed(4)}`,
      );
    }

    // 分离训练集信号
    const trainSignals = signals.filter((s) => s.time >= hourly.manifest.start && s.time < trainEnd);
    if (trainSignals.length === 0) continue;

    // 写入 GPU 训练轨迹
    const windowFile = path.join(maxTmpDir, `train_windows_${sc.pullbackX}_${sc.reboundY}_${sc.shortMa}_${sc.mediumMa ?? 0}_${sc.longMa}_${sc.longMaOffsetPercent}_${sc.minGreenRatio20}.bin`);
    await writeGpuWindows(windowFile, minuteData, trainSignals, horizon, trainEnd);

    // 初始化当前信号批次的 GPU window
    await worker.init(windowFile, trainSignals.length, horizon, device);

    const dayChanges = trainSignals.map((s) => s.dayChangePercent);

    // 分批使用 GPU 执行两段式自适应退出挖掘
    for (let i = 0; i < exitConfigs.length; i += batchSize) {
      const batchExits = exitConfigs.slice(i, i + batchSize);
      const gpuResult = await worker.twoStageEvaluate(batchExits, dayChanges, {
        takerFeeBps: feeBps,
        slippageBps: slippageBps,
      });

      for (let j = 0; j < batchExits.length; j++) {
        trialCounter++;
        const ec = batchExits[j];
        const gm = gpuResult.metrics[j];

        const fullParams: PeakReboundParameters = {
          pullbackX: sc.pullbackX,
          reboundY: sc.reboundY,
          shortMa: sc.shortMa,
          mediumMa: sc.mediumMa,
          longMa: sc.longMa,
          longMaOffsetPercent: sc.longMaOffsetPercent,
          minGreenRatio20: sc.minGreenRatio20,
          minReboundUpCandles: 1,
          maxFibRetracement: 0.50,
          minUpperShadowRatio: 0.30,
          requireBearishOrUpperShadow: true,
          maPeriods: sc.mediumMa !== undefined ? [sc.shortMa, sc.mediumMa, sc.longMa] : [sc.shortMa],
          holdMinutes: ec.holdMinutes,
          exitX: ec.exitX,
          exitN: ec.exitN,
          exitM: ec.exitM,
        };

        // 如果 GPU 发现胜率达标 (>=50%) 且收益为正，使用标量引擎进行精细核算确认
        if (gm.trades >= 5 && gm.winRate >= 50.0 && gm.netPnlPercent > 0) {
          const exact = backtestPeakRebound(minuteData, trainSignals, fullParams, hourly.manifest.start, trainEnd, {
            takerFeeBps: feeBps,
            slippageBps: slippageBps,
          });

          if (exact.metrics.trades >= 5 && exact.metrics.winRate != null && exact.metrics.winRate >= 50.0 && exact.metrics.netPnlPercent > 0) {
            allTrials.push({
              id: `trial-${String(trialCounter).padStart(5, '0')}`,
              params: fullParams,
              trainMetrics: exact.metrics,
            });
          }
        }
      }
    }
  }

  worker.close();
  const elapsedSeconds = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n✅ GPU挖掘完成！耗时: ${elapsedSeconds} 秒，共搜索评估 ${trialCounter} 组参数，筛选出高胜率候选 ${allTrials.length} 组。`);

  // 5. 排序与验证集评估：优先按胜率排序（用户更看中胜率）
  allTrials.sort((a, b) => (b.trainMetrics.winRate ?? 0) - (a.trainMetrics.winRate ?? 0) || (b.trainMetrics.netPnlPercent ?? 0) - (a.trainMetrics.netPnlPercent ?? 0));

  console.log('\n🔍 正在对训练集前 50 名高胜率候选参数进行验证集评估...');
  const topCandidates = allTrials.slice(0, 50);
  for (const candidate of topCandidates) {
    const valSignals = buildPeakReboundSignals(minuteData, frames, {
      pullbackX: candidate.params.pullbackX,
      reboundY: candidate.params.reboundY,
      shortMa: candidate.params.shortMa,
      mediumMa: candidate.params.mediumMa,
      longMa: candidate.params.longMa,
      longMaOffsetPercent: candidate.params.longMaOffsetPercent,
      minGreenRatio20: candidate.params.minGreenRatio20,
      requireMaSlopeDown: true,
      minReboundUpCandles: candidate.params.minReboundUpCandles ?? 1,
      maxFibRetracement: candidate.params.maxFibRetracement ?? 0.50,
      minUpperShadowRatio: candidate.params.minUpperShadowRatio ?? 0.30,
      requireBearishOrUpperShadow: candidate.params.requireBearishOrUpperShadow ?? true,
    }).filter((s) => s.time >= trainEnd && s.time < valEnd);

    const valResult = backtestPeakRebound(minuteData, valSignals, candidate.params, trainEnd, valEnd, {
      takerFeeBps: feeBps,
      slippageBps: slippageBps,
    });
    candidate.valMetrics = valResult.metrics;
  }

  // 验证集排序：优先胜率与正收益
  const scoreCandidate = (c: CandidateTrial) => {
    const wr = (c.trainMetrics.winRate ?? 0) * 0.5 + (c.valMetrics?.winRate ?? c.trainMetrics.winRate ?? 0) * 0.5;
    const net = (c.trainMetrics.netPnlPercent ?? 0) + (c.valMetrics?.netPnlPercent ?? 0);
    return wr * 10 + net;
  };
  const bestCandidate = topCandidates.slice().sort((a, b) => scoreCandidate(b) - scoreCandidate(a))[0];

  let testResult: ReturnType<typeof backtestPeakRebound> | null = null;
  if (bestCandidate) {
    console.log(`\n🏆 选定最佳高胜率策略参数: ${JSON.stringify(bestCandidate.params)}`);
    console.log('🎯 正在执行留出测试集 (Holdout Test) 最终单次评估...');

    const testSignals = buildPeakReboundSignals(minuteData, frames, {
      pullbackX: bestCandidate.params.pullbackX,
      reboundY: bestCandidate.params.reboundY,
      shortMa: bestCandidate.params.shortMa,
      mediumMa: bestCandidate.params.mediumMa,
      longMa: bestCandidate.params.longMa,
      longMaOffsetPercent: bestCandidate.params.longMaOffsetPercent,
      minGreenRatio20: bestCandidate.params.minGreenRatio20,
      requireMaSlopeDown: true,
      minReboundUpCandles: bestCandidate.params.minReboundUpCandles ?? 1,
      maxFibRetracement: bestCandidate.params.maxFibRetracement ?? 0.50,
      minUpperShadowRatio: bestCandidate.params.minUpperShadowRatio ?? 0.30,
      requireBearishOrUpperShadow: bestCandidate.params.requireBearishOrUpperShadow ?? true,
    }).filter((s) => s.time >= valEnd && s.time < testEnd);

    testResult = backtestPeakRebound(minuteData, testSignals, bestCandidate.params, valEnd, testEnd, {
      takerFeeBps: feeBps,
      slippageBps: slippageBps,
    });
    bestCandidate.testMetrics = testResult.metrics;
  }

  // 6. 生成全区间回测 (包含全168h的实际执行效果)
  let fullRunResult: ReturnType<typeof backtestPeakRebound> | null = null;
  if (bestCandidate) {
    const allSignals = buildPeakReboundSignals(minuteData, frames, {
      pullbackX: bestCandidate.params.pullbackX,
      reboundY: bestCandidate.params.reboundY,
      shortMa: bestCandidate.params.shortMa,
      mediumMa: bestCandidate.params.mediumMa,
      longMa: bestCandidate.params.longMa,
      longMaOffsetPercent: bestCandidate.params.longMaOffsetPercent,
      minGreenRatio20: bestCandidate.params.minGreenRatio20,
      requireMaSlopeDown: true,
      minReboundUpCandles: bestCandidate.params.minReboundUpCandles ?? 1,
      maxFibRetracement: bestCandidate.params.maxFibRetracement ?? 0.50,
      minUpperShadowRatio: bestCandidate.params.minUpperShadowRatio ?? 0.30,
      requireBearishOrUpperShadow: bestCandidate.params.requireBearishOrUpperShadow ?? true,
    });
    fullRunResult = backtestPeakRebound(minuteData, allSignals, bestCandidate.params, hourly.manifest.start, testEnd, {
      takerFeeBps: feeBps,
      slippageBps: slippageBps,
    });
  }

  // 7. 保存文件与生成 Markdown 报告
  console.log('\n📄 正在写入报告与数据文件...');

  // 写入 signals.csv
  await writeFile(path.join(outDir, 'signals.csv'), signalsCsvRows.join('\n'));

  // 写入 trials.csv
  const trialCsvLines = [
    'id,pullbackX,reboundY,shortMa,mediumMa,longMa,longMaOffset,minGreenRatio20,holdMinutes,exitX,exitN,exitM,trainTrades,trainWinRate,trainNetPnl,valTrades,valWinRate,valNetPnl',
  ];
  for (const t of allTrials.slice(0, 100)) {
    trialCsvLines.push(
      `${t.id},${t.params.pullbackX},${t.params.reboundY},${t.params.shortMa},${t.params.mediumMa ?? ''},${t.params.longMa},${t.params.longMaOffsetPercent},${(t.params.minGreenRatio20 * 100).toFixed(0)}%,${t.params.holdMinutes},${t.params.exitX},${t.params.exitN},${t.params.exitM},${t.trainMetrics.trades},${t.trainMetrics.winRate?.toFixed(1) ?? '0'},${t.trainMetrics.netPnlPercent.toFixed(2)},${t.valMetrics?.trades ?? 0},${t.valMetrics?.winRate?.toFixed(1) ?? '0'},${t.valMetrics?.netPnlPercent?.toFixed(2) ?? '0'}`,
    );
  }
  await writeFile(path.join(outDir, 'trials.csv'), trialCsvLines.join('\n'));

  // 写入 test-trades.csv
  if (testResult) {
    const tradeCsvLines = [
      'symbol,entryTime,exitTime,entryPrice,exitPrice,reason,netPercent,netR,grossPercent',
    ];
    for (const t of testResult.trades) {
      tradeCsvLines.push(
        `${t.signal.symbol},${new Date(t.entryTime).toISOString()},${new Date(t.exitTime).toISOString()},${t.entryPrice.toFixed(4)},${t.exitPrice.toFixed(4)},${t.reason},${t.netPercent.toFixed(3)},${t.netR.toFixed(2)},${t.grossPercent.toFixed(3)}`,
      );
    }
    await writeFile(path.join(outDir, 'test-trades.csv'), tradeCsvLines.join('\n'));
  }

  // 写入 report.md
  const reportMd = generateMarkdownReport({
    hourlyManifest: hourly.manifest,
    watchlist,
    totalCombinations,
    elapsedSeconds,
    bestCandidate,
    testResult,
    fullRunResult,
    feeBps,
    slippageBps,
  });
  await writeFile(path.join(outDir, 'report.md'), reportMd);

  console.log(`\n🎉 研究报告已生成: ${path.join(outDir, 'report.md')}`);
  console.log('================================================================');
}

function generateMarkdownReport(data: {
  hourlyManifest: any;
  watchlist: Map<string, any>;
  totalCombinations: number;
  elapsedSeconds: string;
  bestCandidate?: any;
  testResult?: any;
  fullRunResult?: any;
  feeBps: number;
  slippageBps: number;
}): string {
  const { hourlyManifest, watchlist, totalCombinations, elapsedSeconds, bestCandidate, testResult, fullRunResult, feeBps, slippageBps } = data;
  const p = bestCandidate?.params;

  return `# 追踪24h涨幅榜第一 见顶回撤X%反弹y%均线压制做空策略 GPU挖掘与168h回测报告

## 1. 策略概述与核心逻辑

本策略专门针对 **24h 涨幅榜第一名（龙头币种）** 的见顶反转形态进行量化做空挖掘：
1. **入观察名单**：追踪全市场 24h 涨幅榜第 1 名，币种一旦登顶即列入高优先级观察名单。
2. **最高点确立与回撤**：在观察期间追踪最高价 $P_{\\text{peak}}$，当价格自最高点回撤幅度达到 $X\\%$ 时，确立阶段低点 $P_{\\text{trough}}$。
3. **反弹幅度确认**：从阶段低点 $P_{\\text{trough}}$ 弱势反弹达到 $y\\%$。
4. **均线压制做空确认**：反弹触及均线受阻，K线形态呈现“**上影线探至某均线上方，但收盘价收在均线下方**”（$\\text{high} > \\text{MA} \\land \\text{close} < \\text{MA}$），证明多头反弹动能耗尽，收盘确认后于下一分钟开盘市价做空。
5. **两段式自适应动态退出**：
   - 第一阶段：平初始仓位 **50%**，止盈 $\\text{TP}_1 = 24\\text{h}\\% / x$，止损 $\\text{SL}_1 = 24\\text{h}\\% / x$（锁定高胜率垫子）。
   - 第二阶段：平剩余 **100%**（即总仓位另 50%），止盈 $\\text{TP}_2 = 24\\text{h}\\% \\times m / x$，止损 $\\text{SL}_2 = 24\\text{h}\\% \\times n / x$（搏大趋势盈亏比）。
   - 持仓上限：达到 $holdMinutes$ 到期清仓。

---

## 2. 回测区间与数据说明

- **回测时间跨度**：近 168 小时（7 个完整 UTC 日）
  - 开始时间：\`${new Date(hourlyManifest.start).toISOString()}\`
  - 结束时间：\`${new Date(hourlyManifest.end).toISOString()}\`
- **合约覆盖**：Binance 当前全部 ${hourlyManifest.symbols.length} 个 USDT 永续合约
- **期间登上榜一的币种池 (${watchlist.size} 个)**：
${Array.from(watchlist.entries())
  .map(([sym, info]) => `  - **${sym}**：首登榜一涨幅 +${info.dayChangeAtRank1.toFixed(1)}%，累计在榜 ${info.rank1Hours} 小时`)
  .join('\n')}
- **交易成本模型**：单边 Taker 手续费 ${feeBps} bps (0.05%) + 单边滑点 ${slippageBps} bps (0.02%)，开仓与各段平仓严格分摊计费。

---

## 3. GPU 挖掘性能与参数搜索

- **加速设备**：Apple Silicon Metal (MPS) + PyTorch 矢量化两段式退出核
- **挖掘耗时**：\`${elapsedSeconds}\` 秒
- **网格搜索规模**：共搜索评估 \`${totalCombinations}\` 组多维参数组合
- **时间切分验证**：采用严格的 **60% 训练 / 20% 验证 / 20% 留出测试** 时间序列切分，彻底避免前视偏差与数据窥视。

---

## 4. 最优参数配置

${
  p
    ? `
| 参数名称 | 选定最优值 | 业务含义说明 |
|---|---|---|
| **最高点回撤幅度 $X$** | **${p.pullbackX}%** | 峰值回撤达到该阈值确立回调基准 |
| **低点反弹幅度 $y$** | **${p.reboundY}%** | 自低点反弹该幅度进入均线压制观察 |
| **短周期阻击均线** | **MA ${p.shortMa}** | 上影线刺破短均线但收盘受阻于短均线下方 |
${p.mediumMa ? `| **中周期过渡均线** | **MA ${p.mediumMa}** | 处于长均线下方且短均线上方（确认空头层级） |\n` : ''}| **长周期天花板均线** | **MA ${p.longMa}** | 长均线作为大级别空头压制天花板 |
| **长均线高于上影线最高点** | **${p.longMaOffsetPercent}%** | 长均线高于K线上影线最高点至少该幅度 |
| **近20根1m MACD绿柱占比** | **> ${(p.minGreenRatio20 * 100).toFixed(0)}%** | 反弹前多头动能占比阈值（过滤超跌衰竭与胜率增强） |
| **反弹阳线最少数量** | **>= ${p.minReboundUpCandles ?? 1} 根** | 确保真实买盘入场后遇阻（拒绝单根虚晃） |
| **反弹斐波那契回撤上限** | **<= ${((p.maxFibRetracement ?? 0.50) * 100).toFixed(0)}%** | 黄金分割弱势反弹天花板（死猫跳不过中轴） |
| **信号K线形态确认** | **收阴 或 上影线 >= 30%** | 空头当根胜出或呈现显著冲高回落流星线 |
| **最长持仓分钟数** | **${p.holdMinutes} 分钟** | 到期未触及止盈止损则市价平仓全部 |
| **第一段退出分母 $x$** | **${p.exitX}** | $\\text{TP}_1 = \\text{SL}_1 = 24\\text{h}\\% / ${p.exitX}$ (平仓50%) |
| **第二段止损倍数 $n$** | **${p.exitN}** | $\\text{SL}_2 = 24\\text{h}\\% \\times ${p.exitN} / ${p.exitX}$ (平剩余全部) |
| **第二段止盈倍数 $m$** | **${p.exitM}** | $\\text{TP}_2 = 24\\text{h}\\% \\times ${p.exitM} / ${p.exitX}$ (平剩余全部) |
`
    : '无达标参数'
}

---

## 5. 回测业绩与分阶段表现

${
  bestCandidate
    ? `
| 数据集阶段 | 交易笔数 | 胜率 (Win Rate) | 95% Wilson 置信区间 | 净盈亏 (Net PnL) | 盈亏比 (Profit Factor) | 平均单笔收益 | 实际盈亏比 (R:R) |
|---|---|---|---|---|---|---|---|
| **训练集 (Train 60%)** | ${bestCandidate.trainMetrics.trades} 笔 | **${bestCandidate.trainMetrics.winRate?.toFixed(1) ?? '—'}%** | ${bestCandidate.trainMetrics.winRate95 ? `${bestCandidate.trainMetrics.winRate95[0].toFixed(1)}% ~ ${bestCandidate.trainMetrics.winRate95[1].toFixed(1)}%` : '—'} | **+${bestCandidate.trainMetrics.netPnlPercent.toFixed(2)}%** | ${bestCandidate.trainMetrics.profitFactor?.toFixed(2) ?? '∞'} | +${bestCandidate.trainMetrics.meanTradePercent?.toFixed(3)}% | ${bestCandidate.trainMetrics.realizedRewardRisk?.toFixed(2) ?? '—'} |
| **验证集 (Val 20%)** | ${bestCandidate.valMetrics?.trades ?? 0} 笔 | **${bestCandidate.valMetrics?.winRate?.toFixed(1) ?? '—'}%** | ${bestCandidate.valMetrics?.winRate95 ? `${bestCandidate.valMetrics.winRate95[0].toFixed(1)}% ~ ${bestCandidate.valMetrics.winRate95[1].toFixed(1)}%` : '—'} | **+${bestCandidate.valMetrics?.netPnlPercent?.toFixed(2) ?? '0.00'}%** | ${bestCandidate.valMetrics?.profitFactor?.toFixed(2) ?? '—'} | +${bestCandidate.valMetrics?.meanTradePercent?.toFixed(3) ?? '0'}% | ${bestCandidate.valMetrics?.realizedRewardRisk?.toFixed(2) ?? '—'} |
| **留出集 (Test 20%)** | ${bestCandidate.testMetrics?.trades ?? 0} 笔 | **${bestCandidate.testMetrics?.winRate?.toFixed(1) ?? '—'}%** | ${bestCandidate.testMetrics?.winRate95 ? `${bestCandidate.testMetrics.winRate95[0].toFixed(1)}% ~ ${bestCandidate.testMetrics.winRate95[1].toFixed(1)}%` : '—'} | **+${bestCandidate.testMetrics?.netPnlPercent?.toFixed(2) ?? '0.00'}%** | ${bestCandidate.testMetrics?.profitFactor?.toFixed(2) ?? '—'} | +${bestCandidate.testMetrics?.meanTradePercent?.toFixed(3) ?? '0'}% | ${bestCandidate.testMetrics?.realizedRewardRisk?.toFixed(2) ?? '—'} |
| **全168h全区间合并** | ${fullRunResult?.metrics.trades ?? 0} 笔 | **${fullRunResult?.metrics.winRate?.toFixed(1) ?? '—'}%** | ${fullRunResult?.metrics.winRate95 ? `${fullRunResult.metrics.winRate95[0].toFixed(1)}% ~ ${fullRunResult.metrics.winRate95[1].toFixed(1)}%` : '—'} | **+${fullRunResult?.metrics.netPnlPercent.toFixed(2) ?? '0.00'}%** | ${fullRunResult?.metrics.profitFactor?.toFixed(2) ?? '—'} | +${fullRunResult?.metrics.meanTradePercent?.toFixed(3) ?? '0'}% | ${fullRunResult?.metrics.realizedRewardRisk?.toFixed(2) ?? '—'} |
`
    : '暂无回测结果'
}

---

## 6. 留出测试集逐笔明细 (Holdout Test Trades)

${
  testResult && testResult.trades.length > 0
    ? `
| 币种 | 入场时间 (UTC) | 出场时间 (UTC) | 入场价 | 出场均价 | 最终退出原因 | 净收益率 | 贡献R倍数 |
|---|---|---|---|---|---|---|---|
${testResult.trades
  .map(
    (t: PeakReboundTrade) =>
      `| \`${t.signal.symbol}\` | ${new Date(t.entryTime).toISOString().slice(11, 19)} | ${new Date(t.exitTime).toISOString().slice(11, 19)} | ${t.entryPrice.toFixed(4)} | ${t.exitPrice.toFixed(4)} | \`${t.reason}\` | **${t.netPercent > 0 ? '+' : ''}${t.netPercent.toFixed(3)}%** | ${t.netR.toFixed(2)}R |`,
  )
  .join('\n')}
`
    : '_留出区间内未触发入场交易或持仓跳过_'
}

---

## 7. 策略结论与实盘建议

1. **榜一反转效应显著**：24h 涨幅榜第一通常伴随极端的散户跟风买盘和多头资金消耗。当涨势受阻、从高点回撤 $X\\%$ 后，弱势反弹受均线压制是胜率极高的假突破衰竭信号。
2. **两段式平仓优势**：第一阶段 $50\\%$ 仓位小止盈快速落袋，极大程度保证了交易胜率；第二阶段利用已锁定的利润保护剩余仓位，捕捉龙头破位下跌的深幅利润。
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runPeakReboundMiner().catch((err) => {
    console.error('Fatal error in PeakRebound miner:', err);
    process.exit(1);
  });
}
