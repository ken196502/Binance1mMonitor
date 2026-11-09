/** Serializable rules, shared by monitoring, research, API validation and the editor. */
export type FeatureValue = number | string | boolean;
export type FeatureOperand = FeatureValue | FeatureValue[] | { field: string; scale?: number };
export interface FeatureCondition {
  field: string;
  op: ">=" | "<=" | "==" | "!=" | ">" | "<" | "in" | "contains";
  value: FeatureOperand;
}
export type FeatureRule = FeatureCondition | { all: FeatureRule[] } | { any: FeatureRule[] };
export const ref = (field: string, scale?: number): { field: string; scale?: number } => ({ field, ...(scale === undefined ? {} : { scale }) });
export const rule = (field: string, op: FeatureCondition["op"], value: FeatureOperand): FeatureCondition => ({ field, op, value });
export const all = (...rules: FeatureRule[]): FeatureRule => ({ all: rules });
export const any = (...rules: FeatureRule[]): FeatureRule => ({ any: rules });

export interface RuleResult { pass: boolean; failedReason?: string }
export function evaluateRules(rules: FeatureRule, read: (field: string) => unknown): RuleResult {
  if ("all" in rules) {
    for (const child of rules.all) { const result = evaluateRules(child, read); if (!result.pass) return result; }
    return { pass: true };
  }
  if ("any" in rules) {
    const results = rules.any.map(child => evaluateRules(child, read));
    return results.some(result => result.pass) ? { pass: true } : { pass: false, failedReason: results.map(r => r.failedReason).join(" 或 ") };
  }
  const actual = read(rules.field);
  let expected: unknown = rules.value;
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    const operand = expected as { field: string; scale?: number };
    expected = read(operand.field);
    if (operand.scale !== undefined) expected = typeof expected === "number" ? expected * operand.scale : undefined;
  }
  // Missing or non-finite data never satisfies a condition, including !=.
  const valid = (v: unknown) => v !== undefined && v !== null && (typeof v !== "number" || Number.isFinite(v));
  let pass = false;
  if (valid(actual) && valid(expected)) {
    switch (rules.op) {
      case "==": pass = actual === expected; break;
      case "!=": pass = actual !== expected; break;
      case ">=": pass = typeof actual === "number" && typeof expected === "number" && actual >= expected; break;
      case "<=": pass = typeof actual === "number" && typeof expected === "number" && actual <= expected; break;
      case ">": pass = typeof actual === "number" && typeof expected === "number" && actual > expected; break;
      case "<": pass = typeof actual === "number" && typeof expected === "number" && actual < expected; break;
      case "in": pass = Array.isArray(expected) && expected.includes(actual); break;
      case "contains": pass = Array.isArray(actual) ? actual.includes(expected) : typeof actual === "string" && typeof expected === "string" && actual.includes(expected); break;
    }
  }
  return pass ? { pass } : { pass, failedReason: `${rules.field} ${rules.op} ${JSON.stringify(rules.value)} 未满足 (${String(actual)})` };
}

