import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("real server exposes safe live status and locks every paper mutation while live is enabled", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-api-"));
  Object.assign(process.env, { NODE_ENV: "test", DATA_DIR: dir, LIVE_TRADING_ENABLED: "true", LIVE_TRADING_TESTNET: "true", BINANCE_API_KEY: "fixture-key", BINANCE_API_SECRET: "fixture-secret", LIVE_CONTROL_TOKEN: "x".repeat(32) });
  // NODE_TEST_CONTEXT prevents the server from starting any exchange/background tasks.
  const { server } = await import("../../src/server.ts");
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const response = await fetch(`${url}/api/live-trading`);
  const body = await response.text();
  assert.equal(response.status, 200); assert.equal(JSON.parse(body).enabled, true);
  for (const secret of ["fixture-key", "fixture-secret", "x".repeat(32)]) assert.ok(!body.includes(secret));
  for (const endpoint of ["/api/paper-trading", "/api/paper-trading/reset", "/api/paper-trading/config"]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal((await fetch(url + endpoint, { method, headers: { "Content-Type": "application/json" }, body: "{}" })).status, 423, `${method} ${endpoint}`);
    }
  }
  assert.equal((await fetch(`${url}/api/paper-trading/config`)).status, 200);
  assert.equal((await fetch(`${url}/api/live-trading/close`, { method: "POST" })).status, 401);
  assert.equal((await fetch(`${url}/api/live-trading/close`)).status, 405);
  assert.equal(fs.existsSync(path.join(dir, "live-trading.json")), false);
});
