/** Real local Chrome + CDP, isolated HTTP fixture, production React build and trading engine. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { FactorMiningResult, FactorMetrics } from "../src/factor-policy.ts";

// Must precede the dynamic import: the module's singleton must never load the live account.
process.env.NODE_TEST_CONTEXT = "browser-cdp";
const { PaperTradingEngine } = await import("../src/paper-trading.ts");
const { FACTOR_POLICY_VERSION } = await import("../src/factor-policy.ts");
const { FEATURE_VERSION } = await import("../src/features.ts");
const { factorWindows } = await import("../src/factor-settings.ts");
const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "reports/ui-validation");
const dist = path.join(root, "web/dist");
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
await access(chromePath);
await access(path.join(dist, "index.html"));
await mkdir(out, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), "factor-cdp-"));
const engine = new PaperTradingEngine({ storageFile: null });
const checks: string[] = [], screenshots: string[] = [], browserErrors: string[] = [], dialogs: string[] = [];
let paperRequests = 0;
let frozenState: ReturnType<typeof engine.getState> | undefined;
const metrics = (): FactorMetrics => ({ trades: 20, wins: 18, winRate: 90, wilsonLow: 69,
  grossProfit: 20, grossLoss: 2, profitFactor: 10, netPercent: 18, avgNetPercent: 0.9 });
function fixtureResult(): FactorMiningResult {
  const config = engine.getConfig();
  return { policyVersion: FACTOR_POLICY_VERSION, featureVersion: FEATURE_VERSION, dataAsOf: Date.now(),
    datasetHash: "cdp-isolated-fixture", windows: factorWindows(config.factorMining), trials: 216,
    costs: { takerFeeBps: config.takerFeeBps, slippageBps: config.slippageBps },
    sides: { SHORT: { reason: "CDP fixture", candidate: { id: "fixture-short", config: config.klineStatsShortConfig!,
      train: metrics(), validation: metrics(), holdout: metrics() } }, LONG: { reason: "CDP fixture: insufficient samples" } } };
}
const server = createServer(async (req, res) => {
  const json = (value: unknown, status = 200) => res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(value));
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/status") {
      json({ at: new Date().toISOString(), base: "CDP 隔离测试行情（非实盘）", topN: 10,
        highRatio: 0.9, highWindow: 30, gainers: [], losers: [], paperTrading: frozenState?.summary ?? engine.getSummary() });
    } else if (url.pathname === "/api/live-trading") {
      json({ enabled: false, configured: false, testnet: false, status: "disabled", reason: null,
        budgetUsdt: 10, marginPercent: 20, nextMarginUsdt: 2, nextNotionalUsdt: 6, nextMaxNotionalUsdt: 10, leverage: 3, shortHoldLeverage: 5, shortHoldMaxMinutes: 10, maxPositions: 1, walletUsdt: null, equityUsdt: null,
        lastCheckedAt: null, activeTrade: null, recentTrades: [] });
    } else if (url.pathname === "/api/paper-trading") {
      paperRequests++; json(frozenState ?? engine.getState());
    } else if (url.pathname === "/api/paper-trading/config") {
      if (req.method === "GET") { json(engine.getConfig()); return; }
      let body = "";
      for await (const chunk of req) body += chunk;
      try { json({ ok: true, config: engine.updateConfig(JSON.parse(body)) }); }
      catch (error) { json({ ok: false, error: String(error) }, 400); }
    } else if (url.pathname === "/api/klines") {
      json({ symbol: "BTCUSDT", interval: "1m", updatedAt: new Date().toISOString(), source: "monitor",
        maPeriods: [5, 10, 20, 30, 60], macd: { fast: 12, slow: 26, signal: 9 }, bars: [] });
    } else if (url.pathname === "/favicon.ico") {
      res.writeHead(204).end();
    } else {
      const relative = decodeURIComponent(url.pathname === "/" ? "index.html" : url.pathname.slice(1));
      const file = path.resolve(dist, relative);
      if (!file.startsWith(dist + path.sep)) { res.writeHead(403).end(); return; }
      const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff": "font/woff", ".svg": "image/svg+xml" };
      res.writeHead(200, { "Content-Type": mime[path.extname(file)] ?? "application/octet-stream" }).end(await readFile(file));
    }
  } catch (error) {
    if (!res.headersSent) res.writeHead(500);
    res.end(String(error));
  }
});

class Cdp {
  private serial = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  onEvent = (_method: string, _params: any) => {};
  constructor(private socket: WebSocket) {
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (!message.id) { this.onEvent(message.method, message.params); return; }
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); this.pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error("CDP closed")); }
      this.pending.clear();
    });
  }
  static async connect(url: string) {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP connection failed")), { once: true });
    });
    return new Cdp(ws);
  }
  send(method: string, params: object = {}): Promise<any> {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate<T = any>(expression: string): Promise<T> {
    const response = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  }
  close() { this.socket.close(); }
}
async function until(check: () => Promise<unknown>, label: string, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
let chrome: ChildProcess | undefined, cdp: Cdp | undefined;
let chromeLog = "";
try {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/`;
  chrome = spawn(chromePath, [
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync",
    "--disable-component-update", "--disable-default-apps", "--window-size=1440,1100",
    ...(process.env.CDP_HEADLESS === "1" ? ["--headless=new"] : []), "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  chrome.on("error", error => { chromeLog += String(error); });
  chrome.stderr?.on("data", chunk => { chromeLog = (chromeLog + chunk).slice(-8000); });
  let port = "";
  await until(async () => {
    try { port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; return !!port; }
    catch { return false; }
  }, "Chrome CDP endpoint");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const page = targets.find(t => t.type === "page"); assert.ok(page);
  cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  cdp.onEvent = (method, params) => {
    if (method === "Runtime.exceptionThrown") browserErrors.push(JSON.stringify(params.exceptionDetails));
    if (method === "Runtime.consoleAPICalled" && params.type === "error") browserErrors.push(JSON.stringify(params.args));
    if (method === "Log.entryAdded" && params.entry.level === "error") browserErrors.push(params.entry.text);
    if (method === "Page.javascriptDialogOpening") {
      dialogs.push(params.message);
      void cdp!.send("Page.handleJavaScriptDialog", { accept: true }).catch(error => browserErrors.push(String(error)));
    }
  };
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("Log.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url });
  const evaluate = <T = any>(expression: string) => cdp!.evaluate<T>(expression);
  const waitText = (text: string) => until(() => evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`), text);
  const click = (selector: string) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw Error('Missing element'); e.click(); })()`);
  const input = (selector: string, value: string) => evaluate(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw Error('Missing input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(value)});
    e.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const screenshot = async (name: string) => {
    await evaluate("document.fonts.ready");
    await delay(150);
    const capture = await cdp!.send("Page.captureScreenshot", { format: "png" });
    const file = path.join(out, `${name}.png`);
    await writeFile(file, Buffer.from(capture.data, "base64")); screenshots.push(file);
  };
  const factorField = (label: string) => `[data-testid="factor-settings"] input[aria-label="${label}"]`;
  const openSettings = async () => {
    await evaluate(`Array.from(document.querySelectorAll('button')).find(e => e.textContent.includes('策略参数设置')).click()`);
    await waitText("超短滚动挖掘");
  };
  const assertModalFits = async () => {
    const layout = await evaluate(`(() => {
      const e = document.querySelector('.config-modal-content'), r = e.getBoundingClientRect();
      return { left: r.left, right: r.right, width: innerWidth, scrollWidth: e.scrollWidth, clientWidth: e.clientWidth };
    })()`);
    assert.ok(layout.left >= 0 && layout.right <= layout.width + 1, JSON.stringify(layout));
    assert.ok(layout.scrollWidth <= layout.clientWidth + 1, JSON.stringify(layout));
  };
  await waitText("待近期样本验证");
  await click(".trading-mode-badge");
  await waitText("实盘小额测试");
  await waitText("未启用");
  assert.equal(await evaluate("document.querySelector('.live-panel input')"), null);
  await screenshot("desktop-live-disabled");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  await screenshot("mobile-live-disabled");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await click(".live-modal-close");
  checks.push("实盘默认关闭，首轮 10 USDT 上限，桌面和移动端无横向溢出");
  checks.push("首次启动不显示未经验证的生效因子");
  await openSettings();
  assert.equal(await evaluate("document.querySelectorAll('.unified-strategy-settings .strategy-preset-card').length"), 7);
  for (const [label, value] of [["训练窗口（分钟）", "720"], ["验证窗口（分钟）", "120"], ["留出窗口（分钟）", "120"], ["刷新间隔（分钟）", "15"], ["最长使用时间（分钟）", "120"]]) {
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(factorField(label))}).value`), value);
  }
  await assertModalFits(); await screenshot("desktop-settings");
  checks.push("七个统一策略预设及超短窗口默认值正确");
  await input(factorField("验证窗口（分钟）"), "90");
  await input(factorField("留出窗口（分钟）"), "45");
  const pollCount = paperRequests;
  await until(async () => paperRequests > pollCount, "background poll while editing");
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(factorField("验证窗口（分钟）"))}).value`), "90");
  await click(".btn-config-save");
  await until(() => evaluate("!document.querySelector('.config-modal-content')"), "save modal closes");
  assert.equal(engine.getConfig().factorMining!.validationMinutes, 90);
  assert.equal(engine.getConfig().factorMining!.holdoutMinutes, 45);
  checks.push("后台轮询不覆盖编辑，窗口经真实引擎 API 保存");

  const before = engine.getConfig();
  const invalid = await fetch(`${url}api/paper-trading/config`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ marginPercent: 10, factorMining: { ...before.factorMining, holdoutMinutes: 0 } }) });
  assert.equal(invalid.status, 400); assert.deepEqual(engine.getConfig(), before);
  checks.push("非法窗口 API 整次拒绝，无部分保存");

  await openSettings();
  await click(".unified-strategy-settings .strategy-preset-card summary");
  await evaluate(`Array.from(document.querySelectorAll('.unified-strategy-settings button')).find(e => e.textContent === '复制为新组合').click()`);
  assert.equal(await evaluate("document.querySelectorAll('.unified-strategy-settings .strategy-preset-card').length"), 8);
  await click(".unified-strategy-settings .strategy-preset-card:last-of-type summary");
  const copied = ".unified-strategy-settings .strategy-preset-card:last-of-type";
  await input(`${copied} .kline-strategy-fields input`, "CDP 特征组合");
  await input(`${copied} input[aria-label="阈值"]`, "9");
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(copied + ' input[type="checkbox"]')}).checked`), false);
  await evaluate(`document.querySelector(${JSON.stringify(copied)}).scrollIntoView({block:'start'})`);
  await assertModalFits(); await screenshot("desktop-strategy");
  await click(".btn-config-save");
  await until(() => evaluate("!document.querySelector('.config-modal-content')"), "strategy saved");
  const custom = engine.getConfig().strategies!.find(s => s.label === "CDP 特征组合")!;
  assert.ok(custom && !custom.enabled && !custom.factorManaged);
  assert.ok(JSON.stringify(custom.entry).includes('"value":9'));
  checks.push("特征组合复制、阈值编辑与保存，新组合默认关闭");

  engine.applyMinedFactors(fixtureResult());
  const state = engine.getFactorMiningState(); state.sides.SHORT.active!.expiresAt = Date.now() + 10_000;
  engine.setFactorMiningState(state);
  // Freeze a previously authorized response so the browser must notice expiry between polls itself.
  frozenState = structuredClone(engine.getState());
  assert.equal(frozenState.summary.factorMining!.entryAllowed.SHORT, true);
  await waitText("空头生效"); await screenshot("desktop-active-factor");
  await waitText("因子失效 · 等待新验证"); await screenshot("desktop-expired-factor");
  assert.equal(engine.factorEntryAllowed("SHORT"), false);
  checks.push("已验证因子展示生效；即使 API 快照滞后，到期也停止显示生效");
  frozenState = undefined;
  const rejected = fixtureResult(); rejected.sides.SHORT = { reason: "CDP fixture: holdout rejected" };
  engine.applyMinedFactors(rejected);
  await waitText("待近期样本验证");
  checks.push("最新留出拒绝后恢复等待状态");

  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await openSettings();
  await evaluate(`document.querySelector('[data-testid="factor-settings"]').scrollIntoView({block:'center'})`);
  await assertModalFits(); await screenshot("mobile-settings");
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(factorField("验证窗口（分钟）"))}).value`), "90");
  await click(".unified-strategy-settings .strategy-preset-card summary");
  await evaluate(`document.querySelector('.unified-strategy-settings .strategy-preset-card').scrollIntoView({block:'start'})`);
  await assertModalFits(); await screenshot("mobile-strategy");
  await evaluate(`document.querySelector('.btn-config-save').scrollIntoView({block:'center'})`);
  const saveVisible = await evaluate(`(() => { const r = document.querySelector('.btn-config-save').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()`);
  assert.equal(saveVisible, true);
  checks.push("390px 移动端设置与展开条件无横向溢出，保存按钮可见");
  assert.equal(dialogs.length, 2); assert.ok(dialogs.every(s => s.startsWith("✅")), dialogs.join("\n"));
  assert.deepEqual(browserErrors, []);
  checks.push("浏览器无脚本、控制台或资源加载错误");
  const report = { passed: true, at: new Date().toISOString(), browser: chromePath, fixture: true, checks, screenshots, browserErrors };
  await writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (cdp) {
    try { const capture = await cdp.send("Page.captureScreenshot", { format: "png" }); await writeFile(path.join(out, "failure.png"), Buffer.from(capture.data, "base64")); } catch {}
  }
  await writeFile(path.join(out, "failure.json"), JSON.stringify({ error: String(error), checks, browserErrors, chromeLog }, null, 2));
  throw error;
} finally {
  cdp?.close();
  if (chrome && chrome.exitCode === null) {
    chrome.kill("SIGTERM");
    await Promise.race([new Promise<void>(resolve => chrome!.once("exit", () => resolve())), delay(2500)]);
    if (chrome.exitCode === null) chrome.kill("SIGKILL");
  }
  clearTimeout((engine as any).saveTimeout);
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
