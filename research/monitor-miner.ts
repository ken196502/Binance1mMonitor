import { parseArgs, isDeepStrictEqual } from 'node:util';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './data.ts';
import { MINUTE } from './gainers-types.ts';
import { prepareMonitorData } from './monitor-prepare.ts';
import { MONITOR_BOARDS, MONITOR_RULE, type MonitorBoard } from './monitor-data.ts';
import { buildMonitorSignals } from './monitor-signals.ts';
import { MONITOR_BASELINE, monitorSearch, validateMonitorGrid } from './monitor-grid.ts';
import { writeMonitorReport, type MonitorState } from './monitor-report.ts';
import { acquireMiningLock } from './miner.ts';
import { hydrateMiningState, saveMiningState } from './miner-state.ts';
import { GpuWorker, writeGpuWindows } from './gpu.ts';
import { DEFAULT_ACCOUNT, validateAccount, backtestAccount, accountGpuParameters, accountTrainOrder, accountValidationOrder, accountQualified, type AccountOptions, type AccountTrial } from './futures-account.ts';

const HELP = `同币1m/5m DIFF + 60D趋势 + 1500根高点：独立GPU做空挖掘
npm run mine:monitor -- --fetch --board all
--board gainers|losers|all   默认all；两榜分别选参和输出
--data DIR                  全市场小时缓存，默认 data/research/hourly-initial
--cache DIR                 新分钟/日线缓存，默认 data/research/monitor-7d
--start UTC --end UTC        小时对齐且在小时缓存内；默认最近7个完整UTC日
--days N                    默认7；显式start时由start决定
--fetch                     从官方历史归档补齐分钟和日线，逐币断点续传
--fetch-only                仅补齐缓存，不启动搜索
--out DIR                   默认 reports/research/monitor-gpu，下面分gainers/losers
--grid FILE                 默认 research/miner-grid-monitor.json
--max-trials N              默认20000，最多400000；预先按状态/连续/回撤分层抽样
--batch N                   默认32，最多128
--signal-batch N            默认1024，最多4096
--rounds N                  本次每榜轮数；0运行完预定清单（默认0）
--min-trades N              默认100；验证/留出至少ceil(N/3)
--min-net-rr N              默认3；名义盈亏比也须≥3
--fee-bps N --slippage-bps N 默认单边5+2bps
--leverage N --margin-usdt N --balance-usdt N  默认10倍/100/1000 USDT
--max-positions N           默认10
--baseline-high-ratio N     默认HIGH_RATIO或0.8；1m/5m基线使用相同阈值
--seed N                    默认42
--python FILE               默认 .venv-gpu/bin/python
--device mps|cpu            默认mps；cpu用于排错
--resume                    相同参数续跑；完成的研究不会重新选参
--help
训练前五进入验证，只选一个留出。固定当前播报条件为独立基线。
仅本地日志/报告，不发送Telegram，不下单。原mine、mine:btc5m保留复现旧研究。
`;

