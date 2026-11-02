import { useEffect, useRef, useState } from "react";
import type { Status } from "../../../src/types.ts";

export interface StatusState {
  status: Status | null;
  error: string | null;
}

// Polls /api/status immediately on mount, then at the close of each 1-minute
// candle (the wall-clock minute boundary). Detection runs on already-closed 1m
// K-lines, so there's no value in polling mid-minute — the data only changes at
// the boundary. A request failure surfaces as `error` (and turns the dot
// orange). Each poll re-arms itself relative to Date.now(), so setTimeout
// drift never accumulates across cycles.
export function useStatus(): StatusState {
  const [state, setState] = useState<StatusState>({
    status: null,
    error: null,
  });
  const req = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        req.current?.abort();
        const ac = new AbortController();
        req.current = ac;
        const r = await fetch("/api/status", { signal: ac.signal });
        const s = (await r.json()) as Status;
        if (active) setState({ status: s, error: null });
      } catch (e) {
        if (!active) return;
        if (e instanceof DOMException && e.name === "AbortError") return;
        setState({
          status: null,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    };

    // 距下一个整分钟对齐刷新点 (整分钟 + 1200ms) 的毫秒延迟
    // 后端会在整分钟 + 1000ms 执行扫描并更新缓存，前端在 +1200ms 抓取最新数据
    const msToNextPoll = () => {
      const now = Date.now();
      const currentMinuteStart = Math.floor(now / 60000) * 60000;
      let target = currentMinuteStart + 1200;
      if (now >= target) {
        target += 60000;
      }
      return Math.max(100, target - now);
    };
    const scheduleNext = () => {
      timer = setTimeout(async () => {
        await poll();
        if (active) scheduleNext();
      }, msToNextPoll());
    };

    poll(); // immediate on mount so the page isn't blank until the boundary
    scheduleNext();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      req.current?.abort();
    };
  }, []);

  return state;
}
