import type { KlineStatsStrategyLiveConfig } from "../../../src/types.ts";
import { INTERVAL_WINDOWS, MA_REQUIREMENTS, MACD_REQUIREMENTS, CANDLE_REQUIREMENTS } from "../../../src/strategy-spec.ts";

function requirementLabel(value: string): string {
  const labels: Record<string, string> = {
    NONE: "不限制", MA_BULLISH_STACK: "均线多头排列", MA_BEARISH_STACK: "均线空头排列",
    MA_FRESH_BULL: "刚形成多头", MA_FRESH_BEAR: "刚形成空头", MA_SUSTAINED_BULL: "持续多头", MA_SUSTAINED_BEAR: "持续空头",
    BIAS_RATIO_HIGH: "高乖离率", GREEN_STREAK_3: "连续 3 根绿柱", HIST_WEAKENING: "柱体衰减", HIST_EXPANDING: "柱体增强",
    DEATH_CROSS_RECENT: "最近 3 根内死叉", GOLDEN_CROSS_RECENT: "最近 3 根内金叉", TOP_DIVERGENCE: "顶背离",
    BOTTOM_DIVERGENCE: "底背离", TF5M_CONFIRM: "5 分钟动能确认",
    DIF_HIGH_LEVEL: "DIF 处于短周期高位", DIF_LOW_LEVEL: "DIF 处于短周期低位",
    DIF_CROSS_ZERO_DOWN: "DIF 下穿 0 轴", DIF_CROSS_ZERO_UP: "DIF 上穿 0 轴",
    UPPER_SHADOW_PINBAR: "长上影冲高回落 (Pinbar)", BEARISH_BAR: "阴线实体跌破",
    LOWER_SHADOW_HAMMER: "长下影探底企稳 (Hammer)", BULLISH_BAR: "阳线实体企稳",
  };
  if (labels[value]) return labels[value];
  if (value.startsWith("GREEN_RATIO_")) {
    const [, , window, ratio] = value.split("_");
    return `近 ${window} 根绿柱 ≥ ${ratio}%${window === "15" ? "，DIF ≥ DEA" : ""}`;
  }
  return value.replace("_SUPPORT", " 支撑").replace("_RESIST", " 压制").replace("_BREAKOUT", " 突破").replace("_BREAKDOWN", " 跌破").replace("_CLOSE_BELOW", " 收于下方").replace("_CLOSE_ABOVE", " 收于上方");
}

export function KlineStrategySettings({ title, value, onChange }: {
  title: string;
  value: Partial<KlineStatsStrategyLiveConfig>;
  onChange: (value: Partial<KlineStatsStrategyLiveConfig>) => void;
}) {
  const fields = [
    ["ampDivisor", "振幅分母 N", 0.1, 0.1], ["topN", "榜单前 N 名", 1, 1],
    ["minHighChange24h", "最低 24h 最高涨幅 (%)", 0, 0.1], ["maxHighChange24h", "最高 24h 最高涨幅 (%)", 0, 0.1],
    ["minDayChange", "最低 24h 涨幅 (%)", 0, 0.1], ["maxDayChange", "最高 24h 涨幅 (%)", 0, 0.1],
    ["holdMinutes", "最长持仓 (分钟)", 1, 1],
    ["tp1Percent", "第一阶段止盈 (%)", 0.01, 0.01], ["tp2Percent", "第二阶段止盈 (%)", 0.01, 0.01],
    ["stopLossPercent", "止损 (%)", 0.01, 0.01], ["cooldownMinutes", "冷却时间 (分钟)", 0, 1],
    ["leverage", "本策略杠杆", 1, 1],
  ] as const;
  return <fieldset className="kline-strategy-settings">
    <legend>{title}</legend>
    <div className="kline-strategy-fields">
      <label>观察窗口 x (分钟)
        <select value={value.intervalWindow ?? 5} onChange={e => onChange({ ...value, intervalWindow: Number(e.target.value) })}>
          {INTERVAL_WINDOWS.map(w => <option key={w} value={w}>{w}</option>)}
        </select>
      </label>
      {fields.map(([key, label, min, step]) => <label key={key}>{label}
        <input type="number" required min={min} step={step} value={value[key] ?? ""}
          onChange={e => onChange({ ...value, [key]: e.target.value === "" ? undefined : Number(e.target.value) })} />
      </label>)}
      <label>均线形态 (ovcl vs MA)
        <select value={value.maRequirement ?? "NONE"} onChange={e => onChange({ ...value, maRequirement: e.target.value as KlineStatsStrategyLiveConfig["maRequirement"] })}>
          {MA_REQUIREMENTS.map(v => <option key={v} value={v}>{requirementLabel(v)}</option>)}
        </select>
      </label>
      <label>MACD / DIF 周期形态
        <select value={value.macdRequirement ?? "NONE"} onChange={e => onChange({ ...value, macdRequirement: e.target.value as KlineStatsStrategyLiveConfig["macdRequirement"] })}>
          {MACD_REQUIREMENTS.map(v => <option key={v} value={v}>{requirementLabel(v)}</option>)}
        </select>
      </label>
      <label>微观 K 线形态
        <select value={value.candleRequirement ?? "NONE"} onChange={e => onChange({ ...value, candleRequirement: e.target.value as KlineStatsStrategyLiveConfig["candleRequirement"] })}>
          {CANDLE_REQUIREMENTS.map(v => <option key={v} value={v}>{requirementLabel(v)}</option>)}
        </select>
      </label>
    </div>
    <label><input type="checkbox" checked={value.moveSlToEntryAfterTp1 ?? true}
      onChange={e => onChange({ ...value, moveSlToEntryAfterTp1: e.target.checked })} /> 第一阶段平 50%，剩余仓位移动至成本保本价</label>
  </fieldset>;
}
