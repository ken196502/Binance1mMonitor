import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALIGN_OFFSET_MS,
  getMinuteCycle,
  getNextMinuteDelay,
} from '../../src/server.ts';
import { PaperTradingEngine } from '../../src/paper-trading.ts';

test('getNextMinuteDelay: computes exact non-drifting delay to next (minute + offset)', () => {
  const baseMinute = 1793534040000; // e.g. 19:54:00.000
  const offset = 1000;

  // 1. Exactly at offset (19:54:01.000) -> targets 19:55:01.000 (delay = 60000ms)
  const delayAtOffset = getNextMinuteDelay(baseMinute + 1000, offset);
  assert.equal(delayAtOffset, 60000);

  // 2. 50ms after offset (19:54:01.050) -> targets 19:55:01.000 (delay = 59950ms)
  const delayAfterOffset = getNextMinuteDelay(baseMinute + 1050, offset);
  assert.equal(delayAfterOffset, 59950);

  // 3. Mid minute (19:54:30.000) -> targets 19:55:01.000 (delay = 31000ms)
  const delayMidMinute = getNextMinuteDelay(baseMinute + 30000, offset);
  assert.equal(delayMidMinute, 31000);

  // 4. End of minute (19:54:59.500) -> targets 19:55:01.000 (delay = 1500ms)
  const delayEndMinute = getNextMinuteDelay(baseMinute + 59500, offset);
  assert.equal(delayEndMinute, 1500);

  // 5. Right after minute boundary before offset (19:55:00.300) -> targets 19:55:01.000 (delay = 700ms)
  const nextMinStart = baseMinute + 60000;
  const delayBeforeOffset = getNextMinuteDelay(nextMinStart + 300, offset);
  assert.equal(delayBeforeOffset, 700);
});

test('getMinuteCycle: groups timestamps into discrete 1-minute cycle blocks', () => {
  const baseMinute = 1793534040000; // 19:54:00.000
  const offset = 1000;

  // Timestamps from 19:54:01.000 up to 19:55:00.999 belong to 19:54:00 cycle
  assert.equal(getMinuteCycle(baseMinute + 1000, offset), baseMinute);
  assert.equal(getMinuteCycle(baseMinute + 15000, offset), baseMinute);
  assert.equal(getMinuteCycle(baseMinute + 59999, offset), baseMinute);
  assert.equal(getMinuteCycle(baseMinute + 60000 + 999, offset), baseMinute);

  // 19:55:01.000 enters the new cycle (19:55:00.000)
  assert.equal(getMinuteCycle(baseMinute + 60000 + 1000, offset), baseMinute + 60000);
});

test('PaperTradingEngine: clamps tick time to entryTime preventing negative duration', () => {
  const engine = new PaperTradingEngine({
    initialBalanceUsdt: 100,
    enableStreak: true,
  });

  const entryTime = 1793534099252;
  const pos = engine.openPosition({
    symbol: 'TESTUSDT',
    side: 'SHORT',
    dayChangePercent: 20,
    entryPrice: 100,
    entryTime,
    marginUsdt: 20,
    leverage: 10,
    signal: {
      candle: { time: entryTime - 60000, open: 98, high: 101, low: 97, close: 100, volume: 1000 },
      streakCount: 2,
      amp30Percent: 5,
      upperShadowRatio: 0.1,
      greenRatio: 0.8,
      consecutiveGreenBars: 2,
    },
    exitParams: {
      holdMinutes: 15,
      exitX: 50,
      exitN: 1.5,
      exitM: 3.0,
      moveSlToEntryAfterTp1: false,
    },
  });

  // Simulate an incoming WS tick with exchange time 30ms earlier than entryTime (clock skew)
  // that immediately triggers TP1 (short target below 100 * (1 - 20/50/100) = 99.60)
  const skewTick = {
    symbol: 'TESTUSDT',
    price: 99.50,
    qty: 10,
    time: entryTime - 30, // 30ms before entryTime!
  };

  engine.onTick(skewTick);

  // Position should have Stage 1 exit recorded with safeExitTime >= entryTime
  assert.equal(pos.exits.length, 1);
  assert.ok(pos.exits[0].exitTime >= pos.entryTime, `exitTime ${pos.exits[0].exitTime} must >= entryTime ${pos.entryTime}`);

  // Now trigger Stage 2 exit with another skewed tick
  const skewTick2 = {
    symbol: 'TESTUSDT',
    price: 98.00,
    qty: 10,
    time: entryTime - 10,
  };
  engine.onTick(skewTick2);

  assert.equal(pos.status, 'CLOSED');
  assert.ok(pos.closedAt! >= pos.entryTime, `closedAt ${pos.closedAt} must >= entryTime ${pos.entryTime}`);
  assert.ok(pos.closedAt! - pos.entryTime >= 0, 'Holding duration cannot be negative');
});
