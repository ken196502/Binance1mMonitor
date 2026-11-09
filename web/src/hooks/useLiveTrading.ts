import { useEffect, useState } from "react";
import type { LiveTradingSummary } from "../../../src/live-trading-types.ts";

export interface LiveTradingState {
  state: LiveTradingSummary | null;
  connected: boolean;
  setState: React.Dispatch<React.SetStateAction<LiveTradingSummary | null>>;
}

export function useLiveTrading(initial?: LiveTradingSummary | null): LiveTradingState {
  const [state, setState] = useState<LiveTradingSummary | null>(initial ?? null);
  const [connected, setConnected] = useState<boolean>(true);

  // Sync if initial prop changes and local state is empty
  useEffect(() => {
    if (initial && !state) {
      setState(initial);
    }
  }, [initial, state]);

  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const res = await fetch("/api/live-trading", {
          cache: "no-store",
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const next = (await res.json()) as LiveTradingSummary;
        if (active) {
          setState(next);
          setConnected(true);
        }
      } catch {
        if (active) {
          setConnected(false);
        }
      } finally {
        if (active) {
          timer = setTimeout(poll, 3000);
        }
      }
    };

    void poll();
    return () => {
      active = false;
      abort.abort();
      clearTimeout(timer);
    };
  }, []);

  return { state, connected, setState };
}
