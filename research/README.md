# 独立 CLI 做空策略研究

## 同币 1m/5m DIFF 新维度挖掘

入口 `npm run mine:monitor`，独立于旧版 `mine`、`mine:btc5m`。DIFF严格指柱体 `2 × (DIF − DEA)`；两个周期均取交易币种自身行情。固定1m无MA支撑及60D上涨，交叉搜索1m/5m高、中、低档位、各自高位比例、1m连阳/连阴根数、距1500根高点的回撤阈值，以及1–60分钟持仓、止损、止盈。

```bash
# 已有小时缓存覆盖的最近7个完整UTC日；归档补取支持逐币续传
npm run mine:monitor -- --fetch --start 2026-10-04 --end 2026-10-11 \
  --cache data/research/monitor-20261004-20261011 \
  --out reports/research/monitor-gpu-20261004-20261011 --board all

# 相同配置恢复断点；已完成的榜不会重新选参或测试留出
npm run mine:monitor -- --resume --start 2026-10-04 --end 2026-10-11 \
  --cache data/research/monitor-20261004-20261011 \
  --out reports/research/monitor-gpu-20261004-20261011 --board all
```

`--board gainers|losers|all`；all按顺序执行，两榜使用独立账户和选参结果。也可用相同缓存、相同输出根目录，以gainers/losers分别启动两个进程。`--fetch-only`只补数据，`--rounds N`运行指定轮数后保存，`--max-trials`默认20,000、上限400,000，`--batch`默认32。完整选项见 `--help`。新入口仅写本地报告和日志，不发送Telegram。

默认网格 `miner-grid-monitor.json`，按默认费用和净盈亏比门槛共96,040组有效参数，分252个“1m档位×5m档位×连续条件×回撤阈值”组，事前固定种子、无放回抽取20,000组；负DIFF不依赖高位比例，去除无效重复。完成表示预定抽样完成。60/20/20按时间切分，训练至少100笔，训练前五进入验证，验证至少34笔选一个，最终留出仅评价该候选。固定10倍逐仓、每笔100 USDT、总资金1000 USDT，每边手续费5bps、滑点2bps；可通过CLI调整。每轮首组和最佳组核对MPS/CPU逐笔成交及账户净值。

播报条件基线与 `src/alert-rule.ts` 共用：5m中，且1m中配≥2连阳或1m低配≥2连阴；无1m MA支撑、60D上涨、现价严格小于1500根高点的96%。高位比例默认HIGH_RATIO或0.8，两个周期同值；窗口固定100根。基线退出设置事前固定为15分钟、止损0.3%、止盈2%，不把退出规则误称为线上已有策略。基线训练结果立即记录，验证/留出等搜索完成后才评价，不参与选参。

分钟计划含1505分钟预热，并覆盖入场后的退出窗口；5m只聚合完整的5根分钟线，缺口重启预热。日线优先复用含24根完整小时线的UTC日，缺少的日期从官方日线归档补齐；月归档和日归档均校验官方SHA256。60D比较当时已收盘的61根日K；已知上市不足61天时比较全部可用完整日线，数据缺口不会伪装成新币短历史。所有源行情及代码哈希纳入断点，改变配置须使用新输出目录。

这是**单币条件的分钟收盘回测**：使用信号分钟收盘价和截至该分钟的1500根已收盘高点，下一分钟开盘成交。线上使用实时现价及正在形成线的高点；历史榜每小时重建，剔除BTC/SOL后取前十，不重放秒级排名、跌出榜留存、≥3币播报门槛和播报去重。报告明确这些差异。复用此前观察过的历史不构成新独立验证。

输出根目录下分别保存 `gainers/` 和 `losers/`：`report.md`、`state.json`、带SHA256的trials分片、`trials.csv`；完成后写留出 `test-trades.csv` 和 `test-equity.csv`，交易记录含DIFF值/档位、5m收盘时间、60D日线时间与根数、1500根高点及回撤。

## 旧版 Gainers 分钟研究

