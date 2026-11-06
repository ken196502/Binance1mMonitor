import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { PaperTradingEngine } from "./paper-trading.ts";
import { MINUTE_MS, factorConfigKey, type FactorMiningResult } from "./factor-policy.ts";

export interface FactorJob { now: number; costs: FactorMiningResult["costs"] }
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
    try {
      const result = await this.run({ now, costs: { takerFeeBps: config.takerFeeBps, slippageBps: config.slippageBps } }, controller.signal);
      if (controller.signal.aborted) throw new Error("因子挖掘已停止");
      if (signature !== factorConfigKey(this.engine.getConfig())) throw new Error("挖掘期间参数已被修改，等待下轮重新验证");
      this.engine.applyMinedFactors(result, this.clock());
      const completed = this.clock();
      this.engine.setFactorMiningState({ ...this.engine.getFactorMiningState(), running: false,
        lastCompletedAt: completed, nextRunAt: completed + config.factorMining.refreshMinutes * MINUTE_MS });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.engine.setFactorMiningState({ ...this.engine.getFactorMiningState(), running: false, lastError: message,
        nextRunAt: this.clock() + 15 * MINUTE_MS });
      console.warn(`[factor-mining] ${message}`);
    } finally {
      this.running = false;
      this.controller = undefined;
    }
  }
}
