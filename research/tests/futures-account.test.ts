import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_ACCOUNT, backtestAccount, liquidationRatio, accountGpuParameters, accountTrainOrder, accountQualified, validateAccount, type AccountOptions, type AccountTrial } from '../futures-account.ts';
import { MINUTE, type MinuteDataset, type MinuteSignal, type GainersParameters } from '../gainers-types.ts';
import type { Bar } from '../types.ts';
const start = Date.UTC(2026, 0, 1), end = start + 12 * MINUTE;
const p: GainersParameters = { highRatio: 0.8, holdMinutes: 3, stopLossPercent: 0.5, takeProfitPercent: 5 };
const signal = (symbol = 'AAAUSDT', offset = 0): MinuteSignal => ({ symbol, time: start + offset * MINUTE, index: offset, rank: 1, boardTime: start, dif: 1, dea: 0.9, peakDea: 1, deaPeakRatio: 0.9, supportMa: null });
const bar = (offset: number, open = 100, high = 100.1, low = 99.9, close = 100): Bar => [start + offset * MINUTE, open, high, low, close, 1, 1];
function data(symbols = ['AAAUSDT']) {
  return { candles: new Map(symbols.map((s) => [s, Array.from({ length: 13 }, (_, i) => bar(i - 1))])) } as MinuteDataset;
}
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('10x isolated margin sizes the position and pays fees on notional at both ends', () => {
  for (const [high, low, net, reason] of [[100.6, 99.9, -6.4035, 'stop'], [100.1, 94.9, 48.635, 'target']] as const) {
    const d = data(); d.candles.get('AAAUSDT')![1] = bar(0, 100, high, low);
    const r = backtestAccount(d, [signal()], p, start, end, DEFAULT_ACCOUNT);
    const t = r.trades[0];
    assert.equal(t.reason, reason); near(t.marginUSDT, 100); near(t.notionalUSDT, 1000); near(t.quantity, 10);
    near(t.entryCostUSDT, 0.7); near(t.netPnlUSDT, net); near(t.marginReturnPercent, net);
    near(r.metrics.finalBalanceUSDT, 1000 + net); near(r.metrics.netPnlUSDT, net);
    near(r.metrics.accountReturnPercent, net / 10);
    near(r.equity.at(-1)!.lockedMarginUSDT, 0);
  }
});

test('capital and position limits skip entries; a skipped signal never creates a phantom holding', () => {
  const d = data(['AAAUSDT', 'BBBUSDT']);
  const signals = [signal('BBBUSDT'), signal('AAAUSDT'), signal('BBBUSDT', 1), signal('BBBUSDT', 3)];
  const funds = backtestAccount(d, signals, p, start, end, { ...DEFAULT_ACCOUNT, initialBalanceUSDT: 150 });
  assert.deepEqual(funds.trades.map((t) => [t.symbol, (t.entryTime - start) / MINUTE]), [['AAAUSDT', 0], ['BBBUSDT', 3]]);
  assert.equal(funds.metrics.skippedFunds, 2); assert.equal(funds.metrics.maxConcurrentPositions, 1);
  near(funds.metrics.maxLockedMarginUSDT, 100); assert.ok(funds.metrics.minFreeUSDT >= 0);
  const cap = backtestAccount(d, signals, p, start, end, { ...DEFAULT_ACCOUNT, maxPositions: 1 });
  assert.equal(cap.metrics.skippedPositionLimit, 2); assert.equal(cap.metrics.skippedFunds, 0);
});

test('liquidation is earlier than a distant stop at high leverage and isolates losses on a gap', () => {
  const highLeverage = { ...DEFAULT_ACCOUNT, leverage: 125 };
  const d = data(); d.candles.get('AAAUSDT')![1] = bar(0, 100, 100.4);
  const r = backtestAccount(d, [signal()], p, start, end, highLeverage);
  assert.equal(r.trades[0].reason, 'liquidation');
  near(r.trades[0].exitPrice, 100 * liquidationRatio(highLeverage));
  assert.equal(r.metrics.liquidations, 1); assert.equal(accountQualified(r.metrics, 1), false);
  assert.ok(accountGpuParameters(p, highLeverage).stopLossPercent < p.stopLossPercent);
  const gapped = data(); gapped.candles.get('AAAUSDT')![2] = bar(1, 120, 121, 119, 120);
  const gap = backtestAccount(gapped, [signal()], p, start, end, DEFAULT_ACCOUNT);
  assert.equal(gap.trades[0].reason, 'liquidation'); near(gap.trades[0].exitPrice, 120);
  near(gap.trades[0].insuranceShortfallUSDT, 100);
  near(gap.metrics.finalBalanceUSDT, 899.3); // loses isolated margin plus entry fee, not other collateral
});

