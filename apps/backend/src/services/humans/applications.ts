
import { asTenantId, tenantClient } from "@/services/tenant-client";

export const HUMAN_APPLICATION_REVIEW_CLASS = "human.application_review";

export const OPEN_BRIEF_KINDS = ["creative"] as const;
export type BriefKind = (typeof OPEN_BRIEF_KINDS)[number];

export type SettleResult =
  | { handled: false }
  | { handled: true; application_id: string; engagement_id: string | null };

export async function settleHumanApplicationDecision(args: {
  decision_id: string;
  tenant_id: string;
  action: "approve" | "reject";
}): Promise<SettleResult> {
  const tc = tenantClient(asTenantId(args.tenant_id));

  const { data: dRow } = await tc
    .from("decisions")
    .select("decision_class, body")
    .eq("id", args.decision_id)
    .maybeSingle();

  const decision = dRow as {
    decision_class?: string | null;
    body?: Record<string, unknown> | null;
  } | null;
  if (!decision || decision.decision_class !== HUMAN_APPLICATION_REVIEW_CLASS) {
    return { handled: false };
  }

  const application_id = decision.body?.application_id;
  if (typeof application_id !== "string" || application_id.length === 0) {
    return { handled: false };
  }

  if (args.action === "reject") {
    await tc
      .from("brief_applications")
      .update({ status: "rejected", updated_at: new Date().toISOString() })
      .eq("id", application_id)
      .in("status", ["applied", "shortlisted"]);
  }

  return { handled: true, application_id, engagement_id: null };
}
