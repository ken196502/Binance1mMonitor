# Binance 1m 行情监控与形态研究

核心流程：行情监控 → x 分钟内达标振幅的前置特征统计 → 多空形态参数挖掘 → 二阶段回测与模拟交易，配合 Telegram 播报和 mihomo 自动切换线路。

## 运行口径

- 监控 Binance USDT 永续合约涨幅榜，保留置顶和追踪标的；每分钟对齐扫描，WebSocket 驱动实时价格与模拟平仓。
- `24h/N` 沿用现有 **24h 涨跌幅的绝对值 / N**。它不是 24h 最高价与最低价之间的振幅。默认策略标的仍筛选正涨幅榜。
- 研究样本以之后 x 分钟相对起始开盘价的上涨/下跌幅度判定是否达标；形态特征只取事件开始前的已收盘 K 线。未来价格只用于事件标签和回测退出。
- 图表展示按 x 分钟时间桶提取的最大有序冲高/回撤段，以及该段启动前的特征；缺少前置数据时不伪造前置特征。
- 特征最多使用 500 根连续已收盘 K 线，至少需要 60 根；遇到缺口重新预热。默认行情缓存为 500 根已收盘加 1 根形成中 K 线。
- 量化做多沿用蓄势与支撑条件，量化做空沿用冲高后的衰竭条件。现有独立策略与持久化参数仍兼容，可通过面板分别开关。

## 仓位、退出与统计

默认每笔分配当前净权益的 **20%**，全局最多 **5** 个持仓/挂单，每策略最多 **1** 个；远程参数可以降低仓位与总仓数，不能超过这些上限。已有仓位延续原参数；同一币种互斥。部分平仓仍占用一个槽位，挂单也预留保证金。资金不足时不新开仓；低权益时不再强行抬高到 5 USDT。

两阶段各平原始仓位的 50%。支持独立 TP1、TP2、止损、最长持仓时间；TP1 后可把剩余仓位止损移至包含手续费和滑点的成本保本价。价格跳空仍可能导致实际亏损。

单策略候选与组合回测共用 `research/strategy-replay.ts`：

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
npm start
```

服务默认端口 `4111`；生产启动前执行 `npm run build`。网络、Telegram 与部署参数使用 `.env`；策略参数通过 API 持久化到 `data/paper-trading.json`，采用临时文件后原子替换保存。

## 挖掘与远程设置

```bash
# --window / --divisor 控制前置事件统计的 x 与 N；候选形态按内置网格搜索
npm run mine:strategy -- --quick --window 15 --divisor 10
npm run mine:strategy -- --window 15 --divisor 10

# 阅读 reports/strategy-mining-report.md 与 data/mined-strategy.json 后应用
npm run deploy:strategy -- --url https://macd.subx.fun
```

读取历史 `.json`、`.json.gz` 和实时归档 `data/research/live-1m/*.jsonl`，跨日合并、按时间去重，计算数据内容哈希。榜单只使用当时可用的已收盘行情；不足完整 24h 的分钟历史不冒充 24h 涨幅，存在历史小时快照时可沿用已知快照。

默认训练/验证/留出比例 60/20/20；`--val-recent` 为 70/15/15，区间互不重叠。输出多空排名、验证结果和组合表现。**特征/执行口径已升级至 2.1.0，旧报告需要重新挖掘，不能直接沿用其胜率。**

面板“策略参数设置”可分别修改量化多、空的 x、N、均线/MACD 条件、TP1/TP2、止损、持仓时间、冷却、杠杆和保本开关。编辑期间后台轮询不会覆盖输入。

| API | 用途 |
| --- | --- |
| `GET /api/status` | 行情快照与模拟账户摘要 |
| `GET /api/paper-trading` | 账户、挂单、持仓、历史及多空统计 |
| `GET /api/paper-trading/config` | 当前参数 |
| `POST /api/paper-trading/config` | 合并更新参数（也支持 PUT/PATCH）；非法形态参数整次拒绝 |
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

## Telegram 与 mihomo

配置 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`、`DASHBOARD_URL` 即可播报行情、挂单、开仓和两阶段平仓。网络请求沿用 `PROXY` / `HTTP(S)_PROXY`。

Docker 保留现有 mihomo 启动、订阅、Binance 健康检查、失败节点回避和线路切换机制。主要参数为 `MIHOMO_SUBSCRIPTION_URL`、`MIHOMO_CONFIG_MODE`、`MIHOMO_PROXY_PORT`；详见 `.env.example` 与 `docker-compose.yml`。部署前备份 `data/`，保持该目录挂载以延续现有账户与配置。

```bash
docker compose up -d --build
```

核心目录：`src/` 为监控、特征、交易及通知；`research/strategy-replay.ts` 为共用回测；`scripts/mine-strategy.ts` 为挖掘入口；`web/` 为监控与参数面板。其他研究脚本保留为历史实验入口。
