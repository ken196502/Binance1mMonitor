import { normalizeFactorMiningConfig, type FactorMiningConfig } from "./factor-settings.ts";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { PaperTradingEngine } from "./paper-trading.ts";
import { MINUTE_MS, factorConfigKey, type FactorMiningResult, type FactorMiningRunRecord } from "./factor-policy.ts";

export interface FactorJob { now: number; costs: FactorMiningResult["costs"]; config?: FactorMiningConfig; root?: string }
export function runFactorWorker(job: FactorJob, signal?: AbortSignal): Promise<FactorMiningResult> {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL("./factor-worker.ts", import.meta.url)), [], {
      execArgv: ["--max-old-space-size=768", "--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    let settled = false;
    const finish = (error?: Error, result?: FactorMiningResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      child.kill();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(new Error("因子挖掘已停止"));
    const timer = setTimeout(() => finish(new Error("因子挖掘超过 10 分钟，已终止本轮")), 10 * MINUTE_MS);
    child.once("error", error => finish(error));
    child.once("exit", code => finish(new Error(`因子挖掘进程退出 (${code})`)));
    child.once("message", (message: { error?: string; result?: FactorMiningResult }) => {
      if (message.error || !message.result) finish(new Error(message.error ?? "因子挖掘结果为空"));
      else finish(undefined, message.result);
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort(); else child.send(job);
  });
}

/** Independent of position counts, account balance, and the market polling backoff. */
export class FactorMiningService {
  private timer?: NodeJS.Timeout;
  private running = false;
  private controller?: AbortController;
  constructor(
    private engine: PaperTradingEngine,
    private run: (job: FactorJob, signal?: AbortSignal) => Promise<FactorMiningResult> = runFactorWorker,
    private clock = Date.now,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, 15_000);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort();
  }

  async tick(): Promise<void> {
    const now = this.clock();
    const config = this.engine.getConfig();
    const state = this.engine.getFactorMiningState();
    if (!config.factorMining?.enabled) { this.controller?.abort(); return; }
    if (this.running || now < (state.nextRunAt ?? 0)) return;
    this.running = true;
    const controller = this.controller = new AbortController();
    const signature = factorConfigKey(config);
    this.engine.setFactorMiningState({ ...state, running: true, lastStartedAt: now, lastError: undefined });
    console.log(`[factor-mining] ⏳ [${new Date(now).toISOString()}] 开始新一轮因子模型训练与参数挖掘 (调度周期: 每 ${config.factorMining.refreshMinutes} 分钟, 10分钟超时看门狗监控中)...`);
    const notification = this.engine.notifyFactorMiningStarted?.(config.factorMining)?.catch(e =>
      console.error(`[factor-mining] TG 播报 [训练开始] 失败:`, e)
    );
    try {
      const runPromise = this.run({ now, config: normalizeFactorMiningConfig(config.factorMining), costs: { takerFeeBps: config.takerFeeBps, slippageBps: config.slippageBps } }, controller.signal);
      await notification;
      const result = await runPromise;
      if (controller.signal.aborted) throw new Error("因子挖掘已停止");
      if (signature !== factorConfigKey(this.engine.getConfig())) throw new Error("挖掘期间参数已被修改，等待下轮重新验证");
      this.engine.applyMinedFactors(result, this.clock());
      const completed = this.clock();
      const durationMs = Math.max(0, completed - now);
      const durationSec = (durationMs / 1000).toFixed(2) + "s";
      const timeoutUsagePercent = ((durationMs / (10 * MINUTE_MS)) * 100).toFixed(1) + "%";
      const appliedSides = (["LONG", "SHORT"] as const).filter(s => !!result.sides[s]?.candidate);
      const appliedStrategies = result.strategies
        ? Object.entries(result.strategies).filter(([_, info]) => !!info.candidate).map(([id]) => id)
        : [];
      const record: FactorMiningRunRecord = {
        id: String(now),
        startedAt: now,
        completedAt: completed,
        durationMs,
        durationSec,
        timeoutUsagePercent,
        trials: result.trials,
        status: "success",
        appliedSides,
        appliedStrategies,
        timings: result.timings,
      };
      const currentState = this.engine.getFactorMiningState();
      const history = [...(currentState.history ?? []), record].slice(-20);
      this.engine.setFactorMiningState({
        ...currentState,
        running: false,
        lastCompletedAt: completed,
        lastDurationMs: durationMs,
        lastDurationSec: durationSec,
        nextRunAt: completed + config.factorMining.refreshMinutes * MINUTE_MS,
        history,
      });

      const sidesSummary = `做多: ${result.sides.LONG.candidate ? "达标" : "未达标(" + result.sides.LONG.reason + ")"}, 做空: ${result.sides.SHORT.candidate ? "达标" : "未达标(" + result.sides.SHORT.reason + ")"}`;
      const strategySummary = result.strategies
        ? ` | 预设策略达标: ${appliedStrategies.length > 0 ? appliedStrategies.join(", ") : "无"}`
        : "";
      const timingsSummary = result.timings
        ? ` [数据加载: ${result.timings.loadDatasetMs ?? 0}ms, 挖掘计算: ${result.timings.mineFactorsMs ?? 0}ms]`
        : "";
      console.log(`[factor-mining] ✅ [${new Date(completed).toISOString()}] 训练挖掘完成！总耗时: ${durationSec} (${durationMs}ms, 仅占10m看门狗 ${timeoutUsagePercent}) | 候选集: ${result.trials} 组${timingsSummary} | ${sidesSummary}${strategySummary}`);
    } catch (error) {
      const completed = this.clock();
      const durationMs = Math.max(0, completed - now);
      const durationSec = (durationMs / 1000).toFixed(2) + "s";
      const timeoutUsagePercent = ((durationMs / (10 * MINUTE_MS)) * 100).toFixed(1) + "%";
      const message = error instanceof Error ? error.message : String(error);
      const record: FactorMiningRunRecord = {
        id: String(now),
        startedAt: now,
        completedAt: completed,
        durationMs,
        durationSec,
        timeoutUsagePercent,
        trials: 0,
        status: controller.signal.aborted ? "aborted" : "failed",
        error: message,
        appliedSides: [],
        appliedStrategies: [],
      };
      const currentState = this.engine.getFactorMiningState();
      const history = [...(currentState.history ?? []), record].slice(-20);
      this.engine.setFactorMiningState({
        ...currentState,
        running: false,
        lastCompletedAt: completed,
        lastDurationMs: durationMs,
        lastDurationSec: durationSec,
        lastError: message,
        nextRunAt: this.clock() + 15 * MINUTE_MS,
        history,
      });
      console.warn(`[factor-mining] ❌ [${new Date(completed).toISOString()}] 训练挖掘异常 (已耗时: ${durationSec}, 看门狗占用: ${timeoutUsagePercent}): ${message}`);
    } finally {
      this.running = false;
      this.controller = undefined;
    }
  }
}