当前研究集中于历史涨幅榜，**1m DEA 高位 + DIF 多头 + 无 MA 支撑才可入场**：MACD(12,26,9)，DEA > 0，DEA ≥ 0.8 × 最近 100 根已收盘分钟 DEA 峰值（含当前），DIF ≥ DEA，且 MA5/7/10/20/25/30/60/99/120 均不满足当根已收盘分钟线 `low < MA < close`。与监控共用同一函数，MA 含当根收盘价，等于边界不算支撑；要求连续历史足够计算全部 MA。无死叉、阴线、连阴、量比、周线或额外涨幅过滤。该研究通过 `gainers` 命令运行，独立于服务和通知。

```bash
# 先获取全市场小时数据（已有数据可跳过）
npm run research -- fetch --days 30 --data data/hourly

# 一天试跑：使用已有全市场小时池重建榜单，分钟行情取官方历史归档
npm run research -- gainers --data data/research/hourly-initial --end 2026-10-11 --days 1 --minute-source archive --minutes-data data/research/gainers-1m-archive-1day --out reports/gainers-day1

# 固定相同区间和缓存，离线复现；输出使用新目录
npm run research -- gainers --data data/research/hourly-initial --end 2026-10-11 --days 1 --minutes-data data/research/gainers-1m-archive-1day --offline --out reports/gainers-day1-replay

# API 获取分钟数据，默认使用整个小时数据研究区间
npm run research -- gainers --data data/hourly --minutes-data data/minutes --out reports/gainers-full
```

`--start/--end` 或 `--days/--end` 可在小时缓存范围内选取整点对齐的子区间。区间左闭右开、日期为 UTC；上例研究 2026-10-10 00:00 至 2026-10-11 00:00。`--fetch-only` 仅补分钟数据，`--offline` 仅读完整缓存。

`--minute-source api`（默认）使用小时缓存的 Binance API 来源；`archive` 使用官方 `https://data.binance.vision/data/futures/um/daily/klines/` 合约归档，下载后校验官方 `.CHECKSUM` SHA256。归档通常次日发布，宜选已完整结束的 UTC 日；404 或下载失败会中止并保留续传进度，不用缺失档案冒充完整样本。换来源、区间、榜单宽度、高位窗口或最大持有期需使用新分钟缓存目录。

历史榜单仍以**当前全部 USDT 永续合约池**的过去 24 根已收盘小时线排序，每小时刷新一次；只为历史涨幅前 N（默认 10）补取入榜期间、至少 300 分钟指标预热和离榜后退出窗口的分钟线。分钟数据节省下载量，不缩小用于排名的全市场池。缺口后重新预热；离榜不强制平仓。

默认网格见 `gainers-grid.example.json`：高位比例 0.8，止损 **0.2/0.3/0.5%**，止盈 **1.5/2/3/5%**，最长持有 **15/30/60/120/240 分钟**，仅搜索名义止盈/止损 ≥ 3 的组合。默认 3 轮 × 20 组覆盖 60 个组合；可以通过 `--grid` 自定义这四个维度，止损上限为 1%。`--high-window` 默认 100 根。分钟网格不接受旧策略的死叉、周线、量比等过滤。

信号收盘后下一分钟开盘做空，同币同时仅持一笔，退出后下一分钟满足条件即可重入，没有冷却期。分钟 OHLC 同时触及止盈止损时按止损优先，开盘跳空按开盘成交。默认单边手续费 5 bps、滑点 2 bps，按入场与出场金额分别扣除。

按时间切分 60% 训练、20% 验证、20% 测试。多轮搜索只看训练，默认训练至少 100 笔；训练前五名进入验证，至少 34 笔后选择一个参数集进入最终测试。每段必须容纳网格最大持有期；跨段候选按最大持有期提前剔除。一天试跑用于验证流程，样本不足会如实报告。

