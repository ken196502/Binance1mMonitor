import { useEffect, useState } from "react";
import type { LiveTradingSummary } from "../../../src/live-trading-types.ts";

const labels = {
  disabled: "未启用",
  starting: "检查中",
  ready: "等待新信号",
  paused: "已暂停开仓",
  halted: "已熔断开仓",
};

export interface LiveTradingPanelProps {
  isOpen: boolean;
  onClose: () => void;
  state: LiveTradingSummary | null;
  connected?: boolean;
  onStateChange?: (next: LiveTradingSummary) => void;
}

export function LiveTradingPanel({
  isOpen,
  onClose,
  state,
  connected = true,
  onStateChange,
}: LiveTradingPanelProps) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // ESC 键关闭弹窗
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const control = async (action: "pause" | "resume" | "close") => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/live-trading/${action}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(60000),
      });
      const data = await res.json();
      if (data.summary && onStateChange) onStateChange(data.summary);
      if (!res.ok) throw new Error(data.error ?? data.summary?.reason ?? "操作未确认，请查看持仓状态");
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作未确认，请查看持仓状态");
    } finally {
      setBusy(false);
    }
  };

  const trade = state?.activeTrade;

  let badgeText = "加载中";
  if (state) {
    badgeText = labels[state.status] || state.status;
    if (!connected && state.enabled) {
      badgeText += " (连接断开)";
    }
  } else if (!connected) {
    badgeText = "未连接";
  }

  return (
    <div className="live-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="实盘交易设置与状态">
      <div className="live-modal-content live-panel" onClick={(e) => e.stopPropagation()}>
        <div className="live-modal-header">
          <div>
            <h2>
              实盘小额测试{" "}
              <span className={`live-badge ${state?.status === "halted" ? "live-danger" : ""}`}>
                {badgeText}
              </span>
            </h2>
            <span className="live-muted">
              {state?.testnet ? "Binance 测试网" : "Binance USDT 合约"} · 逐仓 · ≤10 分钟 5× / 其余 3× · 最多 1 仓
            </span>
          </div>
          <button className="live-modal-close" onClick={onClose} aria-label="关闭弹窗" title="关闭 (Esc)">
            ✕
          </button>
        </div>

        <div className="live-metrics">
          <span>总资金上限 <strong>{state?.budgetUsdt ?? 10} USDT</strong></span>
          <span>每笔保证金 <strong>{state?.marginPercent ?? 20}% ≈ {(state?.nextMarginUsdt ?? 2).toFixed(2)} USDT</strong></span>
          <span>名义金额 <strong>≈ {(state?.nextNotionalUsdt ?? 6).toFixed(2)}–{(state?.nextMaxNotionalUsdt ?? 10).toFixed(2)} USDT</strong></span>
          <span>最近开仓检查余额 <strong>{state?.walletUsdt?.toFixed(2) ?? "—"} USDT</strong></span>
          <span>凭证 <strong>{state?.configured ? "已配置" : "待配置 .env"}</strong></span>
        </div>

        {state?.reason && <p className="live-danger" role="status">{state.reason}</p>}

        {!state?.enabled ? (
          <div className="live-guide-card">
            <h4>📖 如何开启实盘交易？</h4>
            <div className="live-guide-steps">
              <p>1. 在项目根目录下打开或创建 <code>.env</code> 文件（可参考 <code>.env.example</code>）：</p>
              <pre>{`BINANCE_API_KEY=你的BinanceApiKey
BINANCE_API_SECRET=你的BinanceApiSecret`}</pre>
              <p>2. 设置 32 位以上随机控制口令（用于在本弹窗暂停开仓或平仓鉴权）：</p>
              <pre>{`LIVE_CONTROL_TOKEN=你的32位随机安全控制口令`}</pre>
              <p>3. 开启实盘总开关（支持测试网与实盘合约）：</p>
              <pre>{`LIVE_TRADING_ENABLED=true
# 若使用币安合约测试网，请同时设置:
# LIVE_TRADING_TESTNET=true`}</pre>
              <p>4. 重启监控后端服务（<code>npm start</code>），顶部标题栏将自动切换为【🔥 实盘交易】并等待新信号。</p>
              <div className="live-guide-tip">
                💡 <strong>安全机制：</strong>实盘交易严格限制单笔本金（默认上限 10 USDT），仅跟随新开仓信号；与模拟盘独立记账，不影响历史模拟统计。
              </div>
            </div>
          </div>
        ) : (
          <div className="live-guide-enabled">
            ✅ <strong>实盘交易已激活：</strong>正在跟随策略信号执行真实撮合（{state.testnet ? "币安测试网" : "币安合约实盘"}）。
          </div>
        )}

        <div className="live-position-section" style={{ marginTop: "14px" }}>
          <div style={{ fontSize: "13px", fontWeight: "bold", marginBottom: "6px" }}>当前实盘持仓</div>
          {trade ? (
            <div className="live-position">
              <strong>{trade.symbol} · {trade.side === "LONG" ? "做多" : "做空"} · {trade.leverage}×</strong>
              <span>{trade.status === "ENTERING" ? "开仓对账中" : trade.pendingClose ? "平仓对账中" : "持仓中"} · {trade.strategy}</span>
              <span>成交均价 {trade.entryPrice || "待确认"} · 剩余数量 {trade.remainingQuantity}</span>
              <span>开仓名义金额 {(trade.initialQuantity * trade.entryPrice).toFixed(2)} USDT · 保证金约 {(trade.initialQuantity * trade.entryPrice / trade.leverage).toFixed(2)} USDT</span>
              <span>止损触发价 {trade.stopPrice || "待确认"} · 到期 {new Date(trade.timeoutAt).toLocaleTimeString()}</span>
            </div>
          ) : (
            <p className="live-muted" style={{ margin: "4px 0 10px" }}>
              当前无本程序实盘持仓。模拟账户和实盘账户分别独立记录。
            </p>
          )}
        </div>

        {(state?.enabled || trade) && (
          <div className="live-controls">
            <input
              type="password"
              aria-label="实盘控制口令"
              placeholder="LIVE_CONTROL_TOKEN（仅保留在本页内存）"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <button disabled={busy || token.length < 32} onClick={() => void control("pause")}>
              暂停开仓
            </button>
            <button
              disabled={busy || token.length < 32 || !state?.enabled || !!trade}
              onClick={() => void control("resume")}
            >
              检查并恢复
            </button>
            <button
              className="live-close"
              disabled={busy || token.length < 32 || !trade}
              onClick={() => void control("close")}
            >
              暂停并平仓
            </button>
          </div>
        )}

        {error && <p className="live-danger" role="alert" style={{ marginTop: "10px" }}>{error}</p>}

        {state && state.recentTrades.length > 0 && (
          <details className="live-history" style={{ marginTop: "14px" }}>
            <summary>最近实盘记录（{state.recentTrades.length}）</summary>
            {state.recentTrades.map((t) => (
              <div key={t.id}>
                <strong>{t.symbol} {t.side === "LONG" ? "多" : "空"}</strong> · 成交 {t.initialQuantity} @ {t.entryPrice || "未成交"} · {t.exits.map((e) => `${e.reason}: ${e.quantity} @ ${e.price}`).join(" / ") || "交易所结清或未成交"}
              </div>
            ))}
          </details>
        )}
      </div>
    </div>
  );
}
