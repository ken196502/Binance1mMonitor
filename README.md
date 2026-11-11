# Binance 1m 行情监控与形态研究

核心流程：行情监控 → x 分钟内达标振幅的前置特征统计 → 多空形态参数挖掘 → 二阶段回测与模拟交易，配合 Telegram 播报和 mihomo 自动切换线路。

设计目标是**超短挖掘、短期验证、持续替换**：从共享特征及参数组合衍生策略，只要求组合在近期行情中通过检验，不要求单个因子长期有效。后台持续监控、滚动挖掘新组合；因子失效或到期就停止该方向量化新入场，等待新的合格结果。策略名称是预设名称，真正执行的是统一特征条件与退出参数。

## 运行口径

- 监控 Binance USDT 永续合约涨幅榜，保留置顶和追踪标的；每分钟对齐扫描，WebSocket 驱动实时价格与模拟平仓。
- `24h/N` 沿用现有 **24h 涨跌幅的绝对值 / N**。它不是 24h 最高价与最低价之间的振幅。默认策略标的仍筛选正涨幅榜。
- 研究样本以之后 x 分钟相对起始开盘价的上涨/下跌幅度判定是否达标；形态特征只取事件开始前的已收盘 K 线。未来价格只用于事件标签和回测退出。
- 图表展示按 x 分钟时间桶提取的最大有序冲高/回撤段，以及该段启动前的特征；缺少前置数据时不伪造前置特征。
- 特征最多使用 500 根连续已收盘 K 线；基础特征向量至少需要 60 根，各策略通过 `minBars` 保留自身预热要求。遇到缺口重新预热，形成中 K 线不参与特征判定。默认行情缓存为 500 根已收盘加 1 根形成中 K 线。
- 所有在用策略统一为“特征监控 + 条件组合 + 退出参数”，共用 `StrategyEngine`。现有策略是参数预设；旧策略类仅保留为调用兼容层。

## 统一策略框架

行情 → `StrategyFeatureMonitor`（每币每根共享缓存）→ `StrategyDefinition.entry`（特征规则树）→ `StrategyEngine`（观察、判定、执行确认）→ 模拟交易 / 共用回测。

| 预设 ID | 特征组合 |
| --- | --- |
| `streak` | 24h 新高 + x 分钟冲高 / 当日涨幅 + 无 MA 支撑 + DEA 回落或双峰背离 + K 线确认 |
| `rebound` | 曾达指定排名 + 峰谷回撤、反弹状态 + 均线压制 / 排列 / 斜率 + MACD 比例 |
| `deep_rebound` | 距 24h 高点回撤 + 窗口反弹 + 短长均线压制 + MACD 比例 |
| `hourly_suppression` | 冲高 + 深回撤 + 穿过 MA60 + 均线排列 + 连续绿柱 |
| `w_bottom_divergence` | 近期回撤 + 前低与颈线反弹 + 双底容差 + DIF/柱体背离 + 阳线突破 |
| `kline_stats_short` | 冲高比例下限 + 可选均线、MACD、附加特征条件 |
| `kline_stats_long` | 蓄势振幅上限 + 可选均线、MACD、附加特征条件 |

`src/strategy-presets.ts` 只负责将旧参数编译为这些规则，无独立策略判定分支。历史研究脚本保留其实验口径；新增策略与组合回放使用 `src/strategy-replay.ts`，可直接传入完整 `StrategyDefinition[]`。

- `all` / `any` 可嵌套；条件支持 `>=`、`<=`、`>`、`<`、`==`、`!=`、`in`、`contains`，右侧可引用另一个特征并乘以系数。
- 参数化特征例子：`surge.5`（5 根冲高百分数）、`ma.15.slope2`、`pivotLow.8.25.dif`、`deaPeak.30.ago`。绿柱比例使用 0~1；百分比特征使用百分数。
- 峰谷观察使用时间戳，窗口滚动后仍能正确统计。观察名单在跌出榜单后继续监控到期；扫描传入真实榜单排名。
- 策略按列表顺序匹配，组合按输入榜单顺序分配仓位。达到某策略仓位上限后仍可匹配后续策略。只有成功开仓或接受挂单才消耗信号；同根去重、冷却和观察状态可持久化恢复。
- `GET /api/paper-trading` 返回 `strategyMonitor`，列出最近扫描各币种/策略的匹配或未满足原因，面板中可查看。触发快照保存所用策略及特征值。