报告保存在 `--out/gainers/`，包含 `report.md`、`result.json`、`trials.csv`、`test-trades.csv`、`board-history.csv`，记录选定参数、净盈亏比、训练/验证/测试统计、退出原因分布、同分钟止盈止损冲突、数据覆盖和源文件校验值。当前池存在存活偏差；统计为等名义单笔收益，未建模资金费率、杠杆、资金占用或组合资金回撤。

## 原三榜小时级实验（复现旧报告）

CLI 获取 Binance **当前全部正在交易的 USDT 永续合约**的小时 K 线，在此回测池内重建历史 24h 涨幅榜、跌幅榜和成交额榜，再对三个榜**分别产生样本、搜索参数、验证和生成报告**。

以下 `run/backtest` 为保留的旧实验，使用 **1h 指标与 1h 成交模拟**，不代表当前 `gainers` 命令的入场规则。代码全部位于 `research/`，入口为 `research/cli.ts`。

## 运行

```bash
# 一键：抓取最近 30 天小时数据 → 重建历史榜单 → 三榜分别搜索参数 → 报告
npm run research -- run --days 30 --rounds 3 --trials 24 --data data/hourly --out reports/study-01

# 分步获取；与任何研究榜单选择无关，始终获取整个回测池
npm run research -- fetch --start 2026-09-01 --end 2026-10-01 --data data/september

# 三个榜独立回测，也可只运行 gainers / losers / volume
npm run research -- backtest --board all --data data/september --out reports/september

# 保留已有报告，用同一数据和自定义网格做新的参数实验（无需联网）
npm run research -- backtest --board losers --data data/september --out reports/losers-round2 --grid research/grid.example.json --rounds 5 --trials 50 --seed 123

npm run research -- --help
```

`--board all` 依次执行三个独立研究。原始行情可以共用，但一个榜的入选记录不会从另一个榜删除；参数候选、训练/验证选参、测试交易和统计均独立。一个研究任务失败时，其他榜仍继续。

运行目录默认为带时间戳的 `data/research/`、`reports/research/` 子目录。数据和报告已加入 `.gitignore`。

## 数据与历史榜单

1. `/fapi/v1/exchangeInfo` 获取当前 `TRADING + PERPETUAL + USDT` 合约清单，保存币种与上市时间。支持 Binance 的中文币对代码。
2. `/fapi/v1/klines?interval=1h` 分页获取各合约历史小时 OHLC、基础成交量、`quoteVolume`，不调用当前 24h ticker 排名接口。仅保存请求结束边界之前的已收盘小时线。
3. 自动补取至少 100 小时预热，并覆盖研究开始当周 UTC 周一开盘，用于 MACD 和周涨跌幅计算。
4. 在历史整点 `t`，窗口严格为 `[t-24h, t)`，只有完整且连续的 24 根小时线才参与排名。
5. `24h 涨跌幅 = (最后一根 close / 第一根 open - 1) × 100%`；`24h 成交额 = 24 根 quoteVolume 之和`。分别降序、升序、按成交额降序取前 N。相同值按币种代码排序。
6. 技术特征只能使用 `t` 之前已收盘的小时线。新币有 24h 历史就可入榜，但策略必须有至少 100 根连续小时线完成预热。

每个历史时点都重新排序，币种和排名随时间变化。后续离榜不会强行结束已经入场的模拟持仓。

这重建的是**当前合约回测池内、按整点对齐的历史榜单**。当前清单缺少已退市币种，无法消除存活偏差；不能称为包含全部历史合约的逐 tick 榜单。报告会列出池大小、覆盖不全的时点数和本榜历史入选币种。

### 缓存与续传

数据目录包含 `manifest.json`、`partial.json` 和每币一个 `SYMBOL.json.gz`。清单记录时间范围、合约池、每个文件的 SHA256、K 线数量和内部缺口。

