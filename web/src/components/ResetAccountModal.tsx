import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export interface ResetAccountModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function ResetAccountModal({ isOpen, onClose, onSuccess }: ResetAccountModalProps) {
  const [password, setPassword] = useState("Abcd#123456");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 每次打开弹窗时重置状态
  useEffect(() => {
    if (isOpen) {
      setPassword("Abcd#123456");
      setError(null);
      setLoading(false);
    }
  }, [isOpen]);

  // ESC 键快捷关闭
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, loading, onClose]);

  if (!isOpen) return null;

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!password.trim()) {
      setError("请输入重置密码");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/paper-trading/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: password.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `重置失败 (HTTP ${res.status})`);
      }
      onClose();
      if (onSuccess) {
        onSuccess();
      } else {
        window.location.reload();
      }
    } catch (err: any) {
      setError(err?.message || "重置请求异常，请检查网络或后端状态");
    } finally {
      setLoading(false);
    }
  };

  const modalContent = (
    <div className="reset-modal-backdrop" onClick={() => !loading && onClose()}>
      <div className="reset-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="reset-modal-header">
          <h3>
            <span>🔄</span>
            <span>重置模拟账户</span>
          </h3>
          <button
            type="button"
            className="reset-modal-close"
            onClick={onClose}
            disabled={loading}
            title="关闭"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="reset-modal-warning">
            <span className="reset-warning-icon">⚠️</span>
            <div className="reset-warning-text">
              <strong>高风险操作提示：</strong>
              <p>
                此操作将立即清空当前所有<b>活跃持仓</b>、<b>限价挂单</b>与<b>24h 历史平仓明细</b>，账户余额将恢复为初始 <b>100 USDT</b>。此操作无法撤销！
              </p>
            </div>
          </div>

          <div className="config-form-group" style={{ marginTop: "16px" }}>
            <label htmlFor="reset-account-pwd">
              <span>操作密码验证</span>
              <small>默认密码: Abcd#123456</small>
            </label>
            <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
              <input
                id="reset-account-pwd"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入重置密码 (默认: Abcd#123456)"
                autoFocus
                disabled={loading}
                style={{ paddingRight: "42px" }}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                style={{
                  position: "absolute",
                  right: "8px",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  fontSize: "14px",
                  color: "var(--muted, #888)",
                  padding: "4px",
                }}
                title={showPassword ? "隐藏密码" : "显示密码"}
              >
                {showPassword ? "🙈" : "👁️"}
              </button>
            </div>
            <div
              style={{
                marginTop: "6px",
                fontSize: "11px",
                color: "var(--muted, #888)",
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <span>
                系统默认密码：<code>Abcd#123456</code>
              </span>
              <button
                type="button"
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "#3498db",
                  fontSize: "11px",
                  padding: 0,
                  textDecoration: "underline",
                }}
                onClick={() => setPassword("Abcd#123456")}
              >
                填入默认密码
              </button>
            </div>
          </div>

          {error && (
            <div className="reset-modal-error">
              ❌ {error}
            </div>
          )}

          <div className="config-modal-actions" style={{ marginTop: "20px" }}>
            <button
              type="button"
              className="btn-preset-reset"
              onClick={onClose}
              disabled={loading}
            >
              取消
            </button>
            <button
              type="submit"
              className="btn-reset-paper"
              style={{
                padding: "8px 18px",
                fontSize: "13px",
                fontWeight: 600,
                cursor: loading ? "not-allowed" : "pointer",
              }}
              disabled={loading}
            >
              {loading ? "正在重置账户…" : "⚠️ 确认重置账户"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(modalContent, document.body) : modalContent;
}
