import { BTC_FIVE, BTC_FIVE_RULE } from './btc-five.ts';
import { planNative, loadNative, fetchNative, type NativePlan } from './native-data.ts';

const rule = { ...BTC_FIVE_RULE, milliseconds: BTC_FIVE, fetchFlag: '--fetch-btc-five' };
export const planBtcFive = (start: number, end: number) => planNative(rule, start, end, [BTC_FIVE_RULE.symbol]);
function checkPlan(plan: NativePlan) {
  if (plan.symbols.length !== 1 || plan.symbols[0] !== BTC_FIVE_RULE.symbol) throw new Error('BTC 5m 缓存只能包含 BTCUSDT');
}
export async function loadBtcFive(directory: string, plan: NativePlan) {
  checkPlan(plan);
  return loadNative(rule, directory, plan);
}
export async function fetchBtcFive(directory: string, plan: NativePlan, log = console.log) {
  checkPlan(plan);
  return fetchNative(rule, directory, plan, log);
}
