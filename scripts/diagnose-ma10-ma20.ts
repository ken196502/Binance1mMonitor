import * as fs from 'fs';
import * as path from 'path';
import { loadGainersMinutes } from '../research/peak-rebound-dataset';
import { runPeakReboundScan } from '../research/peak-rebound-signals';
import { backtestWick } from '../research/wick-backtest';

const minutes168Dir = path.resolve('data/research/peak-rebound-1m-168h');
const manifest = JSON.parse(fs.readFileSync(path.join(minutes168Dir, 'manifest.json'), 'utf-8'));
const minutes = loadGainersMinutes(minutes168Dir, manifest.plan);

const baselineSignals = runPeakReboundScan(minutes, {
  pullbackPercent: 10,
  reboundPercent: 4,
  shortMa: 5,
  mediumMa: 15,
  longMa: 30,
  longMaOffsetPercent: 0.5,
  confirmSlopeDown: true,
  minGreenRatio20: 0.65,
});

const ma10_20Signals = runPeakReboundScan(minutes, {
  pullbackPercent: 10,
  reboundPercent: 4,
  shortMa: 10,
  mediumMa: undefined,
  longMa: 20,
  longMaOffsetPercent: 0,
  confirmSlopeDown: true,
  minGreenRatio20: 0.65,
});

const baseRes = backtestWick(baselineSignals, minutes, { denom: 35, stopMultiplier: 2.0, takeProfitMultiplier: 3.0, maxHoldBars: 45 });
const maRes = backtestWick(ma10_20Signals, minutes, { denom: 35, stopMultiplier: 2.0, takeProfitMultiplier: 3.0, maxHoldBars: 45 });

console.log('Baseline total trades:', baseRes.trades.length, 'PnL:', baseRes.metrics.totalReturnPercent.toFixed(2) + '%');
console.log('MA 10/20 total trades:', maRes.trades.length, 'PnL:', maRes.metrics.totalReturnPercent.toFixed(2) + '%');

// Group trades by symbol
const symPnLBase: Record<string, number> = {};
for (const t of baseRes.trades) {
  symPnLBase[t.symbol] = (symPnLBase[t.symbol] || 0) + t.netPnl;
}

const symPnLMa: Record<string, { pnl: number; count: number; stopCount: number }> = {};
for (const t of maRes.trades) {
  if (!symPnLMa[t.symbol]) symPnLMa[t.symbol] = { pnl: 0, count: 0, stopCount: 0 };
  symPnLMa[t.symbol].pnl += t.netPnl;
  symPnLMa[t.symbol].count++;
  if (t.leg2Outcome === 'stop') symPnLMa[t.symbol].stopCount++;
}

console.log('\nPer-symbol comparison:');
console.log('Symbol'.padEnd(12) + 'Base PnL'.padStart(10) + 'MA10/20 PnL'.padStart(14) + 'MA Trades'.padStart(12) + 'MA Stops'.padStart(10));
for (const sym of Object.keys(symPnLMa).sort()) {
  const base = (symPnLBase[sym] || 0).toFixed(2) + '%';
  const ma = symPnLMa[sym].pnl.toFixed(2) + '%';
  console.log(
    sym.padEnd(12) +
    base.padStart(10) +
    ma.padStart(14) +
    String(symPnLMa[sym].count).padStart(12) +
    String(symPnLMa[sym].stopCount).padStart(10)
  );
}
