
import { serviceClient } from "@/services/supabase";
import { getStringSetting } from "@/services/settings";
import { decideOnDecision } from "@/services/approvals/decide-service";
import { logEvent } from "@/services/logging/logEvent";

export const TRUST_LADDER_CLASS = "autopilot.daily-plan";

export const TRUST_LEVELS = ["L0", "L1"] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export function coerceTrustLevel(raw: unknown): TrustLevel {
  return raw === "L1" ? "L1" : "L0";
}

export async function resolveTrustLevel(tenant_id: string): Promise<TrustLevel> {
  return coerceTrustLevel(await getStringSetting("autopilot_trust_level", tenant_id));
}

export type AutoApproveOutcome =
  | { attempted: false; reason: "level_l0" | "never_auto_clamp" | "no_owner_actor" }
  | { attempted: true; approved: boolean; reason?: string };

export async function maybeAutoApproveDailyPlan(args: {
  tenant_id: string;
  decision_id: string;
}): Promise<AutoApproveOutcome> {
  const { tenant_id, decision_id } = args;
  try {
    const level = await resolveTrustLevel(tenant_id);
    if (level !== "L1") return { attempted: false, reason: "level_l0" };

    const svc = serviceClient();

    const { data: classRow, error: classErr } = await svc
      .from("decision_classes")
      .select("never_auto")
      .eq("slug", TRUST_LADDER_CLASS)
      .maybeSingle();
    if (classErr || !classRow || (classRow as { never_auto: boolean | null }).never_auto === true) {
      return { attempted: false, reason: "never_auto_clamp" };
    }

    const { data: ownerRow } = await svc
      .from("tenant_users")
      .select("user_id")
      .eq("tenant_id", tenant_id)
      .eq("role", "owner")
      .maybeSingle();
    const owner_user_id = (ownerRow as { user_id: string } | null)?.user_id;
    if (!owner_user_id) return { attempted: false, reason: "no_owner_actor" };

    const result = await decideOnDecision({
      decision_id,
      tenant_id,
      action: "approve",
      actor: { user_id: owner_user_id },
    });

    await logEvent({
      level: "info",
      source: "trust-ladder",
      code: result.ok && result.changed
        ? "autopilot.trust_ladder.auto_approved"
        : "autopilot.trust_ladder.auto_approve_failed",
      message: "auto-approved by trust-ladder L1",
      tenant_id,
      meta: { decision_class: TRUST_LADDER_CLASS },
    });

    return {
      attempted: true,
      approved: result.ok && result.changed,
      reason: result.ok ? undefined : result.code,
    };
  } catch (e) {
    console.warn(
      `[trust-ladder] auto-approve failed for decision ${decision_id} (tenant ${tenant_id}): ${(e as Error).message}`,
    );
    return { attempted: true, approved: false, reason: "threw" };
  }
}
