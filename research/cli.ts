import { parseArgs } from "node:util";
import path from "node:path";
import { fetchDataset } from "./data.ts";

const HELP = `24h涨幅榜双信号做空策略研究 CLI

用法：npm run research -- <wick|peak-rebound|fetch> [选项]

wick          涨幅榜连阳做空研究（两段平仓：先平50%，再平剩余全部）
              npm run research:wick -- --help 查看详细选项

peak-rebound  涨幅榜首峰值反弹做空挖掘（两段式动态退出）
              npm run mine:peak-rebound -- --help 查看详细选项

fetch         获取 Binance 当前全部 USDT 永续合约的历史 1h K 线并缓存
              --days N                          历史天数（默认 30）
              --start ISO --end ISO              时间范围 [start,end)，需按整小时对齐
              --data DIR                        全市场小时数据保存目录
`;

async function main() {
  const cmd = process.argv[2];
  if (cmd === "wick") {
    const { runWickCommand } = await import("./wick.ts");
    await runWickCommand(process.argv.slice(3));
    return;
  }
  if (cmd === "peak-rebound") {
    await import("./peak-rebound-miner.ts");
    return;
  }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      days: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      data: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help || !positionals.length) {
    console.log(HELP);
    return;
  }
  const command = positionals[0];
  if (command !== "fetch") {
    throw new Error(`未知命令：${command}。有效命令为 wick、peak-rebound 或 fetch`);
  }
  const tag = new Date().toISOString().replaceAll(":", "-");
  const directory = path.resolve(values.data ?? `data/research/${tag}`);
  const nowHour = Math.floor(Date.now() / 3600000) * 3600000;
  const end = values.end ? Date.parse(values.end) : nowHour;
  const days = values.days ? Number(values.days) : 30;
  const start = values.start ? Date.parse(values.start) : end - days * 24 * 3600000;
  await fetchDataset({ directory, start, end });
}

main().catch((err) => {
  console.error((err as any)?.message ?? err);
  process.exit(1);
});