配置 API 的 `strategies` 是**完整列表替换**：先 GET 现有列表，编辑或追加后再提交。数组可为空（关闭全部策略），最多 50 个；ID 必须唯一。旧 `*Config`、策略开关和杠杆字段继续兼容，在边界编译成相同结构；同时提交时 `strategies` 优先。旧配置首次加载自动生成预设，已开仓的退出参数不变。修改旧形态参数会重新编译对应预设；只改开关或杠杆不会重置自定义条件。

一个完整策略定义示例（可追加至读取的 `strategies` 列表）：

```json
{
  "id": "custom_rebound_short",
  "label": "深回撤反弹压制",
  "side": "SHORT",
  "enabled": false,
  "minBars": 60,
  "entry": { "all": [
    { "field": "rank", "op": "<=", "value": 10 },
    { "field": "dayChange", "op": ">=", "value": 10 },
    { "field": "dropFrom24hHigh", "op": ">=", "value": 20 },
    { "field": "surge.10", "op": ">=", "value": 5 },
    { "field": "price.close", "op": "<", "value": { "field": "ma.15.value" } },
    { "field": "ma.15.value", "op": "<", "value": { "field": "price.high" } }
  ] },
  "exit": { "holdMinutes": 30, "tp1Percent": 3.5, "tp2Percent": 8, "stopLossPercent": 7, "leverage": 3, "moveSlToEntryAfterTp1": true },
  "cooldownMinutes": 30,
  "cooldownFrom": "entry"
}
```

量化预设保留因子验证标记：手动修改规则或退出参数不能复用旧因子审批。自动挖掘仍只更新两个量化预设，保留各自开关；自定义组合按手动配置运行。3.0.0 统一了规则、500 根预热、反弹信号收盘时间与组合优先级，并修正旧规则中 `in` / `contains` 未执行的问题，旧回测统计须重新生成。

## 仓位、退出与统计

默认每笔分配当前净权益的 **20%**，全局最多 **5** 个持仓/挂单，每策略最多 **1** 个；远程参数可以降低仓位与总仓数，不能超过这些上限。已有仓位延续原参数；同一币种互斥。部分平仓仍占用一个槽位，挂单也预留保证金。资金不足时不新开仓；低权益时不再强行抬高到 5 USDT。

默认杠杆统一为 **3x**，包括量化多空、闪击、波段和后台挖掘候选。首次读取旧版持久化配置会将后续开仓杠杆迁移至 3x；现有持仓的杠杆、名义仓位和退出价保持建仓记录。迁移只执行一次，之后显式设置的杠杆继续保留。`aggressive` / `conservative` 仍为手动选择的独立实验预设。

两阶段各平原始仓位的 50%。支持独立 TP1、TP2、止损、最长持仓时间；TP1 后可把剩余仓位止损移至包含手续费和滑点的成本保本价。价格跳空仍可能导致实际亏损。

单策略候选、后台挖掘与组合回测共用 `src/strategy-replay.ts`（研究目录保留兼容导出）：

- 上一根收盘生成信号，下一根开盘入场，包含入场当根撮合。
- 同根止盈/止损冲突默认先止损；穿越两个目标时结算两阶段。
- 第一阶段完成后只结算剩余半仓；组合净权益包含未平仓的阶段收益与浮盈亏。
- 手续费和滑点各收取一次；超时在到期分钟开盘退出，期末按最后已知价格结清。
- OHLC 无法提供逐笔成交顺序，回测采用保守规则；模拟交易使用实际接收到的 Tick。

