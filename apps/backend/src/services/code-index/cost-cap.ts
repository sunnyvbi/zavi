
import { serviceClient } from "@/services/supabase";
import { getAppSetting } from "@/services/settings";

export const DEFAULT_MAX_CODE_INDEX_PER_TENANT_PER_DAY = 5;

export async function resolveMaxIndexPerDay(): Promise<number> {
  const fromSetting = await getAppSetting("max_code_index_per_tenant_per_day");
  if (fromSetting !== undefined) {
    const n = Number(fromSetting);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const raw = process.env.PRAXIS_MAX_CODE_INDEX_PER_TENANT_PER_DAY;
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_MAX_CODE_INDEX_PER_TENANT_PER_DAY;
}

function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export type CanIndexResult = {
  ok: boolean;
  remaining: number;
  used: number;
  cap: number;
  reason?: "db_error" | "over_cap";
};

export async function canIndex(tenant_id: string): Promise<CanIndexResult> {
  const cap = await resolveMaxIndexPerDay();
  if (cap <= 0) {
    return { ok: false, remaining: 0, used: 0, cap, reason: "over_cap" };
  }

  const day = utcDay();
  const dayStart = `${day}T00:00:00.000Z`;
  const dayEnd = new Date(new Date(dayStart).getTime() + 86_400_000).toISOString();

  const { count, error } = await serviceClient()
    .from("code_index_builds")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenant_id)
    .gte("built_at", dayStart)
    .lt("built_at", dayEnd);

  if (error) {
    console.warn(`[code-index] cost-cap read failed for tenant ${tenant_id}: ${error.message}`);
    return { ok: false, remaining: 0, used: 0, cap, reason: "db_error" };
  }

  const used = count ?? 0;
  const remaining = Math.max(0, cap - used);
  return remaining > 0
    ? { ok: true, remaining, used, cap }
    : { ok: false, remaining, used, cap, reason: "over_cap" };
}
