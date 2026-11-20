import type { SupabaseClient } from "@supabase/supabase-js";
import { getNumberSetting } from "@/services/settings";

export async function isActiveStaffUser(db: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await db
    .from("staff_users").select("user_id")
    .eq("user_id", userId).is("revoked_at", null).maybeSingle();
  if (error) throw new Error(`staff_check_unavailable: ${error.message}`);
  return data != null;
}

export async function isTenantOwnerOrAdmin(db: SupabaseClient, userId: string, tenantId: string): Promise<boolean> {
  const { data, error } = await db
    .from("tenant_users").select("role")
    .eq("user_id", userId).eq("tenant_id", tenantId).maybeSingle<{ role: string }>();
  if (error) throw new Error(`owner_check_unavailable: ${error.message}`);
  return data?.role === "owner" || data?.role === "admin";
}

function utcMidnightIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export async function staffModelSpendTodayUsd(db: SupabaseClient): Promise<number> {
  const PAGE = 1000;
  const since = utcMidnightIso();
  let total = 0;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("agent_runs").select("cost_usd")
      .not("payload->staff_model", "is", null)
      .gte("enqueued_at", since)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`staff_model_spend_unavailable: ${error.message}`);
    const rows = (data ?? []) as Array<{ cost_usd: number | null }>;
    total += rows.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
    if (rows.length < PAGE) return total;
  }
}

export type CapResult = { ok: true } | { ok: false; spent: number; cap: number };

export async function checkStaffModelCap(db: SupabaseClient): Promise<CapResult> {
  const cap = await getNumberSetting("staff_model_test_daily_usd");
  try {
    const spent = await staffModelSpendTodayUsd(db);
    return spent >= cap ? { ok: false, spent, cap } : { ok: true };
  } catch {
    return { ok: false, spent: Number.NaN, cap };
  }
}
