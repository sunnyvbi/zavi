
import type { SupabaseClient } from "@supabase/supabase-js";

export const VOICE_BUDGET_NIL_RUN_SENTINEL =
  "00000000-0000-0000-0000-000000000000";

export const DEFAULT_DAILY_BUDGET_MICROS = 25_000_000n;
export const DEFAULT_TURN_WORSTCASE_MICROS = 350_000n;

export interface BudgetGateOutcome {
  allowed: boolean;
  remainingTodayMicros: bigint;
  capMicros: bigint;
  reason?: "cap_exhausted" | "worst_case_too_close";
}

function envBigint(name: string, fallback: bigint): bigint {
  const v = process.env[name];
  if (!v) return fallback;
  try {
    const n = BigInt(v);
    return n >= 0n ? n : fallback;
  } catch {
    return fallback;
  }
}

export async function resolveTenantDailyCapMicros(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<bigint> {
  const envDefault = envBigint(
    "PRAXIS_DAILY_VOICE_BUDGET_MICROS",
    DEFAULT_DAILY_BUDGET_MICROS,
  );
  const { data, error } = await supabase
    .from("tenants")
    .select("settings")
    .eq("id", tenantId)
    .maybeSingle();
  if (error || !data) return envDefault;
  const override = (data.settings as Record<string, unknown> | null)
    ?.voice_budget_micros_daily;
  if (typeof override === "string") {
    try {
      const n = BigInt(override);
      return n >= 0n ? n : envDefault;
    } catch {
      return envDefault;
    }
  }
  if (typeof override === "number" && Number.isFinite(override)) {
    return BigInt(Math.floor(override));
  }
  return envDefault;
}

export async function sumTodayVoiceMicros(
  supabase: SupabaseClient,
  tenantId: string,
  nowIso: string = new Date().toISOString(),
): Promise<bigint> {
  const utcMidnight = new Date(nowIso);
  utcMidnight.setUTCHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from("voice_session_costs")
    .select("stt_micros, tts_micros, llm_micros")
    .eq("tenant_id", tenantId)
    .gte("created_at", utcMidnight.toISOString());
  if (error) throw error;
  let total = 0n;
  for (const row of data ?? []) {
    const stt = BigInt((row as { stt_micros: string | number }).stt_micros ?? 0);
    const tts = BigInt((row as { tts_micros: string | number }).tts_micros ?? 0);
    const llm = BigInt((row as { llm_micros: string | number }).llm_micros ?? 0);
    total += stt + tts + llm;
  }
  return total;
}

export async function checkVoiceBudget(
  supabase: SupabaseClient,
  tenantId: string,
  worstCaseMicros: bigint = envBigint(
    "PRAXIS_VOICE_TURN_WORSTCASE_MICROS",
    DEFAULT_TURN_WORSTCASE_MICROS,
  ),
): Promise<BudgetGateOutcome> {
  const cap = await resolveTenantDailyCapMicros(supabase, tenantId);
  const spent = await sumTodayVoiceMicros(supabase, tenantId);
  const remaining = cap - spent;
  if (remaining <= 0n) {
    return {
      allowed: false,
      remainingTodayMicros: remaining < 0n ? 0n : remaining,
      capMicros: cap,
      reason: "cap_exhausted",
    };
  }
  if (remaining < worstCaseMicros) {
    return {
      allowed: false,
      remainingTodayMicros: remaining,
      capMicros: cap,
      reason: "worst_case_too_close",
    };
  }
  return {
    allowed: true,
    remainingTodayMicros: remaining,
    capMicros: cap,
  };
}
