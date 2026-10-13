import type { Streak } from '../src/macd.ts';

export interface StreakParameters { minuteStreak?: number; fifteenStreak?: number }
export const STREAK_AXES = ['minuteStreak', 'fifteenStreak', 'btcFiveStreak'] as const;

/** Signed minimum length: +N at least N up bars, -N down bars, 0 unrestricted. */
export function matchesStreak(streak: Streak | undefined, minimum = 0): boolean {
  if (!Number.isInteger(minimum) || Math.abs(minimum) > 100) return false;
  if (minimum === 0) return true;
  return !!streak && Number.isInteger(streak.count) && streak.count >= Math.abs(minimum)
    && streak.direction === (minimum > 0 ? 'up' : 'down');
}
export function streakText(minimum = 0): string {
  return minimum === 0 ? '连阳/连阴不限' : `至少${Math.abs(minimum)}连${minimum > 0 ? '阳' : '阴'}`;
}
