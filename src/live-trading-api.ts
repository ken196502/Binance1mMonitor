import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LiveTradingEngine } from "./live-trading.ts";
import type { LiveTradingSummary } from "./live-trading-types.ts";

export function authorizedLiveControl(header: string | undefined, token: string): boolean {
  if (token.length < 32 || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7)), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** No GET mutation; bearer token stays server-side / in the operator's memory. */
export async function handleLiveTradingApi(req: IncomingMessage, res: ServerResponse, pathname: string, engine: LiveTradingEngine | null, token: string, summary: () => LiveTradingSummary): Promise<boolean> {
  if (pathname !== "/api/live-trading" && !pathname.startsWith("/api/live-trading/")) return false;
  const json = (status: number, data: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  };
  if (pathname === "/api/live-trading" && req.method === "GET") { json(200, summary()); return true; }
  const action = pathname.slice("/api/live-trading/".length);
  if (!["pause", "resume", "close"].includes(action)) { json(404, { error: "未知实盘接口" }); return true; }
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); json(405, { error: "请使用 POST" }); return true; }
  if (!authorizedLiveControl(req.headers.authorization, token)) { json(401, { error: "需要有效的 LIVE_CONTROL_TOKEN" }); return true; }
  if (!engine) { json(503, { error: summary().reason }); return true; }
  try {
    await engine.control(action as "pause" | "resume" | "close");
    const state = summary();
    json(state.status === "halted" ? 409 : 200, { ok: state.status !== "halted", summary: state });
  } catch (e) { json(409, { error: e instanceof Error ? e.message : "实盘控制失败" }); }
  return true;
}
