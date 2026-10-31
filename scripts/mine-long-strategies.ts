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

async function testEngine(
  name: string,
  minuteData: MinuteDataset,
  gainerBoards: Map<number, Map<string, { rank: number; dayChange: number }>>,
  detector: (ctx: {
    symbol: string;
    candle: { open: number; high: number; low: number; close: number; time: number };
    closes: number[];
    highs: number[];
    lows: number[];
    opens: number[];
    idx: number;
    hist: number[];
    dif: number[];
    high24h: number;
    low24h: number;
    dayChange: number;
    rank: number;
  }) => { triggered: boolean; exitParams: any } | null
) {
  const events: any[] = [];
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
      if (!gRow) continue;

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
      const res = detector({
        symbol: sym,
        candle: candleObj,
        closes,
        highs,
        lows,
        opens,
        idx: i,
        hist,
        dif,
        high24h: curMax24h,
        low24h: curMin24h,
        dayChange: gRow.dayChange,
        rank: gRow.rank,
      });

      if (res && res.triggered) {
        const nextBar = bars[i + 1];
        if (!nextBar) continue;
        events.push({
          symbol: sym,
          time: nextBar[0],
          entryPrice: nextBar[1],
          dayChange: gRow.dayChange,
          exitParams: res.exitParams,
        });
      }
    }
  }

  // 排序与防重持仓模拟
  events.sort((a, b) => a.time - b.time);
  const occupiedUntil = new Map<string, number>();
  const cooldownUntil = new Map<string, number>();
  const executed: any[] = [];

  for (const ev of events) {
    if ((occupiedUntil.get(ev.symbol) ?? -Infinity) > ev.time) continue;
    if ((cooldownUntil.get(ev.symbol) ?? -Infinity) > ev.time) continue;

    const bars = minuteData.candles.get(ev.symbol);
    if (!bars) continue;
    const fillIdx = bars.findIndex(b => b[0] === ev.time);
    if (fillIdx < 0) continue;

    const { holdMinutes, exitX, exitN, exitM, stopLossPercent, tp1Percent, tp2Percent, moveSlToEntryAfterTp1 } = ev.exitParams;
    const absDayChange = Math.max(10, Math.abs(ev.dayChange));
    const entry = ev.entryPrice;

    const tp1P = tp1Percent ?? (absDayChange / exitX);
    const sl1P = stopLossPercent ?? (absDayChange / exitX);
    const tp2P = tp2Percent ?? (absDayChange * exitM / exitX);
    const sl2P = stopLossPercent ?? (absDayChange * exitN / exitX);

    const tp1 = entry * (1 + tp1P / 100);
    const sl1 = entry * (1 - sl1P / 100);
    const tp2 = entry * (1 + tp2P / 100);
    let sl2 = entry * (1 - sl2P / 100);

    let stage1Closed = false;
    let stage2Closed = false;
    let tradeNet = 0;
    let exitTime = ev.time + holdMinutes * MINUTE;
    let reason1 = 'timeout';
    let reason2 = 'timeout';

    for (let step = 0; step < holdMinutes; step++) {
      const b = bars[fillIdx + step];
      if (!b) break;
      const h = b[2], l = b[3], c = b[4];

      if (!stage1Closed) {
        if (l <= sl1) {
          tradeNet += calcLongReturn(entry, sl1).netPercent * 0.5;
          stage1Closed = true;
          reason1 = 'stop';
        } else if (h >= tp1) {
          tradeNet += calcLongReturn(entry, tp1).netPercent * 0.5;
          stage1Closed = true;
          reason1 = 'target';
          if (moveSlToEntryAfterTp1) sl2 = entry;
        }
      }

      if (stage1Closed && !stage2Closed) {
        if (l <= sl2) {
          tradeNet += calcLongReturn(entry, sl2).netPercent * 0.5;
          stage2Closed = true;
          reason2 = 'stop';
          exitTime = b[0];
          break;
        } else if (h >= tp2) {
          tradeNet += calcLongReturn(entry, tp2).netPercent * 0.5;
          stage2Closed = true;
          reason2 = 'target';
          exitTime = b[0];
          break;
        }
      }

      if (step === holdMinutes - 1) {
        const rem = (!stage1Closed ? 1.0 : !stage2Closed ? 0.5 : 0);
        if (rem > 0) tradeNet += calcLongReturn(entry, c).netPercent * rem;
        exitTime = b[0];
      }
    }

    occupiedUntil.set(ev.symbol, exitTime);
    cooldownUntil.set(ev.symbol, exitTime + 20 * MINUTE);
    executed.push({ netPercent: tradeNet, reasons: `${reason1}/${reason2}` });
  }

  const total = executed.length;
  const wins = executed.filter(t => t.netPercent > 0).length;
  const losses = total - wins;
  const wr = total > 0 ? (wins / total) * 100 : 0;
  const totalNet = executed.reduce((s, t) => s + t.netPercent, 0);
  const gains = executed.filter(t => t.netPercent > 0).reduce((s, t) => s + t.netPercent, 0);
  const lossSum = Math.abs(executed.filter(t => t.netPercent < 0).reduce((s, t) => s + t.netPercent, 0));
  const pf = lossSum > 0 ? gains / lossSum : gains > 0 ? 999 : 0;

  console.log(`[${name.padEnd(28)}] 交易数: ${String(total).padStart(3)} | 胜率: ${(wr.toFixed(1) + '%').padStart(6)} (${wins}W ${losses}L) | 净收益: ${(totalNet >= 0 ? '+' : '') + totalNet.toFixed(2) + '%'} | PF: ${pf.toFixed(2)}`);
  return { total, wr, totalNet, pf };
}

