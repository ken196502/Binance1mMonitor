/** Browser-safe contracts. Credentials never appear in these types. */
export interface LiveTrade {
  id: string;
  signalId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  strategy: string;
  status: "ENTERING" | "OPEN" | "CLOSED";
  requestedQuantity: string;
  limitPrice: string;
  entryOrderId: string;
  entryPrice: number;
  initialQuantity: number;
  remainingQuantity: number;
  openedAt: number;
  timeoutAt: number;
  tp1Percent: number;
  tp2Percent: number;
  stopPercent: number;
  stopPrice: number;
  firstTargetDone: boolean;
  moveToBreakeven: boolean;
  stopIds: string[];
  pendingClose?: { id: string; quantity: string; reason: string; firstTarget: boolean };
  exits: { orderId: string; quantity: number; price: number; reason: string; time: number }[];
  closedAt?: number;
}

export interface LiveTradingSummary {
  enabled: boolean;
  configured: boolean;
  testnet: boolean;
  status: "disabled" | "starting" | "ready" | "paused" | "halted";
  reason: string | null;
  budgetUsdt: number;
  orderUsdt: number;
  leverage: 1;
  maxPositions: 1;
  walletUsdt: number | null;
  lastCheckedAt: number | null;
  activeTrade: LiveTrade | null;
  recentTrades: LiveTrade[];
}
