import type { FactorMiningConfig } from "./factor-settings.ts";
import { loadFactorDataset } from "./factor-data.ts";
import { mineFactors } from "./factor-miner.ts";
import type { FactorMiningResult } from "./factor-policy.ts";

// Invoked only in an isolated process. Never import the trading engine/Telegram here.
process.once("message", async (input: { now: number; costs: FactorMiningResult["costs"]; root?: string; config?: FactorMiningConfig }) => {
  try {
    const t0 = Date.now();
    const data = await loadFactorDataset(input.now, input.root, input.config);
    const t1 = Date.now();
    const result = mineFactors(data, input.costs, undefined, input.config);
    const t2 = Date.now();
    result.timings = {
      loadDatasetMs: t1 - t0,
      mineFactorsMs: t2 - t1,
      totalWorkerMs: t2 - t0,
    };
    process.send?.({ result });
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    process.disconnect?.();
  }
});
