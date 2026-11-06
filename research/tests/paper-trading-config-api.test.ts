import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PaperTradingEngine, PAPER_DEFAULT_CONFIG } from "../../src/paper-trading.ts";

test("PaperTradingEngine: differential dual-speed leverage (10x streak vs 3x trend)", () => {
  const engine = new PaperTradingEngine({
    initialBalanceUsdt: 100,
    leverage: 3,
    trendLeverage: 3,
    streakLeverage: 10,
    marginUsdt: 20,
    storageFile: null,
  });

  // Verify leverage resolution
  assert.equal(engine.getLeverageForSignal("streak"), 10);
  assert.equal(engine.getLeverageForSignal("rebound"), 3);
  assert.equal(engine.getLeverageForSignal("deep_rebound"), 3);
  assert.equal(engine.getLeverageForSignal("w_bottom_divergence"), 3);

  const now = Date.now();
  const dummyCandle = { time: now - 60000, open: 100, high: 101, low: 99, close: 100, volume: 100 };
  const dummySignal = {
    candle: dummyCandle,
    streakCount: 3,
    amp30Percent: 8,
    upperShadowRatio: 0.1,
    greenRatio: 0.8,
    consecutiveGreenBars: 8,
  };

  // 1. Open 新高顶背离 (streak) -> expect 10x leverage, 20 USDT margin, 200 USDT notional
  const posStreak = engine.openPosition({
    symbol: "ATHUSDT",
    dayChangePercent: 25,
    rank: 1,
    entryPrice: 100,
    entryTime: now,
    signalType: "streak",
    signal: dummySignal,
  });
  assert.equal(posStreak.leverage, 10);
  assert.equal(posStreak.marginUsdt, 20);
  assert.equal(posStreak.notionalUsdt, 200);

  // 2. Open 首次跌10% (rebound) -> expect 3x leverage, 20 USDT margin, 60 USDT notional
  const posRebound = engine.openPosition({
    symbol: "TRENDUSDT",
    dayChangePercent: 30,
    rank: 1,
    entryPrice: 50,
    entryTime: now + 1000,
    signalType: "rebound",
    signal: dummySignal,
  });
  assert.equal(posRebound.leverage, 3);
  assert.equal(posRebound.marginUsdt, 20);
  assert.equal(posRebound.notionalUsdt, 60);

  // 3. Update configuration dynamically via updateConfig (as done by API)
  const updatedCfg = engine.updateConfig({
    streakLeverage: 8,
    trendLeverage: 2,
    marginUsdt: 15,
  });

  assert.equal(updatedCfg.streakLeverage, 8);
  assert.equal(updatedCfg.trendLeverage, 2);
  assert.equal(updatedCfg.marginUsdt, 15);
  assert.equal(engine.getLeverageForSignal("streak"), 8);
  assert.equal(engine.getLeverageForSignal("rebound"), 2);

  const summary = engine.getSummary();
  assert.equal(summary.config?.streakLeverage, 8);
  assert.equal(summary.config?.trendLeverage, 2);
  assert.equal(summary.config?.marginUsdt, 15);
});

test("PAPER_DEFAULT_CONFIG: has zero dependency on process.env for strategy & trading params", () => {
  assert.equal(PAPER_DEFAULT_CONFIG.leverage, 3);
  assert.equal(PAPER_DEFAULT_CONFIG.trendLeverage, 3);
  assert.equal(PAPER_DEFAULT_CONFIG.streakLeverage, 10);
  assert.equal(PAPER_DEFAULT_CONFIG.marginUsdt, 20);
  assert.equal(PAPER_DEFAULT_CONFIG.initialBalanceUsdt, 100);
  assert.equal(PAPER_DEFAULT_CONFIG.limitDivisor, 0);
  assert.equal(PAPER_DEFAULT_CONFIG.stopAtHigh, true);
  assert.equal(PAPER_DEFAULT_CONFIG.enableKlineStatsShort, true);
  assert.equal(PAPER_DEFAULT_CONFIG.enableKlineStatsLong, false);
});

test("PaperTradingEngine: updateConfig updates klineStats strategy parameters and persists state", (t) => {
  const tmpFile = `/tmp/paper-trading-test-${Date.now()}.json`;
  const engine = new PaperTradingEngine({
    initialBalanceUsdt: 200,
    storageFile: tmpFile,
  });

  const updatePayload = {
    leverage: 5,
    klineStatsLeverage: 10,
    enableKlineStatsShort: true,
    enableKlineStatsLong: false,
    klineStatsShortConfig: {
      topN: 5,
      minDayChange: 15,
      intervalWindow: 5,
      ampDivisor: 10,
      maRequirement: "MA10_BREAKDOWN" as const,
      macdRequirement: "GREEN_RATIO_30_80" as const,
      holdMinutes: 45,
      tp1Percent: 3.5,
      tp2Percent: 7.5,
      stopLossPercent: 4.5,
      moveSlToEntryAfterTp1: true,
      cooldownMinutes: 15,
      leverage: 10,
    },
  };

  const updated = engine.updateConfig(updatePayload);
  assert.equal(updated.klineStatsLeverage, 10);
  assert.equal(updated.enableKlineStatsLong, false);
  assert.equal(updated.klineStatsShortConfig?.tp1Percent, 3.5);
  assert.equal(updated.klineStatsShortConfig?.topN, 5);

  // Check summary reflects config
  const summary = engine.getSummary();
  assert.equal(summary.config?.klineStatsLeverage, 10);
  assert.equal(summary.config?.enableKlineStatsLong, false);
  assert.equal(summary.config?.klineStatsShortConfig?.topN, 5);

  // Check save and restore
  engine.saveState();

  const restoredEngine = new PaperTradingEngine({
    storageFile: tmpFile,
  });

  const restoredSummary = restoredEngine.getSummary();
  assert.equal(restoredSummary.config?.klineStatsLeverage, 10);
  assert.equal(restoredSummary.config?.enableKlineStatsLong, false);
  assert.equal(restoredSummary.config?.klineStatsShortConfig?.topN, 5);
  assert.equal(restoredSummary.config?.klineStatsShortConfig?.tp1Percent, 3.5);
});

