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

    // ms from now until the next minute boundary (when the current 1m candle
    // closes and the next one opens). Schedules a poll there, then re-arms.
    const msToNextMinute = () => 60000 - (Date.now() % 60000);
    const scheduleNext = () => {
      timer = setTimeout(async () => {
        await poll();
        if (active) scheduleNext();
      }, msToNextMinute());
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
