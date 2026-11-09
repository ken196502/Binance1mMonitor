import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PaperTradingEngine, PAPER_DEFAULT_CONFIG } from "../../src/paper-trading.ts";
import { FEATURE_VERSION } from "../../src/features.ts";
import {
  FACTOR_POLICY_VERSION,
  MINUTE_MS as M,
  type FactorMiningResult,
  type FactorMetrics,
} from "../../src/factor-policy.ts";
import { factorWindows } from "../../src/factor-settings.ts";
import { FactorMiningService } from "../../src/factor-mining-service.ts";

const now = Math.floor(Date.now() / M) * M;

const metrics = (): FactorMetrics => ({
  trades: 25,
  wins: 20,
  winRate: 80,
  wilsonLow: 62.5,
  grossProfit: 25,
  grossLoss: 5,
  profitFactor: 5,
  netPercent: 20,
  avgNetPercent: 0.8,
});

const sampleResult = (at = now): FactorMiningResult => ({
  policyVersion: FACTOR_POLICY_VERSION,
  featureVersion: FEATURE_VERSION,
  dataAsOf: at,
  datasetHash: "dataset-hash-1234",
  trials: 96,
  costs: { takerFeeBps: 5, slippageBps: 2 },
  windows: factorWindows(),
  sides: {
    SHORT: {
      reason: "近期训练和留出检验通过",
      candidate: {
        id: "short-test-cand",
        config: {
          ...PAPER_DEFAULT_CONFIG.klineStatsShortConfig!,
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
          leverage: 3,
        },
        train: metrics(),
        validation: metrics(),
        holdout: metrics(),
      },
    },
    LONG: {
      reason: "训练/验证样本不足或收益未达标",
    },
  },
});

test("Telegram broadcasts for factor training start and applying new strategy parameters", async () => {
  const received: { text: string; auth: string }[] = [];
  const fake = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url ?? "";
      if (!url.startsWith("/botTEST_BROADCAST_TOKEN/sendMessage")) {
        res.writeHead(404).end('{"ok":false}');
        return;
      }
      const payload = JSON.parse(body);
      received.push({ text: payload.text, auth: url });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true,"result":{"message_id":1}}');
    });
  });

  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const port = (fake.address() as { port: number }).port;

  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalChatId = process.env.TELEGRAM_CHAT_ID;
  const originalApiBase = process.env.TELEGRAM_API_BASE;

  process.env.TELEGRAM_BOT_TOKEN = "TEST_BROADCAST_TOKEN";
  process.env.TELEGRAM_CHAT_ID = "999";
  process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${port}`;

  try {
    const engine = new PaperTradingEngine({ storageFile: null });

    // 1. 验证 FactorMiningService.tick() 启动训练时发送 TG 播报
    let jobExecuted = false;
    const service = new FactorMiningService(
      engine,
      async () => {
        jobExecuted = true;
        return sampleResult();
      },
      () => now,
    );

    await service.tick();
    assert.equal(jobExecuted, true, "训练任务应被执行");

    // 等待异步 TG 消息接收
    for (let i = 0; i < 20 && received.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.ok(received.length >= 2, `应该收到至少2条消息（1条训练开始，1条应用新策略），实际收到 ${received.length} 条`);

    // 验证第一条消息：开始训练播报
    const trainingMsg = received[0].text;
    assert.match(trainingMsg, /开始新一轮因子模型训练与参数挖掘/);
    assert.match(trainingMsg, /训练集/);
    assert.match(trainingMsg, /验证集/);
    assert.match(trainingMsg, /留出集/);
    assert.match(trainingMsg, /模拟成本/);
    assert.match(trainingMsg, /搜索空间/);

    // 验证第二条消息：应用新因子策略参数播报
    const applyMinedMsg = received[1].text;
    assert.match(applyMinedMsg, /新一轮模型参数已通过验证并成功应用生效/);
    assert.match(applyMinedMsg, /做空/);
    assert.match(applyMinedMsg, /MA10_BREAKDOWN/);
    assert.match(applyMinedMsg, /GREEN_RATIO_30_80/);
    assert.match(applyMinedMsg, /回测战绩/);
    assert.match(applyMinedMsg, /胜率 <b>80.0%<\/b>/);
    assert.match(applyMinedMsg, /未更新 \(训练\/验证样本不足或收益未达标\)/);

    // 2. 验证手动更新策略配置 (updateConfig) 触发应用新策略参数播报
    const preCount = received.length;
    engine.updateConfig({
      klineStatsShortConfig: {
        tp1Percent: 3.5,
        tp2Percent: 8.0,
      },
      streakLeverage: 5,
    });

    for (let i = 0; i < 20 && received.length < preCount + 1; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.equal(received.length, preCount + 1, "updateConfig 应触发 1 条手动应用策略参数的播报");
    const manualConfigMsg = received[received.length - 1].text;
    assert.match(manualConfigMsg, /已应用新策略参数 \(手动\/API配置\)/);
    assert.match(manualConfigMsg, /量化做空参数/);
    assert.match(manualConfigMsg, /闪击 5x/);

    // 3. 验证带有 skipNotify: true 的 updateConfig 不会发送通知（如 loadState 恢复状态场景）
    const countBeforeSkip = received.length;
    engine.updateConfig(
      {
        klineStatsShortConfig: {
          tp1Percent: 2.5,
        },
      },
      { skipNotify: true },
    );

    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received.length, countBeforeSkip, "skipNotify: true 时不得触发 TG 播报");

    // 4. 验证当 TG 播报存在网络延迟且 worker 快速抛出异常（如近期数据不足）时，tick() 不会产生未捕获异常并正常捕获
    const failingService = new FactorMiningService(
      engine,
      async () => {
        // 模拟 worker 快速失败
        throw new Error("近期行情或实际榜单不足/过期，等待归档积累");
      },
      () => now + 16 * 60_000,
    );

    await assert.doesNotReject(async () => {
      await failingService.tick();
    }, "tick() 必须平稳捕获 worker 异常，绝不能产生未处理的 Promise 拒绝导致进程崩溃");

    const state = engine.getFactorMiningState();
    assert.equal(state.running, false);
    assert.match(state.lastError ?? "", /近期行情或实际榜单不足\/过期，等待归档积累/);
  } finally {
    fake.close();
    if (originalToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = originalToken;
    else delete process.env.TELEGRAM_BOT_TOKEN;
    if (originalChatId !== undefined) process.env.TELEGRAM_CHAT_ID = originalChatId;
    else delete process.env.TELEGRAM_CHAT_ID;
    if (originalApiBase !== undefined) process.env.TELEGRAM_API_BASE = originalApiBase;
    else delete process.env.TELEGRAM_API_BASE;
  }
});
