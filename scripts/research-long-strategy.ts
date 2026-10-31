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
          const bars = JSON.parse(gunzipSync(bytes).toString('utf8'));
          candles.set(sym, bars);
        }
      }
    } catch {}
  }

  return {
    manifest: {
      version: 1,
      interval: '1m',
      source: 'Binance',
      fetchedAt: new Date().toISOString(),
      plan: {} as any,
      files: {},
    },
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

export interface LongSignalMember {
  id: string;
  name: string;
  category: string;
  tag: string;
  evaluate: (ctx: {
    symbol: string;
    candle: { open: number; high: number; low: number; close: number; time: number };
    closes: number[];
    highs: number[];
    lows: number[];
    opens: number[];
    idx: number;
    hist: number[];
    dif: number[];
    low24h: number;
    high24h: number;
    dayChange: number;
    rankGainers: number | null;
    rankLosers: number | null;
  }) => {
    triggered: boolean;
    impulsePercent?: number;
    exitParams: {
      holdMinutes: number;
      exitX: number;
      exitN: number;
      exitM: number;
      stopLossPercent?: number;
      tp1Percent?: number;
      tp2Percent?: number;
      moveSlToEntryAfterTp1?: boolean;
    };
  };
}

async function main() {
  console.log('========================================================================================');
  console.log('🚀【做多策略系统性挖掘与回测】基于做空镜像与顺势动能反推的多头四大子策略群');
  console.log('========================================================================================\n');

  console.log('正在载入 168 小时全市场小时数据与全部 1m 历史分钟 K 线...');
  const hourly = await loadDataset(path.resolve('data/research/hourly-168h'));
  const frames = buildFrames(hourly, 10, 1);
  const minuteData = await loadAllMinutes();

  console.log(`载入成功: 覆盖 ${minuteData.candles.size} 个标的，共 ${Array.from(minuteData.candles.values()).reduce((s, b) => s + b.length, 0)} 根 1m K 线。\n`);

  // 构建小时榜单缓存 (Gainers 与 Losers 榜单)
  const gainerBoards = new Map<number, Map<string, { rank: number; dayChange: number }>>();
  const loserBoards = new Map<number, Map<string, { rank: number; dayChange: number }>>();

  for (const frame of frames) {
    const gMap = new Map<string, { rank: number; dayChange: number }>();
    for (const obs of frame.boards.gainers) {
      gMap.set(obs.symbol, { rank: obs.rank, dayChange: obs.dayChange });
    }
    gainerBoards.set(frame.time, gMap);

    const lMap = new Map<string, { rank: number; dayChange: number }>();
    for (const obs of frame.boards.losers) {
      lMap.set(obs.symbol, { rank: obs.rank, dayChange: obs.dayChange });
    }
    loserBoards.set(frame.time, lMap);
  }

  // 定义多头策略群
  const members: LongSignalMember[] = [
    // 策略 1：【瀑布极度负乖离做多】 (Extreme Negative MA Deviation Long)
    // 逻辑：3m 内暴跌幅度达到 |24h 跌幅|/3.5 (>= 3.5%)，收盘价极度跌穿 MA30 (负乖离 >= 1.5%)，且收盘价高于当根最低价确认反抽
    {
      id: 'extreme_neg_dev',
      name: '断崖极度负乖离多',
      category: '均值回归',
      tag: '【多头-极度负乖离】',
      evaluate: ({ candle, closes, lows, idx, dayChange, rankLosers }) => {
        // 跌幅榜前 15 或 24h 跌幅 >= 10%
        if (dayChange > -10 && (rankLosers == null || rankLosers > 15)) {
          return { triggered: false, exitParams: {} as any };
        }
        const x = 3;
        const startX = idx - x + 1;
        if (startX < 0) return { triggered: false, exitParams: {} as any };

        let maxHigh = -Infinity;
        for (let k = startX; k <= idx; k++) if (closes[k] > maxHigh) maxHigh = closes[k];
        if (maxHigh <= 0) return { triggered: false, exitParams: {} as any };

        const drop = ((maxHigh - candle.close) / maxHigh) * 100;
        const absDayChange = Math.abs(dayChange);
        const reqDrop = Math.max(3.5, absDayChange / 3.5);
        if (drop < reqDrop) return { triggered: false, exitParams: {} as any };

        // 检验 MA30 负乖离 (MA30 - Close) / MA30 >= 1.5%
        const ma30 = calculateSma(closes, idx, 30);
        if (ma30 == null) return { triggered: false, exitParams: {} as any };
        const negDev = ((ma30 - candle.close) / ma30) * 100;
        if (negDev < 1.5) return { triggered: false, exitParams: {} as any };

        // 拒绝光脚大阴线，确认下探有抵抗
        const range = candle.high - candle.low;
        const lowerWick = candle.close - candle.low;
        if (range > 0 && lowerWick / range < 0.15) {
          return { triggered: false, exitParams: {} as any };
        }

        return {
          triggered: true,
          impulsePercent: drop,
          exitParams: { holdMinutes: 20, exitX: 30, exitN: 2.0, exitM: 2.0 },
        };
      },
    },

    // 策略 2：【新低底背离做多】 (New Low Bullish Divergence Long)
    // 逻辑：创 24h 新低，5m 暴跌达到 |24h|/10，MACD Hist 面积收窄 + DIF 快线抬高形成双重底背离，且信号 K 线收阳
    {
      id: 'new_low_divergence',
      name: '新低双重底背离多',
      category: '量价背离',
      tag: '【多头-新低背离】',
      evaluate: ({ candle, closes, lows, idx, dayChange, rankLosers, hist, dif, low24h }) => {
        if (dayChange > -10 && (rankLosers == null || rankLosers > 15)) {
          return { triggered: false, exitParams: {} as any };
        }
        // 信号 K 线收阳线确认止跌
        if (candle.close <= candle.open) return { triggered: false, exitParams: {} as any };

        // 1. 创 24h 新低
        if (candle.low > low24h) return { triggered: false, exitParams: {} as any };

        // 2. 5m 急跌脉冲
        const x = 5;
        const startX = idx - x + 1;
        if (startX < 0) return { triggered: false, exitParams: {} as any };
        let maxHigh = -Infinity;
        for (let k = startX; k <= idx; k++) if (closes[k] > maxHigh) maxHigh = closes[k];
        if (maxHigh <= 0) return { triggered: false, exitParams: {} as any };
        const drop = ((maxHigh - candle.low) / maxHigh) * 100;
        const absDayChange = Math.abs(dayChange);
        if (drop < absDayChange / 10.0) return { triggered: false, exitParams: {} as any };

        // 3. MACD 双重底背离 (寻找 10~120 根前低)
        const start = Math.max(0, idx - 120);
        const end = Math.max(0, idx - 10);
        if (end <= start) return { triggered: false, exitParams: {} as any };
        let prevIdx = -1;
        let prevMin = Infinity;
        for (let k = start; k <= end; k++) {
          if (lows[k] < prevMin) {
            prevMin = lows[k];
            prevIdx = k;
          }
        }
        if (prevIdx < 0 || candle.low > prevMin) return { triggered: false, exitParams: {} as any };

        // 底背离：价格更低，但 hist 更高（红柱更短/绿柱增大），dif 快线更高
        if (hist[idx] <= hist[prevIdx] || dif[idx] <= dif[prevIdx]) {
          return { triggered: false, exitParams: {} as any };
        }

        return {
          triggered: true,
          impulsePercent: drop,
          exitParams: { holdMinutes: 15, exitX: 50, exitN: 1.5, exitM: 3.0 },
        };
      },
    },

    // 策略 3：【见底大反弹次级回踩做多】 (Bottom Rebound Secondary Pullback Long)
    // 逻辑：从 24h 低点暴涨反弹 >= 15%，回撤 4%~8% 回踩 MA15/MA30 踩稳 (Low < MA15 < Close)，MA15 > MA30 金叉上行
    {
      id: 'rebound_pullback_long',
      name: '深跌反弹回踩做多',
      category: '右侧反转',
      tag: '【多头-反弹回踩】',
      evaluate: ({ candle, closes, lows, highs, idx, low24h }) => {
        if (low24h <= 0) return { triggered: false, exitParams: {} as any };
        // 距 24h 最低点反弹幅度 >= 15%
        const maxRebound = ((candle.high - low24h) / low24h) * 100;
        if (maxRebound < 15.0) return { triggered: false, exitParams: {} as any };

        // 近 15 分钟高点回撤 >= 4.0%
        let high15m = 0;
        for (let k = Math.max(0, idx - 14); k <= idx; k++) if (highs[k] > high15m) high15m = highs[k];
        if (high15m <= 0) return { triggered: false, exitParams: {} as any };
        const pullback = ((high15m - candle.close) / high15m) * 100;
        if (pullback < 4.0 || pullback > 12.0) return { triggered: false, exitParams: {} as any };

        // 均线支撑: MA15 > MA30
        const ma15 = calculateSma(closes, idx, 15);
        const ma30 = calculateSma(closes, idx, 30);
        const ma30Prev = calculateSma(closes, idx - 2, 30);
        if (ma15 == null || ma30 == null || ma30Prev == null) return { triggered: false, exitParams: {} as any };
        if (ma15 <= ma30 || ma30 < ma30Prev) return { triggered: false, exitParams: {} as any };

        // 踩稳检验: 刺破 MA15 但收盘在 MA15 之上 (Low < MA15 < Close)
        if (!(candle.low < ma15 && candle.close > ma15)) return { triggered: false, exitParams: {} as any };

        return {
          triggered: true,
          impulsePercent: pullback,
          exitParams: { holdMinutes: 30, exitX: 35, exitN: 2.0, exitM: 2.5 },
        };
      },
    },

    // 策略 4：【涨幅榜强势首阴回踩 MA30 生命线多】 (Top Gainer Strong Pullback Long)
    // 逻辑：24h 涨幅榜 Top 10 (涨幅 >= 20%)，从 24h 峰值首次回踩 8%~15% 到 MA30 附近，Low <= MA30 且 Close > MA30 收阳或长下影
    {
      id: 'gainer_ma30_pullback',
      name: '强势龙头回踩MA30多',
      category: '顺势做多',
      tag: '【多头-龙头回踩】',
      evaluate: ({ candle, closes, high24h, idx, dayChange, rankGainers }) => {
        if (rankGainers == null || rankGainers > 10 || dayChange < 20) {
          return { triggered: false, exitParams: {} as any };
        }
        if (high24h <= 0) return { triggered: false, exitParams: {} as any };

        // 从 24h 最高点回撤 8% ~ 16%
        const dropFromPeak = ((high24h - candle.close) / high24h) * 100;
        if (dropFromPeak < 8.0 || dropFromPeak > 16.0) return { triggered: false, exitParams: {} as any };

        // MA30 生命线支撑
        const ma30 = calculateSma(closes, idx, 30);
        const ma30Prev = calculateSma(closes, idx - 3, 30);
        if (ma30 == null || ma30Prev == null) return { triggered: false, exitParams: {} as any };

        // MA30 必须保持强劲上倾
        if (ma30 <= ma30Prev) return { triggered: false, exitParams: {} as any };

        // 支撑确认: 下探触碰 MA30 但收盘在 MA30 之上
        if (!(candle.low <= ma30 * 1.002 && candle.close >= ma30)) {
          return { triggered: false, exitParams: {} as any };
        }

        // K 线必须收阳或留长下影线
        const range = candle.high - candle.low;
        const lowerWick = Math.min(candle.open, candle.close) - candle.low;
        const isBullish = candle.close >= candle.open;
        if (!isBullish && (range <= 0 || lowerWick / range < 0.35)) {
          return { triggered: false, exitParams: {} as any };
        }

        return {
          triggered: true,
          impulsePercent: dropFromPeak,
          exitParams: {
            holdMinutes: 30,
            exitX: 35,
            exitN: 2.0,
            exitM: 2.5,
          },
        };
      },
    },
  ];

  interface LongSignalEvent {
    member: LongSignalMember;
    symbol: string;
    time: number;
    entryPrice: number;
    dayChange: number;
    impulsePercent: number;
    exitParams: any;
  }

  const allEvents: LongSignalEvent[] = [];

  for (const [sym, bars] of minuteData.candles) {
    if (!bars || bars.length < 65) continue;
    const opens = bars.map(b => b[1]);
    const highs = bars.map(b => b[2]);
    const lows = bars.map(b => b[3]);
    const closes = bars.map(b => b[4]);
    const times = bars.map(b => b[0]);
    const { hist, dif } = computeMacd(closes);

    let curMax24h = 0;
    let curMin24h = Infinity;

    for (let i = 35; i < bars.length - 1; i++) {
      const t = times[i];
      const bTime = Math.floor(t / HOUR) * HOUR;
      const gRow = gainerBoards.get(bTime)?.get(sym);
      const lRow = loserBoards.get(bTime)?.get(sym);

      const dayChange = gRow ? gRow.dayChange : lRow ? lRow.dayChange : 0;
      const rankG = gRow ? gRow.rank : null;
      const rankL = lRow ? lRow.rank : null;

      // 滚动 24h 最高与最低
      const start24h = Math.max(0, i - 1439);
      if (i === 35 || highs[i] > curMax24h) {
        let m = 0;
        for (let k = start24h; k <= i; k++) if (highs[k] > m) m = highs[k];
        curMax24h = m;
      }
      if (i === 35 || lows[i] < curMin24h) {
        let mi = Infinity;
        for (let k = start24h; k <= i; k++) if (lows[k] < mi) mi = lows[k];
        curMin24h = mi;
      }

      const candleObj = { open: opens[i], high: highs[i], low: lows[i], close: closes[i], time: times[i] };

      for (const member of members) {
        const res = member.evaluate({
          symbol: sym,
          candle: candleObj,
          closes,
          highs,
          lows,
          opens,
          idx: i,
          hist,
          dif,
          low24h: curMin24h,
          high24h: curMax24h,
          dayChange,
          rankGainers: rankG,
          rankLosers: rankL,
        });

        if (res.triggered) {
          const nextBar = bars[i + 1];
          if (!nextBar) continue;
          allEvents.push({
            member,
            symbol: sym,
            time: nextBar[0],
            entryPrice: nextBar[1],
            dayChange,
            impulsePercent: res.impulsePercent ?? 0,
            exitParams: res.exitParams,
          });
          break; // 同一根 K 线首个匹配生效
        }
      }
    }
  }

  console.log(`总挖掘发现原始候选做多信号: ${allEvents.length} 笔\n`);

  // 排序信号并运行统一持仓防重回测
  allEvents.sort((a, b) => a.time - b.time);

  const occupiedUntil = new Map<string, number>();
  const cooldownUntil = new Map<string, number>();

  interface ExecutedTrade {
    member: LongSignalMember;
    symbol: string;
    entryTime: number;
    entryPrice: number;
    exitTime: number;
    exitPrice: number;
    dayChange: number;
    impulsePercent: number;
    duration: number;
    netPercent: number;
    reasons: string;
  }

  const executedTrades: ExecutedTrade[] = [];
  let conflicts = 0;

  for (const ev of allEvents) {
    if ((occupiedUntil.get(ev.symbol) ?? -Infinity) > ev.time) {
      conflicts++;
      continue;
    }
    if ((cooldownUntil.get(ev.symbol) ?? -Infinity) > ev.time) {
      conflicts++;
      continue;
    }

    const bars = minuteData.candles.get(ev.symbol);
    if (!bars) continue;

    const fillIdx = bars.findIndex(b => b[0] === ev.time);
    if (fillIdx < 0) continue;

    const { holdMinutes, exitX, exitN, exitM, stopLossPercent, tp1Percent: fixedTp1, tp2Percent: fixedTp2, moveSlToEntryAfterTp1 } = ev.exitParams;
    const absDayChange = Math.max(10, Math.abs(ev.dayChange));
    const entry = ev.entryPrice;

    // 做多价格层级: TP 在上方, SL 在下方
    const tp1Pct = fixedTp1 ?? (absDayChange / exitX);
    const sl1Pct = stopLossPercent ?? (absDayChange / exitX);
    const tp2Pct = fixedTp2 ?? (absDayChange * exitM / exitX);
    const sl2Pct = stopLossPercent ?? (absDayChange * exitN / exitX);

    const tp1 = entry * (1 + tp1Pct / 100);
    const sl1 = entry * (1 - sl1Pct / 100);
    const tp2 = entry * (1 + tp2Pct / 100);
    let sl2 = entry * (1 - sl2Pct / 100);

    let stage1Closed = false;
    let stage2Closed = false;
    let tradeNet = 0;
    let exitTime = ev.time + holdMinutes * MINUTE;
    let reason1 = 'timeout';
    let reason2 = 'timeout';
    let finalExitPrice = entry;

    for (let step = 0; step < holdMinutes; step++) {
      const b = bars[fillIdx + step];
      if (!b) break;
      const h = b[2];
      const l = b[3];
      const c = b[4];

      // 阶段 1 撮合
      if (!stage1Closed) {
        if (l <= sl1) {
          tradeNet += calcLongReturn(entry, sl1).netPercent * 0.5;
          stage1Closed = true;
          reason1 = 'stop';
        } else if (h >= tp1) {
          tradeNet += calcLongReturn(entry, tp1).netPercent * 0.5;
          stage1Closed = true;
          reason1 = 'target';
          if (moveSlToEntryAfterTp1) {
            sl2 = entry; // 移动止损至保本
          }
        }
      }

      // 阶段 2 撮合
      if (stage1Closed && !stage2Closed) {
        if (l <= sl2) {
          tradeNet += calcLongReturn(entry, sl2).netPercent * 0.5;
          stage2Closed = true;
          reason2 = 'stop';
          exitTime = b[0];
          finalExitPrice = sl2;
          break;
        } else if (h >= tp2) {
          tradeNet += calcLongReturn(entry, tp2).netPercent * 0.5;
          stage2Closed = true;
          reason2 = 'target';
          exitTime = b[0];
          finalExitPrice = tp2;
          break;
        }
      }

      // 超时平仓
      if (step === holdMinutes - 1) {
        const rem = (!stage1Closed ? 1.0 : !stage2Closed ? 0.5 : 0);
        if (rem > 0) {
          tradeNet += calcLongReturn(entry, c).netPercent * rem;
        }
        exitTime = b[0];
        finalExitPrice = c;
      }
    }

    occupiedUntil.set(ev.symbol, exitTime);
    cooldownUntil.set(ev.symbol, exitTime + 20 * MINUTE);

    executedTrades.push({
      member: ev.member,
      symbol: ev.symbol,
      entryTime: ev.time,
      entryPrice: entry,
      exitTime,
      exitPrice: finalExitPrice,
      dayChange: ev.dayChange,
      impulsePercent: ev.impulsePercent,
      duration: Math.round((exitTime - ev.time) / MINUTE),
      netPercent: tradeNet,
      reasons: `${reason1}/${reason2}`,
    });
  }

  // 统计结果
  const totalTrades = executedTrades.length;
  const wins = executedTrades.filter(t => t.netPercent > 0).length;
  const losses = executedTrades.filter(t => t.netPercent <= 0).length;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const totalNet = executedTrades.reduce((s, t) => s + t.netPercent, 0);

  const grossGains = executedTrades.filter(t => t.netPercent > 0).reduce((s, t) => s + t.netPercent, 0);
  const grossLosses = Math.abs(executedTrades.filter(t => t.netPercent < 0).reduce((s, t) => s + t.netPercent, 0));
  const pf = grossLosses > 0 ? grossGains / grossLosses : grossGains > 0 ? 999 : 0;

  // 最大回撤
  let peak = 0, curBal = 0, maxDd = 0;
  for (const t of executedTrades) {
    curBal += t.netPercent;
    if (curBal > peak) peak = curBal;
    const dd = peak - curBal;
    if (dd > maxDd) maxDd = dd;
  }

  const ci = wilsonInterval(wins, totalTrades);

  console.log('========================================================================================');
  console.log('🏆【做多策略组联合回测总战绩】');
  console.log('========================================================================================');
  console.log(`  • 候选总信号: ${allEvents.length} 笔 | 实际撮合接纳: ${totalTrades} 笔 (防重冲突拦截: ${conflicts} 笔)`);
  console.log(`  • 综合胜率 (Win Rate): ${winRate.toFixed(1)}% (${wins} 胜 ${losses} 负)`);
  if (ci) console.log(`  • 威尔逊 95% 置信区间: [${(ci[0] * 100).toFixed(1)}%, ${(ci[1] * 100).toFixed(1)}%]`);
  console.log(`  • 利润因子 (Profit Factor): ${pf.toFixed(2)}`);
  console.log(`  • 累计净收益率 (Net PnL): ${totalNet >= 0 ? '+' : ''}${totalNet.toFixed(2)}%`);
  console.log(`  • 最大回撤 (Max Drawdown): ${maxDd.toFixed(2)}%`);
  console.log(`  • 平均单笔净收益: ${totalTrades > 0 ? (totalNet / totalTrades).toFixed(2) : '0'}%\n`);

  console.log('📊【做多各子策略战绩细分】:');
  console.log('| 子策略标识 | 策略类型 | 交易笔数 | 战绩(胜/负) | 胜率(%) | 净收益贡献(%) | 利润因子(PF) |');
  console.log('| :--- | :--- | :---: | :---: | :---: | :---: | :---: |');

  for (const m of members) {
    const subTrades = executedTrades.filter(t => t.member.id === m.id);
    const subTotal = subTrades.length;
    const subWins = subTrades.filter(t => t.netPercent > 0).length;
    const subLosses = subTotal - subWins;
    const subWr = subTotal > 0 ? (subWins / subTotal) * 100 : 0;
    const subNet = subTrades.reduce((s, t) => s + t.netPercent, 0);
    const subGains = subTrades.filter(t => t.netPercent > 0).reduce((s, t) => s + t.netPercent, 0);
    const subLoss = Math.abs(subTrades.filter(t => t.netPercent < 0).reduce((s, t) => s + t.netPercent, 0));
    const subPf = subLoss > 0 ? subGains / subLoss : subGains > 0 ? 999 : 0;

    console.log(
      `| ${m.tag.padEnd(16)} | ${m.category.padEnd(8)} | ${String(subTotal).padStart(8)} | ${String(`${subWins}胜${subLosses}负`).padStart(11)} | ${(subWr.toFixed(1) + '%').padStart(6)} | ${(subNet >= 0 ? '+' : '') + subNet.toFixed(2) + '%'} | ${subPf.toFixed(2)} |`
    );
  }

  console.log('\n📋【做多交易明细前 20 笔流水】:');
  console.log('| 序号 | 所属子策略 | 币种 | 入场时间 (UTC) | 24h涨跌% | 脉冲幅度% | 持仓(分) | 净收益% | 结果 | 退出原因 |');
  console.log('| :---: | :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- |');

  executedTrades.slice(0, 25).forEach((t, i) => {
    const dateStr = new Date(t.entryTime).toISOString().replace('2026-', '').replace(':00.000Z', '').replace('T', ' ');
    const isWin = t.netPercent > 0;
    console.log(
      `| ${String(i + 1).padStart(4)} | ${t.member.tag.padEnd(14)} | ${t.symbol.padEnd(8)} | ${dateStr} | ${String(t.dayChange.toFixed(1) + '%').padStart(7)} | ${String(t.impulsePercent.toFixed(1) + '%').padStart(7)} | ${String(t.duration).padStart(6)} | ${(t.netPercent >= 0 ? ' ' : '') + t.netPercent.toFixed(2) + '%'} | ${isWin ? '✅ 盈利' : '❌ 亏损'} | ${t.reasons} |`
    );
  });
}

main().catch(console.error);