胜率只统计**整笔完全平仓、扣除成本后的净盈亏**，分 `LONG`、`SHORT` 输出。API、面板、Telegram 平仓播报都区分多空；面板还提供滚动 24 小时统计，无交易时显示无样本。历史统计基于保存的平仓记录（当前保留最近 1000 笔）。

## 开发与验证

```bash
npm install
npm --prefix web install
cp .env.example .env
npm run dev
npm run typecheck
npm test
npm run build
npm run test:browser
npm start
```

服务默认端口 `4111`；生产启动前执行 `npm run build`。网络、Telegram 与部署参数使用 `.env`；策略参数通过 API 持久化到 `data/paper-trading.json`，采用临时文件后原子替换保存。

`npm test` 验证短期窗口切分、真实回放筛选、样本/成本门槛、持续调度、防重叠、换版、过期、重启恢复及持仓退出。`npm run test:browser` 构建前端后，通过 CDP 启动本机 Chrome，验证设置保存、轮询不覆盖编辑、策略复制以及因子生效/过期展示，并输出桌面和移动端截图至 `reports/ui-validation/`。浏览器测试使用临时账户、临时浏览器配置和本地测试行情，不读取 `.env`，不连接交易所或发送 Telegram，也不改动现有 `data/`。macOS 默认使用 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`；其他路径用 `CHROME_PATH` 指定，无桌面环境可设 `CDP_HEADLESS=1`。这些测试验证执行机制，不证明未来盈利。

## 挖掘与远程设置

服务启动后默认持续挖掘量化多空因子，**每轮完成后 15 分钟再次挖掘，因子从数据截止时间起最长使用 2 小时 (120 分钟)**。后台独立进程在空仓、持仓、满仓和行情请求退避期间都保持调度，不阻塞实时 Tick 退出。调度每 15 秒检查一次，同一时刻只运行一轮；单轮最多 10 分钟，出错后 15 分钟重试。

- 默认滚动 **12 小时训练**，用 **4-2 小时前和 2-0 小时前的独立留出集检验**（因子最长使用 2 小时）；额外保留 500 根特征预热数据。每轮在滚动训练集选出每个方向的第一名，再在独立留出集检验，留出集不达标不在该轮反复挑选替代候选。滚动轮次的区间可以重叠，留出检验不等于未来实盘保证。
- 自动候选扩展至 **576 组**（每方向 288 组）：多空方向 × 观察窗口 15/30 分钟 × 振幅分母 8/10 × 四种 ovcl (开盘/最高/收盘/最低) 与均线交互条件 × 三种短周期 DIF 高低位与 MACD 形态 × 三种微观 K 线形态 (长上影 Pinbar / 长下影 Hammer / 阴阳收盘实体) × 最长持仓 15/30 分钟。统一 3x 杠杆、3 分钟冷却、两阶段退出。自动搜索当前覆盖量化多空两个预设；其余五个预设及自定义组合也使用同一特征引擎。
- 训练/验证/留出至少各 10/8/5 笔完整交易；各阶段净胜率至少 65%、利润因子至少 1.25、每笔平均净收益至少 0.15%，验证集 Wilson 胜率下界至少 48%。手续费和滑点使用当前模拟账户配置。门槛只是筛选条件，不能保证未来胜率。
- 不以更早历史行情表现作为长期有效性门槛；短窗口内样本不足就等待下一轮，不自动放宽门槛或用长期成绩代替短期验证。训练、验证与留出窗口长度、刷新间隔、因子最长使用时间、单笔最长持仓时间是不同参数。
- 使用 `data/research/live-boards/` 实际观测的涨幅榜，下一分钟才可用于回放；超过 2 分钟的榜单不沿用。分钟归档会补存缓存里的预热和缺口修复数据。实盘分钟K与榜单默认滚动保存 **48 小时**（`KLINE_RETENTION_HOURS=48`），服务启动与定期自动清理过期归档以降低宿主机存储压力；冷启动时优先从本地已归档的 48 小时数据恢复，大幅降低对 Binance REST API 请求的压力与限频风险。初次上线需要各区间内足够的真实榜单和完整交易样本，期间量化策略暂停新开仓，其他策略预设照常按开关运行。
- 新因子通过后自动替换量化参数并保存版本、窗口配置、验证指标和到期时间；有效期从**数据截止时间**计算，重复处理相同数据和重启都不会续期。应用结果时，数据不得来自未来或超过 5 分钟未更新。最新检验不达标即暂停该方向量化新开仓；任务故障可继续使用尚未过期的已验证因子，到期后也会停开仓。
- 预设参数仅作为候选，不自带验证资格。首次启动、账户重置或拒绝结果后重启都不会用固定成绩补造有效因子。策略版本升级会要求重新验证；旧 `baseline:` 记录不允许入场。
- 已有持仓继续使用建仓时的止盈、止损和最长持仓规则。旧因子的未成交挂单在换版/过期后撤销。自动更新不会打开手动关闭的策略，量化做多默认仍关闭。
- 面板显示因子状态、留出胜率及样本数、到期和下轮时间，并可设置开关、三个窗口、刷新间隔、最长使用时间。手动修改量化条件、费用或窗口后，需要匹配当前配置的验证结果才能开仓；挖掘期间配置变化会拒绝应用旧任务结果。

API 配置示例：

```json
{"factorMining":{"enabled":true,"trainingMinutes":720,"validationMinutes":120,"holdoutMinutes":120,"refreshMinutes":15,"validForMinutes":120}}
```

所有时间均为整数分钟。训练至少 60 分钟，留出至少 15 分钟，验证窗口可设为 0~4320 分钟，三者总计最多 4320 分钟（72 小时）；刷新间隔至少 15 分钟且小于最长使用时间，最长使用时间为 30~720 分钟。默认训练时段为 -16:-4 共 12 小时 (720m)，验证时段为 -4、-3 的 120 分钟，留出时段为 -2 和 -1 的 120 分钟。缺失窗口字段补为默认 720/120/120；要采用完整新默认，可在面板设置或提交上例。非法合并配置整次拒绝。`GET /api/paper-trading` 和 `/api/status` 的账户摘要中含 `factorMining` 状态；完整状态保存于 `data/paper-trading.json`。自动模式下，以下离线工具应用的量化参数也须等待后台验证；关闭自动模式后恢复手动参数开仓，此时不受自动验证与到期门槛约束。

```bash
# --window / --divisor 控制前置事件统计的 x 与 N；候选形态按内置网格搜索
npm run mine:strategy -- --quick --window 15 --divisor 10
npm run mine:strategy -- --window 15 --divisor 10

