import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateSma, isMaSuppressed, getRank1Watchlist } from '../peak-rebound-signals.ts';
import { backtestPeakRebound, calcReturn, wilsonInterval } from '../peak-rebound-backtest.ts';
import { calculateMacdGreenBarRatio } from '../../src/macd.ts';
import type { Frame } from '../types.ts';

test('isMaSuppressed detects upper shadow piercing MA and close rejected below MA', () => {
  const mas = { 5: 100, 10: 105 };

  // Case 1: high > 100, close < 100 -> suppressed by MA5
  const res1 = isMaSuppressed({ high: 102, close: 98 }, mas, [5]);
  assert.equal(res1.suppressed, true);
  assert.equal(res1.piercedMaPeriod, 5);

  // Case 2: high < 100, close < 100 -> didn't pierce MA
  const res2 = isMaSuppressed({ high: 99, close: 98 }, mas, [5]);
  assert.equal(res2.suppressed, false);

  // Case 3: high > 100, close > 100 -> broke out above MA, not suppressed
  const res3 = isMaSuppressed({ high: 105, close: 102 }, mas, [5]);
  assert.equal(res3.suppressed, false);

  // Case 4: Multiple MAs [5, 10]: close must be < both, high must pierce at least one
  const res4 = isMaSuppressed({ high: 101, close: 99 }, mas, [5, 10]);
  assert.equal(res4.suppressed, true);
  assert.equal(res4.piercedMaPeriod, 5);

  const res5 = isMaSuppressed({ high: 106, close: 101 }, mas, [5, 10]); // close > MA5
  assert.equal(res5.suppressed, false);
});

test('calculateSma computes simple moving average correctly', () => {
  const closes = [10, 20, 30, 40, 50];
  assert.equal(calculateSma(closes, 4, 3), 40); // (30+40+50)/3 = 40
  assert.equal(calculateSma(closes, 4, 5), 30); // (10+20+30+40+50)/5 = 30
  assert.equal(calculateSma(closes, 1, 3), null); // insufficient data
});

test('calcReturn calculates net short return with taker fee and slippage', () => {
  // Short from 100 to 90: gross = +10%
  // Entry fee: 5bps = 0.05%
  // Exit fee: 5bps * 0.9 = 0.045%
  // Slippage: 2bps * (1 + 0.9) = 0.038%
  // Net = 10 - 0.05 - 0.045 - 0.038 = 9.867%
  const ret = calcReturn(100, 90, 'target', { takerFeeBps: 5, slippageBps: 2 });
  assert.equal(ret.grossPercent, 10);
  assert.ok(Math.abs(ret.netPercent - 9.867) < 1e-4);
});

test('wilsonInterval returns sensible confidence bounds', () => {
  const ci = wilsonInterval(8, 10);
  assert.ok(ci !== null);
  assert.ok(ci[0] > 40 && ci[0] < ci[1] && ci[1] < 100);
});

test('long MA above short MA and above candle high condition correctly validates', () => {
  const candle = { high: 100, close: 98 };
  const maShort = 99; // candle.high > maShort && candle.close < maShort
  const maLong1 = 102; // maLong > maShort && maLong >= candle.high * 1.01 (102 >= 101)
  const maLong2 = 100.5; // maLong >= candle.high * 1.01 is false (100.5 < 101)
  const maLong3 = 98; // maLong < maShort is false

  const check = (shortVal: number, longVal: number, offsetPct: number) => {
    return longVal > shortVal && longVal >= candle.high * (1 + offsetPct / 100) && candle.high > shortVal && candle.close < shortVal;
  };

  assert.equal(check(maShort, maLong1, 1.0), true);
  assert.equal(check(maShort, maLong2, 1.0), false);
  assert.equal(check(maShort, maLong3, 1.0), false);
});

test('tri-MA alignment validates long > medium > short and suppression', () => {
  const candle = { high: 100, close: 98 };
  const maShort = 99;
  const maMed = 101;
  const maLong = 103;

  const checkTri = (s: number, m: number, l: number, offsetPct: number) => {
    const isAlignment = l > m && m > s;
    const isCeiling = l >= candle.high * (1 + offsetPct / 100);
    const isSuppressed = candle.high > s && candle.close < s;
    return isAlignment && isCeiling && isSuppressed;
  };

  assert.equal(checkTri(maShort, maMed, maLong, 1.0), true);
  // Not aligned: m < s
  assert.equal(checkTri(maShort, 98, maLong, 1.0), false);
  // Not aligned: l < m
  assert.equal(checkTri(maShort, 104, maLong, 1.0), false);
});

