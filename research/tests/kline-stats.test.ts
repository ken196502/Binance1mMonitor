import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeMaAlignment,
  analyzeOhlcComparison,
  analyzeMacdStats,
  detectIntervalSignals,
} from "../../src/kline-stats.ts";
import type { ChartBar } from "../../src/types.ts";

function createMockBar(partial: Partial<ChartBar> = {}): ChartBar {
  return {
    time: Date.now(),
    open: 100,
    high: 105,
    low: 95,
    close: 102,
    volume: 1000,
    ma: {
      "5": 101,
      "10": 100,
      "20": 98,
      "30": 95,
      "60": 90,
    },
    dif: 0.5,
    dea: 0.2,
    hist: 0.6,
    ...partial,
  };
}

test("analyzeMaAlignment: detects full bullish stack correctly", () => {
  const bars = [createMockBar()];
  const res = analyzeMaAlignment(bars);
  assert.equal(res.type, "bullish_full");
  assert.equal(res.label, "完全多头排列");
  assert.deepEqual(res.order, [5, 10, 20, 30, 60]);
  assert.equal(res.orderText, "MA5 > MA10 > MA20 > MA30 > MA60");
});

test("analyzeMaAlignment: compares 3 bars for fresh_bull vs sustained_bull", () => {
  // Case 1: Fresh Bull (T-2 tangled -> T-1 short bull -> T0 full bull)
  const barT2 = createMockBar({
    ma: { "5": 90, "10": 95, "20": 92, "30": 88, "60": 85 }, // tangled
  });
  const barT1 = createMockBar({
    ma: { "5": 96, "10": 94, "20": 92, "30": 90, "60": 91 }, // short bull
  });
  const barT0 = createMockBar({
    ma: { "5": 105, "10": 100, "20": 95, "30": 90, "60": 85 }, // full bull
  });

  const resFresh = analyzeMaAlignment([barT2, barT1, barT0], 2);
  assert.equal(resFresh.pattern3Bars, "fresh_bull");
  assert.equal(resFresh.pattern3BarsLabel, "刚成多头 (起爆交叉)");
  assert.ok(resFresh.history3Bars?.length === 3);
  assert.ok(resFresh.transitionText?.includes("➔"));

  // Case 2: Sustained Bull (3 consecutive full bull bars)
  const resSustained = analyzeMaAlignment([barT0, barT0, barT0], 2);
  assert.equal(resSustained.pattern3Bars, "sustained_bull");
  assert.equal(resSustained.streakBars, 3);
});

test("analyzeMaAlignment: detects full bearish stack correctly", () => {
  const bars = [
    createMockBar({
      ma: {
        "5": 80,
        "10": 85,
        "20": 90,
        "30": 95,
        "60": 100,
      },
    }),
  ];
  const res = analyzeMaAlignment(bars);
  assert.equal(res.type, "bearish_full");
  assert.equal(res.label, "完全空头排列");
  assert.deepEqual(res.order, [60, 30, 20, 10, 5]);
});

test("analyzeOhlcComparison: accurately identifies support and resistance", () => {
  // Candle tests low at 99, bounces to close at 101. MA10 is at 100.
  // low <= 100 && close > 100 -> MA10 is support!
  const bar = createMockBar({
    open: 100.5,
    high: 103,
    low: 99.5,
    close: 101.5,
    ma: {
      "5": 101,
      "10": 100,
      "20": 98,
      "30": 95,
      "60": 102, // high (103) >= 102 && close (101.5) < 102 -> MA60 is resistance!
    },
  });
  const res = analyzeOhlcComparison([bar]);
  assert.ok(res.supports.includes(10), "MA10 should be a support");
  assert.ok(res.resistances.includes(60), "MA60 should be resistance");
});

test("analyzeMacdStats: calculates green bar ratio and streaks", () => {
  const bars: ChartBar[] = [];
  // Generate 30 bars, 25 positive and last 5 negative
  for (let i = 0; i < 30; i++) {
    const isGreen = i < 25;
    bars.push(
      createMockBar({
        hist: isGreen ? 0.5 : -0.5,
        dif: isGreen ? 1.0 : -0.5,
        dea: 0,
      }),
    );
  }
  const res = analyzeMacdStats(bars);
  assert.equal(res.greenCount30, 25);
  assert.equal(res.greenBarRatio30, 25 / 30);
  assert.equal(res.redStreak, 5);
  assert.equal(res.greenStreak, 0);
});

