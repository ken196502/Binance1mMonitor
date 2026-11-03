#!/usr/bin/env tsx
/**
 * 策略参数远端自动部署与热更新脚本 (Script 2/2)
 *
 * 核心功能：
 * 1. 自动载入通过统计挖掘出的最新最优策略参数 (data/mined-strategy.json)；
 * 2. 预检目标服务器（远端或本地）网络连通性，获取当前运行的配置快照；
 * 3. 通过 POST /api/paper-trading/config 热更新策略与风控参数，远端内存实时生效；
 * 4. 远端服务自动持久化落盘至 data/paper-trading.json，重启不丢失；
 * 5. 校验最新配置并格式化输出确认，保障部署闭环。
 *
 * 常用命令示例：
 *   # 1. 部署最新统计挖掘的最优参数到指定远端服务器：
 *   npx tsx scripts/deploy-strategy.ts --url http://47.100.20.30:4111
 *
 *   # 2. 或通过环境变量指定远端 URL：
 *   REMOTE_URL=http://47.100.20.30:4111 npm run deploy:strategy
 *
 *   # 3. 查看远端服务器当前运行的策略参数快照 (只读，不修改)：
 *   npx tsx scripts/deploy-strategy.ts --url http://47.100.20.30:4111 --get
 *
 *   # 4. 快速部署指定预设模式 (balanced | top_short | top_long | aggressive | conservative)：
 *   npx tsx scripts/deploy-strategy.ts --url http://47.100.20.30:4111 --preset balanced
 *
 *   # 5. 自定义 JSON 参数部署：
 *   npx tsx scripts/deploy-strategy.ts --url http://47.100.20.30:4111 --json '{"marginPercent": 25, "klineStatsLeverage": 10}'
 */

import fs from "node:fs";
import path from "node:path";
import type { PaperStrategyConfig } from "../src/paper-trading.ts";

export interface DeployOptions {
  url?: string;
  host?: string;
  port?: number;
  token?: string;
  timeoutMs?: number;
}

export function resolveTargetUrl(opts: DeployOptions = {}): string {
  if (opts.url) {
    return opts.url.replace(/\/+$/, "");
  }
  const envUrl = process.env.REMOTE_URL || process.env.MONITOR_URL || process.env.API_URL;
  if (envUrl) {
    return envUrl.replace(/\/+$/, "");
  }
  const host = opts.host || process.env.HOST || "127.0.0.1";
  const port = opts.port || Number(process.env.PORT || 4111);
  return `http://${host}:${port}`;
}

