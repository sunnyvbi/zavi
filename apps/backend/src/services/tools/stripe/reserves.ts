
import { serviceClient } from "@/services/supabase";

export type ReservePolicy = {
  bps: number;
  releaseDays: number;
};

export const DEFAULT_RESERVE_POLICY: ReservePolicy = { bps: 0, releaseDays: 7 };

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

export async function resolveReservePolicy(): Promise<ReservePolicy> {
  try {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (error || !data) return { ...DEFAULT_RESERVE_POLICY };
    const blob = (data.blob ?? {}) as Record<string, unknown>;
    return {
      bps: clampInt(blob.autopilot_reserve_bps, DEFAULT_RESERVE_POLICY.bps, 0, 10_000),
      releaseDays: clampInt(
        blob.autopilot_reserve_release_days,
        DEFAULT_RESERVE_POLICY.releaseDays,
        0,
        365,
      ),
    };
  } catch {
    return { ...DEFAULT_RESERVE_POLICY };
  }
}

export function computeReserveWithhold(amount_minor: number, bps: number): number {
  if (!Number.isFinite(amount_minor) || amount_minor <= 0) return 0;
  const safeBps = Number.isFinite(bps) ? Math.max(0, Math.min(10_000, Math.trunc(bps))) : 0;
  const withhold = Math.floor((Math.trunc(amount_minor) * safeBps) / 10_000);
  return Math.min(Math.max(0, withhold), Math.trunc(amount_minor));
}
