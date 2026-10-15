import type { Row } from './types.ts';

/** Pure single-symbol rule shared by live alerts and the historical baseline. */
export type AlertCandidate = Pick<Row, 'supportMa' | 'change60d' | 'max1500' | 'lastPrice' | 'diff1mLevel' | 'diff5mLevel' | 'diff15mLevel' | 'streakDir' | 'streakCount'>;
export function isAlertMatch(r: AlertCandidate, isPinned = false): boolean {
  if (r.supportMa) return false;
  if (!isPinned && r.change60d !== 'up') return false;
  if (r.max1500 == null || r.lastPrice >= r.max1500 * 0.96) return false;
  if ((r.diff5mLevel ?? r.diff15mLevel) !== 'mid') return false;
  return r.diff1mLevel === 'mid' && r.streakDir === 'up' && (r.streakCount ?? 0) >= 2
    || r.diff1mLevel === 'low' && r.streakDir === 'down' && (r.streakCount ?? 0) >= 2;
}