test('getRank1Watchlist extracts only symbols with rank 1 and dayChange > 0', () => {
  const mockFrames: Frame[] = [
    {
      time: 1000,
      eligibleSymbols: 100,
      boards: {
        gainers: [
          { symbol: 'AAAUSDT', rank: 1, dayChange: 25 } as any,
          { symbol: 'BBBUSDT', rank: 2, dayChange: 20 } as any,
        ],
        losers: [],
        volume: [],
      },
    },
    {
      time: 2000,
      eligibleSymbols: 100,
      boards: {
        gainers: [
          { symbol: 'AAAUSDT', rank: 1, dayChange: 30 } as any,
          { symbol: 'CCCUSDT', rank: 2, dayChange: 15 } as any,
        ],
        losers: [],
        volume: [],
      },
    },
    {
      time: 3000,
      eligibleSymbols: 100,
      boards: {
        gainers: [
          { symbol: 'DDUSDT', rank: 1, dayChange: -5 } as any, // negative change ignored
        ],
        losers: [],
        volume: [],
      },
    },
  ];

  const watchlist = getRank1Watchlist(mockFrames);
  assert.equal(watchlist.size, 1);
  assert.ok(watchlist.has('AAAUSDT'));
  assert.equal(watchlist.get('AAAUSDT')!.rank1Hours, 2);
});

test('calculateMacdGreenBarRatio computes green hist proportion in window', () => {
  // Linearly increasing prices produce positive MACD hist
  const closes: number[] = [];
  for (let i = 0; i < 50; i++) {
    closes.push(10 + i * 0.5);
  }
  const ratioRes = calculateMacdGreenBarRatio(closes, closes.length - 1, 20);
  assert.ok(ratioRes !== null);
  assert.equal(ratioRes.total, 20);
  assert.ok(ratioRes.ratio > 0.5);
});

test('backtestPeakRebound supports extreme stop loss at candle high when stopAtHigh is true', () => {
  const signal: any = {
    symbol: 'TESTUSDT',
    time: 60000,
    index: 0,
    boardTime: 0,
    dayChangePercent: 35,
    rank: 1,
    peakPrice: 110,
    peakTime: 0,
    pullbackPercent: 10,
    troughPrice: 99,
    troughTime: 500,
    reboundPercent: 4,
    fibRetracement: 0.3,
    reboundUpCandles: 2,
    upperShadowRatio: 0.1,
    shortMa: 5,
    longMa: 30,
    longMaOffsetPercent: 0.5,
    greenRatio20: 0.7,
    maPeriod: 5,
    maPeriods: [5, 15, 30],
    maValues: { 5: 100, 15: 102, 30: 105 },
    close: 100,
    high: 101,
    low: 99,
    open: 100,
  };
  const bars = [
    [0, 100, 101, 99, 100],
    [60000, 100, 105, 99.5, 100.5],
  ];
  const dataset = { candles: new Map([['TESTUSDT', bars]]), symbols: ['TESTUSDT'] } as any;
  const params: any = {
    pullbackX: 10,
    reboundY: 4,
    shortMa: 5,
    longMa: 30,
    longMaOffsetPercent: 0.5,
    minGreenRatio20: 0.65,
    maPeriods: [5, 15, 30],
    holdMinutes: 5,
    exitX: 35,
    exitN: 2.0,
    exitM: 1.5,
  };

  // Standard stop: exits at sl1=101, sl2=102
  const stdRes = backtestPeakRebound(dataset, [signal], params, 0, 1000000, { takerFeeBps: 0, slippageBps: 0, stopAtHigh: false });
  assert.equal(stdRes.trades.length, 1);
  assert.equal(stdRes.trades[0].exits[0].exitPrice, 101);
  assert.equal(stdRes.trades[0].exits[1].exitPrice, 102);

  // Extreme high stop: exits at high=105 for both stages
  const extRes = backtestPeakRebound(dataset, [signal], params, 0, 1000000, { takerFeeBps: 0, slippageBps: 0, stopAtHigh: true });
  assert.equal(extRes.trades.length, 1);
  assert.equal(extRes.trades[0].exits[0].exitPrice, 105);
  assert.equal(extRes.trades[0].exits[1].exitPrice, 105);
  assert.equal(extRes.trades[0].grossPercent, -5.0);
});
