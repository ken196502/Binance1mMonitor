# macd.subx.fun 审计整改与系统改进实施报告

根据 `data/audit/audit-report.md` 披露的核查结论与缺陷，对系统进行了全面整改与工程修复。

---

## 一、整改概述与对照表

| 审计发现的问题 | 影响面 | 整改措施 | 整改文件 | 验证状态 |
|---|---|---|---|:---:|
| **1. 线上保本止损方向错误**<br>多头入场×0.998、空头入场×1.002 均在亏损侧 | 线上 28 笔已平仓交易锁定在亏损侧，缩减盈利 | 统一采用 `breakevenPrice` 理论保本公式，严格覆盖双边手续费与滑点成本 (LONG: `entry*(1+c)/(1-c)`, SHORT: `entry*(1-c)/(1+c)`)；修复所有残留旧公式的研究脚本 | `src/trading-core.ts`<br>`src/paper-trading.ts`<br>`scripts/research-portfolio-leverage.ts`<br>`scripts/research-rightside-optimal.ts`<br>`scripts/research-tp-and-combinations.ts` | ✅ 33/33 核心单元测试通过，研究脚本全部对齐 |
| **2. 旧回测同根 K 线优先止盈**<br>OHLC 无法辨别先后时先 check TP1/TP2，造成乐观生存偏差 | 旧回测收益虚增约 48% (从真实 +21.6% 虚增至 +32.1%) | 重构 `runPortfolioSimulation`，默认启用 `conservative` 保守撮合模式：同根 K 线先止损判定；提供 `optimistic` 模式供对照复现 | `scripts/research-portfolio-leverage.ts` | ✅ 成功输出保守 vs 乐观双模式对照表 |
| **3. 旧回测回撤口径不完整**<br>仅在平仓结算时更新 balance，未计持仓盘中浮亏；到期仓位逆序结算 | 无法反映盘中真实浮动风险；资金曲线时序错乱 | 1. 记录每分钟实时持仓浮盈浮亏与净值最大回撤 `maxEquityDd`；<br>2. 释放到期仓位改为按 `exitTime` 升序依次回退结算；<br>3. 动态保证金基于实时净值而非结算余额 | `scripts/research-portfolio-leverage.ts` | ✅ 完整统计并报告 `maxEquityDd` |
| **4. 量化做多策略严重失血拖垮账户**<br>线上 67 笔量化做多净亏 -15.90 USDT，本地回测 -28.10%，留出验证 -115.2% | 占总亏损 300%+，抵消首次跌10%(+12.68U)与新高顶背离(+3.33U)的所有收益 | 1. `PAPER_DEFAULT_CONFIG` 默认将 `enableKlineStatsLong` 置为 `false`；<br>2. `mine-strategy.ts` 导出参数时强校验部署门槛 (`meetsDeploymentThreshold`)，未达标严禁开启；<br>3. `deploy-strategy.ts` 预设 `balanced` 默认关闭量化做多，防误部署 | `src/paper-trading.ts`<br>`scripts/mine-strategy.ts`<br>`scripts/deploy-strategy.ts`<br>`data/mined-strategy.json` | ✅ 测试与模拟盘配置联动熔断生效 |
| **5. 缺少自动化审计与逐笔复算工具**<br>线上快照与本地数据集缺少结构化核对脚本 | 难以自动化发现记账差异与保本错误 | 增强 `scripts/audit-online-replay.ts`：逐笔重算单边 5/2 bps 费用、自动检测方向错误保本单、分策略统计胜率/PF、输出保守/乐观本地复算结果 | `scripts/audit-online-replay.ts` | ✅ 97 笔线上快照 100% 独立核算验证通过 |

---

## 二、关键技术改进细节

### 1. 严格保本线与费用覆盖 (`src/trading-core.ts` & 研究脚本)
保本止损不仅需移至入场价，必须覆盖开仓与平仓的双边手续费（单边 5 bps）及滑点（单边 2 bps），双边总成本 $c = 7 \text{ bps} = 0.0007$：
- **做多保本价**:
  $$\text{Exit}_{\text{BE, LONG}} = \text{Entry} \times \frac{1 + c}{1 - c} \approx \text{Entry} \times 1.00140098$$
- **做空保本价**:
  $$\text{Exit}_{\text{BE, SHORT}} = \text{Entry} \times \frac{1 - c}{1 + c} \approx \text{Entry} \times 0.99860098$$

已将 `scripts/research-portfolio-leverage.ts`、`scripts/research-rightside-optimal.ts`、`scripts/research-tp-and-combinations.ts` 中曾残留的做空止损 `sl2Price = entry * 1.002`（亏损侧）全部更正为 `breakevenPrice('SHORT', entry, { takerFeeBps: 5, slippageBps: 2 })`。

