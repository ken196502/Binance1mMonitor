import path from 'node:path';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import type { MinuteDataset } from '../research/gainers-types.ts';
import { MINUTE } from '../research/gainers-types.ts';
import { loadAllMinutes, extractAllSignals, type RawSignal } from './research-low-leverage-long-hold.ts';

interface ComboConfig {
  name: string;
  holdMinutes: number;
  stopLossPct: number; // 止损百分比 (e.g. 8, 10, 15)
  tp1Pct: number;      // 第一阶段止盈 (e.g. 5, 8)
  tp2Pct: number;      // 第二阶段止盈 (e.g. 10, 15)
  tp1Fraction: number; // 第一阶段平仓比例 (0.5 或 0)
  moveSlToEntryAfterTp1: boolean; // 阶段一达标后，是否将剩余仓位止损移动至保本价 (Breakeven)
  leverage: number;    // 杠杆
}

interface ComboResult {
  config: ComboConfig;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  pf: number | null;
  unleveragedNet: number;
  leveragedNet: number;
  meanTradePct: number;
  maxDrawdownPct: number;
  calmar: number | null;
  liquidations: number;
  tp1Hits: number;
  tp2Hits: number;
  slHits: number;
  timeouts: number;
}

function runComboSimulation(
  minuteData: MinuteDataset,
  signals: RawSignal[],
  cfg: ComboConfig,
  filterStrategy?: string
): ComboResult {
  const filtered = filterStrategy ? signals.filter(s => s.strategyId === filterStrategy) : signals;
  const occupiedUntil = new Map<string, number>();
  const cooldownUntil = new Map<string, number>();

  const takerFeeBps = 5;
  const slippageBps = 2;
  const liqThresholdPct = 100.0 / cfg.leverage * 0.95;

  let wins = 0;
  let losses = 0;
  let grossGains = 0;
  let grossLosses = 0;
  let totalUnleveragedNet = 0;
  let totalLeveragedNet = 0;
  let liquidations = 0;

  let tp1Hits = 0;
  let tp2Hits = 0;
  let slHits = 0;
  let timeouts = 0;

  const tradeResults: number[] = [];

  for (const sig of filtered) {
    if ((occupiedUntil.get(sig.symbol) ?? -Infinity) > sig.entryTime) continue;
    if ((cooldownUntil.get(sig.symbol) ?? -Infinity) > sig.entryTime) continue;

    const bars = minuteData.candles.get(sig.symbol);
    if (!bars) continue;

    const fillIdx = bars.findIndex(b => b[0] === sig.entryTime);
    if (fillIdx < 0) continue;

    const entry = sig.entryPrice;
    let currentStop = entry * (1 + cfg.stopLossPct / 100);
    const tp1Price = entry * (1 - cfg.tp1Pct / 100);
    const tp2Price = entry * (1 - cfg.tp2Pct / 100);
    const liqPrice = entry * (1 + liqThresholdPct / 100);

    let stage1Closed = cfg.tp1Fraction === 0; // 如果不分批，直接当做阶段一已跳过
    let stage2Closed = false;

    let tradeNetPct = 0;
    let finalExitTime = sig.entryTime + cfg.holdMinutes * MINUTE;
    const maxSteps = Math.min(cfg.holdMinutes, bars.length - fillIdx);

    for (let step = 0; step < maxSteps; step++) {
      const b = bars[fillIdx + step];
      if (!b) break;
      const high = b[2];
      const low = b[3];
      const close = b[4];

      // 1. 强平检查
      if (high >= liqPrice) {
        const rem = !stage1Closed ? 1.0 : 1.0 - cfg.tp1Fraction;
        tradeNetPct -= (100.0 / cfg.leverage) * rem;
        liquidations++;
        finalExitTime = b[0];
        break;
      }

      // 2. 止损检查
      if (high >= currentStop) {
        const exitP = high;
        const rem = !stage1Closed ? 1.0 : 1.0 - cfg.tp1Fraction;
        const gross = ((entry - exitP) / entry) * 100;
        const fee = (takerFeeBps * 2 + slippageBps) / 100;
        tradeNetPct += (gross - fee) * rem;
        slHits++;
        finalExitTime = b[0];
        break;
      }

      // 3. 阶段一止盈
      if (!stage1Closed && low <= tp1Price) {
        const gross = ((entry - tp1Price) / entry) * 100;
        const fee = (takerFeeBps * 2 + slippageBps) / 100;
        tradeNetPct += (gross - fee) * cfg.tp1Fraction;
        stage1Closed = true;
        tp1Hits++;

        // 若开启保本，移动剩余仓位止损至入场价 (微加手续费缓冲)
        if (cfg.moveSlToEntryAfterTp1) {
          currentStop = entry * 1.002;
        }

        // 若同一根 K 线也打到了 TP2
        if (low <= tp2Price) {
          const gross2 = ((entry - tp2Price) / entry) * 100;
          tradeNetPct += (gross2 - fee) * (1.0 - cfg.tp1Fraction);
          stage2Closed = true;
          tp2Hits++;
          finalExitTime = b[0];
          break;
        }
      }

      // 4. 阶段二止盈
      if (stage1Closed && !stage2Closed && low <= tp2Price) {
        const rem = 1.0 - (cfg.tp1Fraction > 0 ? cfg.tp1Fraction : 0);
        const gross = ((entry - tp2Price) / entry) * 100;
        const fee = (takerFeeBps * 2 + slippageBps) / 100;
        tradeNetPct += (gross - fee) * rem;
        stage2Closed = true;
        tp2Hits++;
        finalExitTime = b[0];
        break;
      }

      // 5. 超时到期平仓
      if (step === maxSteps - 1) {
        const rem = !stage1Closed ? 1.0 : !stage2Closed ? 1.0 - cfg.tp1Fraction : 0;
        if (rem > 0) {
          const gross = ((entry - close) / entry) * 100;
          const fee = (takerFeeBps * 2 + slippageBps) / 100;
          tradeNetPct += (gross - fee) * rem;
          timeouts++;
        }
        finalExitTime = b[0];
      }
    }

    const levPnl = tradeNetPct * cfg.leverage;
    tradeResults.push(levPnl);

    totalUnleveragedNet += tradeNetPct;
    totalLeveragedNet += levPnl;

    if (tradeNetPct > 0) {
      wins++;
      grossGains += tradeNetPct;
    } else {
      losses++;
      grossLosses += Math.abs(tradeNetPct);
    }

    occupiedUntil.set(sig.symbol, finalExitTime);
    cooldownUntil.set(sig.symbol, Math.max(finalExitTime, sig.entryTime + 20 * MINUTE));
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades ? (wins / totalTrades) * 100 : 0;
  const pf = grossLosses > 0 ? grossGains / grossLosses : grossGains > 0 ? 999 : null;

  // 计算最大回撤 (单笔 20% 保证金)
  let peak = 100;
  let equity = 100;
  let maxDd = 0;
  for (const levPnl of tradeResults) {
    equity += equity * 0.20 * (levPnl / 100);
    if (equity <= 0) { equity = 0; maxDd = 100; break; }
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDd) maxDd = dd;
  }
  const calmar = maxDd > 0 ? totalLeveragedNet / maxDd : null;

  return {
    config: cfg,
    trades: totalTrades,
    wins,
    losses,
    winRate,
    pf,
    unleveragedNet: totalUnleveragedNet,
    leveragedNet: totalLeveragedNet,
    meanTradePct: totalTrades ? totalUnleveragedNet / totalTrades : 0,
    maxDrawdownPct: maxDd,
    calmar,
    liquidations,
    tp1Hits,
    tp2Hits,
    slHits,
    timeouts,
  };
}

