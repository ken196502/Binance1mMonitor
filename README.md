# Binance 1m MACD 高位死叉监控（u本位合约）

监控 Binance **u本位永续合约（USDM Futures）** 24h **涨幅前十 / 跌幅前十 / 成交额前十** 的 **1 分钟 MACD** 是否出现**高位死叉**，命中则高亮显示。

## 高位死叉定义

- **死叉**：最近一根已收盘 1m K 线上，MACD 的 DIF 下穿 DEA（前一根 `DIF ≥ DEA`，当前 `DIF < DEA`）。
- **高位**：当前 `DEA` **接近或达到指定观察周期内的最高值**，即 `DEA ≥ HIGH_RATIO × max(DEA in window)`。默认 `HIGH_RATIO=0.9`、`HIGH_WINDOW=100`（1m K 线，即观察窗口约 100 分钟）。
- 同时满足（死叉 + 高位）即为「高位死叉」告警，面板以红底高亮。

> 只有当窗口内 DEA 曾达到正值峰值时才判定为"高位"，避免全程为负时把"最不低"的值误判为高位。

MACD 参数：`12 / 26 / 9`，柱状值 `= 2 × (DIF − DEA)`（Binance 口径）。

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
| `PROXY` | _(空)_ | 本应用专用的代理地址（如 `http://127.0.0.1:7890`），**设置后强制走该代理**；未设置则回退到标准 `HTTPS_PROXY`/`HTTP_PROXY`（`NO_PROXY` 同样生效），都未设置则直连。由 undici `ProxyAgent`/`EnvHttpProxyAgent` 应用到所有 fetch |

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
  types.ts     # 共享类型（Row / Status），server 与 web 都用，纯类型无副作用
  macd.ts      # EMA / MACD 计算 + 高位死叉判定
  binance.ts   # Binance REST 客户端（24h 行情 + 1m K 线）
  server.ts    # 本地 HTTP 服务 + 托管 web/dist 静态资源 + /api/status
web/           # React 前端（Vite + TypeScript）
  src/
    App.tsx          # 面板布局：header / 窄屏 tab / 三个榜单
    App.css          # 暗色主题 + 响应式 tab
    components/      # GroupSection / Row
    hooks/useStatus.ts  # 每 5s 轮询 /api/status
    lib/format.ts    # fmt / pct / colClass
```

> 仅用于研究/观察，不构成交易建议。MACD 1m 信号噪声大，高位死叉需结合其他条件判断。
