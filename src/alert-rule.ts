import type { Row } from './types.ts';

/** Pure single-symbol rule shared by live alerts and the historical baseline. */
export type AlertCandidate = Partial<
  Pick<
    Row,
    | 'supportMa'
    | 'streakDir'
    | 'streakCount'
    | 'streakGainPercent'
    | 'priceChangePercent'
    | 'greenBarRatio30'
    | 'change60d'
    | 'max1500'
    | 'maxHour'
    | 'hourFirstClose'
    | 'hourFirstLow'
    | 'lastPrice'
    | 'diff1mLevel'
    | 'diff5mLevel'
    | 'diff15mLevel'
  >
>;

export interface AlertRuleOptions {
  minStreakCount?: number;
  minStreakGain?: number;
  minGreenRatio?: number;
}

export function isAlertMatch(
  r: AlertCandidate,
  isPinned = false,
  opts?: AlertRuleOptions,
): boolean {
  // 1. 无任何 MA 支撑
  if (r.supportMa) return false;

  // 新规则：连阳且涨幅达到阈值(24h涨幅/10) + 无任何MA支撑 + 近30根1mMACD绿柱>80%
  if (r.greenBarRatio30 !== undefined || r.streakGainPercent !== undefined) {
    const minStreakCount = opts?.minStreakCount ?? 2;
    // 阈值是 24h 涨幅 / 10
    const dynamicMinGain = r.priceChangePercent != null ? r.priceChangePercent / 10 : null;
    const minStreakGain = opts?.minStreakGain ?? dynamicMinGain ?? 1.0;
    const minGreenRatio = opts?.minGreenRatio ?? 0.8;

    if (r.streakDir !== 'up') return false;
    if ((r.streakCount ?? 0) < minStreakCount) return false;
    if (r.streakGainPercent == null || r.streakGainPercent < minStreakGain) return false;
    if (r.greenBarRatio30 == null || r.greenBarRatio30 <= minGreenRatio) return false;
    return true;
  }

  // 兼容旧版研究基线测试
  if (!isPinned && r.change60d !== 'up') return false;
  if (r.max1500 != null && r.lastPrice != null && r.lastPrice >= r.max1500 * 0.96) return false;
  const hourBenchmark = r.hourFirstLow !== undefined ? r.hourFirstLow : (r.hourFirstClose ?? r.maxHour);
  if (hourBenchmark !== undefined && (hourBenchmark == null || (r.lastPrice != null && r.lastPrice >= hourBenchmark * 0.9))) return false;
  if ((r.diff5mLevel ?? r.diff15mLevel) !== 'mid') return false;
  return (r.diff1mLevel === 'mid' && r.streakDir === 'up' && (r.streakCount ?? 0) >= 2)
    || (r.diff1mLevel === 'low' && r.streakDir === 'down' && (r.streakCount ?? 0) >= 2);
}


