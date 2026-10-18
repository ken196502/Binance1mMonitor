import { useEffect, useState } from "react";
import type { ChartPayload } from "../../../src/types.ts";

export interface KlinesState {
  data: ChartPayload | null;
  error: string | null;
  loading: boolean;
}

// 拉取 1m K 线（后端已算好均线/MACD）。节奏与 useStatus 一致：切换 symbol 立即拉一次，
// 之后对齐整分钟边界轮询——K 线只在收盘时才变定局，没必要每分钟请求多次。
// 失败时保留上一份数据继续渲染，只把 error 抛给调用方展示，避免图表整块消失。
export function useKlines(symbol: string): KlinesState {
  const [state, setState] = useState<KlinesState>({ data: null, error: null, loading: true });

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ac = new AbortController();

    const poll = async () => {
      try {
        const r = await fetch(`/api/klines?symbol=${encodeURIComponent(symbol)}`, { signal: ac.signal });
        const body = (await r.json()) as ChartPayload & { error?: string };
        if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
        if (active) setState({ data: body, error: null, loading: false });
      } catch (e) {
        if (!active) return;
        if (e instanceof DOMException && e.name === "AbortError") return;
        setState((s) => ({
          data: s.data,
          error: e instanceof Error ? e.message : String(e),
          loading: false,
        }));
      }
    };

    setState({ data: null, error: null, loading: true });
    poll();

    const msToNextMinute = () => 60000 - (Date.now() % 60000);
    const scheduleNext = () => {
      timer = setTimeout(async () => {
        await poll();
        if (active) scheduleNext();
      }, msToNextMinute());
    };
    scheduleNext();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      ac.abort();
    };
  }, [symbol]);

  return state;
}
