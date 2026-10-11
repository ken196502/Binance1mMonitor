# PLAN: 三榜单 DEA 高位 + DIFF 多头告警 → Telegram

## 需求说明

> "當三个榜单任意一个出现3个或以上DEA高位和DIFF多头时，发出通知，记住最近一次通知的状态， 只有数量变化的时候才再次通知，不要每次检测都发"

### 规则拆解

1. **判定条件**：
   - **DEA 高位**：`row.high === true`（DEA ≥ HIGH_RATIO × 窗口峰值 且 DEA > 0）
   - **DIFF 多头**：`row.bullish === true`（DIF ≥ DEA）
2. **触发范围**：
   - 24h 涨幅榜、跌幅榜、成交额榜三个榜单中，**任意一个榜单**匹配币种数 ≥ `TG_ALERT_MIN` (默认 3)。
3. **状态记忆与去重**：
   - 记录上一次通知时各榜单的数量：`{ gainers: number, losers: number, volume: number }`。
   - **只有当数量发生变化时才再次通知**，若各榜单数量与上次通知一致，则不再重复发送。
   - 当所有榜单均回落到阈值以下时，状态重置为未触发，并发送解除通知（可通过 `TG_SEND_RECOVERY=false` 关闭）。下次再次达到 ≥3 时可再次触发。
4. **后台常驻监测**：
   - 服务端启动即运行后台定时轮询（`pollLoop`，默认 20s），无需前端浏览器常开。

## 模块清单

1. **`src/telegram.ts`**：
   - `sendTelegramMessage(text)`：POST Telegram Bot API 发送 HTML 格式消息，支持代理环境。
   - `telegramConfigured()`：检查是否已配置 Token 与 Chat ID。
2. **`src/alert.ts`**：
   - `pickHighBull(rows)`：提取满足条件的币种列表。
   - `TelegramAlerter`：状态机管理，记录上一次通知各榜单数量，数量变动比对与重试机制。
3. **`src/types.ts`**：
   - 定义 `BoardAlertInfo`, `HighBullSummary` 等共享类型。
4. **`src/server.ts`**：
   - 每次 snapshot refresh 调用 `alerter.check()`。
   - 启动后台定时轮询任务 `pollLoop`。
5. **`scripts/test-alert.ts`**：
   - 端到端单元测试：模拟 Telegram HTTP 服务，验证触发、数量变化、防重复、恢复、失败重试等各场景。