export function readFeaturePath(value: unknown, field: string): unknown {
  let current = value;
  for (const key of field.split(".")) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

// Parameterized features use decimal path segments: ma.15.slope2, pivotLow.8.25.dif.
export const FEATURE_FIELDS = [
  "rank", "dayChange", "close", "price.open", "price.high", "price.low", "price.close", "price.previousHigh",
  "new24hHigh", "dropFrom24hHigh", "body", "upperWick", "lowerWick", "upperShadowRatio", "upperRangeRatio",
  "surge.5", "surgeRatio.5", "drop.30", "range.30", "closeChange.5", "dayChangeDelta.15", "posIn24hRange",
  "ma.5.value", "ma.10.value", "ma.15.value", "ma.20.value", "ma.30.value", "ma.60.value",
  "ma.10.support", "ma.10.resist", "ma.10.breakout", "ma.10.breakdown", "ma.30.slope2", "ma.60.slope3",
  "support.3", "support.7", "support.15", "stack", "stack3Bars", "maStreak", "aboveCount", "relativeBias30",
  "dif", "dea", "hist", "difPct", "deaPct", "histSlope", "deaSlope", "greenRatio.20", "greenStreak", "redStreak",
  "goldenCrossAgo", "deathCrossAgo", "histPeakAgo", "deaPeakAgo", "topDivergence", "bottomDivergence",
  "difLevel", "diff1mLevel",
  "tf5m.macdHist", "tf5m.macdHistSlope", "tf5m.stack", "tf5m.closeVsMa20",
  "tf15m.macdHist", "tf15m.macdHistSlope", "tf15m.stack", "tf15m.closeVsMa20",
  "deaPeak.30.ago", "deaPeak.30.value", "streak.0.up", "streak.1.up", "streak.0.count",
  "pivotHigh.10.20.price", "pivotHigh.10.20.hist", "pivotHigh.10.20.dif", "pivotHigh.10.20.time",
  "pivotLow.8.25.price", "pivotLow.8.25.hist", "pivotLow.8.25.dif", "pivotLow.8.25.bounce", "pivotLow.8.25.ratio",
  "watch.ready", "watch.state", "watch.pullback", "watch.rebound", "watch.fib", "watch.upCandles", "watch.peakPrice", "watch.troughPrice",
] as const;
export function isFeatureField(field: string): boolean {
  if ((FEATURE_FIELDS as readonly string[]).includes(field)) return true;
  const patterns = [
    /^(surge|surgeRatio|drop|dropRatio|range|closeChange|greenRatio)\.(\d+)$/,
    /^ma\.(\d+)\.(value|slope2|slope3|support|resist|breakout|breakdown|biasPct|biasRatio|emaValue|close_below|close_above)$/,
    /^support\.(\d+)$/, /^streak\.(\d+)\.(up|count)$/,
    /^deaPeak\.(\d+)\.(ago|value)$/,
    /^pivot(High|Low)\.(\d+)\.(\d+)\.(price|hist|dif|time|bounce|ratio)$/,
  ];
  if (!patterns.some(p => p.test(field))) return false;
  const numbers = field.split(".").filter(p => /^\d+$/.test(p)).map(Number);
  return numbers.every(n => n >= (field.startsWith("streak.") ? 0 : 1) && n <= 500) &&
    (!field.startsWith("pivot") || numbers[0] <= numbers[1]);
}
export function validateRules(value: unknown, depth = 0): asserts value is FeatureRule {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 8) throw new Error("特征规则格式错误或嵌套过深");
  const r = value as Record<string, unknown>;
  if ("all" in r || "any" in r) {
    const key = "all" in r ? "all" : "any";
    if (Object.keys(r).length !== 1 || !Array.isArray(r[key]) || r[key].length === 0 || r[key].length > 100) throw new Error("条件组合需要 1~100 条规则");
    r[key].forEach(v => validateRules(v, depth + 1));
    return;
  }
  if (Object.keys(r).some(k => !["field", "op", "value", "dimension"].includes(k)) || typeof r.field !== "string" || !isFeatureField(r.field)) throw new Error(`未知特征: ${r.field}`);
  if (![">=", "<=", "==", "!=", ">", "<", "in", "contains"].includes(String(r.op))) throw new Error(`不支持的操作符: ${r.op}`);
  const scalar = (v: unknown) => typeof v === "boolean" || typeof v === "string" || typeof v === "number" && Number.isFinite(v);
  const v = r.value;
  if (Array.isArray(v)) { if (r.op !== "in" || !v.length || !v.every(scalar)) throw new Error("in 需要非空值列表"); }
  else if (v && typeof v === "object") {
    const operand = v as Record<string, unknown>;
    if (Object.keys(operand).some(k => !["field", "scale"].includes(k)) || typeof operand.field !== "string" || !isFeatureField(operand.field) || operand.scale !== undefined && (typeof operand.scale !== "number" || !Number.isFinite(operand.scale))) throw new Error("特征比较引用无效");
  } else if (!scalar(v) || r.op === "in") throw new Error("规则比较值无效");
  if ([">", "<", ">=", "<="].includes(String(r.op)) && !(typeof v === "number" || v && typeof v === "object" && !Array.isArray(v))) throw new Error("数值比较需要数字或特征引用");
}

