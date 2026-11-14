import type { StrategyDefinition } from "../../../src/strategy-definition.ts";

export function StrategySettings({
  value,
  onChange,
  strategyFaults = [],
  onResetFault,
}: {
  value: StrategyDefinition[];
  onChange: (v: StrategyDefinition[]) => void;
  strategyFaults?: import("../../../src/types.ts").StrategyFault[];
  onResetFault?: (strategyId: string) => void;
}) {
  const update = (i: number, s: StrategyDefinition) => onChange(value.map((old, j) => (j === i ? s : old)));

  return (
    <div className="unified-strategy-settings">
      <div style={{ fontSize: "12px", fontWeight: "bold", color: "var(--text)", marginBottom: "8px" }}>
        🎯 交易策略启用开关
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {value.map((s, i) => {
          const fault = strategyFaults.find((f) => f.strategyId === s.id);
          return (
            <div
              key={s.id}
              className={`strategy-preset-card ${fault ? "strategy-card-faulted" : ""}`}
              style={{ margin: 0, padding: "10px 14px" }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "13px", fontWeight: 600, userSelect: "none" }}>
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    onChange={(e) => update(i, { ...s, enabled: e.target.checked })}
                  />
                  <span>启用策略</span>
                  <span style={{ color: "var(--text-muted, #94a3b8)", fontWeight: 400 }}>·</span>
                  <span>{s.label}</span>
                  <span
                    style={{
                      fontSize: "11px",
                      padding: "1px 6px",
                      borderRadius: "3px",
                      background: s.side === "LONG" ? "rgba(46, 204, 113, 0.15)" : "rgba(231, 76, 60, 0.15)",
                      color: s.side === "LONG" ? "#2ecc71" : "#e74c3c",
                      fontWeight: 500,
                    }}
                  >
                    {s.side === "LONG" ? "做多" : "做空"}
                  </span>
                  <span style={{ fontSize: "11px", color: "var(--text-muted, #94a3b8)", fontWeight: 400 }}>
                    {typeof (s as any).winRate === "number" && (s as any).winRate > 0 ? `胜率 ${((s as any).winRate).toFixed(1)}% · ` : ""}{s.exit.leverage ?? 3}x
                  </span>
                </label>
                {fault && (
                  <span className="strategy-fault-pill" title={`表现不佳暂停: ${fault.reason}`}>
                    ⚠️ 已暂停 (冷却/需重挖)
                  </span>
                )}
              </div>
              {fault && (
                <div className="strategy-fault-inline-banner" style={{ marginTop: "8px" }}>
                  <div>
                    <b>⏸️ 策略已暂停交易</b>：{fault.reason}
                    {fault.nextMineAt && (
                      <span> (下次挖掘重试: {new Date(fault.nextMineAt).toLocaleTimeString("zh-CN", { hour12: false })})</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn-reset-fault-mini"
                    onClick={() => onResetFault?.(s.id)}
                    title="已部署新版本？点击重置该策略的暂停状态并恢复正常开仓"
                  >
                    🔄 重置暂停状态
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
