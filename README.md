# Binance 1m MACD 连阳涨幅监控（u本位合约）

监控 Binance **u本位永续合约（USDM Futures）** 24h **涨幅榜** 的 **1 分钟 MACD**，当币种同时满足「连阳涨幅达标 + 无 MA 支撑 + 近 30 根 1m MACD 绿柱 > 80%」时触发告警。

## 信号直接做空与两段平仓研究

新增 `npm run research:wick -- --help`：历史24h涨幅榜、连阳涨幅达标、无MA支撑、近30根1m绿柱>80%，信号确认后直接市价开空；第一段平50%，第二段平剩余全部，按整笔统计扣费胜率和实际盈亏比，并核对信号与开仓数量。配置、数据准备和报告说明见[研究模块](research/README.md#连阳信号直接做空与两段平仓)。

## 监控规则变更

### 已移除的逻辑

- **1500 分钟逻辑全部移除**：去除了 max1500 最高价统计、lastPrice < max1500 * 0.96 过滤条件，以及初始拉取/滚动的 1500 根限制（冷启动降为拉取 200 根以满足 MA120 及 MACD 绿柱稳定计算）。
- **5 分钟逻辑全部移除**：去除了 1m 合成 5m K 线（update5mFrom1m / aggregate1mTo5m）、diff5m 判定及 5m DIFF 中的告警门槛。
- **小时 K 逻辑全部移除**：去除了整点极值与首分钟价格计算（maxHour / hourFirstLow / hourFirstClose）及价格回撤比例限制。
- **60D 日 K 上涨过滤移除**：去除了非置顶币种必须 60D 上涨的要求，同时去除了日 K 与周 K 网络请求，大幅减轻 API 权重与延迟。
- **跌幅榜全部移除**：
  - 服务端与同步模块完全剔除跌幅榜的 K 线拉取、冷启动调度与 WS 订阅，仅保留置顶标的（BTC、SOL）及 24h 涨幅榜。
  - 前端面板移除了跌幅前十 Tab 与展示区域。
  - Telegram 告警仅监控并播报 24h 涨幅榜。

### 新的告警过滤规则

必须同时满足以下三项条件（非置顶币种触发，置顶标的固定随行展示）：

1. **连阳且涨幅达到阈值**：
   - 1m K 线连续收阳（`streakCount ≥ 2`，可由环境变量 `STREAK_MIN_COUNT` 配置，默认 2）；
   - 该段连阳累计涨幅 ≥ `STREAK_GAIN_THRESHOLD`（默认 1.0%，可由环境变量配置）。

2. **无任何 MA 支撑**：
   - `supportMa === null`（MA 5/7/10/20/25/30/60/99/120 均未形成有效支撑）。

3. **近 30 根 1m MACD 绿柱 > 80%**：
   - 最近 30 根已收盘 1m K 线中，MACD 差离柱（`hist = 2 * (DIF - DEA) > 0`）绿柱占比 `strictly > 80%`（即至少 25 根为绿柱）。

## Telegram 计数告警（24h 涨幅榜：连阳涨幅达标 + 无 MA 支撑 + 近 30 根 1m MACD 绿柱 > 80%）

在面板展示之外，后端进行**榜单实时告警判定**（仅播报 24h 涨幅榜，跌幅榜已彻底移除）：

当 **24h 涨幅榜** 出现 **≥ `TG_ALERT_MIN`（默认 1）个**同时满足上述三项条件的币种时：

- **币种 (symbol)**
- **24h涨幅 (24h: +xx.xx%)**
- **连阳数 (连阳数: N)**
- **连阳涨幅 (连阳涨幅: +x.xx%)**
- **1m30upR (1m30upR: 26/30 (86.7%))**
- **保留榜单排名变动标签**（如 `#1 ↑+2`）与**置顶标的提示**。

### Telegram 播报样例

```
🚨 <b>24h涨幅榜告警：连阳涨幅达标 + 无MA支撑 + 近30根1mMACD绿柱>80%</b>（触发阈值 ≥ 1）

📌 <b>置顶标的</b>：
• <a href="https://www.binance.com/zh-CN/futures/BTCUSDT"><b>BTCUSDT</b></a> 24h: +3.12% | 连阳数: 3 | 连阳涨幅: +1.45% | 1m30upR: 27/30 (90.0%)
• <a href="https://www.binance.com/zh-CN/futures/SOLUSDT"><b>SOLUSDT</b></a> 24h: +4.20% | 连阳数: 2 | 连阳涨幅: +1.10% | 1m30upR: 25/30 (83.3%)

📈 <b>↑↑涨幅榜(24h)↑↑</b>：<b>1</b> 个
• <a href="https://www.binance.com/zh-CN/futures/ETHUSDT"><b>ETHUSDT</b></a> 24h: +12.34% | 连阳数: 4 | 连阳涨幅: +2.50% | 1m30upR: 27/30 (90.0%) [#1 ↑+2]

🔗 <a href="https://macd.reluv.xyz">点击查看监控面板</a>
```

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

## 1m K 线图表（TradingView Lightweight Charts）

页面右栏常驻一张 1m 图表：主图 K 线叠加 **MA5/10/20/30/60**，副图 **MACD(12,26,9)**（DIF / DEA / 柱）。可下拉切换交易对，均线可逐条点击显隐，十字线悬停时顶部图例显示该根 K 线的 OHLC 与各指标数值。

指标不在前端计算，而是由后端算好后随数据下发（`src/chart.ts` 复用 `macd.ts` 的 `ema`/`computeMacd`），因此**图上看到的 MACD / 均线与监控表格、告警逻辑是同一套数值、同一口径**。

```bash
GET /api/klines?symbol=BTCUSDT&limit=200
# → { symbol, interval:"1m", source, maPeriods:[5,10,20,30,60], macd:{fast,slow,signal}, bars:[{time,open,high,low,close,volume,ma,dif,dea,hist}] }
```

- `time` 为 epoch 毫秒且对齐整分钟；`ma` 的键是周期字符串，预热不足的位置为 `null`（前端断线不画假线）。
- `limit` 默认 200、上限 500、下限 60；`symbol` 仅允许字母数字（防注入）。
- 数据来源：榜单内标的直接复用监控已在维护的 `candleCache`（含 WS 实时推进，**零额外请求**）；榜单外标的走 45s TTL 的 REST 兜底，`source` 字段会标明是 `monitor` 还是 `rest`。
- 前端对齐整分钟边界轮询（`web/src/hooks/useKlines.ts`），K 线只在收盘时才定局，没必要一分钟请求多次。

### Docker 部署（容器内置 mihomo 代理）

生产镜像内置 **mihomo（Clash.Meta）** 内核与 Geo 数据：容器启动时由 `docker/entrypoint.sh` 先在容器内拉起 mihomo，再把 `PROXY` / `HTTPS_PROXY` / `HTTP_PROXY` 指向 `http://127.0.0.1:7890`，最后 `exec npm start`。因为 `src/binance.ts` 与 `src/telegram.ts` 都用 undici 的 `EnvHttpProxyAgent`，**Binance 行情监控、60D 趋势、Telegram 播报全部经由容器内 mihomo 出站**，宿主机不需要再开 Clash，也不必配 `host.docker.internal`。

默认（provider 模式）会把订阅节点按 `fapi.binance.com` 健康检查（`expected-status=200`）自动筛选，规避机房被 Binance `HTTP 451` 屏蔽的问题。

提供代理节点有两种方式（优先级：挂载配置 > 订阅地址 > 内置默认直连配置）：

```bash
# 方式 1（推荐）：在 .env 里给 Clash/Mihomo YAML 订阅地址
MIHOMO_SUBSCRIPTION_URL=https://example.com/api/v1/client/subscribe?token=xxx

# 也支持多个订阅源（逗号 / 空格 / 换行分隔），每个都作为 mihomo proxy-provider 加载。
# docker-compose 默认已内置以下两个公共订阅源，不配置时直接生效：
#   https://raw.githubusercontent.com/wzmwayne/proxy-node/main/output/aio/clash.yaml
#   https://raw.githubusercontent.com/ovmvo/FreeSub/refs/heads/main/sub/permanent/mihomo.yaml

# 方式 2：挂载自己的完整配置（含 proxies / proxy-groups / rules），优先级最高
mkdir -p docker/mihomo
# 把你的 config.yaml（含 proxy-providers 订阅亦可）放到 docker/mihomo/config.yaml
# 然后在 docker-compose.yml 中放开：
#   volumes:
#     - ./docker/mihomo/config.yaml:/etc/mihomo/config.yaml:ro
```

**为什么默认用 provider 模式（自动规避 Binance 451）**：很多机房（尤其美国云主机）会被 Binance 以 `HTTP 451` 拒绝。若把订阅直接当配置用，节点由订阅自己的规则/默认选择决定，可能恰好选中被屏蔽的节点；本项目默认把订阅转成 `proxy-provider`，并生成一个对 Binance 做健康检查的 `fallback` 组：

```yaml
proxy-groups:
  - name: PROXY
    type: fallback
    url: https://fapi.binance.com/fapi/v1/ping
    expected-status: 200     # 只有能 200 命中 Binance 的节点才算可用
```

这样 `PROXY` 组只会选中能正常访问 `fapi.binance.com` 的节点，节点失效时自动切换，`DOMAIN-SUFFIX,binance.com / telegram.org` 等流量统一走它。若想完全沿用订阅自带的规则与节点，可设 `MIHOMO_CONFIG_MODE=raw`。

> ⚠️ **重要：mihomo 的 health-check 并不校验 HTTP 状态码**（实测 v1.19.32：把探测地址换成对所有人都返回 500 的 URL，节点依旧被判为 alive；`expected-status` 在该版本中也不生效）。也就是说被 Binance 以 **451** 拒绝的节点仍会被标成 alive 并留在 `PROXY` 组上，仅靠 health-check 无法规避 451。
>
> 因此实际出口由 `ACTIVE` 组承担（rules 指向 `ACTIVE`，默认走 `PROXY` 自动选点），并由 `src/proxyNode.ts` 兜底：一旦真实请求撞上 451 或网络错误，就用 Clash API 把 `ACTIVE` 切到其它候选节点，并**逐个探测确认真的能 200 命中 Binance** 再采用（`PROXY_PROBE_TRIES` 控制探测数）。探测不通的节点会被拉黑，不再重复选用。

```bash
# 在 .env 中配置 DOMAIN / TELEGRAM_* 后一键启动
docker compose up -d --build
docker compose logs -f binance-macd-monitor   # 可见 [entrypoint] 与 mihomo 日志
```

要点与排错：

- **订阅格式**：只支持 Clash / Mihomo 的 YAML 订阅（`proxies:` / `proxy-groups:` …）。base64 分享链接列表无法直接使用，请先用 subconverter 之类转成 Clash 配置再挂载，或直接挂载成品 `config.yaml`。
- **多个订阅**：`MIHOMO_SUBSCRIPTION_URL` 可用逗号 / 空格 / 换行分隔多个地址，全部作为 provider 加载；某个源失效不影响其它源。
- **选点与 451 规避**：provider 模式下 `PROXY` 组按 `MIHOMO_HEALTHCHECK_URL`（默认 `https://fapi.binance.com/fapi/v1/ping`）做健康检查，`expected-status=200` 才算可用，因此被 Binance 屏蔽的节点会被自动跳过。启动后前 ~10-15 秒健康检查还在跑，可能短暂拿到 451，随后会自动切到可用节点。
- **raw 模式**：`MIHOMO_CONFIG_MODE=raw`，按顺序下载第一个可用的订阅直接当配置用；其中的 `mixed-port` / `port` / `socks-port` 会被自动改写为 `MIHOMO_PROXY_PORT`（默认 7890），控制端口收敛到 `127.0.0.1:9090`。
- **没配节点也能跑**：未提供订阅也没挂载配置时，使用 `docker/mihomo/config.default.yaml`（`MATCH,DIRECT` 全部直连），监控不会中断，只是等于没走代理；日志会提示。
- **不想用容器内代理**：`MIHOMO_ENABLE=0` 关闭 mihomo；或显式设置 `PROXY`（如 `PROXY=http://host.docker.internal:7890` 走宿主机 Clash），此时 entrypoint 会沿用你的设置不再自动指向容器内 mihomo。
- **拉订阅本身需要代理**（仅 raw 模式下载订阅时使用）：`MIHOMO_SUBSCRIPTION_PROXY=http://host.docker.internal:7890`（compose 已声明 `host.docker.internal` 网关映射）。
- **改端口**：`MIHOMO_PROXY_PORT=7890`（raw 模式会自动对齐配置里的 `mixed-port`）。
- **升级内核**：`MIHOMO_VERSION` 默认 `v1.19.32`，可在构建时覆盖：`docker compose build --build-arg MIHOMO_VERSION=v1.19.40`；国内网络拉不动 GitHub 时用镜像前缀 `--build-arg MIHOMO_DOWNLOAD_BASE=https://gh-proxy.com/https://github.com/MetaCubeX/mihomo/releases/download`。
- **挂载整个配置目录**会覆盖镜像内置的 `geoip.metadb` / `geosite.dat`，含 `GEOIP`/`GEOSITE` 规则的配置首次启动会尝试联网下载；建议只挂载单个 `config.yaml` 文件。
## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `4111` | 本地服务端口 |
| `TOP_N` | `10` | 每个榜单取前 N |
| `REFRESH_TTL_MS` | `20000` | 快照缓存时长 |
| `KLINE_LIMIT` | `100` | 1m K 线取多少根（≥35 才能稳定算 MACD） |
| `HIGH_RATIO` | `0.9` | "高位"阈值：DEA ≥ 该比例 × 窗口峰值即算接近（旧规则，当前不再使用） |
| `HIGH_WINDOW` | `100` | "高位"观察窗口（1m 根数，旧规则，当前不再使用） |
| `BINANCE_BASE` | `https://fapi.binance.com` | 合约行情基址 |
| `FALLBACK_BASE` | _(空)_ | 主基址网络不可达时自动重试的回退地址（仅对连接级失败生效，HTTP 错误如 429/451 不重试）。合约无公开镜像，默认空；仅在自建反代时设置 |
| `TELEGRAM_BOT_TOKEN` | _(空)_ | Telegram Bot Token（@BotFather 创建）。**不配则不推送**（启动与命中时都会显式警告，不静默） |
| `TELEGRAM_CHAT_ID` | _(空)_ | 接收告警的 chat id（个人：向 @userinfobot 查询；群：把 bot 拉入后用 getUpdates 拿） |
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | Telegram Bot API 基址（自建反代时可改） |
| `TG_ALERT_MIN` | `1` | Telegram 告警阈值：任意一个榜单出现 ≥ N 个「连阳涨幅达标 + 无MA支撑 + 近30根1mMACD绿柱>80%」时推送 |
| `TG_REPEAT_MINUTES` | `0` | 持续命中时的重发间隔（分钟），0 = 仅在首次触发时通知 |
| `DASHBOARD_URL` | `https://macd.reluv.xyz` | Telegram 提醒中附带的面板链接地址 |
| `PROXY` | _(空)_ | 本应用专用的代理地址（如 `http://127.0.0.1:7890`），**设置后强制走该代理**；未设置则回退到标准 `HTTPS_PROXY`/`HTTP_PROXY`（`NO_PROXY` 同样生效），都未设置则直连。由 undici `ProxyAgent`/`EnvHttpProxyAgent` 应用到所有 fetch（**含 Telegram API**） |
| `STREAK_MIN_COUNT` | `2` | 连阳最低根数（`streakCount ≥ N` 才触发告警） |
| `STREAK_GAIN_THRESHOLD` | `1.0` | 连阳累计涨幅阈值（`≥ N%` 才触发告警） |

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

- `GET /fapi/v1/ticker/24hr` — 全市场 USDM 合约 24h 行情，用于排序涨幅榜；
- `GET /fapi/v1/klines?interval=1m&limit=100` — 1m K 线，用于计算 MACD。

已过滤：仅保留 `*USDT` **永续合约**，剔除交割合约（带 `_YYMMDD` 后缀，如 `BTCUSDT_240329`）。币本位合约（`*USD_PERP`）因不以 `USDT` 结尾自动排除。

## 结构

```
src/
  types.ts     # 共享类型（Row / Status / HighBearSummary），server 与 web 都用，纯类型无副作用
  macd.ts      # EMA / MACD 计算 + 连阳统计 + 绿柱占比计算
  binance.ts   # Binance REST 客户端（24h 行情 + 1m K 线）
  telegram.ts  # Telegram Bot API 发送（走全局代理）
  alert.ts     # 「连阳涨幅达标 + 无MA支撑 + 近30根1mMACD绿柱>80%」计数 + 边沿触发 Telegram 告警状态机
  server.ts    # 本地 HTTP 服务 + 托管 web/dist 静态资源 + /api/status
research/      # 独立 CLI：小时数据、历史三榜、多轮参数回测与报告
web/           # React 前端（Vite + TypeScript）
  src/
    App.tsx          # 面板布局：header / 窄屏 tab / 涨幅榜
    App.css          # 暗色主题 + 响应式 tab
    components/      # GroupSection / Row
    hooks/useStatus.ts  # 每 5s 轮询 /api/status
    lib/format.ts    # fmt / pct / colClass
```

开发验证：`npm run typecheck`、`npm test`、`npm run build`。测试使用本地模拟数据与模拟 Telegram 服务，不请求真实通知服务。

> 仅用于研究/观察，不构成交易建议。MACD 1m 信号噪声大，连阳涨幅达标需结合其他条件判断。

### M1 Pro GPU 策略挖掘

以现有报告为基线，交叉搜索1m、15m各自的DEA高/中/低及DIFF多/空，共36种状态组合，再交叉独立的高位阈值与连阳/连阴根数；两个周期都强制无 MA 支撑（MA5/7/10/20/25/30/60/99/120），可用 Apple Metal 批量挖掘 1–60 分钟、小止损、扣费后目标盈亏比 ≥3 的参数组合。默认10倍逐仓、每笔100 USDT保证金、总资金1000 USDT；按账户收益与净值回撤选参，处理资金不足、保证金占用和近似强平。默认使用报告的本地完整行情和 `.env` Telegram 配置，每轮正收益训练新纪录、最终验证结果会播报，并保存断点与失败重试队列。

```bash
npm run mine:setup
npm run mine -- --fetch-fifteen --batch 128
# 中断后继续
npm run mine -- --resume --batch 128
```

两个周期分别配置、交叉组合：1m连续根数1/2/3/5/8，15m为1/2/3/4/6，各含连阳、连阴和不限。默认从58,063,544组有效参数中按状态和连续条件分层抽取400,000组（`--max-trials`），固定种子、无放回，完成只表示预定清单跑完。

默认输出 `reports/research/gainers-gpu-margin-no-ma-streak/report.md`。训练发现会明确标注"尚未留出验证"；复用原报告的一天数据不构成新独立验证。完整选项、验证流程、新数据获取及 Telegram 补发见 [GPU 挖掘说明](research/README.md#m1-pro-gpu-超短线挖掘与-telegram-成果播报)。