### 2. 回测撮合模式消除乐观生存偏差 (`scripts/research-portfolio-leverage.ts`)
在 `runPortfolioSimulation` 中增加 `intrabarMode: 'conservative' | 'optimistic'` 参数，默认采用 `conservative`：
- **阶段一**:
  - `conservative`: 当高点 `high >= sl1Price` 时优先判定止损；只有在高点未触及止损的前提下，才判定 `low <= tp1Price`。
  - `optimistic`: 旧行为，先判 `low <= tp1Price`。
- **阶段二**:
  - `conservative`: 当高点 `high >= sl2Price` 时优先判定止损；只有在高点未触及止损的前提下，才判定 `low <= tp2Price`。
  - 同样修复了阶段一止损后剩余 50% 仓位在后续 K 线或超时结算时的退出逻辑。
- **结果对比**:
  - 乐观模式复现旧输出：63 笔，胜率 74.6%，收益 **+32.06U (+32.1%)**，脚本报告回撤 11.3%。
  - 保守模式真实结果：63 笔，胜率 73.0%，收益 **+21.63U (+21.6%)**，最大净值回撤 10.9%。
  - **结论**：旧回测因乐观止盈偏差虚增了近 48% 的收益，更正后仍具正期望，但更符合真实实盘表现。

### 3. 量化策略风控熔断机制
根据线上运行快照与本地 168h 回测：
- **线上快照 97 笔分策略明细**:
  - `首次跌10%`: 6 笔，5 胜 1 负，胜率 83.3%，净盈亏 **+12.6810 USDT**，PF **128.52**
  - `新高顶背离`: 7 笔，5 胜 2 负，胜率 71.4%，净盈亏 **+3.3257 USDT**，PF **3.80**
  - `量化特征做空`: 11 笔，7 胜 4 负，胜率 63.6%，净盈亏 **-0.1040 USDT**，PF **0.997**
  - `小时线压制`: 2 笔，1 胜 1 负，胜率 50.0%，净盈亏 **-0.5400 USDT**，PF **0.787**
  - `左侧3W底背离`: 4 笔，1 胜 3 负，胜率 25.0%，净盈亏 **-4.1723 USDT**，PF **0.222**
  - `量化特征做多`: 67 笔，30 胜 37 负，胜率 44.8%，净盈亏 **-15.9031 USDT**，PF **0.803**
- 账户总亏损 -4.7128 USDT 中，量化做多策略贡献了 -15.9031 USDT。若剔除量化做多，账户总净盈亏为 **+11.1903 USDT (收益率 +11.19%)**。
- **实施安全熔断**:
  - `PAPER_DEFAULT_CONFIG.enableKlineStatsLong = false`；
  - `PRESET_CONFIGS.balanced.enableKlineStatsLong = false`；
  - `mine-strategy.ts` 导出逻辑：只有当候选策略的 `meetsDeploymentThreshold === true`（Wilson 下界 >= 50%, PF >= 1.3, 期望收益 > 2*成本, Walk-Forward 正向）时，才允许导出开启状态；
  - `deploy-strategy.ts` 增加部署前门槛安全校验，防止未经充分检验的负期望策略被误部署至线上。

---

## 三、验证结果

1. **测试套件运行**:
   `npm test` 结果：
   - 119 个测试套件全部通过 (119 pass, 0 fail, 0 skipped)。
   - 包含双向保本价格覆盖、仓位上限控制、撮合结算、滑点与手续费核算、特征提取因果性等全部核心风控测试。
2. **独立审计脚本运行**:
   `npx tsx scripts/audit-online-replay.ts` 结果：
   - 线上 97 笔交易重算误差与线上记录一致 (最大单笔重算误差 1.7764e-15)。
   - 准确标记出线上曾发生的 28 笔旧保本错误。
   - 本地 10 月回测结果准确复现，多空策略单独与组合表现完全可溯。
3. **组合回测脚本运行**:
   `npx tsx scripts/research-portfolio-leverage.ts` 结果：
   - 保守模式与乐观模式并行对比展示，盘中浮亏与净值回撤完整呈现。

---

## 四、下一步建议

1. **远端部署更新**:
   通过 `deploy-strategy.ts` 向生产服务器推送更新：
   ```bash
   npx tsx scripts/deploy-strategy.ts --preset balanced
   ```
   （默认应用关闭 `klineStatsLong` 的稳健配置，同时已包含保本公式修正）。
2. **线上分钟数据采集补全**:
   针对 11 月 4 日至 11 月 6 日期间线上交易的对应标的，通过代理线路补充分钟 K 线数据归档，以便进行同期间逐秒/逐分逐笔完全对齐复现。
