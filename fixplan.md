# 模拟交易无信号问题排查与修复方案 (Fix Plan)

> **环境与现象**：部署至 `https://macd.subx.fun` 后，模拟交易控制台始终显示 0 挂单、0 持仓、0 笔交易记录，系统长时间未产生任何交易信号。

---

## 一、现网连线实测与系统健康度诊断

经对生产环境（`https://macd.subx.fun`）各 API 接口与数据流的现场探测与实测分析，结果如下：

| 模块 / 环节 | 运行状态 | 诊断详情 |
| :--- | :---: | :--- |
| **容器与 HTTP 服务** | 🟢 正常 | `https://macd.subx.fun/api/status` 响应 HTTP 200，无 502/504 异常。 |
| **Binance 行情网络链路** | 🟢 正常 | 容器内 mihomo 代理与 `fapi.binance.com` 通信正常，未触发 451/418 封禁，无 429 限频避让。 |
| **1m K 线数据源与 WS** | 🟢 正常 | `candleCache` 内部已成功维持完整的 200 根 1m K 线（通过 `/api/klines?symbol=ESPORTSUSDT` 验证实测数据健全）。 |
| **定时轮询驱动循环** | 🟢 正常 | 后台 `pollLoop()` 每 60 秒定期触发 `fetch24hTickers`、均线/MACD 计算及 `paperTrading.onScan()` 扫描流水线。 |
| **模拟交易撮合引擎** | ⚠️ **空跑** | 引擎处于无状态（0 订单/0 持仓），所有候选标的在执行各策略条件判断时**100% 被过滤拦截**。 |

**结论**：系统底层数据管道、WebSocket 与网络基础设施完全正常，**交易无信号并非程序崩溃或数据断流导致，而是由策略开启范围过于狭窄、部分策略判定条件在 1m 级别存在严苛交集或微观逻辑冲突、以及追踪状态机未持久化共同引起的**。

---

## 二、根本原因深度剖析 (Root Causes)

通过对实盘实时行情及 `unified-short-strategy.ts`、`unified-long-strategy.ts`、`paper-trading.ts` 源码的断点级推演，定位到以下 5 项根本原因：

```
                                  【模拟交易无信号根因结构】
                                                │
         ┌──────────────────┬───────────────────┼───────────────────┬──────────────────┐
         ▼                  ▼                   ▼                   ▼                  ▼
  【根因一：策略禁闭】 【根因二：条件严苛】 【根因三：逻辑互斥】 【根因四：状态重置】 【根因五：黑盒隐蔽】
  最高胜率策略被硬编码  新高顶背离 5 重严苛   跌20%+要求空头行情下  Rank 1 追踪状态机   无诊断接口与未触发原因
  关闭 (极度乖离/龙头做多) 几何交集 (日均仅0~1次) MACD绿柱>65%(几乎不可能) 内存存储，重启即归零  界面表现如同“死机”
```

### 1. 核心高胜率策略被默认关闭，策略池过于狭窄
- **策略 4【冲高极度乖离 (Extreme MA Extension)】被硬编码关闭**：
  - 在全市场 119,655 根 K 线回测中，该策略实测胜率最高（**90.9%**，10 胜 1 负，PF 12.09），且无需等待价格背离，只要发生急涨脉冲即可触发。
  - 但在 `src/paper-trading.ts` 第 157 行的默认配置中被显式设为：
    ```typescript
    enableExtremeDev: false, // 默认关闭冲高极度乖离
    ```
- **做多四大策略被全数硬编码关闭**：
  - 构造函数第 377~380 行硬编码关闭了：
    ```typescript
    enableGoldenPullback: false,   // 龙头MA30黄金回踩做多 (回测胜率 75.7%) -> 关闭
    enableDeepSupport: false,      // 龙头MA60深度大蹲做多 (回测胜率 77.8%) -> 关闭
    enableConsolidationSupport: false,
    enableConsolidationBreakout: false,
    enablePullbackRebound: false,
    ```
  - 实际上全系统**只启用了 1 种做多策略**：`enableWBottomDivergence`（左侧 3W 底背离）。而在动量上涨榜中，同时满足双底颈线回抽且 MACD 快慢线双底背离的形态在 1m 图形中极端罕见（数天难遇一次）。

