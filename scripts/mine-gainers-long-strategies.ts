import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import type { MinuteDataset } from '../research/gainers-types.ts';
import { HOUR } from '../research/types.ts';
import { MINUTE } from '../research/gainers-types.ts';
import { calculateSma } from '../research/peak-rebound-signals.ts';
import { computeMacd } from '../src/macd.ts';
import { wilsonInterval } from '../research/peak-rebound-backtest.ts';

async function loadAllMinutes(): Promise<MinuteDataset> {
  const dir1 = path.resolve('data/research/staged-1m-20261020-20261023');
  const dir2 = path.resolve('data/research/peak-rebound-1m-168h');
  const candles = new Map<string, any[]>();

  for (const dir of [dir1, dir2]) {
    try {
      const files = await readdir(dir);
      for (const f of files) {
        if (f.endsWith('.json.gz')) {
          const sym = f.replace('.json.gz', '');
          const bytes = await readFile(path.join(dir, f));
          candles.set(sym, JSON.parse(gunzipSync(bytes).toString('utf8')));
        }
      }
    } catch {}
  }
  return {
    manifest: { version: 1, interval: '1m', source: 'Binance', fetchedAt: '', plan: {} as any, files: {} },
    candles,
  };
}

export function calcLongReturn(
  entryPrice: number,
  exitPrice: number,
  costs = { takerFeeBps: 5, slippageBps: 2 }
) {
  const grossPercent = ((exitPrice - entryPrice) / entryPrice) * 100;
  const entryFeePercent = costs.takerFeeBps / 100;
  const exitFeePercent = (costs.takerFeeBps / 100) * (exitPrice / entryPrice);
  const slippagePercent = (costs.slippageBps / 100) * (1 + exitPrice / entryPrice);
  const netPercent = grossPercent - entryFeePercent - exitFeePercent - slippagePercent;
  return { grossPercent, netPercent };
}

export interface GainerLongCandidate {
  id: string;
  name: string;
  tag: string;
  evaluate: (ctx: {
    symbol: string;
    candle: any;
    closes: number[];
    highs: number[];
    lows: number[];
    opens: number[];
    idx: number;
    hist: number[];
    dif: number[];
    dea: number[];
    high24h: number;
    dayChange: number;
    rank: number;
  }) => {
    triggered: boolean;
    info?: any;
    exitParams: {
      holdMinutes: number;
      tp1Percent: number;
      tp2Percent: number;
      stopLossPercent: number;
      moveSlToEntryAfterTp1: boolean;
      leverage: number;
    };
  } | null;
}