async function main() {
  console.log('========================================================================================');
  console.log('🎯【进阶网格挖掘】大止损 + 大止盈 + 动态保本 + 长持仓的最优组合搜寻');
  console.log('========================================================================================\n');

  const hourly = await loadDataset(path.resolve('data/research/hourly-168h'));
  const frames = buildFrames(hourly, 10, 1);
  const minuteData = await loadAllMinutes();
  const allSignals = await extractAllSignals(minuteData, frames, hourly);

  console.log(`载入完成，测试信号总数: ${allSignals.length}`);

  // 网格参数空间定义
  const holdOptions = [30, 45, 60, 90, 120, 180, 240];
  const stopLossOptions = [6.0, 8.0, 10.0, 12.0, 15.0];
  const tpPairs = [
    { tp1: 4.0, tp2: 8.0, name: '稳健型 (TP1=4%, TP2=8%)' },
    { tp1: 5.0, tp2: 10.0, name: '进取型 (TP1=5%, TP2=10%)' },
    { tp1: 6.0, tp2: 12.0, name: '大波段 (TP1=6%, TP2=12%)' },
    { tp1: 8.0, tp2: 15.0, name: '超级波段 (TP1=8%, TP2=15%)' },
    { tp1: 10.0, tp2: 20.0, name: '暴跌捕鲸 (TP1=10%, TP2=20%)' },
    { tp1: 0, tp2: 0, name: '纯到期平仓 (不设TP)' },
  ];
  const leverageOptions = [2, 3, 5];

  console.log('\n--- 阶段 A: 全组合网格扫描 (探索最高胜率、最高 PF 与最高卡玛组合) ---');

  const allResults: ComboResult[] = [];

  for (const h of holdOptions) {
    for (const sl of stopLossOptions) {
      for (const tp of tpPairs) {
        for (const be of [true, false]) {
          for (const lev of leverageOptions) {
            const isNoTp = tp.tp1 === 0;
            const cfg: ComboConfig = {
              name: `H${h}m_SL${sl}%_${tp.name}_BE${be}_${lev}x`,
              holdMinutes: h,
              stopLossPct: sl,
              tp1Pct: tp.tp1,
              tp2Pct: tp.tp2,
              tp1Fraction: isNoTp ? 0 : 0.5,
              moveSlToEntryAfterTp1: be,
              leverage: lev,
            };

            const res = runComboSimulation(minuteData, allSignals, cfg);
            allResults.push(res);
          }
        }
      }
    }
  }

  console.log(`网格完成，共评估 ${allResults.length} 种参数组合！`);

  // 1. 按盈利因子 (PF) 排序 Top 10 (要求交易笔数 >= 40, 最大回撤 <= 35%)
  const topPf = allResults
    .filter(r => r.trades >= 40 && r.maxDrawdownPct <= 35 && r.pf !== null && r.liquidations === 0)
    .sort((a, b) => (b.pf ?? 0) - (a.pf ?? 0));

  console.log('\n========================================================================================');
  console.log('🏆【TOP 10 最佳盈亏比 (Profit Factor) 组合】(严格要求零爆仓、回撤<=35%)');
  console.log('========================================================================================');
  console.log('| 排名 | 组合配置 | 胜率 (%) | PF | 3x累计收益% | 最大回撤% | 收益/回撤比 | 止盈1/止损触发 | 评价 |');
  console.log('| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |');

  for (let i = 0; i < Math.min(10, topPf.length); i++) {
    const r = topPf[i];
    const c = r.config;
    const tpDesc = c.tp1Pct > 0 ? `TP:${c.tp1Pct}%/${c.tp2Pct}%` : 'No-TP';
    const beDesc = c.moveSlToEntryAfterTp1 ? '保本' : '不保本';
    const desc = `${c.leverage}x | ${c.holdMinutes}m | SL:${c.stopLossPct}% | ${tpDesc} | ${beDesc}`;
    console.log(
      `| ${(i + 1).toString().padStart(2)} | ${desc.padEnd(46)} | ${r.winRate.toFixed(1).padStart(7)}% | ${(r.pf?.toFixed(2) ?? '').padStart(5)} | ${r.leveragedNet.toFixed(1).padStart(11)}% | ${r.maxDrawdownPct.toFixed(1).padStart(8)}% | ${(r.calmar?.toFixed(2) ?? '').padStart(10)} | ${String(r.tp1Hits).padStart(2)}TP1 / ${String(r.slHits).padStart(2)}SL | ${r.pf! > 3.0 ? '🌟 神级稳健' : '卓越'} |`
    );
  }

  // 2. 按卡玛比率 (Calmar Ratio = 收益/回撤) 排序 Top 10
  const topCalmar = allResults
    .filter(r => r.trades >= 40 && r.liquidations === 0 && r.calmar !== null)
    .sort((a, b) => (b.calmar ?? 0) - (a.calmar ?? 0));

  console.log('\n========================================================================================');
  console.log('💎【TOP 10 最佳卡玛比率 (Calmar Ratio = 收益/回撤) 组合】(长期复利最优解)');
  console.log('========================================================================================');
  console.log('| 排名 | 组合配置 | 胜率 (%) | PF | 累计杠杆收益% | 最大回撤% | 卡玛比率 | TP1达标率 | 评价 |');
  console.log('| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |');

  for (let i = 0; i < Math.min(10, topCalmar.length); i++) {
    const r = topCalmar[i];
    const c = r.config;
    const tpDesc = c.tp1Pct > 0 ? `TP:${c.tp1Pct}%/${c.tp2Pct}%` : 'No-TP';
    const beDesc = c.moveSlToEntryAfterTp1 ? '保本' : '不保本';
    const desc = `${c.leverage}x | ${c.holdMinutes}m | SL:${c.stopLossPct}% | ${tpDesc} | ${beDesc}`;
    const tp1Rate = ((r.tp1Hits / r.trades) * 100).toFixed(1);
    console.log(
      `| ${(i + 1).toString().padStart(2)} | ${desc.padEnd(46)} | ${r.winRate.toFixed(1).padStart(7)}% | ${(r.pf?.toFixed(2) ?? '').padStart(5)} | ${r.leveragedNet.toFixed(1).padStart(12)}% | ${r.maxDrawdownPct.toFixed(1).padStart(8)}% | ${(r.calmar?.toFixed(2) ?? '').padStart(8)} | ${tp1Rate.padStart(8)}% | ${r.calmar! > 8.0 ? '👑 皇冠组合' : '顶尖'} |`
    );
  }

  // 3. 各子策略在最优配置下的细分表现
  const bestConfig = topCalmar[0].config;
  console.log('\n========================================================================================');
  console.log(`🔬【全策略穿透剖析】皇冠最优组合 (${bestConfig.leverage}x, 持仓${bestConfig.holdMinutes}m, 止损${bestConfig.stopLossPct}%, 止盈${bestConfig.tp1Pct}%/${bestConfig.tp2Pct}%, 保本=${bestConfig.moveSlToEntryAfterTp1}) 在四大策略中的实测表现：`);
  console.log('========================================================================================');
  console.log('| 子策略名称 | 交易笔数 | 胜率 (%) | 盈亏比 (PF) | 无杠杆净利% | 杠杆总收益% | 止盈1达成数 | 止损击中数 | 综合表现评价 |');
  console.log('| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |');

  const strats = [
    { id: 'rebound', name: '首次跌10%' },
    { id: 'extreme_dev', name: '冲高极度乖离' },
    { id: 'deep_rebound', name: '跌到20%+' },
    { id: 'streak', name: '新高顶背离' },
  ];

  for (const s of strats) {
    const sRes = runComboSimulation(minuteData, allSignals, bestConfig, s.id);
    console.log(
      `| ${s.name.padEnd(12)} | ${String(sRes.trades).padStart(8)} | ${sRes.winRate.toFixed(1).padStart(7)}% | ${(sRes.pf?.toFixed(2) ?? 'N/A').padStart(10)} | ${sRes.unleveragedNet.toFixed(1).padStart(10)}% | ${sRes.leveragedNet.toFixed(1).padStart(10)}% | ${String(sRes.tp1Hits).padStart(10)} | ${String(sRes.slHits).padStart(9)} | ${sRes.winRate >= 70 ? '⭐⭐⭐⭐⭐ 极佳' : sRes.winRate >= 60 ? '⭐⭐⭐⭐ 优良' : '⭐⭐⭐ 合格'} |`
    );
  }
}

main().catch(console.error);