export const PRESET_CONFIGS: Record<string, Partial<PaperStrategyConfig>> = {
  // 1. Top 1 空头量化特征挖掘策略 (168h 回测胜率 85.0%, PF 3.33)
  top_short: {
    enableKlineStatsShort: true,
    klineStatsLeverage: 10,
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
  },

  // 2. Top 1 多头量化特征挖掘策略 (168h 回测胜率 70.4%, PF 1.90)
  top_long: {
    enableLongs: true,
    enableKlineStatsLong: true,
    klineStatsLongConfig: {
      topN: 10,
      minDayChange: 10,
      intervalWindow: 5,
      ampDivisor: 8,
      maRequirement: "MA20_SUPPORT",
      macdRequirement: "GREEN_RATIO_15_70",
      holdMinutes: 30,
      tp1Percent: 2.5,
      tp2Percent: 5.5,
      stopLossPercent: 3.5,
      moveSlToEntryAfterTp1: true,
      cooldownMinutes: 20,
      leverage: 5,
    },
  },

  // 3. 双向平衡组合 (Top 1 做多 + Top 1 做空 + 核心策略组合)
  balanced: {
    marginPercent: 20,
    maxPositions: 5,
    maxPositionsPerStrategy: 1,
    enableStreak: true,
    enableRebound: true,
    enableDeepRebound: true,
    enableHourlySuppression: true,
    enableLongs: true,
    enableWBottomDivergence: true,
    enableKlineStatsShort: true,
    enableKlineStatsLong: true,
    klineStatsLeverage: 10,
    streakLeverage: 10,
    trendLeverage: 3,
    longLeverage: 5,
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
    klineStatsLongConfig: {
      topN: 10,
      minDayChange: 10,
      intervalWindow: 5,
      ampDivisor: 8,
      maRequirement: "MA20_SUPPORT",
      macdRequirement: "GREEN_RATIO_15_70",
      holdMinutes: 30,
      tp1Percent: 2.5,
      tp2Percent: 5.5,
      stopLossPercent: 3.5,
      moveSlToEntryAfterTp1: true,
      cooldownMinutes: 20,
      leverage: 5,
    },
  },

  // 4. 激进高收益模式 (做空 10x, 做多 5x, 单笔仓位 25%)
  aggressive: {
    marginPercent: 25,
    maxPositions: 6,
    klineStatsLeverage: 10,
    streakLeverage: 10,
    enableKlineStatsShort: true,
    enableKlineStatsLong: true,
    klineStatsShortConfig: {
      topN: 10,
      minDayChange: 10,
      intervalWindow: 5,
      ampDivisor: 8,
      maRequirement: "MA10_BREAKDOWN",
      macdRequirement: "GREEN_RATIO_30_80",
      holdMinutes: 45,
      tp1Percent: 3.5,
      tp2Percent: 8.0,
      stopLossPercent: 4.5,
      moveSlToEntryAfterTp1: true,
      cooldownMinutes: 15,
      leverage: 10,
    },
  },

  // 5. 稳健防守模式 (低杠杆 3x~5x, 仓位 15%)
  conservative: {
    marginPercent: 15,
    maxPositions: 4,
    klineStatsLeverage: 5,
    streakLeverage: 5,
    trendLeverage: 2,
    enableKlineStatsShort: true,
    enableKlineStatsLong: true,
    klineStatsShortConfig: {
      topN: 8,
      minDayChange: 12,
      intervalWindow: 5,
      ampDivisor: 10,
      maRequirement: "MA60_RESIST",
      macdRequirement: "GREEN_RATIO_30_80",
      holdMinutes: 30,
      tp1Percent: 2.5,
      tp2Percent: 6.0,
      stopLossPercent: 4.0,
      moveSlToEntryAfterTp1: true,
      cooldownMinutes: 25,
      leverage: 5,
    },
  },
};

export async function fetchCurrentConfig(opts: DeployOptions = {}) {
  const baseUrl = resolveTargetUrl(opts);
  const endpoint = `${baseUrl}/api/paper-trading/config`;
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (opts.token) {
    headers["Authorization"] = `Bearer ${opts.token}`;
  }

  const res = await fetch(endpoint, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }

  return (await res.json()) as { ok: boolean; config?: PaperStrategyConfig; error?: string };
}

export async function deployConfig(
  updates: Partial<PaperStrategyConfig>,
  opts: DeployOptions = {},
) {
  const baseUrl = resolveTargetUrl(opts);
  const endpoint = `${baseUrl}/api/paper-trading/config`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (opts.token) {
    headers["Authorization"] = `Bearer ${opts.token}`;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(updates),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }

  return (await res.json()) as { ok: boolean; message?: string; config?: PaperStrategyConfig; error?: string };
}

