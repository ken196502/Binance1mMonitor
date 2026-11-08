import { useEffect, useState } from "react";
import type { LiveTradingSummary } from "../../../src/live-trading-types.ts";

const labels = { disabled: "未启用", starting: "检查中", ready: "等待新信号", paused: "已暂停开仓", halted: "已熔断开仓" };

export function LiveTradingPanel() {
  const [state, setState] = useState<LiveTradingSummary | null>(null);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const res = await fetch("/api/live-trading", { cache: "no-store", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const next = await res.json() as LiveTradingSummary;
        if (active) { setState(next); setError(""); }
      } catch { if (active) setError("实盘状态连接失败，请勿将旧状态视为实时持仓"); }
      finally { if (active) timer = setTimeout(poll, 3000); }
    };
    void poll();
    return () => { active = false; abort.abort(); clearTimeout(timer); };
  }, []);
  const control = async (action: "pause" | "resume" | "close") => {
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/live-trading/${action}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) });
      const data = await res.json();
      if (data.summary) setState(data.summary);
      if (!res.ok) throw new Error(data.error ?? data.summary?.reason ?? "操作未确认，请查看持仓状态");
    } catch (e) { setError(e instanceof Error ? e.message : "操作未确认，请查看持仓状态"); }
    finally { setBusy(false); }
  };
  const trade = state?.activeTrade;
  return <section className="live-panel" aria-label="实盘小额测试">
    <div className="live-heading">
      <h2>实盘小额测试 <span className={`live-badge ${state?.status === "halted" ? "live-danger" : ""}`}>{state ? labels[state.status] : "加载中"}</span></h2>
      <span className="live-muted">{state?.testnet ? "Binance 测试网" : "Binance USDT 合约"} · 逐仓 1× · 最多 1 仓</span>
    </div>
    <div className="live-metrics">
      <span>总资金上限 <strong>{state?.budgetUsdt ?? 10} USDT</strong></span>
      <span>单笔额度 <strong>{state?.orderUsdt ?? 10} USDT</strong></span>
      <span>最近开仓检查余额 <strong>{state?.walletUsdt?.toFixed(2) ?? "—"} USDT</strong></span>
      <span>凭证 <strong>{state?.configured ? "已配置" : "待配置 .env"}</strong></span>
    </div>
    {state?.reason && <p className="live-danger" role="status">{state.reason}</p>}
    {!state?.enabled && <p className="live-muted">填写 .env 中的 API key、secret 和控制口令，再设置 LIVE_TRADING_ENABLED=true 并重启。启用后仅跟随新开仓信号。</p>}
    {trade ? <div className="live-position">
      <strong>{trade.symbol} · {trade.side === "LONG" ? "做多" : "做空"}</strong>
      <span>{trade.status === "ENTERING" ? "开仓对账中" : trade.pendingClose ? "平仓对账中" : "持仓中"} · {trade.strategy}</span>
      <span>成交均价 {trade.entryPrice || "待确认"} · 剩余数量 {trade.remainingQuantity}</span>
      <span>止损触发价 {trade.stopPrice || "待确认"} · 到期 {new Date(trade.timeoutAt).toLocaleTimeString()}</span>
    </div> : <p className="live-muted">当前无本程序实盘持仓。模拟账户和实盘账户分别记录。</p>}
    {(state?.enabled || trade) && <div className="live-controls">
      <input type="password" aria-label="实盘控制口令" placeholder="LIVE_CONTROL_TOKEN（仅保留在本页内存）" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} />
      <button disabled={busy || token.length < 32} onClick={() => void control("pause")}>暂停开仓</button>
      <button disabled={busy || token.length < 32 || !state?.enabled || !!trade} onClick={() => void control("resume")}>检查并恢复</button>
      <button className="live-close" disabled={busy || token.length < 32 || !trade} onClick={() => void control("close")}>暂停并平仓</button>
    </div>}
    {error && <p className="live-danger" role="alert">{error}</p>}
    {state && state.recentTrades.length > 0 && <details className="live-history"><summary>最近实盘记录（{state.recentTrades.length}）</summary>
      {state.recentTrades.map(t => <div key={t.id}><strong>{t.symbol} {t.side === "LONG" ? "多" : "空"}</strong> · 成交 {t.initialQuantity} @ {t.entryPrice || "未成交"} · {t.exits.map(e => `${e.reason}: ${e.quantity} @ ${e.price}`).join(" / ") || "交易所结清或未成交"}</div>)}
    </details>}
  </section>;
}