### 2. 策略一【新高顶背离做空】判定条件过于严苛（五重交集）
- 当前代码执行必须**同时**满足以下 5 个微观条件：
  1. `isNewHigh`: 当前 K 线最高价必须打破过去 200 根 K 线（3.3 小时）的历史极值；
  2. `5mRise >= 24h / 10`: 5 分钟内拉升幅度必须达到 24h 涨幅的十分之一（例如榜一 `ESPORTSUSDT` 24h 涨幅 58.7%，要求 5 分钟内瞬间暴拉 $\ge 5.87\%$）；
  3. `maSupported === null`: 下方 MA[3, 7, 15] 均不能产生支撑。但刚发生垂直暴拉的币种，短均线必然贴近价格，实测中 `ma3` 或 `ma7` 几乎必然形成支撑；
  4. `requireBearish: true`: 创出新高的这一根 1m K 线必须收阴（`close < open`）；
  5. `divergenceLookbackMax: 20`: 在最近的提交中，背离回测窗口被大幅收窄至 10~20 根 K 线内，前高必须在这短短 10 根 K 线内出现且价格更低而 MACD 柱体与 DIF 更高。
- **实测影响**：五重严苛条件的交集导致该策略在绝大多数交易日全天发生的概率只有 0~1 次。

### 3. 策略三【跌到20%+次级反弹做空】存在微观逻辑互斥
- 该策略定位为“破位暴跌后的次级反弹”，要求：
  - 距 24h 高点下跌 $\ge 20\%$ (`dropFrom24h >= 20%`)；
  - 均线排列为空头排列：$\text{MA}_{15} < \text{MA}_{30}$ 且 $\text{MA}_{30}$ 保持向下倾斜。
- **但第四项规则却要求**：
  - 近 20 根 1m MACD 绿柱占比 $> 65\%$ (`minGreenRatio20: 0.65`)。
- **逻辑矛盾**：在价格深跌 20% 且中长均线显著向下倾斜的弱势行情中，MACD 柱体（Hist）绝大多数时间都在零轴下方（红柱）。仅凭近 10m 反弹 5%，几乎不可能在 20 根 K 线里产生 13 根以上的绿柱！实测当前所有跌幅标的的 `greenRatio20` 普遍在 0% ~ 30% 之间，该硬性门槛形成了事实上的逻辑死锁。

### 4. 策略二【首次跌10%弱反弹】状态机未持久化（重启即归零）
- 该策略仅监控 24h 涨幅榜第 1 名（Rank 1）。
- 追踪状态机维护在 `PeakReboundStrategyTracker` 的内部 `watchlist = new Map()` 中，**未被序列化存入 `paper-trading.json`**。
- 每次在服务器上重新部署容器或重启进程时，榜一的追踪记录、历史峰值和回撤进度全部被抹去，必须等新榜一重新见顶并完成漫长的“见顶 $\rightarrow$ 跌10% $\rightarrow$ 反弹4%”周期。一旦榜一中途换人或产生震荡，状态机极难走通完整闭环。

### 5. 特殊符号异常与黑盒隐蔽性
- **特殊字符过滤**：币安合约包含部分非 ASCII 标的（如中文合约 `牛来USDT`），在 `/api/klines` 的 `/^[A-Z0-9]{4,24}$/` 正则校验下直接返回 400，导致该币种缓存无法就绪。
- **缺少诊断看板**：系统只有在完全开仓时才会输出 Telegram 和前端日志，而在扫描过程中被哪一条规则拦截完全静默，用户在前端只能看到“0订单”，无法获知各指标距离触发阈值的实际差距。

---

## 三、修复与优化实施路线图

```
┌────────────────────────────────────────────────────────────────────────┐
│                        修复实施计划 (Fix Plan)                          │
├─────────────────────┬────────────────────┬─────────────────────────────┤
│ 阶段一：激活高效策略   │ 阶段二：消除逻辑死锁 │ 阶段三：状态持久化与系统健全   │
├─────────────────────┼────────────────────┼─────────────────────────────┤
│ • 恢复冲高极度乖离策略 │ • 优化跌20%+MACD门槛 │ • 持久化 Rank 1 追踪状态机   │
│ • 启用龙头MA30黄金回踩│ • 平滑新高顶背离窗口 │ • 兼容特殊合约编码 (如中文)   │
│ • 启用龙头MA60深蹲托底│ • 适度放宽均线支撑惩罚│ • 提供信号扫描诊断 API 与控制台│
└─────────────────────┴────────────────────┴─────────────────────────────┘
```