function printConfigSummary(c: PaperStrategyConfig) {
  console.log(`   • 杠杆配置: 顺势 ${c.trendLeverage ?? c.leverage}x | 闪击 ${c.streakLeverage ?? 10}x | 量化做空 ${c.klineStatsLeverage ?? 10}x | 做多 ${c.longLeverage ?? 5}x`);
  console.log(`   • 仓位风控: 单笔比例 ${((c.marginRate ?? 0.2) * 100).toFixed(0)}% | 最大同时持仓 ${c.maxPositions ?? 5} 笔 (每策略至多 ${c.maxPositionsPerStrategy ?? 1} 笔)`);
  console.log(`   • 基础策略: 新高闪击=${c.enableStreak} | 首次跌10%=${c.enableRebound} | 跌20%+=${c.enableDeepRebound} | 小时线压制=${c.enableHourlySuppression}`);
  console.log(`   • 量化策略: 开启做多=${c.enableLongs} | 3W底背离=${c.enableWBottomDivergence} | 量化做空=${c.enableKlineStatsShort} | 量化做多=${c.enableKlineStatsLong}`);
  if (c.klineStatsShortConfig) {
    const sc = c.klineStatsShortConfig;
    console.log(`   • 量化做空: 窗口 ${sc.intervalWindow}m, 比例 24h/${sc.ampDivisor}, 均线 [${sc.maRequirement}], MACD [${sc.macdRequirement}], 止盈 TP1=${sc.tp1Percent}% / TP2=${sc.tp2Percent}%, 止损 ${sc.stopLossPercent}%, 杠杆 ${sc.leverage}x`);
  }
  if (c.klineStatsLongConfig) {
    const lc = c.klineStatsLongConfig;
    console.log(`   • 量化做多: 窗口 ${lc.intervalWindow}m, 比例 24h/${lc.ampDivisor}, 均线 [${lc.maRequirement}], MACD [${lc.macdRequirement}], 止盈 TP1=${lc.tp1Percent}% / TP2=${lc.tp2Percent}%, 止损 ${lc.stopLossPercent}%, 杠杆 ${lc.leverage}x`);
  }
}

