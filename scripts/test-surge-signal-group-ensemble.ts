import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { loadDataset } from '../research/data.ts';
import { buildFrames } from '../research/backtest.ts';
import type { MinuteDataset } from '../research/gainers-types.ts';
import { HOUR } from '../research/types.ts';
import { MINUTE } from '../research/gainers-types.ts';
import { calculateSma } from '../research/peak-rebound-signals.ts';
import { computeMacd, calculateSupportMaAt } from '../src/macd.ts';
import { calcReturn, wilsonInterval } from '../research/peak-rebound-backtest.ts';

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

interface SignalGroupMember {
  id: string;
  name: string;
  category: string;
  tag: string;
  evaluate: (ctx: {
    symbol: string;
    candle: any;
    closes: number[];
    highs: number[];
    lows: number[];
    idx: number;
    hist: number[];
    dif: number[];
    candlesList: any[];
    high24h: number;
    dayChange: number;
    rank: number;
  }) => {
    triggered: boolean;
    surgePercent?: number;
    requiredSurge?: number;
    exitParams: { holdMinutes: number; exitX: number; exitN: number; exitM: number };
  };
}

async function main() {
  console.log('========================================================================================');
  console.log('🎯【信号组联合回测】以 X 分钟涨幅 24h/N 为公共基底的三大做空子策略群协同回测');
  console.log('========================================================================================\n');

  console.log('载入全市场 168 小时历史行情与全部 1m K 线数据...');
  const hourly = await loadDataset(path.resolve('data/research/hourly-168h'));
  const frames = buildFrames(hourly, 10, 1);
  const minuteData = await loadAllMinutes();

  const boards = new Map<number, Map<string, { rank: number; dayChange: number }>>();
  for (const frame of frames) {
    const symbolMap = new Map<string, { rank: number; dayChange: number }>();
    for (const obs of frame.boards.gainers) {
      symbolMap.set(obs.symbol, { rank: obs.rank, dayChange: obs.dayChange });
    }
    boards.set(frame.time, symbolMap);
  }

  // 构建 3 个基于公共冲高基底的专业化子策略
  const members: SignalGroupMember[] = [
    // 成员 1：【脉冲极度乖离空】(Impulse Extreme MA Extension)
    // 核心逻辑：3m 内暴涨达到 24h/3.5，价格极速脱离 MA30 均线 (乖离 >= 1.5%)，捕捉流动性瞬间打穿的橡皮筋拉扯极限
    {
      id: 'impulse_extreme_dev',
      name: '脉冲极度乖离空',
      category: '均线因子',
      tag: '【信号组-极度乖离】',
      evaluate: ({ closes, highs, lows, idx, dayChange, rank }) => {
        if (rank > 10 || dayChange < 20) return { triggered: false, exitParams: {} as any };
        const x = 3;
        const n = 3.5;
        const startX = idx - x + 1;
        if (startX < 0) return { triggered: false, exitParams: {} as any };
        let minLow = Infinity;
        for (let k = startX; k <= idx; k++) if (lows[k] < minLow) minLow = lows[k];
        if (minLow <= 0) return { triggered: false, exitParams: {} as any };

        const surge = ((closes[idx] - minLow) / minLow) * 100;
        const reqSurge = dayChange / n;
        if (surge < reqSurge || surge < 4.0) return { triggered: false, exitParams: {} as any };

        // 均线因子: MA30 乖离率 >= 1.5%
        const ma30 = calculateSma(closes, idx, 30);
        if (ma30 == null || ((closes[idx] - ma30) / ma30) * 100 < 1.5) {
          return { triggered: false, exitParams: {} as any };
        }

        return {
          triggered: true,
          surgePercent: surge,
          requiredSurge: reqSurge,
          exitParams: { holdMinutes: 20, exitX: 30, exitN: 2.0, exitM: 2.0 },
        };
      },
    },

    // 成员 2：【脉冲新高顶背离空】(Impulse ATH Bearish Divergence)
    // 核心逻辑：5m 涨幅达到 24h/10，创 24h 新高，下方短均线 MA [3,7,15] 悬空无支撑，且 MACD Hist 与 DIF 双重顶背离
    {
      id: 'impulse_ath_divergence',
      name: '脉冲新高顶背离空',
      category: 'MACD+均线因子',
      tag: '【信号组-新高背离】',
      evaluate: ({ candle, closes, highs, lows, idx, dayChange, rank, hist, dif, candlesList, high24h }) => {
        if (rank > 10 || dayChange < 15) return { triggered: false, exitParams: {} as any };
        const x = 5;
        const n = 10.0;
        const startX = idx - x + 1;
        if (startX < 0) return { triggered: false, exitParams: {} as any };
        let minLow = Infinity;
        for (let k = startX; k <= idx; k++) if (lows[k] < minLow) minLow = lows[k];
        if (minLow <= 0) return { triggered: false, exitParams: {} as any };

        const surge = ((candle.high - minLow) / minLow) * 100;
        const reqSurge = dayChange / n;
        if (surge < reqSurge) return { triggered: false, exitParams: {} as any };

        // 因子 1: 创 24h 新高
        if (candle.high < high24h) return { triggered: false, exitParams: {} as any };

        // 因子 2: 均线悬空 MA [3, 7, 15] 无支撑
        if (calculateSupportMaAt(candlesList, idx, [3, 7, 15]) !== null) {
          return { triggered: false, exitParams: {} as any };
        }

        // 因子 3: MACD 双重顶背离 (10~120 根前高)
        const start = Math.max(0, idx - 120);
        const end = Math.max(0, idx - 10);
        if (end <= start) return { triggered: false, exitParams: {} as any };
        let prevIdx = -1; let prevMax = 0;
        for (let k = start; k <= end; k++) {
          if (highs[k] > prevMax) { prevMax = highs[k]; prevIdx = k; }
        }
        if (prevIdx < 0 || candle.high < prevMax) return { triggered: false, exitParams: {} as any };
        if (hist[idx] >= hist[prevIdx] || dif[idx] >= dif[prevIdx]) {
          return { triggered: false, exitParams: {} as any };
        }

        return {
          triggered: true,
          surgePercent: surge,
          requiredSurge: reqSurge,
          exitParams: { holdMinutes: 15, exitX: 50, exitN: 1.5, exitM: 3.0 },
        };
      },
    },

    // 成员 3：【脉冲反抽均线压制空】(Impulse Pullback MA Ceiling)
    // 核心逻辑：10m 涨幅达到 24h/4.0，从 24h 高点回撤 >= 20%，MA15 < MA30 空头排列且 MA30 下倾，冲高遭遇 MA15 阻击刺破收回 (Close < MA15 < High)
    {
      id: 'impulse_trend_ceiling',
      name: '脉冲反抽均线压制空',
      category: '均线趋势因子',
      tag: '【信号组-均线压制】',
      evaluate: ({ candle, closes, highs, lows, idx, dayChange, rank, high24h, hist }) => {
        if (high24h <= 0) return { triggered: false, exitParams: {} as any };
        const drop = ((high24h - closes[idx]) / high24h) * 100;
        if (drop < 20.0) return { triggered: false, exitParams: {} as any };

        const x = 10;
        const n = 4.0;
        const startX = idx - x + 1;
        if (startX < 0) return { triggered: false, exitParams: {} as any };
        let minLow = Infinity;
        for (let k = startX; k <= idx; k++) if (lows[k] < minLow) minLow = lows[k];
        if (minLow <= 0) return { triggered: false, exitParams: {} as any };

        const surge = ((highs[idx] - minLow) / minLow) * 100;
        const reqSurge = Math.max(5.0, dayChange / n);
        if (surge < reqSurge) return { triggered: false, exitParams: {} as any };

        // 均线排列与压制
        const ma15 = calculateSma(closes, idx, 15);
        const ma30 = calculateSma(closes, idx, 30);
        if (ma15 == null || ma30 == null) return { triggered: false, exitParams: {} as any };
        if (!(ma15 < ma30)) return { triggered: false, exitParams: {} as any };
        if (!(closes[idx] < ma15 && ma15 < highs[idx])) return { triggered: false, exitParams: {} as any };

        // MA30 下倾
        if (idx >= 2) {
          const prevMa30 = calculateSma(closes, idx - 2, 30);
          if (prevMa30 != null && ma30 >= prevMa30) return { triggered: false, exitParams: {} as any };
        }

        // MACD 动能确认 (近 20 根绿柱占比 > 65%)
        let greenCount = 0;
        for (let k = Math.max(0, idx - 19); k <= idx; k++) if (hist[k] > 0) greenCount++;
        if (greenCount / 20 < 0.65) return { triggered: false, exitParams: {} as any };

        return {
          triggered: true,
          surgePercent: surge,
          requiredSurge: reqSurge,
          exitParams: { holdMinutes: 30, exitX: 35, exitN: 2.0, exitM: 4.0 },
        };
      },
    },
  ];

  interface SignalEvent {
    member: SignalGroupMember;
    symbol: string;
    time: number;
    entryPrice: number;
    dayChange: number;
    surgePercent: number;
    requiredSurge: number;
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
    const { hist, dif } = computeMacd(closes);
    const candlesList = bars.map(b => ({ time: b[0], open: b[1], high: b[2], low: b[3], close: b[4] }));

    let curMax24h = 0;

    for (let i = 35; i < bars.length - 1; i++) {
      const t = times[i];
      const bTime = Math.floor(t / HOUR) * HOUR;
      const row = boards.get(bTime)?.get(sym);
      if (!row) continue;

      const start24h = Math.max(0, i - 1439);
      if (i === 35 || highs[i] > curMax24h) {
        let m = 0;
        for (let k = start24h; k <= i; k++) if (highs[k] > m) m = highs[k];
        curMax24h = m;
      }

      const candleObj = { open: opens[i], high: highs[i], low: lows[i], close: closes[i], time: times[i] };

      // 评估信号组各成员
      for (const member of members) {
        const res = member.evaluate({
          symbol: sym,
          candle: candleObj,
          closes,
          highs,
          lows,
          idx: i,
          hist,
          dif,
          candlesList,
          high24h: curMax24h,
          dayChange: row.dayChange,
          rank: row.rank,
        });

        if (res.triggered) {
          const nextBar = bars[i + 1];
          if (!nextBar) continue;
          allEvents.push({
            member,
            symbol: sym,
            time: nextBar[0],
            entryPrice: nextBar[1],
            dayChange: row.dayChange,
            surgePercent: res.surgePercent ?? 0,
            requiredSurge: res.requiredSurge ?? 0,
            exitParams: res.exitParams,
          });
          break; // 同一根 K 线优先触发首个匹配的策略
        }
      }
    }
  }

  // 排序信号并运行统一持仓防重回测
  allEvents.sort((a, b) => a.time - b.time);

  const occupiedUntil = new Map<string, number>();
  const cooldownUntil = new Map<string, number>();
  interface ExecutedTrade {
    member: SignalGroupMember;
    symbol: string;
    entryTime: number;
    entryPrice: number;
    exitTime: number;
    exitPrice: number;
    dayChange: number;
    surgePercent: number;
    duration: number;
    netPercent: number;
    reasons: string;
  }

  const executedTrades: ExecutedTrade[] = [];
  let conflicts = 0;

  for (const ev of allEvents) {
    // 检查持仓冲突与同币冷却 (20 分钟防刷单)
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

    const { holdMinutes, exitX, exitN, exitM } = ev.exitParams;
    const dayChange = Math.max(10, ev.dayChange);
    const entry = ev.entryPrice;

    const tp1 = entry * (1 - (dayChange / exitX) / 100);
    const sl1 = entry * (1 + (dayChange / exitX) / 100);
    const tp2 = entry * (1 - (dayChange * exitM / exitX) / 100);
    const sl2 = entry * (1 + (dayChange * exitN / exitX) / 100);

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

      if (!stage1Closed) {
        if (h >= sl1) {
          tradeNet += calcReturn(entry, sl1, 'stop').netPercent * 0.5;
          stage1Closed = true;
          reason1 = 'stop';
        } else if (l <= tp1) {
          tradeNet += calcReturn(entry, tp1, 'target').netPercent * 0.5;
          stage1Closed = true;
          reason1 = 'target';
        }
      }

      if (stage1Closed && !stage2Closed) {
        if (h >= sl2) {
          tradeNet += calcReturn(entry, sl2, 'stop').netPercent * 0.5;
          stage2Closed = true;
          reason2 = 'stop';
          exitTime = b[0];
          finalExitPrice = sl2;
          break;
        } else if (l <= tp2) {
          tradeNet += calcReturn(entry, tp2, 'target').netPercent * 0.5;
          stage2Closed = true;
          reason2 = 'target';
          exitTime = b[0];
          finalExitPrice = tp2;
          break;
        }
      }

      if (step === holdMinutes - 1) {
        const rem = (!stage1Closed ? 1.0 : !stage2Closed ? 0.5 : 0);
        if (rem > 0) {
          tradeNet += calcReturn(entry, c, 'timeout').netPercent * rem;
        }
        exitTime = b[0];
        finalExitPrice = c;
      }
    }

    occupiedUntil.set(ev.symbol, exitTime);
    cooldownUntil.set(ev.symbol, Math.max(exitTime, ev.time + 20 * MINUTE));

    executedTrades.push({
      member: ev.member,
      symbol: ev.symbol,
      entryTime: ev.time,
      entryPrice: entry,
      exitTime,
      exitPrice: finalExitPrice,
      dayChange: ev.dayChange,
      surgePercent: ev.surgePercent,
      duration: Math.round((exitTime - ev.time) / MINUTE),
      netPercent: tradeNet,
      reasons: `${reason1}/${reason2}`,
    });
  }

  // 计算指标
  const wins = executedTrades.filter(t => t.netPercent > 0);
  const losses = executedTrades.filter(t => t.netPercent < 0);
  const totalNet = executedTrades.reduce((s, t) => s + t.netPercent, 0);
  const grossWins = wins.reduce((s, t) => s + t.netPercent, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPercent, 0));
  const pf = grossLoss > 0 ? grossWins / grossLoss : Infinity;
  const winRate = executedTrades.length ? (wins.length / executedTrades.length) * 100 : 0;
  const winRate95 = wilsonInterval(wins.length, executedTrades.length);

  let peakEquity = 0;
  let cumPnl = 0;
  let maxDd = 0;
  for (const t of executedTrades) {
    cumPnl += t.netPercent;
    if (cumPnl > peakEquity) peakEquity = cumPnl;
    const dd = peakEquity - cumPnl;
    if (dd > maxDd) maxDd = dd;
  }

  console.log(`========================================================================================`);
  console.log(`🏆【重构后冲高做空信号组：全局战绩】`);
  console.log(`========================================================================================`);
  console.log(`  • 候选总信号: ${allEvents.length} 笔 | 实际撮合接纳: ${executedTrades.length} 笔 (冲突拦截 ${conflicts} 笔)`);
  console.log(`  • 综合胜率 (Win Rate): ${winRate.toFixed(1)}% (${wins.length} 胜 ${losses.length} 负)`);
  if (winRate95) {
    console.log(`  • 威尔逊 95% 置信区间: [${winRate95[0].toFixed(1)}%, ${winRate95[1].toFixed(1)}%]`);
  }
  console.log(`  • 盈利因子 (Profit Factor): ${pf ? pf.toFixed(2) : '∞'}`);
  console.log(`  • 累计净收益率 (Net PnL): +${totalNet.toFixed(2)}%`);
  console.log(`  • 最大回撤 (Max Drawdown): ${maxDd.toFixed(2)}%`);
  console.log(`  • 平均单笔收益: +${(totalNet / executedTrades.length).toFixed(2)}%\n`);

  console.log(`📊【信号组内部各子策略战绩细分】:`);
  console.log('| 子策略标识 | 核心因子配置 | 交易笔数 | 战绩(胜/负) | 胜率(%) | 净收益贡献(%) | 盈亏比(PF) |');
  console.log('| :--- | :--- | :---: | :---: | :---: | :---: | :---: |');
  for (const m of members) {
    const subTrades = executedTrades.filter(t => t.member.id === m.id);
    const subWins = subTrades.filter(t => t.netPercent > 0);
    const subLoss = subTrades.filter(t => t.netPercent < 0);
    const subNet = subTrades.reduce((s, t) => s + t.netPercent, 0);
    const subGrossWins = subWins.reduce((s, t) => s + t.netPercent, 0);
    const subGrossLoss = Math.abs(subLoss.reduce((s, t) => s + t.netPercent, 0));
    const subPf = subGrossLoss > 0 ? subGrossWins / subGrossLoss : Infinity;
    const subWr = subTrades.length ? (subWins.length / subTrades.length) * 100 : 0;

    let desc = '';
    if (m.id === 'impulse_extreme_dev') desc = '3m≥24h/3.5 + MA30乖离≥1.5%';
    else if (m.id === 'impulse_ath_divergence') desc = '5m≥24h/10 + 24h新高 + MACD双背离 + MA悬空';
    else desc = '10m≥24h/4 + 跌破24h高点20% + MA15阻击 + 空头排列';

    console.log(
      `| ${m.tag.padEnd(16)} | ${desc.padEnd(38)} | ${subTrades.length.toString().padStart(8)} | ${(subWins.length + '胜' + subLoss.length + '负').padStart(9)} | ${subWr.toFixed(1)}% | +${subNet.toFixed(2)}% | ${subPf ? subPf.toFixed(2) : '∞'} |`,
    );
  }

  console.log('\n📋【全部交易逐笔审查流水】:');
  console.log('| 序号 | 所属子策略 | 币种 | 入场时间 (UTC) | 24h涨幅% | 冲高幅度% | 持仓(分) | 净收益% | 结果 | 退出原因 |');
  console.log('| :---: | :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- |');
  executedTrades.forEach((t, i) => {
    const res = t.netPercent > 0 ? '✅ 盈利' : '❌ 亏损';
    console.log(
      `| ${(i + 1).toString().padStart(4)} | ${t.member.tag.padEnd(14)} | ${t.symbol.padEnd(8)} | ${new Date(t.entryTime).toISOString().slice(5, 16)} | ${t.dayChange.toFixed(1).padStart(5)}% | ${t.surgePercent.toFixed(1).padStart(5)}% | ${t.duration.toString().padStart(6)} | ${t.netPercent.toFixed(2).padStart(6)}% | ${res} | ${t.reasons} |`,
    );
  });
}

main().catch(console.error);