# 阅读 reports/strategy-mining-report.md 与 data/mined-strategy.json 后应用
npm run deploy:strategy -- --url https://macd.subx.fun
```

读取历史 `.json`、`.json.gz` 和实时归档 `data/research/live-1m/*.jsonl`，跨日合并、按时间去重，计算数据内容哈希。榜单只使用当时可用的已收盘行情；不足完整 24h 的分钟历史不冒充 24h 涨幅，存在历史小时快照时可沿用已知快照。

上述手动离线脚本默认训练/验证/留出比例 60/20/20；`--val-recent` 为 70/15/15，区间互不重叠。该比例仅用于手动研究，后台自动挖掘使用前述可配置的分钟窗口。输出多空排名、验证结果和组合表现。**特征/执行口径已升级至 3.0.0，因子准入策略版本为 2；旧报告需要重新挖掘，不能直接沿用其胜率。**

面板“策略参数设置”统一编辑全部预设和自定义组合：特征周期、比较阈值、全部/任一条件组、峰谷观察、TP1/TP2、止损、持仓时间、冷却、杠杆和保本开关。可复制现有策略衍生新组合，或从空白组合开始；新组合默认关闭。编辑期间后台轮询不会覆盖输入。

| API | 用途 |
| --- | --- |
| `GET /api/status` | 行情快照与模拟账户摘要 |
| `GET /api/paper-trading` | 账户、挂单、持仓、历史及多空统计 |
| `GET /api/paper-trading/config` | 当前参数 |
| `POST /api/paper-trading/config` | 合并更新参数（也支持 PUT/PATCH）；部署新参数或传入 `resetFaults: true` 自动重置暂停策略 |
| `POST /api/paper-trading/strategy-faults/reset` | 重置策略表现不佳停用/重新挖掘冷却状态（支持可选 `{ strategyId }` 或全部重置） |
| `POST /api/paper-trading/reset` | 重置模拟账户；GET 不会重置 |

示例：

```json
{
  "marginPercent": 20,
  "maxPositions": 5,
  "maxPositionsPerStrategy": 1,
  "klineStatsShortConfig": {
    "intervalWindow": 5,
    "ampDivisor": 8,
    "maRequirement": "MA10_BREAKDOWN",
    "macdRequirement": "GREEN_RATIO_30_80",
    "holdMinutes": 45,
    "tp1Percent": 3,
    "tp2Percent": 7,
    "stopLossPercent": 5,
    "moveSlToEntryAfterTp1": true
  }
}
```

## 实盘小额测试（默认关闭）

实盘跟随模拟引擎**启用后新产生的开仓信号**（包括模拟限价单触发成交时的信号），不复制旧持仓、不补追漏单。模拟盘继续独立运行。实盘使用独立的成交记录、退出状态和交易所订单号，不把模拟成交价当作真实成交价。

在 `.env` 配置（仓库中的 key / secret 留空）：

```dotenv
LIVE_TRADING_ENABLED=false
LIVE_TRADING_TESTNET=false
BINANCE_API_KEY=
BINANCE_API_SECRET=
LIVE_CONTROL_TOKEN=
LIVE_MAX_CAPITAL_USDT=10
LIVE_MARGIN_PERCENT=20
```

使用 **HMAC API key**，开通合约交易权限；`LIVE_CONTROL_TOKEN` 是自行生成的至少 32 字符随机口令，用于面板操作，与 API secret 不同。可以用 `openssl rand -hex 32` 生成。填写凭证后，显式设置 `LIVE_TRADING_ENABLED=true` 并重启才会开仓。测试网需设置 `LIVE_TRADING_TESTNET=true`，使用 Binance Demo 的独立 key 和独立 `DATA_DIR`。签名请求固定发送至 Binance 官方主网 / Demo 地址，不沿用行情的 `BINANCE_BASE` 或 `FALLBACK_BASE`。

小额测试的约束：

- **总保证金预算默认 10 USDT，每笔按当前权益的 20% 分配保证金，代码总资金硬上限为 100 USDT**，后续可以在这个硬上限内逐步调整环境变量。请使用专门的合约账户，只放不超过当前总额度的 USDT；单向持仓、单资产模式，关闭自动追加保证金。账户有其他资产、持仓或普通/条件挂单时拒绝开仓。钱包盈利后超过当前上限也会暂停后续开仓，转出超额部分后在面板检查恢复。
- **逐仓，计划持仓时长 ≤10 分钟用 5 倍，超过 10 分钟用 3 倍，同时最多 1 仓**；每笔保证金为当前权益的 20%，以钱包余额、权益和总预算三者的较小值为基数。初始 10 USDT 对应每笔约 **2 USDT 保证金 / 6–10 USDT 名义金额**，再预留 2% 给费用和价格偏差；亏损后会按剩余权益缩小，不是固定下注 2 USDT。杠杆按信号的原计划持仓时长选择并随订单持久化，不会因剩余时间缩短、重启或后续策略调整而加杠杆。不自动转账、补充保证金或使用其他币种。账户余额不足时缩小下单；低于交易所最小下单金额则跳过，不凑单。
- 新开仓使用 **LIMIT IOC**，限制追价；拒绝超过 15 秒的信号、超过 10 秒的盘口、超过 0.5% 的信号价格偏离或盘口价差。IOC 未成交部分立即撤销，部分成交按真实数量管理。成交后的名义金额除以该笔实际杠杆，超过该笔保证金额度时会只减仓退出。限价卖单可能以更高价成交，成交后仍需这次额度检查。
- 交易所侧通过当前 `/fapi/v1/algoOrder` 接口挂 **STOP_MARKET / closePosition** 止损，以标记价格触发；初始整仓止损取模拟 SL1 / SL2 中更紧的幅度。止盈由行情 Tick 驱动，TP1 减半、TP2 结清；不足以分成两份时 TP1 全平。TP1 后可将止损移至开仓价外 0.2%（费用缓冲，并非净收益保证）。超时和主动退出使用 `reduceOnly` 市价单。止损挂单失败或消失时，停止开仓并尝试立即只减仓退出。
- 不承诺最大净亏损恰好等于 100 美元：这里按 **USDT 钱包与下单额度**限制投入，实际费用、资金费率、滑点及 USDT/USD 汇率仍以交易所为准。不要在该账户同时手动交易或运行其他程序。

面板独立显示实盘状态。输入控制口令后可“暂停开仓”“检查并恢复”“暂停并平仓”；口令仅保存在当前页面内存。**暂停或设置 `LIVE_TRADING_ENABLED=false` 仅阻止新开仓**，保留 key 并重启时仍会管理已有持仓。完全停止服务后，交易所止损保留，程序的止盈/到期退出停止执行。需要退出测试时，先用“暂停并平仓”，确认交易所空仓和无残留挂单后再停止服务或移除 key。

实盘开启或仍有未结持仓时，网页/API 的模拟策略修改和模拟账户重置返回 `423`，防止公开的模拟盘接口改变真实下单行为。后台因子更新仍按原有验证规则运行。修改策略前先结清实盘、关闭实盘并重启。

| API | 用途 |
| --- | --- |
| `GET /api/live-trading` | 只读状态和最近交易，不返回 key / secret / 控制口令 |
| `POST /api/live-trading/pause` | 暂停新开仓，继续管理持仓 |
| `POST /api/live-trading/resume` | 空仓且账户检查通过后解除暂停/熔断 |
| `POST /api/live-trading/close` | 暂停并只减仓结清本程序持仓 |

所有实盘 POST 需 `Authorization: Bearer <LIVE_CONTROL_TOKEN>`。接口不提供修改额度、启用实盘或清空实盘账本的功能。

实盘状态保存于 `DATA_DIR/live-trading.json`，下单意图先原子落盘，再发请求。网络超时不重发订单，先按 `clientOrderId` 查询；未确认的开/平仓会保留记录并熔断新开仓。**查询持续返回“订单不存在”也不会自动释放未确认开仓**：应先在 Binance 核对订单和持仓后人工排查，不要直接删除账本重新启动。状态文件损坏、key / 网络不匹配或另一实例持锁时均禁止交易。正常退出会释放 `.lock`，异常终止后的遗留锁需要人工处理；只有确认旧实例已经停止才可移除锁，保留 `.json` 账本。不同机器/不同 `DATA_DIR` 的锁不互通，同一账户只能运行一个实例。Docker 已挂载 `./data:/app/data`，并给正在对账的订单预留 90 秒退出时间，必须保留该目录。

交易所接口参数核对来源：[Binance 官方 TypeScript Futures SDK](https://github.com/binance/binance-connector-js/blob/master/clients/derivatives-trading-usds-futures/src/rest-api/modules/trade-api.ts)。自动测试使用本地模拟交易所，覆盖限额、签名、只减仓、部分成交、请求结果未知、保护单失败和重启恢复；不发送真实订单。运行 `npx tsx --test research/tests/live-trading.test.ts` 可单独复查。

## Telegram 与 mihomo

配置 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`、`DASHBOARD_URL` 即可播报行情、挂单、开仓和两阶段平仓。网络请求沿用 `PROXY` / `HTTP(S)_PROXY`。

Docker 保留现有 mihomo 启动、订阅、Binance 健康检查、失败节点回避和线路切换机制。主要参数为 `MIHOMO_SUBSCRIPTION_URL`、`MIHOMO_CONFIG_MODE`、`MIHOMO_PROXY_PORT`；详见 `.env.example` 与 `docker-compose.yml`。

**行情和实盘接口遇到 429 / 451 都调用容器内 mihomo 的控制 API 切线。**候选列表直接排除美国节点标记；通过同一代理请求 `https://www.cloudflare.com/cdn-cgi/trace`，确认有效出口 IP、国家非 US/CA，再验证 Binance `ping` 成功后采用节点。无法验证地区时不视为可用。切换后清理 mihomo 的旧连接，避免 HTTP CONNECT / WebSocket 继续使用旧 IP；WebSocket 按原有机制重连。并发错误合并为一次切线，短时间内不反复切换；429 节点临时避开 5 分钟，仍完整遵守 `Retry-After`，418 保留封禁退避。

实盘切线只恢复网络，**不会自动重发 POST / DELETE 交易请求**；持久化订单号继续用于对账。只读 GET 在 451 切线成功后最多重试一次，并重新生成时间戳和签名。控制接口默认 `http://127.0.0.1:9090`、组名 `ACTIVE`，可通过 `MIHOMO_API_URL` / `MIHOMO_PROXY_GROUP` 修改；自定义配置有控制密码时设置 `MIHOMO_API_SECRET`。生成的容器配置已把出口检查和 Binance 路由至 ACTIVE；挂载自定义配置时应保持这两个域名使用相同代理组。API key 不会发送给出口检查服务。自动测试使用模拟 mihomo 和出口响应，不发送真实交易请求。
保持挂载 `./data:/app/data` 目录：
- **持久化 48 小时分钟 K 线与榜单归档**：容器升级、重启时直接从本地秒级恢复，免去全量 REST API 请求（规避 Binance 429 限频）；
- **宿主机存储与磁盘保护**：每个 UTC 0 点按整天文件清理超过 48 小时的历史归档与信号快照，不进行日内逐行重写，严格保护宿主机磁盘寿命与空间；
- **模拟盘账户与动态因子状态**：持仓、胜率统计与当前挖掘出的有效因子（最长 2 小时有效）平滑延续。

```bash
docker compose up -d --build
```

> [!TIP]
> **宿主机目录权限**：生产环境若宿主机 `./data` 目录属主为 root，容器内内置的 `gosu` 自愈机制会在启动时自动递归修正属主为 `node:node` 并降权执行。若使用旧版镜像或手动挂载出现 `EACCES: permission denied`，可在宿主机直接执行 `sudo chown -R 1000:1000 ./data && sudo chmod -R 775 ./data` 立即恢复。

Mac 本机测试（Apple Silicon）使用独立的 [docker-compose.local.yml](docker-compose.local.yml)，Docker Desktop 启动后执行：

```bash
docker compose --env-file /dev/null -f docker-compose.local.yml up -d --build
docker compose --env-file /dev/null -f docker-compose.local.yml logs -f --tail 100
# 停止测试，保留独立测试数据卷
docker compose --env-file /dev/null -f docker-compose.local.yml down
```

面板位于 **http://localhost:14111**，只绑定本机；不需要 Traefik。测试配置不载入项目 `.env`，固定关闭实盘和 Telegram，交易凭证为空。数据放在独立的 `binance1m-local_monitor-data` Docker 卷，容器包含 mihomo。ARM64 构建支持使用官方 v1.19.32 Release API 下载（`MIHOMO_ASSET_URL`），规避常规 GitHub 下载地址偶发 504。

核心目录：`src/` 为监控、特征、交易及通知；`src/strategy-replay.ts` 为共用回测，`research/strategy-replay.ts` 为兼容导出；`src/factor-settings.ts` 定义短窗口与默认节奏；`src/factor-mining-service.ts` 调度后台挖掘；`scripts/mine-strategy.ts` 为手动挖掘入口；`web/` 为监控与参数面板。其他研究脚本保留为历史实验入口，见 [研究说明](research/README.md)。