export async function main() {
  const args = process.argv.slice(2);
  let targetUrl = "";
  let port: number | undefined = undefined;
  let host = "";
  let token = "";
  let preset = "";
  let jsonStr = "";
  let filePath = "";
  let isGet = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--url" && i + 1 < args.length) {
      targetUrl = args[++i];
    } else if (arg === "--port" && i + 1 < args.length) {
      port = Number(args[++i]);
    } else if (arg === "--host" && i + 1 < args.length) {
      host = args[++i];
    } else if (arg === "--token" && i + 1 < args.length) {
      token = args[++i];
    } else if (arg === "--preset" && i + 1 < args.length) {
      preset = args[++i];
    } else if (arg === "--json" && i + 1 < args.length) {
      jsonStr = args[++i];
    } else if (arg === "--file" && i + 1 < args.length) {
      filePath = args[++i];
    } else if (arg === "--get") {
      isGet = true;
    }
  }

  const resolvedUrl = resolveTargetUrl({ url: targetUrl, host: host || undefined, port });

  console.log("==================================================================");
  console.log("🚀【策略参数远端部署与热更新工具】");
  console.log(`🌐 目标服务器地址: ${resolvedUrl}`);
  console.log("==================================================================");

  // 1. 如果是查询模式 (--get)
  if (isGet) {
    console.log(`正在向目标服务器拉取当前运行配置 (${resolvedUrl}/api/paper-trading/config)...`);
    try {
      const res = await fetchCurrentConfig({ url: resolvedUrl, token });
      if (res.ok && res.config) {
        console.log("\n✅ 目标服务器当前运行的策略配置快照：");
        printConfigSummary(res.config);
        console.log("\n完整 JSON 配置:");
        console.log(JSON.stringify(res.config, null, 2));
      } else {
        console.error("❌ 获取配置失败:", res.error ?? "未知错误");
      }
    } catch (e: any) {
      console.error(`❌ 连接目标服务器失败 (${resolvedUrl}):`, e.message);
      console.error("\n💡 排查建议: 请确认目标服务已启动 (npm start)，且端口/防火墙已开放。");
      process.exit(1);
    }
    return;
  }

  // 2. 解析待部署的策略参数更新载荷
  let payload: Partial<PaperStrategyConfig> = {};
  const defaultMinedFile = path.resolve("data/mined-strategy.json");

  if (preset) {
    if (!PRESET_CONFIGS[preset]) {
      console.error(`❌ 未知的预设名称: "${preset}". 可用预设: ${Object.keys(PRESET_CONFIGS).join(", ")}`);
      process.exit(1);
    }
    payload = { ...PRESET_CONFIGS[preset] };
    console.log(`📦 已加载预设策略配置: [${preset}]`);
  } else if (jsonStr) {
    try {
      payload = JSON.parse(jsonStr);
      console.log("📦 已加载命令行指定的自定义 JSON 配置");
    } catch (e: any) {
      console.error("❌ 自定义 JSON 解析失败:", e.message);
      process.exit(1);
    }
  } else if (filePath) {
    try {
      const content = fs.readFileSync(path.resolve(filePath), "utf8");
      const parsed = JSON.parse(content);
      payload = parsed.strategyConfig ?? parsed;
      console.log(`📦 已从指定文件加载配置: ${filePath}`);
    } catch (e: any) {
      console.error(`❌ 读取配置文件失败: ${e.message}`);
      process.exit(1);
    }
  } else if (fs.existsSync(defaultMinedFile)) {
    // 默认优先加载最新挖掘结果
    try {
      const content = fs.readFileSync(defaultMinedFile, "utf8");
      const parsed = JSON.parse(content);
      payload = parsed.strategyConfig ?? parsed;
      console.log(`📦 已自动载入最新量化统计挖掘成果 (${defaultMinedFile}):`);
      if (parsed.updatedAt) console.log(`   • 挖掘完成时间: ${parsed.updatedAt}`);
      if (parsed.summary?.bestShort) {
        const bs = parsed.summary.bestShort;
        console.log(`   • 最优空头策略: ${bs.name} (胜率 ${bs.winRate.toFixed(1)}%, PF ${bs.pf.toFixed(2)}, 回撤 ${bs.maxDrawdown.toFixed(1)}%)`);
      }
      if (parsed.summary?.bestLong) {
        const bl = parsed.summary.bestLong;
        console.log(`   • 最优多头策略: ${bl.name} (胜率 ${bl.winRate.toFixed(1)}%, PF ${bl.pf.toFixed(2)}, 回撤 ${bl.maxDrawdown.toFixed(1)}%)`);
      }
    } catch (e: any) {
      console.warn(`⚠️ 解析 ${defaultMinedFile} 失败，将回退至默认 [balanced] 组合: ${e.message}`);
      payload = { ...PRESET_CONFIGS.balanced };
    }
  } else {
    console.log("ℹ️ 未指定参数且未找到 data/mined-strategy.json，默认应用推荐的 [balanced] 双向平衡组合...");
    payload = { ...PRESET_CONFIGS.balanced };
  }

  // 3. 部署前预检：连接测试并展示当前运行参数快照
  console.log(`\n[步骤 1/3] 正在检测目标服务器连通性 (${resolvedUrl})...`);
  try {
    const currentRes = await fetchCurrentConfig({ url: resolvedUrl, token });
    if (currentRes.ok && currentRes.config) {
      console.log("✅ 目标服务器连接正常！变更前运行配置快照：");
      printConfigSummary(currentRes.config);
    }
  } catch (e: any) {
    console.error(`❌ 无法连接到目标服务器 (${resolvedUrl}):`, e.message);
    console.error("\n💡 故障排查指引：");
    console.error(`   1. 确认远端服务已启动 (例如 pm2 status 或 nohup 运行)；`);
    console.error(`   2. 检查云服务安全组与防火墙，确保端口 (默认 4111) 已对当前 IP 放行；`);
    console.error(`   3. 检查传入的 URL 是否准确，例如: --url http://<您的服务器公网IP>:4111`);
    process.exit(1);
  }

  // 4. 发送热更新请求
  console.log(`\n[步骤 2/3] 正在通过 POST /api/paper-trading/config 发送热更新...`);
  try {
    const deployRes = await deployConfig(payload, { url: resolvedUrl, token });
    if (!deployRes.ok) {
      console.error("❌ 部署失败，远端返回错误:", deployRes.error);
      process.exit(1);
    }
    console.log(`✅ ${deployRes.message || "策略参数已成功推送生效！"}`);

    // 5. 部署后验证并展示最新生效配置
    console.log("\n[步骤 3/3] 验证最新生效配置并确认持久化：");
    const updated = deployRes.config;
    if (updated) {
      console.log("==================================================================");
      console.log("🎉 远端策略热更新成功！最新生效配置如下：");
      console.log("==================================================================");
      printConfigSummary(updated);
      console.log("==================================================================");
      console.log(`💾 远端服务器已在内存中热生效，并自动持久化写入远端 data/paper-trading.json！`);
    }
  } catch (e: any) {
    console.error("❌ 策略部署过程异常中断:", e.message);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
