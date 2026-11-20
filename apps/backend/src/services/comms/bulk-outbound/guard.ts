
import { effectiveCap, resolveEnvDailySendCap, warmupAllowance } from "@/services/tools/email/safety-net";
import type { BulkSendStore, ClaimOutcome } from "./store";

export function bulkDailyCap(): number {
  return resolveEnvDailySendCap();
}

export function daysToFinish(remaining: number, dayIndex: number): number {
  const dailyCap = resolveEnvDailySendCap();
  let left = remaining;
  let days = 0;
  for (let d = dayIndex + 1; left > 0; d += 1) {
    days += 1;
    const cap = effectiveCap(dailyCap, warmupAllowance(d));
    if (cap <= 0) break;
    left -= cap;
  }
  return Math.max(1, days);
}

export function warmUpIsTheLimit(dayIndex: number): boolean {
  const warmup = warmupAllowance(dayIndex);
  const dailyCap = resolveEnvDailySendCap();
  return warmup > 0 && (dailyCap <= 0 || warmup <= dailyCap);
}

export function guardBulkSend(store: BulkSendStore, args: { tenantId: string; sendId: string }): Promise<ClaimOutcome> {
  return store.claimNext(args.tenantId, args.sendId, bulkDailyCap());
}