async function main() {
  console.log('========================================================================================');
  console.log('🚀【涨幅榜专属做多策略体系深度挖掘与回测】全面摒弃跌幅榜，聚焦 24h 涨幅榜强势龙头');
  console.log('========================================================================================\n');

  const hourly = await loadDataset(path.resolve('data/research/hourly-168h'));
  const frames = buildFrames(hourly, 10, 1);
  const minuteData = await loadAllMinutes();

  const gainerBoards = new Map<number, Map<string, any>>();
  for (const frame of frames) {
    const gMap = new Map<string, any>();
    for (const obs of frame.boards.gainers) gMap.set(obs.symbol, { rank: obs.rank, dayChange: obs.dayChange });
    gainerBoards.set(frame.time, gMap);
  }

  // 4 大涨幅榜专属做多策略候选
  const strategies: GainerLongCandidate[] = [
    // 策略 1：【龙头 MA30 黄金生命线回踩做多】 (Leader MA30 Golden Pullback)
    // 逻辑：24h 涨幅 >= 25%，处于强势主升浪，从峰值回调 10%~20%，MA30 保持强劲上倾，下探触及 MA30 收出阳线或长下影
    {
      id: 'gainer_ma30_pullback',
      name: '龙头MA30黄金生命线回踩',
      tag: '【涨幅榜-MA30回踩】',
      evaluate: ({ candle, closes, high24h, idx, dayChange, rank, dif }) => {
        if (rank > 10 || dayChange < 25) return null;
        if (high24h <= 0) return null;

        const drop = ((high24h - candle.close) / high24h) * 100;
        if (drop < 10.0 || drop > 20.0) return null;

        const ma30 = calculateSma(closes, idx, 30);
        const ma30Prev = calculateSma(closes, idx - 3, 30);
        if (ma30 == null || ma30Prev == null) return null;
        if (ma30 <= ma30Prev) return null; // MA30 严格上行趋势

        // 触碰支撑: Low 探至 MA30 附近，收盘踩在 MA30 之上
        if (!(candle.low <= ma30 * 1.003 && candle.close >= ma30 * 0.998)) return null;

        // MACD DIF > 0 (牛市多头区间)
        if (dif[idx] <= 0) return null;

        // 企稳阳线或长下影线
        const range = candle.high - candle.low;
        const lowerWick = Math.min(candle.open, candle.close) - candle.low;
        const isBull = candle.close >= candle.open;
        if (!isBull && (range <= 0 || lowerWick / range < 0.40)) return null;

        return {
          triggered: true,
          info: { drop, ma30 },
          exitParams: {
            holdMinutes: 90,
            tp1Percent: 3.0,
            tp2Percent: 8.0,
            stopLossPercent: 8.0,
            moveSlToEntryAfterTp1: true,
            leverage: 3,
          },
        };
      },
    },

    // 策略 2：【龙头 MA60 深度洗盘深蹲托底做多】 (Leader MA60 Deep Dip Support)
    // 逻辑：24h 涨幅 >= 25%，主升浪深度洗盘回撤 15%~25%，在 1h 级别大生命线 MA60 处获得强支撑，下影线探针长下影反包
    {
      id: 'gainer_ma60_support',
      name: '龙头MA60深度深蹲托底',
      tag: '【涨幅榜-MA60深蹲】',
      evaluate: ({ candle, closes, high24h, idx, dayChange, rank, dif }) => {
        if (rank > 10 || dayChange < 25) return null;
        if (high24h <= 0) return null;

        const drop = ((high24h - candle.close) / high24h) * 100;
        if (drop < 14.0 || drop > 25.0) return null;

        const ma60 = calculateSma(closes, idx, 60);
        const ma60Prev = calculateSma(closes, idx - 4, 60);
        if (ma60 == null || ma60Prev == null) return null;
        if (ma60 <= ma60Prev) return null; // MA60 保持上倾

        if (!(candle.low <= ma60 * 1.003 && candle.close >= ma60 * 0.998)) return null;

        // MACD DIF 保持在多头区域
        if (dif[idx] <= 0) return null;

        const range = candle.high - candle.low;
        const lowerWick = Math.min(candle.open, candle.close) - candle.low;
        const isBull = candle.close >= candle.open;
        if (!isBull && (range <= 0 || lowerWick / range < 0.45)) return null;

        return {
          triggered: true,
          info: { drop, ma60 },
          exitParams: {
            holdMinutes: 60,
            tp1Percent: 3.0,
            tp2Percent: 8.0,
            stopLossPercent: 7.0,
            moveSlToEntryAfterTp1: true,
            leverage: 3,
          },
        };
      },
    },

    // 策略 3：【龙头二浪启动：回踩后零轴金叉大阳突破做多】 (Second-Wave Zero-Lag MACD Golden Cross)
    // 逻辑：24h 涨幅 >= 20%，价格已回踩洗盘完毕，MACD 在零轴附近（DIF > -0.01）重新金叉 DEA，收出放量大阳线突破 MA15
    {
      id: 'gainer_wave2_breakout',
      name: '龙头回踩二浪金叉突破',
      tag: '【涨幅榜-二浪金叉】',
      evaluate: ({ candle, closes, idx, dayChange, rank, dif, dea, hist }) => {
        if (rank > 10 || dayChange < 20) return null;
        if (idx < 10) return null;

        // MACD 在零轴上方或临界点出现刚性金叉
        const isCross = dif[idx - 1] <= dea[idx - 1] && dif[idx] > dea[idx];
        if (!isCross) return null;
        if (dif[idx] < 0) return null; // 必须是零轴上方的牛市强势金叉

        // 均线多头形态: 站上 MA15
        const ma15 = calculateSma(closes, idx, 15);
        const ma30 = calculateSma(closes, idx, 30);
        if (ma15 == null || ma30 == null) return null;
        if (candle.close < ma15 || ma15 < ma30) return null; // MA15 > MA30 多头排列

        // 强实体大阳线 (阳线实体占比 >= 60%)
        const body = candle.close - candle.open;
        const range = candle.high - candle.low;
        if (body <= 0 || range <= 0 || body / range < 0.60) return null;

        // 阳线涨幅 >= 0.8% (放量启动)
        const barReturn = (body / candle.open) * 100;
        if (barReturn < 0.8) return null;

        return {
          triggered: true,
          info: { barReturn },
          exitParams: {
            holdMinutes: 45,
            tp1Percent: 3.0,
            tp2Percent: 7.0,
            stopLossPercent: 5.0,
            moveSlToEntryAfterTp1: true,
            leverage: 3,
          },
        };
      },
    },

    // 策略 4：【榜一首阴探针反抽做多】 (Rank 1 First Pullback Hammer Long)
    // 逻辑：专门盯防 24h 涨幅榜首（Rank 1，市场龙头，24h >= 30%），见顶后首次回踩 10%~16% 处收出长下影探针或反包阳线
    {
      id: 'rank1_first_pullback',
      name: '榜一首次回踩探针闪击',
      tag: '【涨幅榜-榜一首踩】',
      evaluate: ({ candle, closes, high24h, idx, dayChange, rank, dif, hist }) => {
        if (rank !== 1 || dayChange < 30) return null;
        if (high24h <= 0) return null;

        const drop = ((high24h - candle.close) / high24h) * 100;
        if (drop < 10.0 || drop > 18.0) return null;

        // 必须收阳且下影线显著 (探底回升)
        if (candle.close <= candle.open) return null;
        const range = candle.high - candle.low;
        const lowerWick = candle.open - candle.low;
        if (range <= 0 || lowerWick / range < 0.35) return null;

        // MACD 柱体翻绿或红柱缩短
        if (hist[idx] < hist[idx - 1]) return null;

        return {
          triggered: true,
          info: { drop },
          exitParams: {
            holdMinutes: 45,
            tp1Percent: 3.5,
            tp2Percent: 8.0,
            stopLossPercent: 6.0,
            moveSlToEntryAfterTp1: true,
            leverage: 5,
          },
        };
      },
    },
  ];

  interface SignalEvent {
    strat: GainerLongCandidate;
    symbol: string;
    time: number;
    entryPrice: number;
    dayChange: number;
    exitParams: any;
  }

  const allEvents: SignalEvent[] = [];

  for (const [sym, bars] of minuteData.candles) {
    if (!bars || bars.length < 65) continue;
    const opens = bars.map(b => b[1]);
    const highs = bars.map(b => b[2]);
    const lows = bars.map(b => b[3]);
    const closes = bars.map(b => b[4]);
    const times = bars.map(b => b[0]);
    const { hist, dif, dea } = computeMacd(closes);

    let curMax24h = 0;

    for (let i = 60; i < bars.length - 1; i++) {
      const t = times[i];
      const bTime = Math.floor(t / HOUR) * HOUR;
      const gRow = gainerBoards.get(bTime)?.get(sym);
      if (!gRow) continue;

      const start24h = Math.max(0, i - 1439);
      if (i === 60 || highs[i] > curMax24h) {
        let m = 0;
        for (let k = start24h; k <= i; k++) if (highs[k] > m) m = highs[k];
        curMax24h = m;
      }

      const candleObj = { open: opens[i], high: highs[i], low: lows[i], close: closes[i], time: times[i] };

      for (const strat of strategies) {
        const res = strat.evaluate({
          symbol: sym,
          candle: candleObj,
          closes,
          highs,
          lows,
          opens,
          idx: i,
          hist,
          dif,
          dea,
          high24h: curMax24h,
          dayChange: gRow.dayChange,
          rank: gRow.rank,
        });

        if (res && res.triggered) {
          const nextBar = bars[i + 1];
          if (!nextBar) continue;
          allEvents.push({
            strat,
            symbol: sym,
            time: nextBar[0],
            entryPrice: nextBar[1],
            dayChange: gRow.dayChange,
            exitParams: res.exitParams,
          });
          break; // 排他
        }
      }
    }
  }

  console.log(`候选做多信号挖掘完毕: 共发现 ${allEvents.length} 笔信号。`);

  // 先对各策略进行【独立战绩回测】
  console.log('\n----------------------------------------------------------------------------------------');
  console.log('📊 各子策略独立回测表现 (无其他策略挤占干扰)');
  console.log('----------------------------------------------------------------------------------------');
  console.log('| 子策略标识 | 核心逻辑 | 交易数 | 胜率(%) | 战绩(W/L) | 净收益(%) | 盈亏比(PF) | 平均单笔(%) |');
  console.log('| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |');

  for (const strat of strategies) {
    const stratEvents = allEvents.filter(e => e.strat.id === strat.id);
    stratEvents.sort((a, b) => a.time - b.time);

    const occ = new Map<string, number>();
    const cld = new Map<string, number>();
    const trades: any[] = [];

    for (const ev of stratEvents) {
      if ((occ.get(ev.symbol) ?? 0) > ev.time) continue;
      if ((cld.get(ev.symbol) ?? 0) > ev.time) continue;

      const bars = minuteData.candles.get(ev.symbol);
      if (!bars) continue;
      const fillIdx = bars.findIndex((b: any) => b[0] === ev.time);
      if (fillIdx < 0) continue;

      const { holdMinutes, tp1Percent, tp2Percent, stopLossPercent, moveSlToEntryAfterTp1 } = ev.exitParams;
      const entry = ev.entryPrice;
      const tp1Price = entry * (1 + tp1Percent / 100);
      const tp2Price = entry * (1 + tp2Percent / 100);
      const sl1Price = entry * (1 - stopLossPercent / 100);
      let sl2Price = entry * (1 - stopLossPercent / 100);

      let stage1 = false, stage2 = false;
      let net = 0;
      let exitT = ev.time + holdMinutes * MINUTE;

      for (let s = 0; s < holdMinutes; s++) {
        const b = bars[fillIdx + s];
        if (!b) break;
        const h = b[2], l = b[3], c = b[4];

        if (!stage1) {
          if (l <= sl1Price) {
            net += calcLongReturn(entry, sl1Price).netPercent * 0.5;
            stage1 = true;
          } else if (h >= tp1Price) {
            net += calcLongReturn(entry, tp1Price).netPercent * 0.5;
            stage1 = true;
            if (moveSlToEntryAfterTp1) sl2Price = entry;
          }
        }

        if (stage1 && !stage2) {
          if (l <= sl2Price) {
            net += calcLongReturn(entry, sl2Price).netPercent * 0.5;
            stage2 = true;
            exitT = b[0];
            break;
          } else if (h >= tp2Price) {
            net += calcLongReturn(entry, tp2Price).netPercent * 0.5;
            stage2 = true;
            exitT = b[0];
            break;
          }
        }

        if (s === holdMinutes - 1) {
          const rem = !stage1 ? 1.0 : !stage2 ? 0.5 : 0;
          if (rem > 0) net += calcLongReturn(entry, c).netPercent * rem;
          exitT = b[0];
        }
      }

      occ.set(ev.symbol, exitT);
      cld.set(ev.symbol, exitT + 20 * MINUTE);
      trades.push(net);
    }

    const total = trades.length;
    const wins = trades.filter(t => t > 0).length;
    const wr = total > 0 ? (wins / total) * 100 : 0;
    const netSum = trades.reduce((a, b) => a + b, 0);
    const gains = trades.filter(t => t > 0).reduce((a, b) => a + b, 0);
    const losses = Math.abs(trades.filter(t => t < 0).reduce((a, b) => a + b, 0));
    const pf = losses > 0 ? gains / losses : 999;
    const avg = total > 0 ? netSum / total : 0;

    console.log(
      `| ${strat.tag.padEnd(16)} | ${strat.name.padEnd(16)} | ${String(total).padStart(6)} | ${(wr.toFixed(1) + '%').padStart(7)} | ${String(`${wins}W/${total - wins}L`).padStart(9)} | ${(netSum >= 0 ? '+' : '') + netSum.toFixed(2) + '%'} | ${pf.toFixed(2).padStart(10)} | ${(avg >= 0 ? '+' : '') + avg.toFixed(2) + '%'} |`
    );
  }

  // 接下来进行【四大策略联合协同回测】(全局持仓防重，同币冷却)
  console.log('\n----------------------------------------------------------------------------------------');
  console.log('🤝 四大涨幅榜做多子策略【联合协同调度回测】(统一持仓排他 + 20m 币种冷静期)');
  console.log('----------------------------------------------------------------------------------------');

  allEvents.sort((a, b) => a.time - b.time);

  const occupiedUntil = new Map<string, number>();
  const cooldownUntil = new Map<string, number>();

  interface JointTrade {
    strat: GainerLongCandidate;
    symbol: string;
    entryTime: number;
    entryPrice: number;
    exitTime: number;
    exitPrice: number;
    duration: number;
    dayChange: number;
    netPercent: number;
    reasons: string;
  }

  const executedTrades: JointTrade[] = [];
  let conflicts = 0;

  for (const ev of allEvents) {
    if ((occupiedUntil.get(ev.symbol) ?? 0) > ev.time) {
      conflicts++;
      continue;
    }
    if ((cooldownUntil.get(ev.symbol) ?? 0) > ev.time) {
      conflicts++;
      continue;
    }

    const bars = minuteData.candles.get(ev.symbol);
    if (!bars) continue;
    const fillIdx = bars.findIndex((b: any) => b[0] === ev.time);
    if (fillIdx < 0) continue;

    const { holdMinutes, tp1Percent, tp2Percent, stopLossPercent, moveSlToEntryAfterTp1 } = ev.exitParams;
    const entry = ev.entryPrice;

    const tp1Price = entry * (1 + tp1Percent / 100);
    const tp2Price = entry * (1 + tp2Percent / 100);
    const sl1Price = entry * (1 - stopLossPercent / 100);
    let sl2Price = entry * (1 - stopLossPercent / 100);

    let stage1Closed = false;
    let stage2Closed = false;
    let tradeNet = 0;
    let exitT = ev.time + holdMinutes * MINUTE;
    let finalExitPrice = entry;
    let reason1 = 'timeout';
    let reason2 = 'timeout';

    for (let s = 0; s < holdMinutes; s++) {
      const b = bars[fillIdx + s];
      if (!b) break;
      const h = b[2], l = b[3], c = b[4];

      if (!stage1Closed) {
        if (l <= sl1Price) {
          tradeNet += calcLongReturn(entry, sl1Price).netPercent * 0.5;
          stage1Closed = true;
          reason1 = 'stop';
        } else if (h >= tp1Price) {
          tradeNet += calcLongReturn(entry, tp1Price).netPercent * 0.5;
          stage1Closed = true;
          reason1 = 'target';
          if (moveSlToEntryAfterTp1) sl2Price = entry; // 锁定保本
        }
      }

      if (stage1Closed && !stage2Closed) {
        if (l <= sl2Price) {
          tradeNet += calcLongReturn(entry, sl2Price).netPercent * 0.5;
          stage2Closed = true;
          reason2 = 'stop';
          exitT = b[0];
          finalExitPrice = sl2Price;
          break;
        } else if (h >= tp2Price) {
          tradeNet += calcLongReturn(entry, tp2Price).netPercent * 0.5;
          stage2Closed = true;
          reason2 = 'target';
          exitT = b[0];
          finalExitPrice = tp2Price;
          break;
        }
      }

      if (s === holdMinutes - 1) {
        const rem = !stage1Closed ? 1.0 : !stage2Closed ? 0.5 : 0;
        if (rem > 0) tradeNet += calcLongReturn(entry, c).netPercent * rem;
        exitT = b[0];
        finalExitPrice = c;
      }
    }

    occupiedUntil.set(ev.symbol, exitT);
    cooldownUntil.set(ev.symbol, exitT + 20 * MINUTE);

    executedTrades.push({
      strat: ev.strat,
      symbol: ev.symbol,
      entryTime: ev.time,
      entryPrice: entry,
      exitTime: exitT,
      exitPrice: finalExitPrice,
      duration: Math.round((exitT - ev.time) / MINUTE),
      dayChange: ev.dayChange,
      netPercent: tradeNet,
      reasons: `${reason1}/${reason2}`,
    });
  }

  const total = executedTrades.length;
  const wins = executedTrades.filter(t => t.netPercent > 0).length;
  const losses = total - wins;
  const wr = total > 0 ? (wins / total) * 100 : 0;
  const netSum = executedTrades.reduce((s, t) => s + t.netPercent, 0);
  const gains = executedTrades.filter(t => t.netPercent > 0).reduce((s, t) => s + t.netPercent, 0);
  const lossSum = Math.abs(executedTrades.filter(t => t < 0).reduce((s, t) => s + t.netPercent, 0));
  const pf = lossSum > 0 ? gains / lossSum : gains > 0 ? 999 : 0;

  let peak = 0, cur = 0, mdd = 0;
  for (const t of executedTrades) {
    cur += t.netPercent;
    if (cur > peak) peak = cur;
    if (peak - cur > mdd) mdd = peak - cur;
  }

  const ci = wilsonInterval(wins, total);

  console.log('========================================================================================');
  console.log('🏆【涨幅榜专属做多联合引擎：全局战绩】');
  console.log('========================================================================================');
  console.log(`  • 候选总信号: ${allEvents.length} 笔 | 实际撮合接纳: ${total} 笔 (防重冲突拦截: ${conflicts} 笔)`);
  console.log(`  • 综合胜率 (Win Rate): ${wr.toFixed(1)}% (${wins} 胜 ${losses} 负)`);
  if (ci) console.log(`  • 威尔逊 95% 置信区间: [${(ci[0] * 100).toFixed(1)}%, ${(ci[1] * 100).toFixed(1)}%]`);
  console.log(`  • 利润因子 (Profit Factor): ${pf.toFixed(2)}`);
  console.log(`  • 累计净收益率 (Net PnL): +${netSum.toFixed(2)}%`);
  console.log(`  • 最大回撤 (Max Drawdown): ${mdd.toFixed(2)}%`);
  console.log(`  • 平均单笔净收益: +${(netSum / total).toFixed(2)}%\n`);

  console.log('📊【联合回测各子策略分项战绩明细】:');
  console.log('| 子策略标识 | 核心逻辑 | 交易笔数 | 战绩(胜/负) | 胜率(%) | 净收益贡献(%) | 盈亏比(PF) |');
  console.log('| :--- | :--- | :---: | :---: | :---: | :---: | :---: |');

  for (const s of strategies) {
    const list = executedTrades.filter(t => t.strat.id === s.id);
    const subTotal = list.length;
    const subWins = list.filter(t => t.netPercent > 0).length;
    const subLoss = subTotal - subWins;
    const subWr = subTotal > 0 ? (subWins / subTotal) * 100 : 0;
    const subNet = list.reduce((a, b) => a + b.netPercent, 0);
    const subGains = list.filter(t => t.netPercent > 0).reduce((a, b) => a + b.netPercent, 0);
    const subLosses = Math.abs(list.filter(t => t < 0).reduce((a, b) => a + b.netPercent, 0));
    const subPf = subLosses > 0 ? subGains / subLosses : 999;

    console.log(
      `| ${s.tag.padEnd(16)} | ${s.name.padEnd(16)} | ${String(subTotal).padStart(8)} | ${String(`${subWins}胜${subLoss}负`).padStart(11)} | ${(subWr.toFixed(1) + '%').padStart(6)} | ${(subNet >= 0 ? '+' : '') + subNet.toFixed(2) + '%'} | ${subPf.toFixed(2)} |`
    );
  }

  console.log('\n📋【前 25 笔真实撮合执行流水】:');
  console.log('| 序号 | 所属子策略 | 币种 | 入场时间 (UTC) | 24h涨幅% | 持仓(分) | 净收益% | 结果 | 退出原因 |');
  console.log('| :---: | :--- | :--- | :--- | :---: | :---: | :---: | :---: | :--- |');

  executedTrades.slice(0, 25).forEach((t, i) => {
    const dateStr = new Date(t.entryTime).toISOString().replace('2026-', '').replace(':00.000Z', '').replace('T', ' ');
    const isWin = t.netPercent > 0;
    console.log(
      `| ${String(i + 1).padStart(4)} | ${t.strat.tag.padEnd(14)} | ${t.symbol.padEnd(8)} | ${dateStr} | ${String(t.dayChange.toFixed(1) + '%').padStart(7)} | ${String(t.duration).padStart(6)} | ${(t.netPercent >= 0 ? ' ' : '') + t.netPercent.toFixed(2) + '%'} | ${isWin ? '✅ 盈利' : '❌ 亏损'} | ${t.reasons} |`
    );
  });
}

main().catch(console.error);
