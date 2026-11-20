
import { serviceClient } from "@/services/supabase";

export type WaiverState =
  | {
      state: "active";
      max_daily_usd: number | null;
      cooling_off_seconds: number;
      expires_at: string;
    }
  | {
      state: "expired";
      expires_at: string | null;
    }
  | {
      state: "none";
    };

export async function resolveWaiverState(
  tenant_id: string,
  decision_class: string,
  nowMs: number = Date.now(),
): Promise<WaiverState> {
  try {
    const { data, error } = await serviceClient()
      .from("tenant_decision_class_overrides")
      .select("waiver_expires_at, waiver_max_daily_usd, waiver_cooling_off_seconds")
      .eq("tenant_id", tenant_id)
      .eq("decision_class", decision_class)
      .maybeSingle();
    if (error) {
      console.warn(
        `[waiver-resolve] lookup failed for ${tenant_id}/${decision_class}: ${error.message} — failing CLOSED (treat as expired)`,
      );
      return { state: "expired", expires_at: null };
    }
    if (!data) return { state: "none" };
    const row = data as {
      waiver_expires_at: string | null;
      waiver_max_daily_usd: number | string | null;
      waiver_cooling_off_seconds: number | null;
    };
    if (!row.waiver_expires_at) return { state: "none" };

    const expiresMs = Date.parse(row.waiver_expires_at);
    if (!Number.isFinite(expiresMs)) {
      return { state: "expired", expires_at: row.waiver_expires_at };
    }
    if (expiresMs <= nowMs) {
      return { state: "expired", expires_at: row.waiver_expires_at };
    }

    const cap =
      row.waiver_max_daily_usd === null || row.waiver_max_daily_usd === undefined
        ? null
        : typeof row.waiver_max_daily_usd === "string"
          ? Number(row.waiver_max_daily_usd)
          : row.waiver_max_daily_usd;
    return {
      state: "active",
      max_daily_usd: cap,
      cooling_off_seconds: row.waiver_cooling_off_seconds ?? 0,
      expires_at: row.waiver_expires_at,
    };
  } catch (e) {
    console.warn(
      `[waiver-resolve] threw for ${tenant_id}/${decision_class}: ${(e as Error).message} — failing CLOSED (treat as expired)`,
    );
    return { state: "expired", expires_at: null };
  }
}
