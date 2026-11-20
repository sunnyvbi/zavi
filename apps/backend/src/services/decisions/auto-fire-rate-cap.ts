
import { serviceClient } from "@/services/supabase";

export const AUTO_FIRE_RATE_CAP = 30;

export const AUTO_FIRE_WINDOW_MS = 60 * 60 * 1000;

const FIRED_STATUSES = ["dispatching", "acted"] as const;

export type AutoFireRateCapResult = {
  allowed: boolean;
  count: number;
  cap: number;
  reason?: "over_cap" | "count_error";
};

export async function checkAutoFireRateCap(
  tenant_id: string,
  decision_class: string,
  cap: number = AUTO_FIRE_RATE_CAP,
): Promise<AutoFireRateCapResult> {
  const windowStart = new Date(Date.now() - AUTO_FIRE_WINDOW_MS).toISOString();
  try {
    const { count, error } = await serviceClient()
      .from("decisions")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant_id)
      .eq("decision_class", decision_class)
      .eq("autonomy_at_emit", "auto")
      .in("status", FIRED_STATUSES as unknown as string[])
      .gte("dispatched_at", windowStart);
    if (error) {
      console.warn(
        `[auto-fire-rate-cap] count failed for ${tenant_id}/${decision_class}: ${error.message} — failing closed (route to approval)`,
      );
      return { allowed: false, count: -1, cap, reason: "count_error" };
    }
    const n = count ?? 0;
    if (n >= cap) {
      return { allowed: false, count: n, cap, reason: "over_cap" };
    }
    return { allowed: true, count: n, cap };
  } catch (e) {
    console.warn(
      `[auto-fire-rate-cap] count threw for ${tenant_id}/${decision_class}: ${(e as Error).message} — failing closed (route to approval)`,
    );
    return { allowed: false, count: -1, cap, reason: "count_error" };
  }
}
