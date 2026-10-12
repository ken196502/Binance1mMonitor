import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MINUTE, type GainersParameters, type MinuteDataset, type MinuteSignal } from './gainers-types.ts';

/** Binary float32 trajectories; no future validation/test signals are exported. */
export async function writeGpuWindows(file: string, data: MinuteDataset, signals: MinuteSignal[], horizon: number, end: number) {
  const handle = await open(file, 'w');
  try {
    for (const signal of signals) {
      const bytes = Buffer.alloc(horizon * 5 * 4);
      const bars = data.candles.get(signal.symbol)!;
      const first = bars[signal.index + 1];
      for (let offset = 0; offset < horizon; offset++) {
        const c = bars[signal.index + 1 + offset];
        if (!first || !c || c[0] !== signal.time + offset * MINUTE || c[0] >= end) break;
        for (let j = 0; j < 4; j++) bytes.writeFloatLE(c[j + 1] / first[1], (offset * 5 + j) * 4);
        bytes.writeFloatLE(1, (offset * 5 + 4) * 4);
      }
      await handle.write(bytes);
    }
  } finally { await handle.close(); }
}

export interface GpuInfo { device: 'mps' | 'cpu'; torch: string; signals: number; horizon: number; probe: number }
export class GpuWorker {
  private exitCache = new Map<string, number[]>();
  private child: ChildProcessWithoutNullStreams;
  private pending?: { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
  private failure?: Error;
  private stderr = '';
  constructor(python: string) {
    this.child = spawn(python, ['-u', fileURLToPath(new URL('./gpu/worker.py', import.meta.url))], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTORCH_ENABLE_MPS_FALLBACK: '0' },
    });
    this.child.stderr.on('data', (b) => { this.stderr = (this.stderr + String(b)).slice(-3000); });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      const p = this.pending;
      if (!p) return;
      clearTimeout(p.timer); this.pending = undefined;
      try {
        const value = JSON.parse(line);
        if (!value.ok) p.reject(new Error(`GPU: ${value.error}`));
        else p.resolve(value);
      } catch { p.reject(new Error('GPU worker returned invalid JSON')); }
    });
    this.child.on('error', (e) => this.fail(e));
    this.child.on('exit', (code, signal) => this.fail(new Error(`GPU worker exited (${code ?? signal}): ${this.stderr}`)));
    this.child.stdin.on('error', (e) => this.fail(e));
  }
  private fail(e: Error) {
    this.failure = e;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(e); this.pending = undefined; }
  }
  call<T>(request: object): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new Error('GPU worker requests must be sequential'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(new Error('GPU worker timed out after 180s')); this.child.kill(); }, 180_000);
      this.pending = { resolve, reject, timer };
      this.child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }
  init(file: string, signals: number, horizon: number, device: string) {
    this.exitCache.clear();
    return this.call<GpuInfo>({ op: 'init', file, signals, horizon, device });
  }
  evaluate(parameters: GainersParameters[], signalBatch: number) {
    return this.call<{ offsets: number[][]; seconds: number }>({ op: 'evaluate', parameters, signalBatch });
  }
  /** Indicators do not change first exits. Cache by effective hold/stop/target,
   * including account liquidation-adjusted stop, on this worker's training data.
   */
  async evaluateCached(parameters: GainersParameters[], signalBatch: number) {
    const key = (p: GainersParameters) => `${p.holdMinutes}/${p.stopLossPercent}/${p.takeProfitPercent}`;
    const missing = [...new Map(parameters.filter((p) => !this.exitCache.has(key(p))).map((p) => [key(p), p])).values()];
    let seconds = 0;
    if (missing.length) {
      const result = await this.evaluate(missing, signalBatch);
      if (result.offsets.length !== missing.length) throw new Error('GPU缓存批次长度错误');
      missing.forEach((p, i) => this.exitCache.set(key(p), result.offsets[i]));
      seconds = result.seconds;
    }
    return { offsets: parameters.map((p) => this.exitCache.get(key(p))!), seconds, computed: missing.length };
  }
  close() { this.child.stdin.end(); this.child.kill(); }
}
