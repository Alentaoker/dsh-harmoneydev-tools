export interface HarmonyReceipt {
  action: string;
  dispatchState: "not-sent" | "sent" | "unknown";
  effect: "applied" | "not-applied" | "unknown";
  verification: "passed" | "failed" | "not-run";
  provider: string;
  deviceEpoch: number;
  leaseEpoch: number;
  startedAt: string;
  completedAt: string;
}
