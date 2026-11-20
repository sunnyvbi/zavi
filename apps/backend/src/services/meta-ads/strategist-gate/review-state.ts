
import { asTenantId, staffCrossTenantClient, tenantClient } from "@/services/tenant-client";
import type { ReviewStatus } from "./constants";
import type { ParkedDecision } from "./resolve-verdict";

const TABLE = "ad_set_strategist_reviews";

function scoped(tenantId: string) {
  return tenantClient(asTenantId(tenantId));
}

export async function upsertReviewRow(args: {
  pending_decision_id: string;
  tenant_id: string;
}): Promise<void> {
  const { error } = await scoped(args.tenant_id)
    .from(TABLE)
    .upsert(
      {
        pending_decision_id: args.pending_decision_id,
        status: "pending" as ReviewStatus,
      },
      { onConflict: "tenant_id,pending_decision_id", ignoreDuplicates: true },
    );
  if (error) throw new Error(`upsertReviewRow failed: ${error.message}`);
}

export async function setReviewRunId(args: {
  pending_decision_id: string;
  tenant_id: string;
  review_run_id: string;
}): Promise<void> {
  const { error } = await scoped(args.tenant_id)
    .from(TABLE)
    .update({ review_run_id: args.review_run_id, updated_at: new Date().toISOString() })
    .eq("pending_decision_id", args.pending_decision_id);
  if (error) {
    console.warn(`setReviewRunId failed: ${error.message}`);
  }
}

export async function claimForResolve(
  pendingDecisionId: string,
  tenantId: string,
): Promise<boolean> {
  const { data, error } = await scoped(tenantId)
    .from(TABLE)
    .update({ status: "resolving" as ReviewStatus, claimed_at: new Date().toISOString() })
    .eq("pending_decision_id", pendingDecisionId)
    .eq("status", "pending")
    .select("pending_decision_id")
    .maybeSingle();
  if (error) throw new Error(`claimForResolve failed: ${error.message}`);
  return !!data;
}

export async function finalizeApproved(
  pendingDecisionId: string,
  tenantId: string,
  finalDecisionId: string,
): Promise<boolean> {
  const { data, error } = await scoped(tenantId)
    .from(TABLE)
    .update({
      status: "approved" as ReviewStatus,
      final_decision_id: finalDecisionId,
      updated_at: new Date().toISOString(),
    })
    .eq("pending_decision_id", pendingDecisionId)
    .in("status", ["pending", "resolving"])
    .select("pending_decision_id")
    .maybeSingle();
  if (error) throw new Error(`finalizeApproved failed: ${error.message}`);
  return !!data;
}

