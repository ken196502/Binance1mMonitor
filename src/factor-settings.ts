/** Browser-safe settings: short-lived evidence, rolling replacement, no long-term stability requirement. */
export interface FactorWindows {
  trainingMinutes: number;
  validationMinutes: number;
  holdoutMinutes: number;
}
export interface FactorWindowOptions {
  holdoutOffsetMinutes?: number;
  holdoutPoolHours?: [number, number];
}
export interface FactorMiningConfig extends Partial<FactorWindows>, FactorWindowOptions {
  enabled: boolean;
  refreshMinutes: number;
  validForMinutes: number;
}
export interface NormalizedFactorMiningConfig extends FactorWindows, FactorWindowOptions {
  enabled: boolean;
  refreshMinutes: number;
  validForMinutes: number;
}
export const DEFAULT_FACTOR_MINING: NormalizedFactorMiningConfig = {
  enabled: true,
  refreshMinutes: 15,
  validForMinutes: 120, // 因子最多使用 2 小时 (120 分钟)
  trainingMinutes: 1440, // 默认 24 小时训练 (-28h ~ -4h)
  validationMinutes: 120, // 默认 120 分钟验证 (-4h ~ -2h, 覆盖 -4, -3 小时)
  holdoutMinutes: 120, // 默认 120 分钟留出 (-2h ~ 0h, 覆盖 -2 和 -1 小时)
};
export function factorWindows(config: Partial<FactorWindows & FactorWindowOptions> = {}): FactorWindows & FactorWindowOptions {
  return {
    trainingMinutes: config.trainingMinutes ?? DEFAULT_FACTOR_MINING.trainingMinutes,
    validationMinutes: config.validationMinutes ?? DEFAULT_FACTOR_MINING.validationMinutes,
    holdoutMinutes: config.holdoutMinutes ?? DEFAULT_FACTOR_MINING.holdoutMinutes,
    ...(config.holdoutOffsetMinutes !== undefined ? { holdoutOffsetMinutes: config.holdoutOffsetMinutes } : {}),
    ...(config.holdoutPoolHours ? { holdoutPoolHours: config.holdoutPoolHours } : {}),
  };
}
export function factorWindowKey(config: Partial<FactorWindows> = {}): string {
  const w = factorWindows(config);
  return `${w.trainingMinutes}:${w.validationMinutes}:${w.holdoutMinutes}`;
}
export function validateFactorMiningConfig(config: FactorMiningConfig): void {
  if (!config || typeof config !== "object" || Array.isArray(config) || typeof config.enabled !== "boolean" ||
    !Number.isInteger(config.refreshMinutes) || !Number.isInteger(config.validForMinutes) || config.refreshMinutes < 15 ||
    config.validForMinutes > 720 || config.validForMinutes < 30 || config.refreshMinutes >= config.validForMinutes) {
    throw new Error("因子刷新间隔须为至少 15 分钟的整数，且小于有效期；有效期为 30~720 分钟");
  }
  const windows = factorWindows(config);
  for (const key of ["trainingMinutes", "validationMinutes", "holdoutMinutes"] as const) {
    const min = key === "trainingMinutes" ? 60 : key === "validationMinutes" ? 0 : 15;
    if (!Number.isInteger(windows[key]) || windows[key] < min || windows[key] > 4320) throw new Error(`${key} 必须是 ${min}~4320 分钟的整数`);
  }
  if (Object.values(windows).reduce((a, b) => typeof b === "number" ? a + b : a, 0) > 4320) throw new Error("训练、验证与留出窗口总计不能超过 72 小时");
}
export function normalizeFactorMiningConfig(config: FactorMiningConfig): NormalizedFactorMiningConfig {
  validateFactorMiningConfig(config);
  const w = factorWindows(config);
  return {
    enabled: config.enabled,
    refreshMinutes: config.refreshMinutes,
    validForMinutes: config.validForMinutes,
    trainingMinutes: w.trainingMinutes,
    validationMinutes: w.validationMinutes,
    holdoutMinutes: w.holdoutMinutes,
    ...(w.holdoutOffsetMinutes !== undefined ? { holdoutOffsetMinutes: w.holdoutOffsetMinutes } : {}),
    ...(w.holdoutPoolHours ? { holdoutPoolHours: w.holdoutPoolHours } : {}),
  };
}

export function getHoldoutOffsetMinutes(end: number, maxOffsetMinutes: number): number {
  if (maxOffsetMinutes <= 0) return 0;
  const step = Math.floor(end / (15 * 60_000));
  return Math.abs((step * 317 + 101) % (maxOffsetMinutes + 1));
}

export function factorRanges(end: number, config: Partial<FactorWindows & FactorWindowOptions> = {}) {
  const windows = factorWindows(config);

  if (config.holdoutPoolHours) {
    const validationEnd = end;
    const validationStart = validationEnd - windows.validationMinutes * 60_000;
    const validation = { start: validationStart, end: validationEnd };

    const trainEnd = validationStart;
    const trainStart = trainEnd - windows.trainingMinutes * 60_000;
    const train = { start: trainStart, end: trainEnd };

    const [poolStartHour, poolEndHour] = config.holdoutPoolHours;
    const poolStart = end - poolStartHour * 60 * 60_000;
    const poolEnd = end - poolEndHour * 60 * 60_000;
    const poolDurationMinutes = Math.max(0, Math.floor((poolEnd - poolStart) / 60_000));
    const maxOffsetMinutes = Math.max(0, poolDurationMinutes - windows.holdoutMinutes);
    const offsetMinutes = windows.holdoutOffsetMinutes !== undefined
      ? Math.min(Math.max(0, windows.holdoutOffsetMinutes), maxOffsetMinutes)
      : getHoldoutOffsetMinutes(end, maxOffsetMinutes);
    const holdoutStart = poolStart + offsetMinutes * 60_000;
    const holdoutEnd = holdoutStart + windows.holdoutMinutes * 60_000;
    const holdout = { start: holdoutStart, end: holdoutEnd };

    const earliestStart = Math.min(poolStart, trainStart);
    return { train, validation, holdout, earliestStart };
  }

  // 默认三段固定时段：
  // 训练时段：-28h ~ -4h (相对 end，默认 1440 分钟即 24 小时)
  const trainEnd = end - 4 * 3600_000;
  const trainStart = trainEnd - windows.trainingMinutes * 60_000;
  const train = { start: trainStart, end: trainEnd };

  // 验证时段：-4h ~ -2h (-4, -3 小时的 120 分钟验证)
  const validationEnd = end - 2 * 3600_000;
  const validationStart = validationEnd - windows.validationMinutes * 60_000;
  const validation = { start: validationStart, end: validationEnd };

  // 留出时段：-2h ~ 0h (-2 和 -1 的 120 分钟留出)
  const holdoutEnd = end;
  const holdoutStart = holdoutEnd - windows.holdoutMinutes * 60_000;
  const holdout = { start: holdoutStart, end: holdoutEnd };

  const earliestStart = Math.min(trainStart, validationStart, holdoutStart);
  return { train, validation, holdout, earliestStart };
}
