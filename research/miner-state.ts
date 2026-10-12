import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, digest } from './data.ts';
import type { AccountTrial, AccountMetrics } from './futures-account.ts';

export interface TrialShard { file: string; count: number; sha256: string }
interface Checkpoint {
  next: number; trials: AccountTrial[]; trialShards?: TrialShard[];
  validations?: Record<string, AccountMetrics>;
}

/** Write each training batch once, then atomically commit its pointer and TG outbox.
 * An interrupted uncommitted shard is ignored and safely replaced on replay.
 */
export async function saveMiningState<T extends Checkpoint>(directory: string, state: T) {
  if (state.next !== state.trials.length) throw new Error('挖掘检查点参数数不一致');
  const shards = state.trialShards ??= [];
  const committed = shards.reduce((n, s) => n + s.count, 0);
  if (committed > state.next) throw new Error('挖掘检查点分片超出进度');
  if (committed < state.next) {
    const file = `trials-${committed}-${state.next}.json`;
    const bytes = Buffer.from(JSON.stringify(state.trials.slice(committed)));
    await writeFile(path.join(directory, `${file}.tmp`), bytes);
    await rename(path.join(directory, `${file}.tmp`), path.join(directory, file));
    shards.push({ file, count: state.next - committed, sha256: digest(bytes) });
  }
  const { trials, ...metadata } = state;
  const validations = Object.fromEntries(trials.filter((t) => t.validation != null).map((t) => [t.id, t.validation]));
  await atomicJson(path.join(directory, 'state.json'), { ...metadata, validations });
}

export async function hydrateMiningState<T extends Checkpoint>(directory: string, state: T): Promise<T> {
  const trials: AccountTrial[] = [];
  for (const shard of state.trialShards ?? []) {
    if (shard.file !== `trials-${trials.length}-${trials.length + shard.count}.json` || !Number.isInteger(shard.count) || shard.count <= 0) throw new Error('参数分片路径或顺序无效');
    const bytes = await readFile(path.join(directory, shard.file));
    if (digest(bytes) !== shard.sha256) throw new Error('参数分片 SHA256 校验失败');
    const batch: AccountTrial[] = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(batch) || batch.length !== shard.count) throw new Error('参数分片数量不一致');
    for (const t of batch) { t.validation = state.validations?.[t.id] ?? null; trials.push(t); }
  }
  if (trials.length !== state.next) throw new Error('参数分片缺失');
  state.trials = trials;
  return state;
}