export async function finalizeBounced(
  pendingDecisionId: string,
  tenantId: string,
  reason: string,
): Promise<boolean> {
  const { data, error } = await scoped(tenantId)
    .from(TABLE)
    .update({
      status: "bounced" as ReviewStatus,
      bounce_reason: reason.slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq("pending_decision_id", pendingDecisionId)
    .eq("status", "resolving")
    .select("pending_decision_id")
    .maybeSingle();
  if (error) throw new Error(`finalizeBounced failed: ${error.message}`);
  return !!data;
}

export async function recoverApproved(
  pendingDecisionId: string,
  tenantId: string,
  finalDecisionId: string,
): Promise<boolean> {
  const { data, error } = await scoped(tenantId)
    .from(TABLE)
    .update({
      status: "approved" as ReviewStatus,
      final_decision_id: finalDecisionId,
      updated_at: new Date().toISOString(),
    })
    .eq("pending_decision_id", pendingDecisionId)
    .in("status", ["pending", "resolving", "failed"])
    .select("pending_decision_id")
    .maybeSingle();
  if (error) throw new Error(`recoverApproved failed: ${error.message}`);
  return !!data;
}

export async function supersedeFailureNotice(
  pendingDecisionId: string,
  tenantId: string,
): Promise<void> {
  const { error } = await scoped(tenantId)
    .from("decisions")
    .update({ status: "superseded", superseded_at: new Date().toISOString() })
    .eq("decision_class", "agent.urgent_advisory")
    .eq("status", "proposed")
    .eq("body->>kind", "strategist_review_failed")
    .eq("body->>pending_decision_id", pendingDecisionId);
  if (error) console.warn(`supersedeFailureNotice failed: ${error.message}`);
}

export async function findFinalCreateFor(
  pendingDecisionId: string,
  tenantId: string,
): Promise<{ id: string } | null> {
  const { data, error } = await scoped(tenantId)
    .from("decisions")
    .select("id")
    .eq("decision_class", "meta_ads.create_ad_set")
    .eq("body->strategist_gate->>origin_pending_decision_id", pendingDecisionId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`findFinalCreateFor failed: ${error.message}`);
  return data ? { id: (data as { id: string }).id } : null;
}

export async function finalizeFailed(
  pendingDecisionId: string,
  tenantId: string,
  reason: string,
  staleCutoffIso: string,
): Promise<boolean> {
  const patch = {
    status: "failed" as ReviewStatus,
    bounce_reason: reason.slice(0, 500),
    updated_at: new Date().toISOString(),
  };
  const a = await scoped(tenantId)
    .from(TABLE)
    .update(patch)
    .eq("pending_decision_id", pendingDecisionId)
    .in("status", ["pending", "resolving"])
    .is("claimed_at", null)
    .select("pending_decision_id")
    .maybeSingle();
  if (a.error) throw new Error(`finalizeFailed failed: ${a.error.message}`);
  if (a.data) return true;

  const b = await scoped(tenantId)
    .from(TABLE)
    .update(patch)
    .eq("pending_decision_id", pendingDecisionId)
    .in("status", ["pending", "resolving"])
    .lt("claimed_at", staleCutoffIso)
    .select("pending_decision_id")
    .maybeSingle();
  if (b.error) throw new Error(`finalizeFailed failed: ${b.error.message}`);
  return !!b.data;
}

export async function releaseClaim(
  pendingDecisionId: string,
  tenantId: string,
): Promise<void> {
  const { error } = await scoped(tenantId)
    .from(TABLE)
    .update({ status: "pending" as ReviewStatus, updated_at: new Date().toISOString() })
    .eq("pending_decision_id", pendingDecisionId)
    .eq("status", "resolving");
  if (error) console.warn(`releaseClaim failed: ${error.message}`);
}

export async function bumpAttemptForRetry(args: {
  pending_decision_id: string;
  tenant_id: string;
  attempts: number;
}): Promise<boolean> {
  const { data, error } = await scoped(args.tenant_id)
    .from(TABLE)
    .update({
      attempts: args.attempts + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("pending_decision_id", args.pending_decision_id)
    .eq("status", "pending")
    .select("pending_decision_id")
    .maybeSingle();
  if (error) throw new Error(`bumpAttemptForRetry failed: ${error.message}`);
  return !!data;
}

export async function resetResolvingForRetry(args: {
  pending_decision_id: string;
  tenant_id: string;
  attempts: number;
}): Promise<boolean> {
  const { data, error } = await scoped(args.tenant_id)
    .from(TABLE)
    .update({
      status: "pending" as ReviewStatus,
      attempts: args.attempts + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("pending_decision_id", args.pending_decision_id)
    .eq("status", "resolving")
    .is("final_decision_id", null)
    .select("pending_decision_id")
    .maybeSingle();
  if (error) throw new Error(`resetResolvingForRetry failed: ${error.message}`);
  return !!data;
}

export async function getParkedDecision(
  pendingDecisionId: string,
  tenantId: string,
): Promise<ParkedDecision | null> {
  const { data, error } = await scoped(tenantId)
    .from("decisions")
    .select("id, tenant_id, decision_class, body, agent_run_id, status")
    .eq("id", pendingDecisionId)
    .maybeSingle();
  if (error) throw new Error(`getParkedDecision failed: ${error.message}`);
  return (data ?? null) as ParkedDecision | null;
}

export type StuckReviewDbRow = {
  pending_decision_id: string;
  tenant_id: string;
  status: "pending" | "resolving";
  attempts: number;
  review_run_id: string | null;
  final_decision_id: string | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
};

export async function listStuckReviews(
  graceCutoffIso: string,
  limit = 50,
): Promise<StuckReviewDbRow[]> {
  const { data, error } = await staffCrossTenantClient("strategist review sweep scans stale non-terminal rows across tenants")
    .from(TABLE)
    .select(
      "pending_decision_id, tenant_id, status, attempts, review_run_id, final_decision_id, claimed_at, created_at, updated_at",
    )
    .in("status", ["pending", "resolving"])
    .lt("updated_at", graceCutoffIso)
    .limit(limit);
  if (error) throw new Error(`listStuckReviews failed: ${error.message}`);
  return (data ?? []) as StuckReviewDbRow[];
}

export async function listFailedNeedingHeal(
  recentCutoffIso: string,
  limit = 50,
): Promise<StuckReviewDbRow[]> {
  const { data, error } = await staffCrossTenantClient(
    "strategist review sweep self-heals failed rows that a slow resolver later produced a create for",
  )
    .from(TABLE)
    .select(
      "pending_decision_id, tenant_id, status, attempts, review_run_id, final_decision_id, claimed_at, created_at, updated_at",
    )
    .eq("status", "failed")
    .is("final_decision_id", null)
    .gt("updated_at", recentCutoffIso)
    .limit(limit);
  if (error) throw new Error(`listFailedNeedingHeal failed: ${error.message}`);
  return (data ?? []) as StuckReviewDbRow[];
}

export const reviewStateDeps = {
  claimForResolve,
  getParkedDecision,
  findExistingFinalCreate: findFinalCreateFor,
  finalizeApproved,
  finalizeBounced,
  recoverApproved,
  supersedeFailureNotice,
  releaseClaim,
};