test("detectIntervalSignals: marks interval rise >= 24h change / ampDivisor", () => {
  const bars: ChartBar[] = [];
  const baseTime = 1700000000000;
  // Day change = +20%
  // 5m surge: from low 100 to high 103 = +3%
  // ratio = 3% / 20% = 0.15 (15% >= 10%, divisor = 10)
  for (let i = 0; i < 10; i++) {
    const price = 100 + i * 0.4;
    bars.push(
      createMockBar({
        time: baseTime + i * 60000,
        open: price,
        close: price + 0.3,
        low: price - 0.1,
        high: price + 0.4,
      }),
    );
  }

  const signals = detectIntervalSignals(bars, 20.0, {
    windowMinutes: 5,
    ampDivisor: 10,
    mode: "surge",
  });

  assert.ok(signals.length > 0, "Should detect at least 1 qualified surge interval");
  const first = signals[0];
  assert.equal(first.type, "surge");
  assert.ok(first.ratioToDayChange >= 0.1);
  assert.equal(first.dayChangePercent, 20.0);
  assert.ok(first.maAlignment != null);
  assert.ok(first.ohlc != null);
  assert.ok(first.macd != null);
});

test("detectIntervalSignals: partitions by interval, identifies max amplitude segment, and calculates segment-specific green ratio", () => {
  const bars: ChartBar[] = [];
  const baseTime = Math.floor(1700000000000 / (15 * 60000)) * (15 * 60000); // Aligned to 15m boundary
  // 15 bars in a 15-minute interval
  // Minute 0..4: flat around 100, hist < 0 (red)
  // Minute 5: low = 95, hist < 0 (red) -> lowest point of the interval!
  // Minute 6..9: climbing 97, 100, 103, hist > 0 (green)
  // Minute 10: high = 110, hist > 0 (green) -> highest point of the interval!
  // Minute 11..14: pulling back to 105, hist < 0 (red)
  for (let i = 0; i < 15; i++) {
    let low = 100;
    let high = 101;
    let hist = -0.5; // red by default

    if (i === 5) {
      low = 95; // interval lowest
      high = 98;
    } else if (i >= 6 && i <= 9) {
      low = 97 + (i - 6) * 3;
      high = low + 2;
      hist = 0.8; // green
    } else if (i === 10) {
      low = 106;
      high = 110; // interval highest
      hist = 1.2; // green
    }

    bars.push(
      createMockBar({
        time: baseTime + i * 60000,
        open: low + 0.5,
        close: high - 0.5,
        low,
        high,
        hist,
      }),
    );
  }

  const dayChangePercent = 25.0; // +25%
  const signals = detectIntervalSignals(bars, dayChangePercent, {
    windowMinutes: 15,
    mode: "both",
  });

  assert.equal(signals.length, 1, "Should partition into exactly 1 15m interval");
  const seg = signals[0];

  assert.equal(seg.type, "surge", "Max amplitude segment should be surge");
  // Segment is from minLow (95, idx 5) to maxHigh (110, idx 10)
  // Segment amplitude: (110 - 95) / 95 * 100 = 15.789%
  const expectedAmp = ((110 - 95) / 95) * 100;
  assert.ok(Math.abs(seg.intervalChangePercent - expectedAmp) < 1e-4);

  // Segment ratio to 24h change: amp / 25.0
  const expectedRatio = expectedAmp / dayChangePercent;
  assert.ok(Math.abs(seg.ratioToDayChange - expectedRatio) < 1e-4);

  // Segment spans bar 5 to bar 10 (total 6 bars: idx 5, 6, 7, 8, 9, 10)
  assert.equal(seg.segmentBarsCount, 6);
  // Bars with hist > 0: idx 6, 7, 8, 9, 10 (5 bars are green, idx 5 is red)
  assert.equal(seg.segmentGreenCount, 5);
  // Segment green ratio = 5 / 6 = 83.33%
  assert.ok(Math.abs(seg.segmentGreenRatio! - 5 / 6) < 1e-4);

  // Check start & end price
  assert.equal(seg.segmentStartPrice, 95);
  assert.equal(seg.segmentEndPrice, 110);
});