- 单币完成后原子写入文件并更新进度；重跑使用相同已保存的合约池，不随当前行情改变研究样本。
- 中断后使用 `npm run research -- fetch --data 原目录`，省略日期参数以复用原范围；已完成币种通过校验后跳过。
- 不同日期范围或来源要使用新数据目录；报告目录必须为空，避免覆盖旧实验。
- 任一币种获取失败时不生成完整 `manifest.json`；离线回测不接受只有 `partial.json` 的不完整池，避免悄悄在缩小的池内排序。
- 上市前无历史数据、新币预热不足和数据内部缺口明确保留，不用零价、零收益或未来价格填补。
- 请求间隔至少 250ms，超时 15s；网络异常与 429 最多重试两次。较长限流要求稍后续传。

## 三榜策略假设

各策略只对当时入选相应历史榜单的标的发出信号，不从当前榜单回填成员。

| 榜单 | 基本触发条件 | 可搜索维度 |
|---|---|---|
| 涨幅榜 | 24h 上涨、DEA 正值高位、当根 DIF 下穿 DEA、阴线 | 涨幅门槛、高位比例、量比、连阴数、周线过滤、持有期、止损止盈 |
| 跌幅榜 | 24h 下跌、DIF < DEA、收盘破前 5 根低点、5h 动量为负 | 跌幅门槛、量比、连阴数、周线过滤、持有期、止损止盈 |
| 成交额榜 | 历史 24h 成交额 ≥ 1 亿 USDT、DIF < DEA、5h 动量为负、阴线 | 量比、连阴数、周线过滤、持有期、止损止盈 |

MACD 为 12/26/9；高位比例是 DEA / 过去 100 根 DEA 正峰值；量比为当根成交量 / 前 20 根均量。开启周线过滤时，涨幅榜要求本周上涨，其余两榜要求本周下跌。无关参数不作为另一个榜的不同试验重复计数。

## 多轮搜索和留出测试

默认每榜 3 轮，每轮至多 24 组未尝试参数：

1. 按时间划分 60% 训练、20% 验证、20% 最终测试；禁止随机打乱时间。
2. 首轮从参数网格随机采样。后续围绕训练前五名变动一到两个参数，保留全局探索；固定 `seed` 可复现。
3. 多轮过程中仅使用训练区间。训练不少于 `--min-trades`（默认 20）笔，才可入围。
4. 训练均值前五名进入验证。验证至少 `ceil(minTrades/3)` 笔，以平均净收益选择一个参数集；均值相同时优先较低的收益百分点回撤。
5. 最终测试仅评估选定参数一次，不反复用测试结果调参。没有满足数量要求的参数时，明确报告样本不足。

最多 10 轮、每轮 500 组；小网格会在无法找到更多不同参数时结束。全部试验仍写入 CSV/JSON，便于检查搜索范围。固定数据、种子和参数生成相同结果。

`grid.example.json` 列出全部可编辑参数。`holdHours` 单位为小时；`stopLossPercent`、`takeProfitPercent` 为百分比，0 表示关闭。训练、验证、测试每段长度至少要覆盖网格中的最大持有期。

## 成交和收益

- 收盘形成信号，下一根小时线开盘模拟做空。每币每策略同一时刻仅持有一笔，不跨榜去重；不同币可并行持仓。
- 到达持有期时按收盘价退出；期间可触发止盈止损。开盘跳空按开盘价成交；同根同时触及两个阈值时保守按止损优先。
- 毛收益为 `(入场价 − 出场价) / 入场价 × 100%`；默认单边手续费 5 bps、滑点 2 bps，入场与出场按各自名义金额扣除。1 bps = 0.01%。
- 用最大持有期剔除跨训练/验证/测试边界的信号；出场前缺失 K 线的交易记为缺失，不计入胜率、收益或收益因子。
- 输出平均净收益、扣费胜率、收益因子、最差单笔、累计收益百分点回撤。后者按等名义金额的交易退出顺序累加，**不是组合资金回撤**；未模拟复利、资金占用、杠杆、资金费率或真实成交。
- 参数搜索和币种相关性会影响可信度。留出测试亏损会如实报告，不将规则命中率或训练最高收益宣称为策略有效。

## 报告文件

