import path from 'node:path';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import type { MinuteDataset } from '../research/gainers-types.ts';
import { MINUTE } from '../research/gainers-types.ts';
import { loadAllMinutes, extractAllSignals, type RawSignal } from './research-low-leverage-long-hold.ts';

interface ComboConfig {
  name: string;
  holdMinutes: number;
  stopLossPct: number;
  tp1Pct: number;
  tp2Pct: number;
  tp1Fraction: number;
  moveSlToEntryAfterTp1: boolean;
  leverage: number;
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
  maxDrawdownPct: number;
  calmar: number | null;
  tp1Hits: number;
  tp2Hits: number;
  slHits: number;
  timeouts: number;
}

function runSim(
  minuteData: MinuteDataset,
  signals: RawSignal[],
  cfg: ComboConfig
): ComboResult {
  const occupiedUntil = new Map<string, number>();
  const cooldownUntil = new Map<string, number>();

  const takerFeeBps = 5;
  const slippageBps = 2;
  const feePct = (takerFeeBps * 2 + slippageBps) / 100;

  let wins = 0;
  let losses = 0;
  let grossGains = 0;
  let grossLosses = 0;
  let totalUnleveragedNet = 0;
  let totalLeveragedNet = 0;
  let tp1Hits = 0;
  let tp2Hits = 0;
  let slHits = 0;
  let timeouts = 0;

  const tradePnls: number[] = [];

  for (const sig of signals) {
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

    let stage1Closed = cfg.tp1Fraction === 0;
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

      // 止损检查
      if (high >= currentStop) {
        const rem = !stage1Closed ? 1.0 : 1.0 - cfg.tp1Fraction;
        const gross = ((entry - high) / entry) * 100;
        tradeNetPct += (gross - feePct) * rem;
        slHits++;
        finalExitTime = b[0];
        break;
      }

      // 阶段一止盈
      if (!stage1Closed && low <= tp1Price) {
        const gross = ((entry - tp1Price) / entry) * 100;
        tradeNetPct += (gross - feePct) * cfg.tp1Fraction;
        stage1Closed = true;
        tp1Hits++;

        if (cfg.moveSlToEntryAfterTp1) {
          currentStop = entry * 1.002;
        }

        if (low <= tp2Price) {
          const gross2 = ((entry - tp2Price) / entry) * 100;
          tradeNetPct += (gross2 - feePct) * (1.0 - cfg.tp1Fraction);
          stage2Closed = true;
          tp2Hits++;
          finalExitTime = b[0];
          break;
        }
      }

      // 阶段二止盈
      if (stage1Closed && !stage2Closed && low <= tp2Price) {
        const rem = 1.0 - (cfg.tp1Fraction > 0 ? cfg.tp1Fraction : 0);
        const gross = ((entry - tp2Price) / entry) * 100;
        tradeNetPct += (gross - feePct) * rem;
        stage2Closed = true;
        tp2Hits++;
        finalExitTime = b[0];
        break;
      }

      // 超时平仓
      if (step === maxSteps - 1) {
        const rem = !stage1Closed ? 1.0 : !stage2Closed ? 1.0 - cfg.tp1Fraction : 0;
        if (rem > 0) {
          const gross = ((entry - close) / entry) * 100;
          tradeNetPct += (gross - feePct) * rem;
          timeouts++;
        }
        finalExitTime = b[0];
      }
    }

    const levPnl = tradeNetPct * cfg.leverage;
    tradePnls.push(levPnl);
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

  const trades = wins + losses;
  const winRate = trades ? (wins / trades) * 100 : 0;
  const pf = grossLosses > 0 ? grossGains / grossLosses : grossGains > 0 ? 999 : null;

  let peak = 100;
  let equity = 100;
  let maxDd = 0;
  for (const levPnl of tradePnls) {
    equity += equity * 0.20 * (levPnl / 100);
    if (equity <= 0) { equity = 0; maxDd = 100; break; }
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDd) maxDd = dd;
  }
  const calmar = maxDd > 0 ? totalLeveragedNet / maxDd : null;

  return {
    config: cfg,
    trades,
    wins,
    losses,
    winRate,
    pf,
    unleveragedNet: totalUnleveragedNet,
    leveragedNet: totalLeveragedNet,
    maxDrawdownPct: maxDd,
    calmar,
    tp1Hits,
    tp2Hits,
    slHits,
    timeouts,
  };
}

