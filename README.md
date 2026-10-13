# Binance 1m MACD 高位死叉监控（u本位合约）

监控 Binance **u本位永续合约（USDM Futures）** 24h **涨幅前十 / 跌幅前十 / 成交额前十** 的 **1 分钟 MACD** 是否出现**高位死叉**，命中则高亮显示。

## 独立 CLI 做空策略研究

新增独立研究 **涨幅榜 1m + BTC 5m**：`npm run mine:btc5m -- --fetch-btc-five --batch 128 --no-telegram`。两周期独立搜索 DEA/DIFF、连续K线条件及高位比例，结果保存至 `reports/research/gainers-gpu-margin-no-ma-btc5m/`。详见 [研究说明](research/README.md#新增独立研究涨幅榜-1m--btc-5m)。

研究通过 CLI 单独运行，与监控服务、页面和 Telegram 无依赖。当前重点是 **gainers 涨幅榜：1m DEA 高位 + DIF ≥ DEA 直接做空，小止损、大止盈，不要求死叉**。全市场 USDT 永续小时数据用于重建每个历史整点的 24h 涨幅榜，分钟数据用于信号和成交回测。

```bash
# 首次获取全市场小时数据（已有缓存可复用）
npm run research -- fetch --data data/hourly

# 先研究一个完整 UTC 日；官方历史归档可用于公共 API 无法访问时
npm run research -- gainers --data data/research/hourly-initial --end 2026-10-11 --days 1 --minute-source archive --minutes-data data/research/gainers-1m-archive-1day --out reports/gainers-day1

# 缓存完成后离线重放（报告使用新目录）
npm run research -- gainers --data data/research/hourly-initial --end 2026-10-11 --days 1 --minutes-data data/research/gainers-1m-archive-1day --offline --out reports/gainers-day1-replay
```

输出 `report.md`、`result.json`、`trials.csv`、`test-trades.csv`、`board-history.csv`。默认 3 轮 × 20 组，止损 0.2/0.3/0.5%，止盈 1.5/2/3/5%；按时间使用 60% 训练、20% 验证、20% 最终测试。原三榜小时级实验仍可通过 `backtest --board all` 复现。

完整参数、收益计算和数据边界见 [research/README.md](research/README.md)。当前合约池不包含已退市币种，报告会注明历史覆盖与存活偏差。

## 高位死叉定义

- **死叉**：最近一根已收盘 1m K 线上，MACD 的 DIF 下穿 DEA（前一根 `DIF ≥ DEA`，当前 `DIF < DEA`）。
- **高位**：当前 `DEA` **接近或达到指定观察周期内的最高值**，即 `DEA ≥ HIGH_RATIO × max(DEA in window)`。默认 `HIGH_RATIO=0.9`、`HIGH_WINDOW=100`（1m K 线，即观察窗口约 100 分钟）。
- 同时满足（死叉 + 高位）即为「高位死叉」告警，面板以红底高亮。

> 只有当窗口内 DEA 曾达到正值峰值时才判定为"高位"，避免全程为负时把"最不低"的值误判为高位。

> [!IMPORTANT]
> ### 术语严格区分：DIF vs DIFF（切勿混淆！）
> - **DIF（单个 F，快线）**：$EMA(12) - EMA(26)$，快慢均线之差。在 MACD 中为平滑曲线。
> - **DEA（慢线 / 信号线）**：$EMA(DIF, 9)$。
> - **DIFF（两个 F，红绿柱 / 差离柱）**：$2 \times (DIF - DEA)$（Binance 官方口径柱状图）。
>   - **绿柱（$DIFF > 0$）**：
>     - 若 $DIFF \ge 0.8 \times \text{窗口峰值} \implies$ **高**（亮黄）；
>     - 其余 $DIFF \ge 0 \implies$ **中**（白色）；
>   - **红柱（$DIFF < 0$）**：**严格判定为低（灰色），绝不允许任何负值判定为中或高**。
>
> 页面表头与告警中展示的 `1m DIFF`、`5m DIFF` **全部严格指代红绿柱（两个 F）**，绝不可与快线 DIF 混淆！

## Telegram 计数告警（无支撑 + 5m DIFF中 + [1m中+连阳 或 1m低+连阴]）

在面板高亮之外，后端进行**榜单实时告警判定**：

当 **24h 涨幅榜、跌幅榜** 两个榜单中，**任意一个榜单**出现 **≥ `TG_ALERT_MIN`（默认 3）个**满足以下任意一组条件的币种时：

1. **无支撑**（`supportMa` 为 N/A） + **1m DIFF 中** + **5m DIFF 中** + **连阳**（1m K 线连续阳线 ≥ 2 根）
2. **无支撑**（`supportMa` 为 N/A） + **1m DIFF 低** + **5m DIFF 中** + **连阴**（1m K 线连续阴线 ≥ 2 根）

发出 Telegram 通知：

- **防骚扰**：当且仅当命中榜单达标且币种列表发生变动时才播报，榜币未变绝不重复骚扰；若榜单归零重置状态。
- **后台常驻监测**：服务端启动后自动常驻后台轮询（默认每 20s 刷新），即使没有打开浏览器也会持续监控并推送通知。
- **代理支持**：Telegram 走与 Binance 相同的代理链路（`PROXY` / `HTTP(S)_PROXY`），墙内无需额外配置。
- **接口异常告警（451 / 418）**：当 Binance API 返回 HTTP 451（地区法律限制）或 418（IP 被封）时，后端记录异常并立即发送一次 Telegram 告警。后续每分钟持续检测到相同错误不重复告警（防刷屏）；当接口解封恢复正常（HTTP 200）时自动清空告警标记，后续若再次受限可重新告警。

启用步骤：

```bash
# 1. @BotFather 建 bot 拿 token；2. 给 bot 发条消息；3. 浏览器打开（走代理）:
#    https://api.telegram.org/bot<TOKEN>/getUpdates  → 取 result[].message.chat.id
# 4. 写入 .env:
#    TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
#    TELEGRAM_CHAT_ID=123456789
```

MACD 参数：`12 / 26 / 9`，柱状值（DIFF）`= 2 × (DIF − DEA)`（Binance 口径）。

## 运行

前端已改为 React（Vite + TypeScript），位于 `web/` 子项目。开发与生产两种用法：

### 开发（热更新）

```bash
cd /Users/franklin/VM/DEV/binance-macd-monitor
npm install            # 根依赖（含 concurrently）
npm --prefix web install   # 前端依赖
cp .env.example .env   # 已有则跳过；在 .env 里配代理（PROXY=...）
npm run dev            # 同时起后端(:4111) + Vite 前端(:5173)
# 浏览器打开 http://localhost:5173
```

`npm run dev` 用 concurrently 同时跑后端（tsx watch）与 Vite dev server，前端通过 proxy 把 `/api` 转发到后端 :4111。也可分别用 `npm run dev:server` / `npm run dev:web`。

### 生产（构建后由后端托管）

```bash
npm run build          # 构建前端到 web/dist
npm start              # 起后端，托管 web/dist 静态资源 + /api/status
# 浏览器打开 http://localhost:4111
```

`npm start` 会自动加载项目根目录的 `.env`（`tsx --env-file-if-exists=.env`）。命令行显式传入的变量优先级更高，例如 `PROXY= npm start` 会覆盖 `.env` 里的代理强制直连。

> 合约行情只在 `fapi.binance.com`，**没有公开镜像**（spot 的 `data-api.binance.vision` 不提供 `/fapi/`）。若你的网络直连 fapi 不通，就必须配代理：在 `.env` 设 `PROXY` 或 `HTTP_PROXY`/`HTTPS_PROXY`；不需要代理就把 .env 里的代理行注释掉，即直连。

面板每 5 秒轮询一次 `/api/status`，后端对 Binance 的请求有 ~20s 缓存 TTL，避免触发限频。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `4111` | 本地服务端口 |
| `TOP_N` | `10` | 每个榜单取前 N |
| `REFRESH_TTL_MS` | `20000` | 快照缓存时长 |
| `KLINE_LIMIT` | `100` | 1m K 线取多少根（≥35 才能稳定算 MACD） |
| `HIGH_RATIO` | `0.9` | "高位"阈值：DEA ≥ 该比例 × 窗口峰值即算接近 |
| `HIGH_WINDOW` | `100` | "高位"观察窗口（1m 根数） |
| `BINANCE_BASE` | `https://fapi.binance.com` | 合约行情基址 |
| `FALLBACK_BASE` | _(空)_ | 主基址网络不可达时自动重试的回退地址（仅对连接级失败生效，HTTP 错误如 429/451 不重试）。合约无公开镜像，默认空；仅在自建反代时设置 |
| `TELEGRAM_BOT_TOKEN` | _(空)_ | Telegram Bot Token（@BotFather 创建）。**不配则不推送**（启动与命中时都会显式警告，不静默） |
| `TELEGRAM_CHAT_ID` | _(空)_ | 接收告警的 chat id（个人：向 @userinfobot 查询；群：把 bot 拉入后用 getUpdates 拿） |
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | Telegram Bot API 基址（自建反代时可改） |
| `TG_ALERT_MIN` | `3` | Telegram 告警阈值：任意一个榜单出现 ≥ N 个「DEA 高位 + DIFF 多头」时推送 |
| `TG_REPEAT_MINUTES` | `0` | 持续命中时的重发间隔（分钟），0 = 仅在首次触发时通知 |
| `DASHBOARD_URL` | `https://macd.reluv.xyz` | Telegram 提醒中附带的面板链接地址 |
| `PROXY` | _(空)_ | 本应用专用的代理地址（如 `http://127.0.0.1:7890`），**设置后强制走该代理**；未设置则回退到标准 `HTTPS_PROXY`/`HTTP_PROXY`（`NO_PROXY` 同样生效），都未设置则直连。由 undici `ProxyAgent`/`EnvHttpProxyAgent` 应用到所有 fetch（**含 Telegram API**） |

示例：

```bash
# 走 Clash 代理：在 .env 里写 PROXY=http://127.0.0.1:7890（推荐，配一次即可）
# 临时覆盖：命令行传入的变量优先于 .env
PROXY=http://127.0.0.1:7890 npm start
# 直连（fapi 未被墙，或 .env 未配代理时）：
npm start
```

## 数据源

均为 Binance 合约公开行情接口（无需鉴权）：

- `GET /fapi/v1/ticker/24hr` — 全市场 USDM 合约 24h 行情，用于排序涨幅/跌幅/成交额；
- `GET /fapi/v1/klines?interval=1m&limit=100` — 1m K 线，用于计算 MACD。

已过滤：仅保留 `*USDT` **永续合约**，剔除交割合约（带 `_YYMMDD` 后缀，如 `BTCUSDT_240329`）。币本位合约（`*USD_PERP`）因不以 `USDT` 结尾自动排除。合约市场无杠杆代币、无法币/稳定币计价，故无需现货那一套过滤。

## 结构

```
src/
  types.ts     # 共享类型（Row / Status / HighBearSummary），server 与 web 都用，纯类型无副作用
  macd.ts      # EMA / MACD 计算 + 高位死叉判定
  binance.ts   # Binance REST 客户端（24h 行情 + 1m K 线）
  telegram.ts  # Telegram Bot API 发送（走全局代理）
  alert.ts     # 「DEA 高位 + DIFF 空头」计数 + 边沿触发 Telegram 告警状态机
  server.ts    # 本地 HTTP 服务 + 托管 web/dist 静态资源 + /api/status
research/      # 独立 CLI：小时数据、历史三榜、多轮参数回测与报告
web/           # React 前端（Vite + TypeScript）
  src/
    App.tsx          # 面板布局：header / 窄屏 tab / 三个榜单
    App.css          # 暗色主题 + 响应式 tab
    components/      # GroupSection / Row
    hooks/useStatus.ts  # 每 5s 轮询 /api/status
    lib/format.ts    # fmt / pct / colClass
```

开发验证：`npm run typecheck`、`npm test`、`npm run build`。测试使用本地模拟数据与模拟 Telegram 服务，不请求真实通知服务。

> 仅用于研究/观察，不构成交易建议。MACD 1m 信号噪声大，高位死叉需结合其他条件判断。

### M1 Pro GPU 策略挖掘

以现有报告为基线，交叉搜索1m、15m各自的DEA高/中/低及DIFF多/空，共36种状态组合，再交叉独立的高位阈值与连阳/连阴根数；两个周期都强制无 MA 支撑（MA5/7/10/20/25/30/60/99/120），可用 Apple Metal 批量挖掘 1–60 分钟、小止损、扣费后目标盈亏比 ≥3 的参数组合。默认10倍逐仓、每笔100 USDT保证金、总资金1000 USDT；按账户收益与净值回撤选参，处理资金不足、保证金占用和近似强平。默认使用报告的本地完整行情和 `.env` Telegram 配置，每轮正收益训练新纪录、最终验证结果会播报，并保存断点与失败重试队列。

```bash
npm run mine:setup
npm run mine -- --fetch-fifteen --batch 128
# 中断后继续
npm run mine -- --resume --batch 128
```

两个周期分别配置、交叉组合：1m连续根数1/2/3/5/8，15m为1/2/3/4/6，各含连阳、连阴和不限。默认从58,063,544组有效参数中按状态和连续条件分层抽取400,000组（`--max-trials`），固定种子、无放回，完成只表示预定清单跑完。

默认输出 `reports/research/gainers-gpu-margin-no-ma-streak/report.md`。训练发现会明确标注“尚未留出验证”；复用原报告的一天数据不构成新独立验证。完整选项、验证流程、新数据获取及 Telegram 补发见 [GPU 挖掘说明](research/README.md#m1-pro-gpu-超短线挖掘与-telegram-成果播报)。