每榜输出到 `--out/<board>/`，三个榜没有合并收益或共用的优胜参数。

| 文件 | 内容 |
|---|---|
| `report.md` | 数据覆盖、研究方法、每轮搜索、参数和最终测试结论 |
| `board-history.csv` | 本榜逐历史时点的币种、排名、24h 涨跌幅、成交额与周涨跌幅 |
| `result.json` | 数据清单、源代码哈希、参数网格、全部试验、最终测试与交易明细 |
| `trials.csv` | 全部参数组的训练/验证指标 |
| `test-trades.csv` | 最终测试交易、历史排名、入场/退出时间和价格、原因、费用后收益 |

日期使用 UTC，命令行可传带时区的整点 ISO 时间或 `YYYY-MM-DD`（UTC 零点）。区间左闭右开。代理只在抓取行情时读取 `.env` 的 `PROXY` / 标准代理变量；也支持 `BINANCE_BASE` 指定行情基址。离线 `backtest` 无需网络或 API Key。

## 验证

```bash
npm run typecheck
npm test
npm run build
```

测试覆盖历史排名轮换、跨榜同币保留、未来数据隔离、24h 成交额、缺失数据、费用、止损跳空、时间边界剔除、多轮搜索可复现、测试区间不参与选参、全市场分页获取与离线回测。测试只使用本地模拟行情和模拟 Telegram 服务。

## 新增独立研究：涨幅榜 1m + BTC 5m

`npm run mine:btc5m`（等价于 `npm run mine -- --study btc5m`）对历史涨幅前十币种的1m信号叠加 **BTCUSDT原生5m** 状态。所有榜内币种在同一时刻使用同一个BTC状态，不要求BTC进入涨幅榜，交易及盈亏仍属于榜内币种。

沿用下文GPU逐仓账户模型与训练/验证/留出流程。两个周期分别搜索DEA高/中/低、DIFF多/空、高位比例及连阳/连阴条件，均要求无MA支撑。默认网格 `research/miner-grid-btc5m.json` 使用 `minuteDea/minuteDif/highRatio/minuteStreak` 与 `btcFiveDea/btcFiveDif/btcFiveHighRatio/btcFiveStreak` 独立组合；参数范围与现有1m+15m研究相同。仍为36种状态、121种连续条件、58,063,544组有效参数，默认预先分层抽样400,000组。15m与BTC5m网格分别运行。

```bash
# 首次补取BTC 5m并运行；本地保存结果，不发送Telegram
npm run mine:btc5m -- --fetch-btc-five --batch 128 --no-telegram

# 按相同参数继续尚未完成的研究
npm run mine:btc5m -- --resume --batch 128 --no-telegram
```

共用已有小时榜单池与币种1m缓存，BTC缓存独立保存在 `data/research/btc-5m-1day/`，可用 `--btc-five-data` 指定新目录。下载BTC原生5m，含300根（25小时）预热；以最近100根DEA峰值判断高位。入场t只关联 `floor(t/5m)*5m` 时收盘的BTC线，例如10:04用10:00收盘线、10:05用10:05收盘线。缺失、未收盘、预热不足均不可入场，缺口后重新预热。缓存校验区间、周期、币种、数量与SHA256。

独立输出目录为 `reports/research/gainers-gpu-margin-no-ma-btc5m/`，可用 `--out` 修改。报告包含BTC覆盖率和两组条件的训练比较；`trials.csv` 保存BTC搜索参数；`test-trades.csv` 额外记录 `btcFiveSymbol`、BTC收盘时间、DEA/DIFF、档位、方向、MA支撑和连续根数。断点指纹包含BTC规则和数据哈希，不与原研究混用。升级代码后，旧指纹断点需使用对应旧代码复现，或在新目录重跑。

## M1 Pro GPU 超短线挖掘与 Telegram 成果播报