async function main() {
  console.log('========================================================================================');
  console.log('💎【顺势衰竭+极度乖离专属研究】低杠杆大止损长持仓黄金组合深度扫描');
  console.log('========================================================================================\n');

  const hourly = await loadDataset(path.resolve('data/research/hourly-168h'));
  const frames = buildFrames(hourly, 10, 1);
  const minuteData = await loadAllMinutes();
  const allSignals = await extractAllSignals(minuteData, frames, hourly);

  // 专属筛选：排除 24h 新高背离（该策略天然属于 15m 快速剥头皮），保留首次跌10%、跌到20%+、冲高极度乖离三大顺势衰竭策略
  const rightSignals = allSignals.filter(s => s.strategyId !== 'streak');
  console.log(`筛选出三大顺势衰竭做空信号: 共 ${rightSignals.length} 笔\n`);

  const results: ComboResult[] = [];
  const holdTimes = [30, 45, 60, 90, 120, 180, 240, 360];
  const stopLosses = [6, 8, 10, 12, 15, 20];
  const tpPairs = [
    { tp1: 4, tp2: 8, name: '稳健型 (TP1=4%, TP2=8%)' },
    { tp1: 5, tp2: 10, name: '进取型 (TP1=5%, TP2=10%)' },
    { tp1: 6, tp2: 12, name: '大波段 (TP1=6%, TP2=12%)' },
    { tp1: 8, tp2: 15, name: '超级波段 (TP1=8%, TP2=15%)' },
    { tp1: 0, tp2: 0, name: '纯到期平仓' },
  ];

  for (const h of holdTimes) {
    for (const sl of stopLosses) {
      for (const tp of tpPairs) {
        for (const be of [true, false]) {
          for (const lev of [2, 3, 5]) {
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
            results.push(runSim(minuteData, rightSignals, cfg));
          }
        }
      }
    }
  }

  // 排序前 10 最佳卡玛比率组合
  const topCalmar = results
    .filter(r => r.trades >= 35 && r.calmar !== null)
    .sort((a, b) => (b.calmar ?? 0) - (a.calmar ?? 0));

  console.log('========================================================================================');
  console.log('👑【三大顺势衰竭策略 TOP 10 黄金组合】(胜率极高，卡玛比率极佳)');
  console.log('========================================================================================');
  console.log('| 排名 | 组合配置 | 胜率 (%) | PF | 杠杆收益率% | 最大回撤% | 收益/回撤比 (Calmar) | TP1达成率 |');
  console.log('| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: |');

  for (let i = 0; i < Math.min(10, topCalmar.length); i++) {
    const r = topCalmar[i];
    const c = r.config;
    const tpDesc = c.tp1Pct > 0 ? `TP:${c.tp1Pct}%/${c.tp2Pct}%` : 'No-TP';
    const beDesc = c.moveSlToEntryAfterTp1 ? '保本' : '不保本';
    const desc = `${c.leverage}x | ${c.holdMinutes}m (${(c.holdMinutes/60).toFixed(1)}h) | SL:${c.stopLossPct}% | ${tpDesc} | ${beDesc}`;
    const tpRate = ((r.tp1Hits / r.trades) * 100).toFixed(1);
    console.log(
      `| ${(i + 1).toString().padStart(2)} | ${desc.padEnd(52)} | ${r.winRate.toFixed(1).padStart(7)}% | ${(r.pf?.toFixed(2) ?? '').padStart(5)} | ${r.leveragedNet.toFixed(1).padStart(11)}% | ${r.maxDrawdownPct.toFixed(1).padStart(8)}% | ${(r.calmar?.toFixed(2) ?? '').padStart(20)} | ${tpRate.padStart(8)}% |`
    );
  }

  // 排序前 10 最佳胜率组合
  const topWinRate = results
    .filter(r => r.trades >= 35 && r.pf !== null && r.pf > 1.5)
    .sort((a, b) => b.winRate - a.winRate);

  console.log('\n========================================================================================');
  console.log('🎯【三大顺势衰竭策略 TOP 10 最高胜率组合】(胜率突破 75%~80%)');
  console.log('========================================================================================');
  console.log('| 排名 | 组合配置 | 胜率 (%) | PF | 杠杆收益率% | 最大回撤% | 止盈1达成数 | 止损击中数 |');
  console.log('| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: |');

  for (let i = 0; i < Math.min(10, topWinRate.length); i++) {
    const r = topWinRate[i];
    const c = r.config;
    const tpDesc = c.tp1Pct > 0 ? `TP:${c.tp1Pct}%/${c.tp2Pct}%` : 'No-TP';
    const beDesc = c.moveSlToEntryAfterTp1 ? '保本' : '不保本';
    const desc = `${c.leverage}x | ${c.holdMinutes}m | SL:${c.stopLossPct}% | ${tpDesc} | ${beDesc}`;
    console.log(
      `| ${(i + 1).toString().padStart(2)} | ${desc.padEnd(52)} | ${r.winRate.toFixed(1).padStart(7)}% | ${(r.pf?.toFixed(2) ?? '').padStart(5)} | ${r.leveragedNet.toFixed(1).padStart(11)}% | ${r.maxDrawdownPct.toFixed(1).padStart(8)}% | ${String(r.tp1Hits).padStart(10)} | ${String(r.slHits).padStart(9)} |`
    );
  }
}

main().catch(console.error);