/** Compile the old quant shorthand into exactly the same rule tree as every other preset. */
export function compileFeatureSpec(side: "LONG" | "SHORT", spec: {
  topN?: number; minDayChange?: number; intervalWindow?: number; ampDivisor?: number;
  maRequirement?: string; macdRequirement?: string; candleRequirement?: string; rules?: FeatureCondition[];
}): FeatureRule {
  const rules: FeatureRule[] = [rule("rank", "<=", spec.topN ?? 10), rule("dayChange", ">=", spec.minDayChange ?? 10),
    rule(`surgeRatio.${spec.intervalWindow ?? 5}`, side === "SHORT" ? ">=" : "<=", 1 / (spec.ampDivisor ?? 8))];
  const ma = spec.maRequirement ?? "NONE";
  const match = /^MA(10|20|30|60)_(SUPPORT|RESIST|BREAKOUT|BREAKDOWN|CLOSE_BELOW|CLOSE_ABOVE)$/.exec(ma);
  if (match) rules.push(rule(`ma.${match[1]}.${match[2].toLowerCase()}`, "==", true));
  else if (ma === "MA_BULLISH_STACK" || ma === "MA_BEARISH_STACK") rules.push(rule("stack", "in", ma === "MA_BULLISH_STACK" ? ["bull_full", "bull_short"] : ["bear_full", "bear_short"]));
  else if (/^MA_(FRESH|SUSTAINED)_(BULL|BEAR)$/.test(ma)) rules.push(rule("stack3Bars", "==", ma.slice(3).toLowerCase()));
  else if (ma === "BIAS_RATIO_HIGH") rules.push(rule("relativeBias30", ">=", 0.2));
  else if (ma !== "NONE") rules.push(rule("invalid", "==", true));
  const macd = spec.macdRequirement ?? "NONE";
  const ratio = /^GREEN_RATIO_(15|20|30)_(50|70|80)$/.exec(macd);
  if (ratio) {
    rules.push(rule(`greenRatio.${ratio[1]}`, ">=", Number(ratio[2]) / 100));
    if (ratio[1] === "15") rules.push(rule("dif", ">=", ref("dea")));
  } else {
    const requirements: Record<string, FeatureRule> = {
      GREEN_STREAK_3: rule("greenStreak", ">=", 3), HIST_WEAKENING: any(rule("histSlope", "<", 0), rule("hist", "<=", 0)),
      HIST_EXPANDING: all(rule("histSlope", ">", 0), rule("hist", ">", 0)), DEATH_CROSS_RECENT: rule("deathCrossAgo", "<=", 3),
      GOLDEN_CROSS_RECENT: rule("goldenCrossAgo", "<=", 3), TOP_DIVERGENCE: rule("topDivergence", "==", true), BOTTOM_DIVERGENCE: rule("bottomDivergence", "==", true),
      TF5M_CONFIRM: any(rule("tf5m.macdHistSlope", side === "SHORT" ? "<" : ">", 0), rule("tf5m.macdHist", side === "SHORT" ? "<" : ">", 0)),
      DIF_HIGH_LEVEL: rule("difLevel", "==", "high"),
      DIF_LOW_LEVEL: rule("difLevel", "==", "low"),
      DIF_CROSS_ZERO_DOWN: rule("dif", "<", 0),
      DIF_CROSS_ZERO_UP: rule("dif", ">", 0),
    };
    if (macd !== "NONE") rules.push(requirements[macd] ?? rule("invalid", "==", true));
  }
  const candle = spec.candleRequirement ?? "NONE";
  if (candle === "UPPER_SHADOW_PINBAR") {
    rules.push(any(rule("upperRangeRatio", ">=", 0.35), rule("upperWick", ">=", 0.35), rule("upperShadowRatio", ">=", 1.2)));
  } else if (candle === "BEARISH_BAR") {
    rules.push(rule("price.close", "<", ref("price.open")));
  } else if (candle === "LOWER_SHADOW_HAMMER") {
    rules.push(any(rule("lowerWick", ">=", 0.3), rule("lowerWick", ">=", ref("body"))));
  } else if (candle === "BULLISH_BAR") {
    rules.push(rule("price.close", ">", ref("price.open")));
  } else if (candle !== "NONE") {
    rules.push(rule("invalid", "==", true));
  }
  if (spec.rules) rules.push(...spec.rules);
  return all(...rules);
}
