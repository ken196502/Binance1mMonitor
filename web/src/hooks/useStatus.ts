import { useEffect, useRef, useState } from "react";
import type { Status } from "../../../src/types.ts";

export interface StatusState {
  status: Status | null;
  error: string | null;
  // Wall-clock ms of the last poll attempt (success or failure). The countdown
  // ring in App uses this to show time-until-next-refresh.
  lastFetchedAt: number;
}

// Polls /api/status immediately and every 5s, matching the original dashboard's
// behaviour. A request failure surfaces as `error` (and turns the dot orange),
// just like the old catch block did.
export function useStatus(intervalMs = 5000): StatusState {
  const [state, setState] = useState<StatusState>({
    status: null,
    error: null,
    lastFetchedAt: Date.now(),
  });
  const req = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;

    const poll = async () => {
      try {
        req.current?.abort();
        const ac = new AbortController();
        req.current = ac;
        const r = await fetch("/api/status", { signal: ac.signal });
        const s = (await r.json()) as Status;
        if (active) setState({ status: s, error: null, lastFetchedAt: Date.now() });
      } catch (e) {
        if (!active) return;
        if (e instanceof DOMException && e.name === "AbortError") return;
        setState({
          status: null,
          error: e instanceof Error ? e.message : String(e),
          lastFetchedAt: Date.now(),
        });
      }
    };

    poll();
    const id = setInterval(poll, intervalMs);
    return () => {
      active = false;
      clearInterval(id);
      req.current?.abort();
    };
  }, [intervalMs]);

  return state;
}
