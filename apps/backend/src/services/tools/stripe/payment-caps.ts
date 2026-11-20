
import { serviceClient } from "@/services/supabase";
import { ExpectedToolError } from "@/services/tools/types";

export type DailyUsage = { collected_minor: number; count: number };

export type PaymentCaps = {
  dailyCapMinor: number;
  dailyCountCap: number;
};

export const DEFAULT_PAYMENT_CAPS: PaymentCaps = {
  dailyCapMinor: 200_000,
  dailyCountCap: 50,
};

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export async function resolvePaymentCaps(): Promise<PaymentCaps> {
  try {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (error || !data) return { ...DEFAULT_PAYMENT_CAPS };
    const blob = (data.blob ?? {}) as Record<string, unknown>;
    return {
      dailyCapMinor: clampInt(
        blob.autopilot_daily_cap_minor,
        DEFAULT_PAYMENT_CAPS.dailyCapMinor,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      dailyCountCap: clampInt(
        blob.autopilot_daily_count_cap,
        DEFAULT_PAYMENT_CAPS.dailyCountCap,
        0,
        1_000_000,
      ),
    };
  } catch {
    return { ...DEFAULT_PAYMENT_CAPS };
  }
}

export async function loadTodayUsage(tenant_id: string): Promise<DailyUsage> {
  if (!tenant_id) throw new Error("loadTodayUsage: missing tenant_id");
  const sb = serviceClient();
  const { data, error } = await sb
    .from("autopilot_payment_daily")
    .select("collected_minor, count")
    .eq("tenant_id", tenant_id)
    .eq("day", utcDay())
    .maybeSingle<{ collected_minor: number; count: number }>();
  if (error) throw new Error(`loadTodayUsage failed: ${error.message}`);
  return {
    collected_minor: data?.collected_minor ?? 0,
    count: data?.count ?? 0,
  };
}

export async function assertWithinCaps(args: {
  tenant_id: string;
  amount_minor: number;
}): Promise<void> {
  if (!args.tenant_id) throw new Error("assertWithinCaps: missing tenant_id");
  if (!Number.isInteger(args.amount_minor) || args.amount_minor <= 0) {
    throw new Error("assertWithinCaps: amount_minor must be a positive integer");
  }
  const caps = await resolvePaymentCaps();
  const usage = await loadTodayUsage(args.tenant_id);

  if (usage.count + 1 > caps.dailyCountCap) {
    throw new ExpectedToolError(
      "payment_cap_exceeded",
      `Daily transaction count cap reached (${usage.count}/${caps.dailyCountCap}). Try again tomorrow or raise the cap.`,
      { reason: "count", used: usage.count, cap: caps.dailyCountCap },
    );
  }
  if (usage.collected_minor + args.amount_minor > caps.dailyCapMinor) {
    throw new ExpectedToolError(
      "payment_cap_exceeded",
      `Daily collected amount cap reached (${usage.collected_minor}+${args.amount_minor} > ${caps.dailyCapMinor}, minor units). Try again tomorrow or raise the cap.`,
      {
        reason: "amount",
        used: usage.collected_minor,
        attempted: args.amount_minor,
        cap: caps.dailyCapMinor,
      },
    );
  }
}

export async function recordUsage(tenant_id: string, amount_minor: number): Promise<void> {
  if (!tenant_id) throw new Error("recordUsage: missing tenant_id");
  if (!Number.isInteger(amount_minor) || amount_minor <= 0) {
    throw new Error("recordUsage: amount_minor must be a positive integer");
  }
  const sb = serviceClient();
  const { error } = await sb.rpc("autopilot_record_payment_usage", {
    p_tenant_id: tenant_id,
    p_day: utcDay(),
    p_amount_minor: amount_minor,
  });
  if (error) throw new Error(`recordUsage failed: ${error.message}`);
}