async function main() {
  console.log('正在载入全市场数据进行做多策略空间探索...');
  const hourly = await loadDataset(path.resolve('data/research/hourly-168h'));
  const frames = buildFrames(hourly, 10, 1);
  const minuteData = await loadAllMinutes();

  const gainerBoards = new Map<number, Map<string, { rank: number; dayChange: number }>>();
  for (const frame of frames) {
    const gMap = new Map<string, { rank: number; dayChange: number }>();
    for (const obs of frame.boards.gainers) gMap.set(obs.symbol, { rank: obs.rank, dayChange: obs.dayChange });
    gainerBoards.set(frame.time, gMap);
  }

  console.log('\n--- 维度 1：【顺势新高真突破 (Momentum Breakout Long)】---');
  // 核心：价格创 24h 新高，且 MACD DIF 与 Hist 同步放量创出新高（无背离，真突破），MA[3,7,15] 紧贴支撑
  for (const xMinutes of [3, 5]) {
    for (const holdM of [15, 30]) {
      for (const exitX of [35, 50]) {
        await testEngine(`新高真突破 (x=${xMinutes}m, hold=${holdM}m, X=${exitX})`, minuteData, gainerBoards, ({ candle, closes, highs, lows, idx, dayChange, rank, hist, dif, high24h }) => {
          if (rank > 10 || dayChange < 15) return null;
          // 创 24h 新高
          if (candle.high < high24h) return null;

          // x 分钟内脉冲
          const startX = idx - xMinutes + 1;
          if (startX < 0) return null;
          let minLow = Infinity;
          for (let k = startX; k <= idx; k++) if (lows[k] < minLow) minLow = lows[k];
          if (minLow <= 0) return null;
          const surge = ((candle.high - minLow) / minLow) * 100;
          if (surge < dayChange / 12) return null;

          // 寻找前高 (10~60 根)
          const start = Math.max(0, idx - 60);
          const end = Math.max(0, idx - 10);
          if (end <= start) return null;
          let prevIdx = -1, prevMax = 0;
          for (let k = start; k <= end; k++) {
            if (highs[k] > prevMax) { prevMax = highs[k]; prevIdx = k; }
          }
          if (prevIdx < 0 || candle.high < prevMax) return null;

          // 真突破：DIF 快线与 Hist 绿柱必须高于前高！(完全非背离，动能加速爆破)
          if (dif[idx] <= dif[prevIdx] || hist[idx] <= hist[prevIdx]) return null;

          // 当根收强阳线 (阳线实体占比 >= 60%)
          const body = candle.close - candle.open;
          const totalRange = candle.high - candle.low;
          if (body <= 0 || totalRange <= 0 || body / totalRange < 0.6) return null;

          return {
            triggered: true,
            exitParams: { holdMinutes: holdM, exitX, exitN: 1.5, exitM: 2.5, stopLossPercent: 4.0, tp1Percent: 3.0, tp2Percent: 6.0, moveSlToEntryAfterTp1: true }
          };
        });
      }
    }
  }

  console.log('\n--- 维度 2：【强势龙头 MA30/MA15 黄金首次回踩 (Golden Pullback Long)】---');
  // 核心：24h 涨幅 >= 25%，处于主升浪，首次深度回调至 MA15/MA30，MACD 在零轴之上，长下影/阳包阴企稳
  for (const pullbackMin of [6.0, 8.0, 10.0]) {
    for (const holdM of [30, 60, 90]) {
      await testEngine(`龙头首次回踩 (pb>=${pullbackMin}%, hold=${holdM}m)`, minuteData, gainerBoards, ({ candle, closes, high24h, idx, dayChange, rank, dif, hist }) => {
        if (rank > 10 || dayChange < 25) return null;
        if (high24h <= 0) return null;

        // 回撤深度
        const drop = ((high24h - candle.close) / high24h) * 100;
        if (drop < pullbackMin || drop > 20.0) return null;

        // MA30 均线
        const ma30 = calculateSma(closes, idx, 30);
        const ma30Prev = calculateSma(closes, idx - 3, 30);
        const ma15 = calculateSma(closes, idx, 15);
        if (ma30 == null || ma30Prev == null || ma15 == null) return null;

        // MA30 向上倾斜
        if (ma30 <= ma30Prev) return null;

        // 触碰支撑: Low 触碰 MA30 或 MA15，收盘踩在 MA30 之上
        if (!(candle.low <= ma30 * 1.005 && candle.close >= ma30)) return null;

        // MACD DIF 保持在零轴之上 (大周期多头结构未被破坏)
        if (dif[idx] <= 0) return null;

        // K 线形态：下影线占比 >= 40% 或收阳线
        const range = candle.high - candle.low;
        const lowerWick = Math.min(candle.open, candle.close) - candle.low;
        const isBullish = candle.close > candle.open;
        if (!isBullish && (range <= 0 || lowerWick / range < 0.4)) return null;

        return {
          triggered: true,
          exitParams: { holdMinutes: holdM, exitX: 35, exitN: 2.0, exitM: 2.0, stopLossPercent: 8.0, tp1Percent: 4.0, tp2Percent: 8.0, moveSlToEntryAfterTp1: true }
        };
      });
    }
  }

  console.log('\n--- 维度 3：【猎杀假跌破 V 反弹簧 (Wyckoff Spring Long)】---');
  // 核心：在强势上升通道中，价格故意跌破前 15~60 根低点 (洗盘杀止损)，但当根 K 线收出长下影大阳线重新反包收回低点上方
  for (const lookback of [20, 30, 45]) {
    await testEngine(`假跌破反包做多 (lookback=${lookback})`, minuteData, gainerBoards, ({ candle, closes, lows, idx, dayChange, rank }) => {
      if (rank > 10 || dayChange < 20) return null;
      if (candle.close <= candle.open) return null; // 必须收阳

      const start = Math.max(0, idx - lookback);
      const end = idx - 1;
      if (end <= start) return null;
      let prevLow = Infinity;
      for (let k = start; k <= end; k++) if (lows[k] < prevLow) prevLow = lows[k];
      if (prevLow <= 0) return null;

      // 假破位：最低价刺穿前低 (Low < prevLow)，但收盘价顽强收回前低之上 (Close > prevLow)
      if (!(candle.low < prevLow && candle.close > prevLow)) return null;

      // 下影线必须显著 (假跌破探针)
      const range = candle.high - candle.low;
      const lowerWick = candle.open - candle.low;
      if (range <= 0 || lowerWick / range < 0.35) return null;

      return {
        triggered: true,
        exitParams: { holdMinutes: 30, exitX: 35, exitN: 2.0, exitM: 2.0, stopLossPercent: 6.0, tp1Percent: 3.5, tp2Percent: 7.0, moveSlToEntryAfterTp1: true }
      };
    });
  }
}

main().catch(console.error);
