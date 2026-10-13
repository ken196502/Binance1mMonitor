import { FIFTEEN, FIFTEEN_RULE } from './fifteen.ts';
import { planNative, loadNative, fetchNative, type NativePlan, type NativeManifest } from './native-data.ts';

export type FifteenPlan = NativePlan;
export type FifteenManifest = NativeManifest & { interval: '15m' };
const rule = { ...FIFTEEN_RULE, milliseconds: FIFTEEN, fetchFlag: '--fetch-fifteen' };
export const planFifteen = (start: number, end: number, symbols: string[]) => planNative(rule, start, end, symbols);
export const loadFifteen = (directory: string, plan: FifteenPlan) => loadNative(rule, directory, plan);
export const fetchFifteen = (directory: string, plan: FifteenPlan, log = console.log) => fetchNative(rule, directory, plan, log);
