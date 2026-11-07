import type { StrategyDefinition } from "../../../src/strategy-definition.ts";
import { FEATURE_FIELDS, type FeatureRule, type FeatureCondition, type FeatureOperand } from "../../../src/strategy-rules.ts";

const labels: Record<string, string> = {
  rank: "涨幅榜排名", dayChange: "24h 涨幅 (%)", close: "收盘价", "price.open": "开盘价", "price.high": "最高价", "price.low": "最低价", "price.close": "收盘价", "price.previousHigh": "前根最高价",
  new24hHigh: "创 24h 新高", dropFrom24hHigh: "距 24h 高点回撤 (%)", body: "实体幅度 (%)", upperWick: "上影线幅度 (%)", lowerWick: "下影线幅度 (%)", upperShadowRatio: "上影线 / 实体", upperRangeRatio: "上影线 / 全振幅",
  surge: "窗口冲高 (%)", surgeRatio: "窗口冲高 / 24h 涨幅", drop: "窗口回撤 (%)", dropRatio: "窗口回撤 / 24h 涨幅", range: "窗口振幅 (%)", closeChange: "窗口收盘变化 (%)", dayChangeDelta: "24h 涨幅变化", posIn24hRange: "24h 区间位置",
  value: "数值", slope2: "两根斜率 (%)", slope3: "三根斜率 (%)", support: "支撑", resist: "压制", breakout: "突破", breakdown: "跌破", biasPct: "乖离 (%)", biasRatio: "相对乖离", emaValue: "EMA 数值",
  stack: "均线排列", stack3Bars: "三根均线形态", maStreak: "排列持续根数", aboveCount: "站上均线数量", relativeBias30: "MA30 相对乖离绝对值",
  dif: "DIF", dea: "DEA", hist: "MACD 柱体", difPct: "DIF / 价格 (%)", deaPct: "DEA / 价格 (%)", histSlope: "柱体变化", deaSlope: "DEA 变化", greenRatio: "窗口绿柱比例", greenStreak: "连续绿柱数", redStreak: "连续红柱数",
  goldenCrossAgo: "金叉距今根数", deathCrossAgo: "死叉距今根数", histPeakAgo: "柱峰距今根数", deaPeakAgo: "DEA 峰距今根数", topDivergence: "顶背离", bottomDivergence: "底背离",
  macdHist: "MACD 柱体", macdHistSlope: "MACD 柱体变化", closeVsMa20: "距 MA20 (%)", price: "价格", time: "时间", bounce: "颈线反弹 (%)", ratio: "当前低点 / 前低", ago: "距今根数", up: "连阳根数", count: "同向连续根数",
  "watch.ready": "观察阶段就绪", "watch.state": "峰谷观察阶段", "watch.pullback": "峰谷回撤 (%)", "watch.rebound": "谷底反弹 (%)", "watch.fib": "反弹 / 前段下跌", "watch.upCandles": "反弹阳线数", "watch.peakPrice": "观察峰值", "watch.troughPrice": "观察谷值",
};
function featureLabel(field: string): string {
  if (labels[field]) return labels[field];
  const [kind, a, b, c] = field.split(".");
  if (kind === "ma") return `MA${a} ${labels[b] ?? b}`;
  if (kind === "pivotHigh" || kind === "pivotLow") return `${kind === "pivotHigh" ? "前高" : "前低"}（${a}~${b} 根前）${labels[c] ?? c}`;
  if (kind === "deaPeak") return `DEA 峰（${a} 根）${labels[b] ?? b}`;
  if (kind === "streak") return `${a} 根前 ${labels[b] ?? b}`;
  if (kind === "tf5m" || kind === "tf15m") return `${kind.slice(2)} ${labels[a] ?? a}`;
  return `${labels[kind] ?? kind}（${a} 根）`;
}
const shape = (f: string) => f.replace(/\.\d+(?=\.|$)/g, ".N");
const templates = FEATURE_FIELDS.filter((f, i, fields) => fields.findIndex(g => shape(g) === shape(f)) === i);
function FeatureInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const parts = value.split(".");
  const template = templates.find(f => shape(f) === shape(value));
  return <div className="feature-choice">
    <select aria-label="监控特征" value={template ?? value} onChange={e => onChange(e.target.value)}>
      {!template && <option value={value}>{featureLabel(value)}</option>}
      {templates.map(f => <option key={f} value={f}>{featureLabel(shape(f) === shape(value) ? value : f)}</option>)}
    </select>
    {parts.map((p, i) => /^\d+$/.test(p) && <label key={i}>{value.startsWith("pivot") ? i === 1 ? "最近根数" : "最远根数" : value.startsWith("streak") ? "回看根数" : "周期"}
      <input aria-label={`${featureLabel(value)} 周期 ${i}`} type="number" required min={value.startsWith("streak") ? 0 : 1} max={500} step={1} value={p}
        onChange={e => onChange(parts.map((s, k) => k === i ? e.target.value : s).join("."))} /></label>)}
  </div>;
}
const defaultRule = (): FeatureCondition => ({ field: "dayChange", op: ">=", value: 10 });
function RuleEditor({ value, onChange }: { value: FeatureRule; onChange: (v: FeatureRule) => void }) {
  if ("all" in value || "any" in value) {
    const mode = "all" in value ? "all" : "any", children = "all" in value ? value.all : value.any;
    return <div className="feature-rule-group">
      <select aria-label="条件组合" value={mode} onChange={e => onChange(e.target.value === "all" ? { all: children } : { any: children })}>
        <option value="all">全部满足</option><option value="any">任一满足</option>
      </select>
      {children.map((child, i) => <div className="feature-rule-child" key={i}>
        <RuleEditor value={child} onChange={v => onChange({ [mode]: children.map((c, k) => k === i ? v : c) } as FeatureRule)} />
        <button type="button" aria-label="删除条件" disabled={children.length === 1} onClick={() => onChange({ [mode]: children.filter((_, k) => k !== i) } as FeatureRule)}>删除</button>
      </div>)}
      <button type="button" onClick={() => onChange({ [mode]: [...children, defaultRule()] } as FeatureRule)}>＋条件</button>{" "}
      <button type="button" onClick={() => onChange({ [mode]: [...children, { any: [defaultRule()] }] } as FeatureRule)}>＋条件组</button>
    </div>;
  }
  const operand = value.value;
  const mode = Array.isArray(operand) ? "list" : typeof operand === "object" ? "feature" : typeof operand;
  const patch = (p: Partial<FeatureCondition>) => onChange({ ...value, ...p });
  return <div className="feature-rule">
    <FeatureInput value={value.field} onChange={field => patch({ field })} />
    <select aria-label="比较关系" value={value.op} onChange={e => {
      const op = e.target.value as FeatureCondition["op"];
      patch({ op, ...(op === "in" ? { value: ["bull_full", "bull_short"] } : Array.isArray(operand) ? { value: 0 } : {}) });
    }}>
      {[">=", "<=", ">", "<", "==", "!=", "in", "contains"].map(op => <option key={op}>{op}</option>)}
    </select>
    <select aria-label="比较值类型" value={mode} onChange={e => {
      const values: Record<string, FeatureOperand> = { number: 0, boolean: true, string: "rebounded", list: ["bull_full", "bull_short"], feature: { field: "dayChange", scale: 1 } };
      patch({ value: values[e.target.value], ...(e.target.value === "list" ? { op: "in" } : value.op === "in" ? { op: "==" } : {}) });
    }}>
      <option value="number">数值</option><option value="boolean">是 / 否</option><option value="string">状态</option><option value="list">状态列表</option><option value="feature">另一个特征</option>
    </select>
    {typeof operand === "number" && <input aria-label="阈值" type="number" required step="any" value={operand} onChange={e => patch({ value: Number(e.target.value) })} />}
    {typeof operand === "boolean" && <select aria-label="是否满足" value={String(operand)} onChange={e => patch({ value: e.target.value === "true" })}><option value="true">是</option><option value="false">否</option></select>}
    {typeof operand === "string" && <input aria-label="状态值" value={operand} onChange={e => patch({ value: e.target.value })} />}
    {Array.isArray(operand) && <input aria-label="状态列表，逗号分隔" value={operand.join(",")} onChange={e => patch({ value: e.target.value.split(",").map(s => s.trim()) })} />}
    {operand && typeof operand === "object" && !Array.isArray(operand) && <>
      <FeatureInput value={operand.field} onChange={field => patch({ value: { ...operand, field } })} />
      <label>乘以<input aria-label="特征倍数" type="number" step="any" required value={operand.scale ?? 1} onChange={e => patch({ value: { ...operand, scale: Number(e.target.value) } })} /></label>
    </>}
  </div>;
}

