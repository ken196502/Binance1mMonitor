/** Public market data only; creating a client never starts the monitor/Telegram. */
export async function createBinanceClient(base: string) {
  const { ProxyAgent, EnvHttpProxyAgent, fetch } = await import("undici");
  const proxy = process.env.PROXY ?? process.env.BINANCE_PROXY;
  const dispatcher = proxy ? new ProxyAgent(proxy) : new EnvHttpProxyAgent();
  let lastRequest = 0;
  async function request(endpoint: string, format: "json" | "text" | "bytes" = "json"): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const delay = Math.max(0, lastRequest + 250 - Date.now());
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      lastRequest = Date.now();
      try {
        const response = await fetch(`${base}${endpoint}`, { dispatcher, signal: AbortSignal.timeout(15_000) });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 429 && attempt < 2) {
            const seconds = Number(response.headers.get("retry-after") ?? 2);
            if (!Number.isFinite(seconds) || seconds > 60) throw new Error("Binance 限频，请稍后用同一目录续传");
            await new Promise((resolve) => setTimeout(resolve, Math.max(1, seconds) * 1000));
            continue;
          }
          throw new Error(`Binance HTTP ${response.status} (${endpoint.split("?")[0]})`);
        }
        if (format === "bytes") return Buffer.from(await response.arrayBuffer());
        if (format === "text") return await response.text();
        return await response.json();
      } catch (e) {
        if (attempt < 2 && e instanceof Error && ["TypeError", "TimeoutError"].includes(e.name)) continue;
        throw e;
      }
    }
  }
  return { request, close: () => dispatcher.close() };
}
