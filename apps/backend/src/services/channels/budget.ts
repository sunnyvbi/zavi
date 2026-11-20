
import { asTenantId, tenantRpc } from "@/services/tenant-client";

export type BudgetVerdict =
  | { allowed: true; spent_30d: number }
  | { allowed: false; reason: "cap_reached" | "unavailable"; spent_30d: number };

export async function channelBudgetAllows(
  tenant_id: string,
  estimate: number,
): Promise<BudgetVerdict> {
  try {
    const tid = asTenantId(tenant_id);
    const [allowSettled, spentSettled] = await Promise.allSettled([
      tenantRpc(tid, "channel_budget_allows", { p_estimate: estimate }),
      tenantRpc(tid, "channel_credits_30d", {}),
    ]);

    const spentRes =
      spentSettled.status === "fulfilled" ? spentSettled.value : null;
    const spent_30d =
      spentRes && typeof spentRes.data === "number" && Number.isFinite(spentRes.data)
        ? spentRes.data
        : 0;

    if (allowSettled.status === "rejected") {
      return { allowed: false, reason: "unavailable", spent_30d };
    }
    const allowRes = allowSettled.value;

    if (allowRes.error || typeof allowRes.data !== "boolean") {
      return { allowed: false, reason: "unavailable", spent_30d };
    }
    return allowRes.data
      ? { allowed: true, spent_30d }
      : { allowed: false, reason: "cap_reached", spent_30d };
  } catch {
    return { allowed: false, reason: "unavailable", spent_30d: 0 };
  }
}

export const CAP_REACHED_MESSAGE =
  "This channel refreshes on the next cycle — you've used this period's channel runs.";