export async function main(args = process.argv.slice(2)) {
  const strings = ['board', 'data', 'cache', 'start', 'end', 'days', 'out', 'grid', 'max-trials', 'batch', 'signal-batch', 'rounds', 'min-trades', 'min-net-rr', 'fee-bps', 'slippage-bps', 'leverage', 'margin-usdt', 'balance-usdt', 'max-positions', 'baseline-high-ratio', 'seed', 'python', 'device'];
  const booleans = ['fetch', 'fetch-only', 'resume', 'help'];
  const parsed = parseArgs({ args, strict: true, options: Object.fromEntries([
    ...strings.map((k) => [k, { type: 'string' as const }]), ...booleans.map((k) => [k, { type: 'boolean' as const }]),
  ]) });
  const values = parsed.values as Record<string, string | boolean | undefined>;
  if (values.help) { console.log(HELP); return; }
  const str = (key: string, fallback: string) => String(values[key] ?? fallback);
  const num = (key: string, fallback: number, min: number, max: number, integer = true) => {
    const v = Number(values[key] ?? fallback);
    if (!String(values[key] ?? fallback).trim() || !Number.isFinite(v) || v < min || v > max || integer && !Number.isInteger(v)) throw new Error(`${key} 必须为${min}..${max}${integer ? '整数' : ''}`);
    return v;
  };
  const boardValue = str('board', 'all');
  if (!['gainers', 'losers', 'all'].includes(boardValue)) throw new Error('board 必须为 gainers/losers/all');
  const boards: MonitorBoard[] = boardValue === 'all' ? [...MONITOR_BOARDS] : [boardValue as MonitorBoard];
  const grid = validateMonitorGrid(JSON.parse(await readFile(str('grid', fileURLToPath(new URL('./miner-grid-monitor.json', import.meta.url))), 'utf8')));
  const fee = num('fee-bps', 5, 0, 100, false), slippage = num('slippage-bps', 2, 0, 100, false);
  const account: AccountOptions = { ...DEFAULT_ACCOUNT, costBps: fee + slippage,
    leverage: num('leverage', 10, 1, 125), marginPerTradeUSDT: num('margin-usdt', 100, 0.01, 1e9, false),
    initialBalanceUSDT: num('balance-usdt', 1000, 0.01, 1e9, false), maxPositions: num('max-positions', 10, 1, 100) };
  validateAccount(account);
  const seed = num('seed', 42, 0, 0xffffffff), minTrades = num('min-trades', 100, 1, 100000), minNetRR = num('min-net-rr', 3, 3, 100, false);
  const search = monitorSearch(grid, account.costBps, minNetRR, seed, num('max-trials', 20000, 1, 400000));
  const batch = num('batch', 32, 1, 128), signalBatch = num('signal-batch', 1024, 1, 4096), rounds = num('rounds', 0, 0, 100000);
  const highRatio = num('baseline-high-ratio', Number(process.env.HIGH_RATIO ?? 0.8), 0.01, 1, false);
  if (Number(process.env.HIGH_WINDOW ?? 100) !== 100) throw new Error('新研究当前固定100根DIFF窗口，请显式使用HIGH_WINDOW=100运行');
  const baselineParameters = { ...MONITOR_BASELINE, highRatio, fiveHighRatio: highRatio };
  const horizon = Math.max(baselineParameters.holdMinutes, ...grid.holdMinutes);
  const device = str('device', 'mps');
  if (!['mps', 'cpu'].includes(device)) throw new Error('device 必须为mps或cpu');
  const outRoot = path.resolve(str('out', 'reports/research/monitor-gpu'));
  if (values.resume) {
    let found = false;
    for (const board of boards) {
      try { await readFile(path.join(outRoot, board, 'state.json')); found = true; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    if (!found) throw new Error('没有可恢复的state.json');
  }
  const cacheDir = path.resolve(str('cache', 'data/research/monitor-7d'));
  await mkdir(cacheDir, { recursive: true });
  const fetching = Boolean(values.fetch || values['fetch-only']);
  const releaseCache = fetching ? await acquireMiningLock(cacheDir) : undefined;
  let data: Awaited<ReturnType<typeof prepareMonitorData>>;
  try {
    data = await prepareMonitorData({ dataDir: path.resolve(str('data', 'data/research/hourly-initial')), cacheDir,
      start: values.start === undefined ? undefined : Date.parse(String(values.start)), end: values.end === undefined ? undefined : Date.parse(String(values.end)),
      days: num('days', 7, 1, 365), horizon, fetch: fetching });
  } finally { await releaseCache?.(); }
  if (values['fetch-only']) { console.log('分钟/日线缓存已就绪'); return; }
  const { start, end, hourly, minute, daily, frames } = data;
  const duration = (end - start) / MINUTE, trainEnd = start + Math.floor(duration * 0.6) * MINUTE;
  const validationEnd = trainEnd + Math.floor(duration * 0.2) * MINUTE;
  if (Math.min(trainEnd - start, validationEnd - trainEnd, end - validationEnd) < horizon * MINUTE) throw new Error('每个分段需覆盖最长持仓');
  const sourceHashes: Record<string, string> = {};
  for (const f of ['monitor-miner.ts', 'monitor-signals.ts', 'monitor-data.ts', 'monitor-prepare.ts', 'monitor-grid.ts', 'monitor-report.ts',
    'gainers-types.ts', 'types.ts', 'fifteen.ts', 'btc-five.ts', 'streak.ts', 'futures-account.ts', 'gainers-backtest.ts', 'gainers-config.ts', 'gainers-data.ts', 'gainers-archive.ts',
    'backtest.ts', 'data.ts', 'client.ts', 'miner-core.ts', 'miner-state.ts', 'gpu.ts', 'gpu/worker.py', 'gpu/requirements.txt', '../src/macd.ts', '../src/alert-rule.ts']) {
    sourceHashes[f] = digest(await readFile(new URL(f, import.meta.url)));
  }
  let stopping = false;
  const stop = () => { stopping = true; console.log('收到停止信号，完成当前轮并保存断点。'); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    for (const board of boards) {
      if (stopping) break;
      const out = path.join(outRoot, board); await mkdir(out, { recursive: true });
      const unlock = await acquireMiningLock(out);
      let worker: GpuWorker | undefined;
      try {
        const signals = buildMonitorSignals(minute, daily.candles, frames, board, new Map(hourly.manifest.contracts.map((c) => [c.symbol, c.onboardDate])), Math.min(4, ...grid.minDrawdownPercent));
        const trainingSignals = signals.filter((s) => s.time < trainEnd);
        const config = { board, grid, search: search.plan, total: search.candidates.length, sourceHashes, rule: MONITOR_RULE, account, fee, slippage,
          batch, signalBatch, device, minTrades, minNetRR, baselineParameters, split: { start, trainEnd, validationEnd, end },
          hourlyHash: digest(Buffer.from(JSON.stringify(hourly.manifest))), minuteHash: digest(Buffer.from(JSON.stringify(minute.manifest))), dailyHash: digest(Buffer.from(JSON.stringify(daily.manifest))),
          coverage: { poolSymbols: hourly.manifest.symbols.length, boardHours: frames.length, minuteSymbols: minute.candles.size,
            minuteBars: Object.values(minute.manifest.files).reduce((n, f) => n + f.bars, 0), missingMinutes: Object.values(minute.manifest.files).reduce((n, f) => n + f.missingMinutes, 0),
            dailyBars: Object.values(daily.manifest.files).reduce((n, f) => n + f.bars, 0), missingDays: Object.values(daily.manifest.files).reduce((n, f) => n + f.missingBars, 0),
            signals: signals.length, trainingSignals: trainingSignals.length } };
        const fingerprint = digest(Buffer.from(JSON.stringify(config)));
        let state: MonitorState | undefined;
        try { state = JSON.parse(await readFile(path.join(out, 'state.json'), 'utf8')); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        if (state && !values.resume) throw new Error(`${board}目录已有研究，使用--resume或新目录`);
        if (state && (state.version !== 1 || state.fingerprint !== fingerprint)) throw new Error('代码、数据或参数变化，拒绝混合续跑；使用新目录');
        if (state) state = await hydrateMiningState(out, state);
        // An all-board run may have stopped before the second board was started.
        else if (values.resume && boards.length === 1) throw new Error(`${board}没有可恢复的state.json`);
        state ??= { version: 1, fingerprint, config, createdAt: new Date().toISOString(), status: 'mining', next: 0, trials: [], rounds: [],
          baseline: { parameters: baselineParameters, train: backtestAccount(minute, trainingSignals, baselineParameters, start, trainEnd, account).metrics } };
        const s = state, save = () => saveMiningState(out, s);
        if (s.status === 'complete') { await writeMonitorReport(out, s); console.log(`${board}已完成，未重新使用留出：${out}/report.md`); continue; }
        await save(); await writeMonitorReport(out, s);
        const windowFile = path.join(out, 'training.f32');
        await writeGpuWindows(windowFile, minute, trainingSignals, horizon, trainEnd);
        worker = new GpuWorker(path.resolve(str('python', '.venv-gpu/bin/python')));
        const gpu = await worker.init(windowFile, trainingSignals.length, horizon, device);
        if (s.gpu && s.gpu.torch !== gpu.torch) throw new Error('PyTorch版本改变，请使用新目录');
        s.gpu = gpu; await save();
        console.log(`[${board}] 设备${gpu.device}，训练信号${trainingSignals.length}，搜索${search.candidates.length}/${search.plan.possible}组；基线训练${s.baseline.train.trades}笔，收益${s.baseline.train.accountReturnPercent.toFixed(3)}%`);
        let added = 0;
        while (s.next < search.candidates.length && !stopping && (!rounds || added < rounds)) {
          const parameters = search.candidates.slice(s.next, s.next + batch);
          const result = await worker.evaluateCached(parameters.map((p) => accountGpuParameters(p, account)), signalBatch);
          if (result.offsets.length !== parameters.length) throw new Error('GPU返回参数批次数量错误');
          const evaluated = parameters.map((p, i) => backtestAccount(minute, trainingSignals, p, start, trainEnd, account, result.offsets[i]));
          const round = s.rounds.length + 1;
          const trials: AccountTrial[] = parameters.map((p, i) => ({ id: `${board}-${s.next + i + 1}`, round, parameters: p, train: evaluated[i].metrics, validation: null }));
          const best = [...trials].sort(accountTrainOrder)[0], checks = new Set([0, trials.indexOf(best)]);
          for (const i of checks) if (!isDeepStrictEqual(backtestAccount(minute, trainingSignals, parameters[i], start, trainEnd, account), evaluated[i])) throw new Error('GPU/CPU逐笔结果不一致，本轮未提交');
          s.trials.push(...trials); s.next += trials.length; added++;
          s.rounds.push({ round, trials: trials.length, seconds: result.seconds, scalarChecks: checks.size });
          await save();
          if (round === 1 || round % 32 === 0) await writeMonitorReport(out, s);
          console.log(`[${board}] 第${round}轮 ${s.next}/${search.candidates.length}；本轮最佳训练${best.train.accountReturnPercent.toFixed(3)}% (${best.train.trades}笔)；CPU复核${checks.size}组`);
          // Allow signal handlers to run even when all exits hit the GPU cache.
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        worker.close(); worker = undefined;
        if (s.next === search.candidates.length && !stopping) {
          const shortlist = s.trials.filter((t) => t.train.valid && t.train.trades >= minTrades).sort(accountTrainOrder).slice(0, 5);
          for (const t of shortlist) t.validation = backtestAccount(minute, signals, t.parameters, trainEnd, validationEnd, account).metrics;
          const minimum = Math.ceil(minTrades / 3);
          const winner = shortlist.filter((t) => t.validation!.valid && t.validation!.trades >= minimum).sort(accountValidationOrder)[0];
          s.winner = null;
          if (winner) {
            const test = backtestAccount(minute, signals, winner.parameters, validationEnd, end, account);
            s.winner = { trialId: winner.id, parameters: winner.parameters, train: winner.train, validation: winner.validation!, test,
              qualified: accountQualified(winner.train, minTrades) && accountQualified(winner.validation!, minimum) && accountQualified(test.metrics, minimum) };
          }
          s.baseline.validation = backtestAccount(minute, signals, baselineParameters, trainEnd, validationEnd, account).metrics;
          s.baseline.test = backtestAccount(minute, signals, baselineParameters, validationEnd, end, account).metrics;
          s.status = 'complete'; s.completedAt = new Date().toISOString(); await save();
        }
        await writeMonitorReport(out, s);
        console.log(`[${board}] ${s.status === 'complete' ? '挖掘完成' : '已保存断点'}：${out}/report.md`);
      } finally { worker?.close(); await unlock(); }
    }
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => { console.error(`[monitor-miner] ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
}
