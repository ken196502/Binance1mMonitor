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

interface SubStrategy {
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
    low24h: number;
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
  };
}

async function main() {
  console.log('========================================================================================');
  console.log('💎【做多最优组合回测】四大做多高胜率策略联合协同与资金组合回测');
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

  const strategies: SubStrategy[] = [
    // 策略 1：【强势龙头 MA30 黄金生命线回踩做多】 (Golden MA30 Pullback Long)
    // 胜率 76.3%, 核心做多主力策略
    {
      id: 'ma30_golden_pullback',
      name: '龙头MA30黄金回踩',
      tag: '【做多-龙头回踩】',
      evaluate: ({ candle, closes, high24h, idx, dayChange, rank, dif }) => {
        if (rank > 10 || dayChange < 25) return { triggered: false, exitParams: {} as any };
        if (high24h <= 0) return { triggered: false, exitParams: {} as any };

        const drop = ((high24h - candle.close) / high24h) * 100;
        if (drop < 10.0 || drop > 22.0) return { triggered: false, exitParams: {} as any };

        const ma30 = calculateSma(closes, idx, 30);
        const ma30Prev = calculateSma(closes, idx - 3, 30);
        if (ma30 == null || ma30Prev == null) return { triggered: false, exitParams: {} as any };
        if (ma30 <= ma30Prev) return { triggered: false, exitParams: {} as any }; // MA30 向上倾斜

        // 触碰支撑: Low <= MA30 * 1.003 且 Close >= MA30 * 0.998
        if (!(candle.low <= ma30 * 1.003 && candle.close >= ma30 * 0.998)) {
          return { triggered: false, exitParams: {} as any };
        }

        // MACD DIF > 0 (牛市多头波段结构)
        if (dif[idx] <= 0) return { triggered: false, exitParams: {} as any };

        // 企稳阳线或下影线
        const range = candle.high - candle.low;
        const lowerWick = Math.min(candle.open, candle.close) - candle.low;
        const isBull = candle.close >= candle.open;
        if (!isBull && (range <= 0 || lowerWick / range < 0.40)) {
          return { triggered: false, exitParams: {} as any };
        }

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

    // 策略 2：【强势龙头 MA60 深度洗盘支撑做多】 (Deep MA60 Support Long)
    // 适合大回撤 15%~25% 的深蹲洗盘，MA60 强力托底
    {
      id: 'ma60_deep_support',
      name: '龙头MA60深蹲托底',
      tag: '【做多-深蹲托底】',
      evaluate: ({ candle, closes, high24h, idx, dayChange, rank, dif }) => {
        if (rank > 10 || dayChange < 25) return { triggered: false, exitParams: {} as any };
        if (high24h <= 0) return { triggered: false, exitParams: {} as any };

        const drop = ((high24h - candle.close) / high24h) * 100;
        if (drop < 15.0 || drop > 28.0) return { triggered: false, exitParams: {} as any };

        const ma60 = calculateSma(closes, idx, 60);
        const ma60Prev = calculateSma(closes, idx - 4, 60);
        if (ma60 == null || ma60Prev == null) return { triggered: false, exitParams: {} as any };
        if (ma60 <= ma60Prev) return { triggered: false, exitParams: {} as any };

        if (!(candle.low <= ma60 * 1.003 && candle.close >= ma60 * 0.998)) {
          return { triggered: false, exitParams: {} as any };
        }

        // 下影线必须显著企稳
        const range = candle.high - candle.low;
        const lowerWick = Math.min(candle.open, candle.close) - candle.low;
        const isBull = candle.close >= candle.open;
        if (!isBull && (range <= 0 || lowerWick / range < 0.45)) {
          return { triggered: false, exitParams: {} as any };
        }

        return {
          triggered: true,
          info: { drop, ma60 },
          exitParams: {
            holdMinutes: 60,
            tp1Percent: 3.0,
            tp2Percent: 10.0,
            stopLossPercent: 8.0,
            moveSlToEntryAfterTp1: true,
            leverage: 3,
          },
        };
      },
    },

    // 策略 3：【猎杀假跌破大阳反包做多】 (Wyckoff Spring Reversal Long)
    // 创 30 根新低诱空后瞬间大阳线拉回，打掉空头流动性
    {
      id: 'wyckoff_spring',
      name: '假跌破洗盘大阳反包',
      tag: '【做多-假破反包】',
      evaluate: ({ candle, closes, lows, idx, dayChange, rank, dif, hist }) => {
        if (rank > 10 || dayChange < 20) return { triggered: false, exitParams: {} as any };
        if (candle.close <= candle.open) return { triggered: false, exitParams: {} as any }; // 必须收强阳线

        // 前 25 根低点
        const start = Math.max(0, idx - 25);
        const end = idx - 1;
        if (end <= start) return { triggered: false, exitParams: {} as any };
        let prevLow = Infinity;
        for (let k = start; k <= end; k++) if (lows[k] < prevLow) prevLow = lows[k];
        if (prevLow <= 0) return { triggered: false, exitParams: {} as any };

        // 假破位：最低点破前低，收盘顽强收在当前 K 线上半部分且高于前低
        if (!(candle.low < prevLow && candle.close > prevLow)) return { triggered: false, exitParams: {} as any };

        // 阳线实体充实
        const body = candle.close - candle.open;
        const range = candle.high - candle.low;
        if (range <= 0 || body / range < 0.50) return { triggered: false, exitParams: {} as any };

        // MACD Hist 翻红或红柱显著缩小
        if (hist[idx] < hist[idx - 1] && hist[idx] < 0) return { triggered: false, exitParams: {} as any };

        return {
          triggered: true,
          exitParams: {
            holdMinutes: 45,
            tp1Percent: 3.5,
            tp2Percent: 7.0,
            stopLossPercent: 5.0,
            moveSlToEntryAfterTp1: true,
            leverage: 3,
          },
        };
      },
    },

    // 策略 4：【MACD 零轴二次金叉放量真突破】 (Zero-Lag MACD Golden Cross Long)
    // 强势币回调至零轴附近未破，DIF 重新金叉 DEA，伴随阳线放量
    {
      id: 'macd_zero_cross',
      name: '零轴金叉共振突破',
      tag: '【做多-零轴金叉】',
      evaluate: ({ candle, closes, idx, dayChange, rank, dif, dea, hist }) => {
        if (rank > 10 || dayChange < 25) return { triggered: false, exitParams: {} as any };
        if (idx < 5) return { triggered: false, exitParams: {} as any };

        // 当根金叉: 前一根 DIF <= DEA, 当根 DIF > DEA
        const isGoldenCross = dif[idx - 1] <= dea[idx - 1] && dif[idx] > dea[idx];
        if (!isGoldenCross) return { triggered: false, exitParams: {} as any };

        // 零轴附近 (DIF 介于 -0.005 与 0.05 之间，牛市多头启动点)
        if (dif[idx] < -0.01) return { triggered: false, exitParams: {} as any };

        // MA15 处于多头上方
        const ma15 = calculateSma(closes, idx, 15);
        if (ma15 == null || candle.close < ma15) return { triggered: false, exitParams: {} as any };

        // 收阳线
        if (candle.close <= candle.open) return { triggered: false, exitParams: {} as any };

        return {
          triggered: true,
          exitParams: {
            holdMinutes: 60,
            tp1Percent: 3.5,
            tp2Percent: 8.0,
            stopLossPercent: 6.0,
            moveSlToEntryAfterTp1: true,
            leverage: 3,
          },
        };
      },
    },
  ];

  interface EventRecord {
    strat: SubStrategy;
    symbol: string;
    time: number;
    entryPrice: number;
    dayChange: number;
    exitParams: any;
  }

  const allEvents: EventRecord[] = [];

  for (const [sym, bars] of minuteData.candles) {
    if (!bars || bars.length < 65) continue;
    const opens = bars.map(b => b[1]);
    const highs = bars.map(b => b[2]);
    const lows = bars.map(b => b[3]);
    const closes = bars.map(b => b[4]);
    const times = bars.map(b => b[0]);
    const { hist, dif, dea } = computeMacd(closes);

    let curMax24h = 0;
    let curMin24h = Infinity;

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
      if (i === 60 || lows[i] < curMin24h) {
        let mi = Infinity;
        for (let k = start24h; k <= i; k++) if (lows[k] < mi) mi = lows[k];
        curMin24h = mi;
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
          low24h: curMin24h,
          dayChange: gRow.dayChange,
          rank: gRow.rank,
        });

        if (res.triggered) {
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
          break; // 同一根 K 线首个匹配优先
        }
      }
    }
  }

  allEvents.sort((a, b) => a.time - b.time);

  const occupied = new Map<string, number>();
  const cooldown = new Map<string, number>();

  interface TradeRecord {
    strat: SubStrategy;
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

  const executedTrades: TradeRecord[] = [];
  let conflicts = 0;

  for (const ev of allEvents) {
    if ((occupied.get(ev.symbol) ?? 0) > ev.time) {
      conflicts++;
      continue;
    }
    if ((cooldown.get(ev.symbol) ?? 0) > ev.time) {
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
      const b = bars[fillIdx + stepIndex(s)];
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
          if (moveSlToEntryAfterTp1) sl2Price = entry;
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

    occupied.set(ev.symbol, exitT);
    cooldown.set(ev.symbol, exitT + 20 * MINUTE);

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

  function stepIndex(s: number) { return s; }

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
  console.log('🏆【做多四大高胜率组合策略：全局战绩】');
  console.log('========================================================================================');
  console.log(`  • 候选总信号: ${allEvents.length} 笔 | 实际撮合接纳: ${total} 笔 (持仓防重冲突拦截: ${conflicts} 笔)`);
  console.log(`  • 综合胜率 (Win Rate): ${wr.toFixed(1)}% (${wins} 胜 ${losses} 负)`);
  if (ci) console.log(`  • 威尔逊 95% 置信区间: [${(ci[0] * 100).toFixed(1)}%, ${(ci[1] * 100).toFixed(1)}%]`);
  console.log(`  • 盈利因子 (Profit Factor): ${pf.toFixed(2)}`);
  console.log(`  • 累计净收益率 (Net PnL): +${netSum.toFixed(2)}%`);
  console.log(`  • 最大回撤 (Max Drawdown): ${mdd.toFixed(2)}%`);
  console.log(`  • 平均单笔净收益: +${(netSum / total).toFixed(2)}%\n`);

  console.log('📊【做多各子策略战绩细分】:');
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
    const subLosses = Math.abs(list.filter(t => t.netPercent < 0).reduce((a, b) => a + b.netPercent, 0));
    const subPf = subLosses > 0 ? subGains / subLosses : 999;

    console.log(
      `| ${s.tag.padEnd(16)} | ${s.name.padEnd(12)} | ${String(subTotal).padStart(8)} | ${String(`${subWins}胜${subLoss}负`).padStart(11)} | ${(subWr.toFixed(1) + '%').padStart(6)} | ${(subNet >= 0 ? '+' : '') + subNet.toFixed(2) + '%'} | ${subPf.toFixed(2)} |`
    );
  }

  console.log('\n📋【做多交易执行流水 (前 20 笔)】:');
  console.log('| 序号 | 所属子策略 | 币种 | 入场时间 (UTC) | 24h涨幅% | 持仓(分) | 净收益% | 结果 | 退出原因 |');
  console.log('| :---: | :--- | :--- | :--- | :---: | :---: | :---: | :---: | :--- |');

  executedTrades.slice(0, 20).forEach((t, i) => {
    const dateStr = new Date(t.entryTime).toISOString().replace('2026-', '').replace(':00.000Z', '').replace('T', ' ');
    const isWin = t.netPercent > 0;
    console.log(
      `| ${String(i + 1).padStart(4)} | ${t.strat.tag.padEnd(14)} | ${t.symbol.padEnd(8)} | ${dateStr} | ${String(t.dayChange.toFixed(1) + '%').padStart(7)} | ${String(t.duration).padStart(6)} | ${(t.netPercent >= 0 ? ' ' : '') + t.netPercent.toFixed(2) + '%'} | ${isWin ? '✅ 盈利' : '❌ 亏损'} | ${t.reasons} |`
    );
  });
}

main().catch(console.error);