新增独立入口 `npm run mine`，以 `reports/research/gainers-high-bull-1day/gainers/report.md` 为基线，复用原有历史榜单、1m MACD 和成交模型，将1m与15m各自的DEA高/中/低、DIFF多/空交叉为36种组合；两个周期均强制无MA支撑，并独立设置高位阈值、连阳/连阴方向与最少根数。需要 Apple Silicon、支持 Metal 的 macOS、原生 arm64 Python 3.12 和 `uv`。PyTorch **MPS** 在 GPU 上批量计算参数×信号×持仓分钟的首次退出（包括强平）；GPU 不可用时明确报错。`--device cpu` 只供排错，报告会显示真实设备。

```bash
# 仅首次安装，依赖隔离于本仓库 .venv-gpu
npm run mine:setup

# 使用原报告的完整本地行情，直接进行本轮预定清单 GPU 挖掘并发送 TG
npm run mine -- --fetch-fifteen --batch 128 --leverage 10 --margin-usdt 100 --balance-usdt 1000

# 限本次运行5轮；下次从同一目录接着跑，直至完成预定清单
npm run mine -- --rounds 5 --batch 128
npm run mine -- --resume --batch 128

# 仅重试已经落盘的未发送消息，无需重新运行GPU或回测
npm run mine -- --notify-only

# 查看全部参数、验证 GPU
npm run mine -- --help
npm run test:gpu
```