test("detectIntervalSignals: correctly extracts drop (回撤) segment with amplitude and green ratio", () => {
  const bars: ChartBar[] = [];
  const baseTime = Math.floor(1700000000000 / (15 * 60000)) * (15 * 60000);

  // 15-minute interval with major drop
  // Minute 2: peak high = 120, hist > 0 (green)
  // Minute 3..7: falling, hist < 0 (red)
  // Minute 8: trough low = 96, hist < 0 (red)
  for (let i = 0; i < 15; i++) {
    let low = 105;
    let high = 107;
    let hist = -0.5;

    if (i === 2) {
      low = 115;
      high = 120; // peak
      hist = 0.5;
    } else if (i >= 3 && i <= 7) {
      high = 118 - (i - 2) * 4;
      low = high - 2;
    } else if (i === 8) {
      low = 96; // trough
      high = 99;
    }

    bars.push(
      createMockBar({
        time: baseTime + i * 60000,
        open: high - 0.5,
        close: low + 0.5,
        low,
        high,
        hist,
      }),
    );
  }

  const dayChangePercent = 20.0;
  const signals = detectIntervalSignals(bars, dayChangePercent, {
    windowMinutes: 15,
    mode: "drop",
  });

  assert.equal(signals.length, 1);
  const seg = signals[0];
  assert.equal(seg.type, "drop");

  // Drop from 120 to 96: (120 - 96) / 120 * 100 = 20.0%
  const expectedDropAmp = ((120 - 96) / 120) * 100;
  assert.ok(Math.abs(seg.intervalChangePercent - expectedDropAmp) < 1e-4);

  // Ratio to 24h change: 20% / 20% = 1.0 (100%)
  assert.ok(Math.abs(seg.ratioToDayChange - 1.0) < 1e-4);

  // Bars from idx 2 to idx 8 = 7 bars
  assert.equal(seg.segmentBarsCount, 7);
  // Bar 2 is green (hist = 0.5), bars 3..8 are red
  assert.equal(seg.segmentGreenCount, 1);
  assert.ok(Math.abs(seg.segmentGreenRatio! - 1 / 7) < 1e-4);
  assert.equal(seg.segmentStartPrice, 120);
  assert.equal(seg.segmentEndPrice, 96);
});

test("detectIntervalSignals: precursor correctly captures preceding interval MA and MACD stats", () => {
  const bars: ChartBar[] = [];
  const baseTime = Math.floor(1700000000000 / (15 * 60000)) * (15 * 60000);

  // 30 bars total:
  // Interval 0 (bars 0..14): Consolidation before explosion (前一段区间)
  //   - All bars low ~100, high ~101
  //   - Hist > 0 (green) on 12 of the 15 bars
  //   - Bar 14 (preEndIdx): price 100.5, MA20 at 100.0, low = 99.8 -> MA20 support!
  // Interval 1 (bars 15..29): Qualified Surge Explosion (达标振幅段)
  //   - Starts at bar 15: low = 100
  //   - Surges to bar 25: high = 115 (+15%)
  for (let i = 0; i < 30; i++) {
    let low = 100;
    let high = 101;
    let hist = 0.5; // green

    if (i < 15) {
      // Preceding interval: 12 green, 3 red (indices 0, 1, 2)
      if (i < 3) hist = -0.2;
      if (i === 14) {
        low = 99.8; // dips to touch MA20 at 100.0
        high = 101.0;
      }
    } else {
      // Burst interval: surges up to 115
      low = 100 + (i - 15) * 1.5;
      high = low + 1.0;
      if (i === 25) {
        high = 115;
      }
    }

    bars.push(
      createMockBar({
        time: baseTime + i * 60000,
        open: low + 0.3,
        close: high - 0.2,
        low,
        high,
        hist,
        ma: {
          "5": 101,
          "10": 100.5,
          "20": 100.0,
          "30": 98.0,
          "60": 95.0,
        },
      }),
    );
  }

  const signals = detectIntervalSignals(bars, 20.0, {
    windowMinutes: 15,
    mode: "surge",
  });

  // Latest interval is Interval 1
  const surgeSignal = signals.find((s) => s.intervalStartTime === baseTime + 15 * 60000);
  assert.ok(surgeSignal, "Should have surge signal in interval 1");
  assert.ok(surgeSignal.precursor, "Should have precursor features attached");

  const pre = surgeSignal.precursor!;
  // Precursor window should contain the bars leading up to the burst (burst starts at bar 15)
  assert.equal(pre.endBarIndex, 14, "Precursor should end at bar 14 right before burst");
  // 12 green bars out of 15
  assert.equal(pre.greenCount, 12);
  assert.equal(pre.totalBars, 15);
  assert.ok(Math.abs(pre.greenRatio - 12 / 15) < 1e-4);

  // Precursor MA20 support check at bar 14: low (99.8) <= MA20 (100.0) && close (100.8) > MA20 (100.0)
  assert.ok(pre.ohlc.supports.includes(20), "Precursor should have MA20 support at explosion point");
});