test('nearer stop wins before liquidation during a continuous candle; adverse exit wins dual touch', () => {
  const d = data(); d.candles.get('AAAUSDT')![1] = bar(0, 100, 120, 90);
  const r = backtestAccount(d, [signal()], p, start, end, DEFAULT_ACCOUNT);
  assert.equal(r.trades[0].reason, 'stop'); assert.equal(r.trades[0].ambiguous, true);
  near(r.trades[0].exitPrice, 100.5); assert.equal(r.metrics.liquidations, 0);
});

test('drawdown includes unrealized PnL, and the ledger conserves all fees and released collateral', () => {
  const d = data(); const bars = d.candles.get('AAAUSDT')!;
  bars[1] = bar(0, 100, 100.1, 98.9, 99);
  bars[2] = bar(1, 99, 100.2, 98.9, 100.1);
  bars[3] = bar(2, 100.1, 100.2, 98.9, 99);
  const r = backtestAccount(d, [signal()], p, start, end, DEFAULT_ACCOUNT);
  near(r.metrics.maxEquityDrawdownUSDT, 11);
  near(r.metrics.maxEquityDrawdownPercent, 11 / 1009.3 * 100);
  near(r.metrics.finalBalanceUSDT, 1000 + r.trades.reduce((n, t) => n + t.netPnlUSDT, 0));
  for (const point of r.equity) near(point.equityUSDT, point.freeUSDT + point.lockedMarginUSDT + point.unrealizedPnlUSDT);
});

test('unrealized gains cannot fund new positions before their trade exits', () => {
  const d = data(['AAAUSDT', 'BBBUSDT']); d.candles.get('AAAUSDT')![1] = bar(0, 100, 100.1, 95.1, 96);
  const r = backtestAccount(d, [signal(), signal('BBBUSDT', 1)], p, start, end, { ...DEFAULT_ACCOUNT, initialBalanceUSDT: 180 });
  assert.equal(r.metrics.skippedFunds, 1); assert.equal(r.trades.length, 1);
});

test('missing held candles invalidate the account; split purge happens before looking at exits', () => {
  const d = data(); d.candles.get('AAAUSDT')!.splice(2, 1);
  const r = backtestAccount(d, [signal()], p, start, end, DEFAULT_ACCOUNT);
  assert.equal(r.metrics.valid, false); assert.equal(r.metrics.missing, 1); assert.equal(r.trades[0].reason, 'missing');
  assert.equal(accountQualified(r.metrics, 1), false);
  const purged = backtestAccount(data(), [signal()], p, start, start + 2 * MINUTE, DEFAULT_ACCOUNT);
  assert.equal(purged.metrics.purged, 1); assert.equal(purged.metrics.trades, 0); near(purged.metrics.finalBalanceUSDT, 1000);
});

test('account ranking uses portfolio return, not unlevered mean trade return', () => {
  const metrics = backtestAccount(data(), [], p, start, end, DEFAULT_ACCOUNT).metrics;
  const a: AccountTrial = { id: 'a', round: 1, parameters: p, train: { ...metrics, accountReturnPercent: 5, meanNetPercent: 0.01 }, validation: null };
  const b: AccountTrial = { id: 'b', round: 1, parameters: p, train: { ...metrics, accountReturnPercent: 2, meanNetPercent: 0.5 }, validation: null };
  assert.equal([b, a].sort(accountTrainOrder)[0].id, 'a');
  assert.throws(() => validateAccount({ ...DEFAULT_ACCOUNT, initialBalanceUSDT: 100 }), /不足/);
  assert.throws(() => validateAccount({ ...DEFAULT_ACCOUNT, leverage: 125, maintenanceMarginPercent: 1 }), /维持保证金/);
});

test('isolated account enforces no MA support before reserving funds', () => {
  const d = data();
  for (const supportMa of ['ma7', 'ma120', undefined]) {
    const s = { ...signal(), supportMa } as MinuteSignal;
    const r = backtestAccount(d, [s], p, start, end, DEFAULT_ACCOUNT);
    assert.equal(r.trades.length, 0); near(r.metrics.maxLockedMarginUSDT, 0); near(r.metrics.finalBalanceUSDT, 1000);
  }
});