Telegram 沿用 `.env` 的 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`、`TELEGRAM_API_BASE` 和 `PROXY` / 标准代理变量。默认要求凭据存在；`--no-telegram` 可明确离线运行，消息仍保存，之后 `--notify-only` 可补发。测试只访问本地模拟 Telegram；实际挖掘会向配置的 chat 发送启动、训练发现和完成结果。

默认 `research/miner-grid-streak.json` 对两个周期使用相同参数维度、独立数值网格，做笛卡尔积，不把两个周期绑定为相同值，也不排除碰巧相等的有效组合：

|维度|1m|15m|
|---|---|---|
|DEA档位|`minuteDea`: high/mid/low|`fifteenDea`: high/mid/low|
|DIFF方向|`minuteDif`: bull/bear|`fifteenDif`: bull/bear|
|DEA高位比例|`highRatio`: 0.60–1.00，共9档|`fifteenHighRatio`: 0.65/0.80/0.90|
|连续阈值|`minuteStreak`: 0/±1/±2/±3/±5/±8|`fifteenStreak`: 0/±1/±2/±3/±4/±6|
|MA支撑|必须无支撑|必须无支撑|

连续阈值正N表示**至少N连阳**，负N表示**至少N连阴**，0表示不限。阳线是close>open，阴线是close<open；十字星、方向切换或数据缺口中断连续段。包含当根已收盘线，监控与研究共用 `consecutiveStreakAt`。例如 `minuteStreak:3, fifteenStreak:-4` 表示1m至少3连阳且15m至少4连阴；与DIFF多空是独立维度。两周期各11种连续条件交叉为121组。DEA和DIFF还接受 `any` 表示该状态不限，但仍强制无MA支撑。

交易参数继续保留持仓11档（1/2/3/5/8/10/15/20/30/45/60分钟）、止损11档（0.10–1.00%）、止盈15档（0.50–10.00%）。只保留名义止盈/止损≥3且按入场和出场分别扣费后目标盈亏比≥3的组合，默认每边手续费5bps+滑点2bps。某周期处于低位/不限DEA时，其高位比例不影响规则，只去除该周期重复阈值；不会删除另一周期的独立阈值。

全空间去重及盈亏比过滤后为 **58,063,544组**。默认 `--max-trials 400000`：按双周期DEA/DIFF状态×1m连续阈值×15m连续阈值分成4,356层，尽量等额分配预算，每层内无放回抽取数值参数。若一层已抽完，预算分配给其他层；预算不足以覆盖全部层时会报错。清单在加载行情收益前由固定seed生成，不参考训练/验证/留出成绩，不会把未运行组合算作验证通过。小网格在预算内则全量遍历。报告的search字段记录possible、selected、exhaustive、method和seed所在配置；改变预算/网格/种子需新输出目录。

目标盈亏比不代表包含跳空和超时退出的实际平均盈亏比。旧的双周期无连续过滤网格仍保留在 `miner-grid-15m.json`（205,656组）；可显式指定它并使用新输出目录复现研究规则。

默认使用**10倍逐仓、每笔100 USDT保证金、初始账户1000 USDT**，因此每笔名义金额1000 USDT。可用 `--leverage`、`--margin-usdt`、`--balance-usdt`、`--max-positions` 修改；这些是可复现的回测参数，不代表交易建议或交易所对每个币种支持的档位。开仓锁定保证金并支付按名义金额计算的开仓成本；资金不足跳过，平仓后释放资金；同分钟入场竞争按币种代码排序。固定每笔保证金，不将浮盈当作可用资金。

规则是历史涨幅前十；1m、15m均使用MACD(12,26,9)。DEA高位=DEA>0且≥阈值×最近100根DEA峰值；中位=DEA≥0且未达高位；低位=DEA<0。1m阈值使用highRatio网格，15m独立使用fifteenHighRatio网格（未提供时默认0.8）。DIFF≥DEA为多头（含相等），DIFF<DEA为空头。1m不再固定高位多头，全部状态参与搜索。

两个周期各自的MA5/7/10/20/25/30/60/99/120均不满足已收盘线 `low < MA < close` 才能入场，有支撑直接排除，不提供“有支撑”选项。15m使用原生K线与至少300根（75小时）连续预热，不能从稀疏1m缓存推导。`--fifteen-data` 指定缓存目录；首次加 `--fetch-fifteen` 下载，以后可离线复用SHA256校验后的完整缓存。入场t仅关联 `floor(t/15m)*15m` 时收盘的线：10:14用10:00收盘线，10:15用10:15收盘线；缺失、尚未收盘或预热不足不准入场，缺口后重新预热，不沿用过期状态。

完整小时合约池重建历史榜单。下一分钟开盘做空、同币单仓、离榜不强平、无额外冷却；开盘跳空按开盘，跳过强平线时先强平；同根双触先处理不利退出，连续上涨先触发止损/强平中较近的阈值。GPU 使用 float32 计算首次触发位置；阈值附近用原 CPU 双精度逐根复算，成交价格、杠杆后盈亏及保证金占用由时间顺序账户账本计算。GPU首次退出按持仓时长/有效止损/止盈缓存复用，状态过滤在CPU进行。每轮首组和最佳训练组逐笔核对 CPU；所有拟播报发现再核对 CPU。

训练/验证/留出按时间60/20/20切分，每个参数按其最长持有期事前剔除跨段入场。默认训练至少100笔，验证和留出至少34笔。每轮只搜索训练区间：有样本达标、无缺失交易、无强平、账户净收益率为正且PF>1的新纪录时立即播报“**训练阶段发现，尚未留出验证**”。完成预定清单后，固定按训练账户净收益率排序的前五名参与验证，按验证账户净收益率选择一个参数，同收益率优先较小账户净值回撤，最终留出只评估此参数。每个分段独立从设定初始资金开始，不能把三段相加当连续账户收益。只有三段都达到门槛才标为“达到研究成果门槛”；没有达标则如实发送完成结果。全盈利时PF分母为零，报告使用“—”，门槛按无亏损且正均值处理。

报告列出36种DEA/DIFF组合和121种连阳/连阴组合的训练结果比较，不读取各组合留出收益排名。完整CSV/报告每64轮、训练新纪录与结束时更新，分片检查点和TG队列仍每轮保存。每轮参数按固定种子洗牌后分批遍历，不重复、不无限重搜已经看过的留出段。`--rounds N` 是本次运行的轮数上限，预定清单未完成不会提前打开留出集；默认0表示跑完本轮预定清单，抽样模式不代表穷尽全空间。`--batch` 默认32，`--signal-batch` 默认1024，内存有限时可降低后者。当前网格和一天数据不保证GPU比CPU更快，收益取决于批量规模；这里不会虚构加速比。

输出默认 `reports/research/gainers-gpu-margin-no-ma-streak/`（v4分片检查点，拒绝混用旧版参数或数据）：

- `report.md`：真实计算设备、逐轮耗时、规则与最终结果。
- `state.json`：数据/代码/参数SHA256、断点、试验分片索引、入围验证结果、完整留出交易、待发消息与Telegram回执。
- `trials-起点-终点.json`：每轮训练试验，只写新增分片并校验SHA256；避免20万组网格每轮重写整个状态。读取全部试验可使用 `hydrateMiningState`。
- `trials.csv`：每组双周期状态参数的账户收益、回撤、资金不足跳过和强平次数。
- `test-trades.csv`：每笔杠杆、保证金、名义金额、数量、费用、净盈亏、保证金收益率及两个周期入场DEA、DIFF、档位、方向、支撑状态、连阳/连阴实际方向与根数和15m收盘时间。
- `test-equity.csv`：分钟账户净值、可用余额、锁定保证金及浮动盈亏。
- `training.f32`：只含训练区间的GPU输入，可重新生成。

状态与消息先原子保存再发送；失败指数退避，尊重Telegram限流。本轮和结束时会重试，仍失败以退出码2结束，保留队列供 `--notify-only` 补发。完成状态续跑只检查/补发，不重新选参或看留出。进程锁避免同目录双开；Ctrl-C/SIGTERM在当前轮结束后保存断点。改变杠杆/保证金/总资金/维持保证金等账户设置、数据、代码、种子、费率、网格、每轮批量或筛选门槛须用新输出目录，以免混合研究。进程在远端确认送达后、本地回执落盘前异常退出，可能造成一次重复；消息附研究与事件ID便于识别。

若要使用更长或新的行情，先用原有获取流程生成完整缓存：

```bash
# 选择已经发布官方分钟归档的时间段；下列为历史样例
npm run research -- fetch --start 2026-09-01 --end 2026-10-01 --data data/research/gpu-september-hourly
npm run research -- gainers --data data/research/gpu-september-hourly --minutes-data data/research/gpu-september-minutes --minute-source archive --grid research/miner-grid.json --fetch-only
npm run mine -- --data data/research/gpu-september-hourly --minutes-data data/research/gpu-september-minutes --fifteen-data data/research/gpu-september-15m --fetch-fifteen --batch 128 --out reports/research/gpu-september
```

小时与分钟清单及全部行情都校验SHA256；沿用原报告更长退出覆盖的分钟缓存也可使用。无法读取完整缓存时先修复下载，不会静默缩小历史榜单池。原报告的一天行情已经被观察，重跑它不能算新独立验证。这里输出的是历史研究，不自动下单；未导入历史资金费或真实订单簿，小样本正收益不证明未来盈利。

强平采用明确的近似模型：`强平价 = 入场价 × (1 + 1/杠杆) / (1 + 维持保证金率 + 预估平仓成本率)`，`--maintenance-margin-percent` 默认0.5%，`--liquidation-fee-bps` 默认50bps。保证金不足不自动追加，强平损失限定于该逐仓保证金，开仓成本另计；穿仓缺口单列。**成交价OHLC仅作为标记价格代理，固定维持保证金率不是币安实际分档，也未建模资金费、订单精度与保险基金真实清算过程。**

账户收益率按总初始资金计算；单笔保证金收益率按该笔保证金计算，二者不会混为一谈。账户净值包括未实现盈亏，回撤按分钟收盘和入场扣费时点统计，不覆盖完整分钟内路径。以默认参数、0.5%止损/5%止盈为例，正常止损约亏6.4035 USDT，正常止盈约赚48.635 USDT；跳空或提前强平会改变结果。

仅复现旧的1m高位多头搜索时，显式使用 `--grid research/miner-grid.json --out 新目录`，无需15m缓存。不能直接用旧检查点混合续跑新增维度。