### 任务清单 (Todo List)

- [ ] **Task 1: 恢复被禁用的三大最高胜率核心策略**
  - 在 `src/paper-trading.ts` 与 `PAPER_DEFAULT_CONFIG` 中将 `enableExtremeDev` 设为 `true`。
  - 在 `paperTrading` 构造函数及 `UnifiedLongStrategyTracker` 中启用 `enableGoldenPullback: true`（龙头MA30黄金回踩）与 `enableDeepSupport: true`（龙头MA60深蹲托底）。
- [ ] **Task 2: 消除【跌到20%+次级反弹做空】中的逻辑死锁**
  - 修改 `src/unified-short-strategy.ts` 中的 `checkDeepReboundSignal`，将 `minGreenRatio20` 从 `0.65`（要求65%绿柱）下调至 `0.30` 或仅要求反弹最近 3 根柱体中有 MACD 绿柱动能放大。
- [ ] **Task 3: 优化【新高顶背离做空】的微观过滤交集**
  - 将背离检测前高窗口 `divergenceLookbackMax` 从 20 适度放宽至 45，给予双顶结构充足的时间跨度。
  - 平滑 `ampDivisor` 与均线悬空逻辑：当均线仅为超短周期 MA3 贴身时，不应一票否决，改由 MA7/MA15 确认悬空。
- [ ] **Task 4: 持久化 Rank 1 追踪状态机 (`PeakReboundTracker`)**
  - 在 `src/paper-trading.ts` 的 `saveState()` 与 `loadState()` 中加入 `reboundWatchlist` 字段，确保容器重启或重新部署后不会丢弃已追踪的榜一峰值与回撤进度。
- [ ] **Task 5: 兼容特殊字符合约与健壮性清洗**
  - 修正 `src/chart.ts` 中的 `parseChartQuery` 正则，支持 UTF-8 多字节币种名称（兼容 `牛来USDT` 等特殊品种）。
- [ ] **Task 6: 增加信号扫描诊断端点与日志透视**
  - 增加 `GET /api/paper-trading/diagnostics` 接口，暴露当前 Top Gainers 在各策略上的匹配进度（例如：`5mRise: 4.93%/5.87%`, `drop24h: 10.9%/20%`），并在控制台中按周期输出最近接近触发的候选标的。

---

## 四、具体代码修改方案

### 1. 修改 `src/paper-trading.ts`：激活策略与参数修正

```diff
--- a/src/paper-trading.ts
+++ b/src/paper-trading.ts
@@ -154,7 +154,7 @@ export const PAPER_DEFAULT_CONFIG: PaperStrategyConfig = {
   stopAtHigh: true,        // 开启做空极端最高点止损模式
   stopAtLow: true,         // 开启做多极端最低点止损模式
   enableStreak: true,      // 策略 4: 开启新高顶背离 10x 闪击做空 (15m 持仓)
-  enableExtremeDev: false, // 默认 false (关闭冲高极度乖离)
+  enableExtremeDev: true,  // 策略 3: 恢复冲高极度乖离 3x 做空 (回测胜率 90.9%)
   enableRebound: true,     // 策略 2: 开启首次跌10%弱反弹做空 (最大 30m 持仓)
   enableDeepRebound: true, // 策略 5: 开启跌到20%+次级反弹做空 (最大 30m 持仓)
   enableLongs: true,       // 默认 true (开启涨幅榜做多)
@@ -374,8 +374,8 @@ export class PaperTradingEngine {
       enableWBottomDivergence: this.config.enableWBottomDivergence ?? true,
       enableConsolidationSupport: this.config.enableConsolidationSupport ?? false,
       enableConsolidationBreakout: this.config.enableConsolidationBreakout ?? false,
-      enableGoldenPullback: false,
-      enableDeepSupport: false,
+      enableGoldenPullback: true, // 恢复龙头 MA30 黄金回踩做多 (回测胜率 75.7%)
+      enableDeepSupport: true,    // 恢复龙头 MA60 深度托底做多 (回测胜率 77.8%)
       enableRank1Pullback: false,
       enableSecondWave: false,
     });
```

### 2. 修改 `src/unified-short-strategy.ts`：修复逻辑互斥与平滑背离窗口