export function StrategySettings({ value, onChange }: { value: StrategyDefinition[]; onChange: (v: StrategyDefinition[]) => void }) {
  const update = (i: number, s: StrategyDefinition) => onChange(value.map((old, j) => j === i ? s : old));
  return <div className="unified-strategy-settings">
    <p>所有策略共用特征监控与条件组合。比例使用小数（0.55 = 55%）；带 % 的特征使用百分数。排列状态：bull_full / bull_short / bear_full / bear_short；峰谷阶段：watching_peak / pulled_back / rebounded。</p>
    {value.map((s, i) => <details key={s.id} className="strategy-preset-card">
      <summary>{s.enabled ? "●" : "○"} {s.label} · {s.side === "LONG" ? "做多" : "做空"} · {s.exit.leverage ?? 3}x</summary>
      <div className="kline-strategy-fields">
        <label>名称<input required value={s.label} onChange={e => update(i, { ...s, label: e.target.value })} /></label>
        <label>方向<select value={s.side} disabled={s.factorManaged} onChange={e => update(i, { ...s, side: e.target.value as "LONG" | "SHORT" })}><option value="SHORT">做空</option><option value="LONG">做多</option></select></label>
        <label>连续 K 线至少<input type="number" required min={1} max={500} value={s.minBars} onChange={e => update(i, { ...s, minBars: Number(e.target.value) })} /></label>
      </div>
      <label><input type="checkbox" checked={s.enabled} onChange={e => update(i, { ...s, enabled: e.target.checked })} /> 启用策略</label>
      {s.factorManaged && <p>由自动挖掘更新。修改条件后，自动模式须重新通过验证才会开仓。</p>}
      <h4>特征条件</h4>
      <RuleEditor value={s.entry} onChange={entry => update(i, { ...s, entry })} />
      <h4>峰谷观察</h4>
      <label><input type="checkbox" checked={!!s.observation} onChange={e => update(i, { ...s, observation: e.target.checked ? { rank: 1, watchWindowHours: 48, pullbackPercent: 10, reboundPercent: 4, historyBars: 120 } : undefined })} /> 跟踪曾达到指定排名的标的</label>
      {s.observation && <div className="kline-strategy-fields">{([
        ["rank", "触发排名"], ["watchWindowHours", "观察有效期（小时）"], ["pullbackPercent", "回撤门槛 (%)"], ["reboundPercent", "反弹门槛 (%)"], ["historyBars", "初始峰谷回看根数"],
      ] as const).map(([key, label]) => <label key={key}>{label}<input type="number" required min={0.001} step="any" value={s.observation![key]} onChange={e => update(i, { ...s, observation: { ...s.observation!, [key]: Number(e.target.value) } })} /></label>)}</div>}
      <h4>退出与冷却</h4>
      <label>目标计算<select value={s.exit.tp1Percent === undefined ? "dynamic" : "fixed"} onChange={e => update(i, { ...s, exit: e.target.value === "fixed"
        ? { ...s.exit, tp1Percent: 3, tp2Percent: 6, stopLossPercent: 5 }
        : { holdMinutes: s.exit.holdMinutes, leverage: s.exit.leverage, moveSlToEntryAfterTp1: s.exit.moveSlToEntryAfterTp1, exitX: 35, exitN: 2, exitM: 3 } })}>
        <option value="fixed">固定百分比</option><option value="dynamic">24h 涨幅 / 分母</option>
      </select></label>
      <div className="kline-strategy-fields">
        {([ ["holdMinutes", "最长持仓（分钟）"], ["leverage", "杠杆"], ...(s.exit.tp1Percent === undefined
          ? [["exitX", "TP1 / SL1 分母"], ["exitM", "TP2 倍数"], ["exitN", "SL2 倍数"]]
          : [["tp1Percent", "TP1 (%)"], ["tp2Percent", "TP2 (%)"], ["stopLossPercent", "止损 (%)"]]) ] as Array<[keyof StrategyDefinition["exit"], string]>).map(([key, label]) => <label key={key}>{label}
          <input type="number" required min={0.001} step="any" value={Number(s.exit[key] ?? 3)} onChange={e => update(i, { ...s, exit: { ...s.exit, [key]: Number(e.target.value) } })} /></label>)}
        <label>冷却（分钟）<input type="number" required min={0} step="any" value={s.cooldownMinutes} onChange={e => update(i, { ...s, cooldownMinutes: Number(e.target.value) })} /></label>
        <label>冷却起点<select value={s.cooldownFrom ?? "entry"} onChange={e => update(i, { ...s, cooldownFrom: e.target.value as "entry" | "exit" })}><option value="entry">入场时</option><option value="exit">平仓时</option></select></label>
      </div>
      <label><input type="checkbox" checked={s.exit.moveSlToEntryAfterTp1 ?? true} onChange={e => update(i, { ...s, exit: { ...s.exit, moveSlToEntryAfterTp1: e.target.checked } })} /> TP1 平 50%，剩余仓位移到成本保本价</label>
      <div className="strategy-card-actions">
        <button type="button" disabled={value.length >= 50} onClick={() => onChange([...value, { ...structuredClone(s), id: `custom_${Date.now().toString(36)}`, label: `${s.label} · 自定义`, enabled: false, factorManaged: false, cooldownGroup: undefined }])}>复制为新组合</button>
        <button type="button" onClick={() => onChange(value.filter((_, j) => i !== j))}>移除策略</button>
      </div>
    </details>)}
    <button type="button" disabled={value.length >= 50} onClick={() => onChange([...value, { id: `custom_${Date.now().toString(36)}`, label: "自定义特征组合", side: "SHORT", enabled: false,
      minBars: 60, entry: { all: [defaultRule()] }, exit: { holdMinutes: 30, leverage: 3, tp1Percent: 3, tp2Percent: 6, stopLossPercent: 5, moveSlToEntryAfterTp1: true }, cooldownMinutes: 20 }])}>＋新增特征组合</button>
  </div>;
}
