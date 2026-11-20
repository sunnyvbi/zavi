
import type { SupabaseClient } from "@supabase/supabase-js";
import { asTenantId, globalClient, tenantRpc } from "@/services/tenant-client";

export const X_METRICS_METER_KEY = "x_metrics";

export const X_METRICS_READS_PER_DAY_DEFAULT = 1;

export const X_METRICS_READ_CAP_CODE = "x_read_cap_reached";

export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export async function readsPerDay(): Promise<number> {
  try {
    const { data, error } = await globalClient()
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle();
    if (error) return X_METRICS_READS_PER_DAY_DEFAULT;
    const raw = ((data?.blob ?? {}) as Record<string, unknown>).x_metrics_reads_per_day;
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : X_METRICS_READS_PER_DAY_DEFAULT;
  } catch {
    return X_METRICS_READS_PER_DAY_DEFAULT;
  }
}

export type ReadSlot =
  | { ok: true; used: number; cap: number }
  | { ok: false; used: number; cap: number; reason: "cap_reached" | "unavailable" };

export async function consumeReadSlot(tenant_id: string): Promise<ReadSlot> {
  const cap = await readsPerDay();
  try {
    const { data, error } = await tenantRpc(asTenantId(tenant_id), "consume_metered_read_or_reject", {
      p_day: utcDay(),
      p_key: X_METRICS_METER_KEY,
      p_cap: cap,
    });
    if (error) return { ok: false, used: cap, cap, reason: "unavailable" };
    if (data === null || data === undefined) return { ok: false, used: cap, cap, reason: "cap_reached" };
    return { ok: true, used: Number(data), cap };
  } catch {
    return { ok: false, used: cap, cap, reason: "unavailable" };
  }
}

export async function releaseReadSlot(tenant_id: string): Promise<void> {
  try {
    await tenantRpc(asTenantId(tenant_id), "release_metered_read", {
      p_day: utcDay(),
      p_key: X_METRICS_METER_KEY,
    });
  } catch {
  }
}

export type ReadBudget = { used: number; cap: number; remaining: number };

export async function readBudget(
  sb: Pick<SupabaseClient, "from">,
  tenant_id: string,
): Promise<ReadBudget> {
  const cap = await readsPerDay();
  try {
    const { data, error } = await sb
      .from("tenant_metered_read_counters")
      .select("reads")
      .eq("tenant_id", tenant_id)
      .eq("day", utcDay())
      .eq("key", X_METRICS_METER_KEY)
      .maybeSingle();
    if (error) return { used: cap, cap, remaining: 0 };
    const used = Number((data as { reads?: number } | null)?.reads ?? 0);
    return { used, cap, remaining: cap <= 0 ? Number.POSITIVE_INFINITY : Math.max(0, cap - used) };
  } catch {
    return { used: cap, cap, remaining: 0 };
  }
}
