import type { FactorMiningConfig } from "./factor-settings.ts";
import { loadFactorDataset } from "./factor-data.ts";
import { mineFactors } from "./factor-miner.ts";
import type { FactorMiningResult } from "./factor-policy.ts";

// Invoked only in an isolated process. Never import the trading engine/Telegram here.
process.once("message", async (input: { now: number; costs: FactorMiningResult["costs"]; root?: string; config?: FactorMiningConfig }) => {
  try {
    const data = await loadFactorDataset(input.now, input.root, input.config);
    process.send?.({ result: mineFactors(data, input.costs, undefined, input.config) });
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    process.disconnect?.();
  }
});