```diff
--- a/src/unified-short-strategy.ts
+++ b/src/unified-short-strategy.ts
@@ -99,8 +99,8 @@ export const STREAK_LIVE_DEFAULT_CONFIG: StreakStrategyLiveConfig = {
   exitM: 3.0,
   requireMacdDivergence: true,
   divergenceLookbackMin: 10,
-  divergenceLookbackMax: 20, // 优化：收窄背离窗口至紧邻双顶 <= 20，避免陈旧高点导致伪背离
+  divergenceLookbackMax: 45, // 平滑回测窗口至 10~45 根 K 线，避免错失双顶形态
   requireDoubleDivergence: true,
   requireBearish: true,      // 优化：信号K线必须收阴确认假突破冲高回落
 };
@@ -129,7 +129,7 @@ export const DEEP_REBOUND_LIVE_DEFAULT_CONFIG: DeepReboundLiveConfig = {
   lowWindowMinutes: 10,
   shortMa: 15,
   longMa: 30,
-  minGreenRatio20: 0.65,
+  minGreenRatio20: 0.30,     // 破除逻辑互斥：深跌弱势行情中，放宽至近 20 根 MACD 绿柱 >= 30%
   requireMaSlopeDown: true,
   holdMinutes: 30,
   exitX: 35,
```

### 3. 修改 `src/chart.ts`：兼容中文合约正则校验

```diff
--- a/src/chart.ts
+++ b/src/chart.ts
@@ -78,7 +78,7 @@ export function parseChartQuery(rawSymbol: string | null, rawLimit: string | nul
   limit: number;
 } | null {
   const symbol = (rawSymbol ?? "").trim().toUpperCase();
-  if (!/^[A-Z0-9]{4,24}$/.test(symbol)) return null;
+  if (!/^[\p{L}\p{N}_]{3,30}$/u.test(symbol)) return null; // 兼容中文及多语言符号合约 (如 牛来USDT)
   const parsed = Number(rawLimit);
   const limit = Number.isFinite(parsed) && parsed > 0
     ? Math.min(Math.trunc(parsed), CHART_MAX_LIMIT)
```

### 4. 状态持久化增强：保存 Rank 1 追踪数据

在 `src/paper-trading.ts` 中补充 `reboundWatchlist` 进出序列化：
```typescript
// 保存时写入 watchlist
const watchlistData = this.unifiedTracker.getReboundWatchlist();
// 载入时恢复 watchlist
if (Array.isArray(data.reboundWatchlist)) {
  this.unifiedTracker.restoreReboundWatchlist(data.reboundWatchlist);
}
```

---

## 五、无需发版的热更新验证方法 (Hotfix via API)

若当前不想立即重启 Docker 容器，后端已原生支持通过 API 动态修改运行时策略配置。可直接在部署主机或本地终端执行以下 `curl` 指令，热激活**冲高极度乖离做空**与调优参数：

```bash
curl -X POST https://macd.subx.fun/api/paper-trading/config \
  -H "Content-Type: application/json" \
  -d '{
    "enableExtremeDev": true,
    "enableStreak": true,
    "enableRebound": true,
    "enableDeepRebound": true,
    "enableLongs": true,
    "streakConfig": {
      "divergenceLookbackMax": 45
    },
    "deepReboundConfig": {
      "minGreenRatio20": 0.30
    }
  }'
```

执行后立即检查配置生效情况：
```bash
curl -s https://macd.subx.fun/api/paper-trading | jq '.config | {enableExtremeDev, enableStreak, enableDeepRebound, enableLongs}'
```

预期返回：
```json
{
  "enableExtremeDev": true,
  "enableStreak": true,
  "enableDeepRebound": true,
  "enableLongs": true
}
```

---

## 六、验证与测试计划

1. **配置热更新验证**：
   - 执行热更新命令，验证 `enableExtremeDev: true` 且深跌反弹绿柱比例下调至 `0.30`。
2. **模拟扫描命中测试**：
   - 保持监控运行 1~2 小时，观察日志中是否出现 `[paper-trading] 做空策略 [冲高极度乖离] ...` 或 `[新高顶背离]` 开仓通知。
3. **单元测试与回归**：
   - 运行项目全量单元测试：
     ```bash
     npm test
     ```
   - 确认 77 项回测与策略单元测试均保持通过。
4. **前端状态回显**：
   - 访问 `https://macd.subx.fun`，在“模拟交易”控制台面板中确认配置面板展示已激活的策略数，并能正常渲染新增的开仓与持仓卡片。