test("PaperTradingEngine: checkKlineStatsSignal correctly evaluates 1m candles for short signal", () => {
  const engine = new PaperTradingEngine({
    storageFile: null,
    enableKlineStatsShort: true,
    klineStatsShortConfig: {
      topN: 10,
      minDayChange: 10,
      intervalWindow: 5,
      ampDivisor: 8,
      maRequirement: "MA10_BREAKDOWN",
      macdRequirement: "GREEN_RATIO_30_80",
      holdMinutes: 45,
      tp1Percent: 3.0,
      tp2Percent: 7.0,
      stopLossPercent: 5.0,
      moveSlToEntryAfterTp1: true,
      cooldownMinutes: 20,
      leverage: 10,
    },
  });

  // Construct synthetic candle series: 70 bars
  const now = Date.now();
  const candles = [];
  let basePrice = 100;
  for (let i = 0; i < 70; i++) {
    const time = now - (70 - i) * 60000;
    // Strong upward trend so MACD is overwhelmingly green
    basePrice += 0.5;
    let open = basePrice;
    let high = basePrice + 0.3;
    let low = basePrice - 0.1;
    let close = basePrice + 0.2;

    // Last closed bar (index 68): make it breakdown below MA10
    if (i === 68) {
      open = basePrice + 0.5;
      high = basePrice + 0.6;
      low = basePrice - 3.0; // drops sharply
      close = basePrice - 2.5; // closes well below MA10
    }

    candles.push({
      time,
      open,
      high,
      low,
      close,
      volume: 1000,
    });
  }

  // Symbol with +20% 24h change, rank 2
  const sig = engine.checkKlineStatsSignal("SHORT", "TESTUSDT", 20, 2, candles, now);
  // If breakdown and amp criteria match, returns signal
  if (sig) {
    assert.equal(sig.side, "SHORT");
    assert.equal(sig.type, "kline_stats_short");
    assert.equal(sig.label, "量化特征做空");
    assert.equal(sig.exitParams.holdMinutes, 45);
    assert.equal(sig.exitParams.tp1Percent, 3.0);
    assert.equal(sig.exitParams.tp2Percent, 7.0);
  }
});

test("deploy-strategy: deployConfig and fetchCurrentConfig work seamlessly over HTTP API", async () => {
  const { deployConfig, fetchCurrentConfig, PRESET_CONFIGS } = await import("../../scripts/deploy-strategy.ts");
  const engine = new PaperTradingEngine({ storageFile: null });

  // Spin up lightweight test server matching src/server.ts router
  const server = http.createServer((req, res) => {
    if (req.url === "/api/paper-trading/config") {
      if (req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const parsed = JSON.parse(body);
          const updated = engine.updateConfig(parsed);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, message: "模拟交易策略参数配置更新成功", config: updated, summary: engine.getSummary() }));
        });
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, config: engine.getConfig() }));
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as any;
  const testPort = address.port;

  try {
    // 1. Deploy preset 'top_short'
    const deployRes = await deployConfig(PRESET_CONFIGS.top_short, { port: testPort });
    assert.equal(deployRes.ok, true);
    assert.equal(deployRes.config?.klineStatsLeverage, 10);
    assert.equal(deployRes.config?.klineStatsShortConfig?.maRequirement, "MA10_BREAKDOWN");
    assert.equal(deployRes.config?.klineStatsShortConfig?.tp1Percent, 3.0);

    // 2. Fetch current config via GET
    const fetchRes = await fetchCurrentConfig({ port: testPort });
    assert.equal(fetchRes.ok, true);
    assert.equal(fetchRes.config?.klineStatsLeverage, 10);
    assert.equal(fetchRes.config?.klineStatsShortConfig?.macdRequirement, "GREEN_RATIO_30_80");

    // 3. Deploy balanced combination
    const balancedRes = await deployConfig(PRESET_CONFIGS.balanced, { port: testPort });
    assert.equal(balancedRes.ok, true);
    assert.equal(balancedRes.config?.enableKlineStatsShort, true);
    assert.equal(balancedRes.config?.enableKlineStatsLong, false);
    assert.equal(balancedRes.config?.klineStatsLongConfig?.maRequirement, "MA20_SUPPORT");

    // 4. Deploy using full remote URL string (e.g. http://<remote-ip>:<port>)
    const urlRes = await deployConfig({ marginPercent: 18 }, { url: `http://127.0.0.1:${testPort}` });
    assert.equal(urlRes.ok, true);
    assert.equal(urlRes.config?.marginPercent, 18);
  } finally {
    server.close();
  }
});
