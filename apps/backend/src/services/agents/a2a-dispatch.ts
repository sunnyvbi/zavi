
import { serviceClient } from "@/services/supabase";
import { writeNote } from "@/services/memory";
import { enqueueAgentRun, InsufficientCreditsError } from "@/services/agents/runner";
import { StaffModelCapError, STAFF_MODEL_CAP_MESSAGE } from "@/services/agents/staff-model-inherit";
import { asPlanUpgradeRequired, type Tier } from "@/services/billing/tiers";
import { logDecisionNotTaken } from "@/services/agents/log-decision-not-taken";
import {
  checkDelegationAllowed,
  recordDelegation,
  buildChildLineagePayload,
  type LineageContext,
} from "@/services/agents/delegation-guard";

const DEFAULT_DEDUP_WINDOW_HOURS = 24;

export type A2ADispatchInput = {
  tenant_id: string;
  source_agent_slug: string;
  source_run_id: string;
  target_agent_slug: string;
  payload: Record<string, unknown>;
  dedup_key: string;
  lineage_key: string | null;
  dedup_window_hours?: number;
  note?: { title: string; body_markdown: string; tags?: string[] };
  delegation_guard?: { parentLineage: LineageContext };
};

export type A2ADispatchResult =
  | { ok: true; child_run_id: string }
  | {
      ok: false;
      reason:
        | "deduped"
        | "enqueue_failed"
        | "insufficient_credits"
        | "plan_upgrade_required"
        | "depth_exceeded"
        | "cycle_detected"
        | "cost_ceiling_exceeded"
        | "lookup_failed"
        | "staff_model_cap";
      escalate?: boolean;
      error?: string;
      required_tier?: Tier;
    };

export async function a2aDispatch(input: A2ADispatchInput): Promise<A2ADispatchResult> {
  const sb = serviceClient();
  const windowHours = input.dedup_window_hours ?? DEFAULT_DEDUP_WINDOW_HOURS;
  const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();

  const logRefusal = (
    reason_code: string,
    rejection_type: "dedup_suppressed_24h" | "condition_unmet" | "cap_exceeded",
  ) =>
    logDecisionNotTaken({
      tenant_id: input.tenant_id,
      agent_run_id: input.source_run_id,
      agent_slug: input.source_agent_slug,
      decision_class: "a2a.dispatch",
      rejection_type,
      reason_code,
    });

  const { data: existing, error: dedupErr } = await sb
    .from("dispatch_history")
    .select("id")
    .eq("tenant_id", input.tenant_id)
    .eq("dedup_key", input.dedup_key)
    .gt("created_at", since)
    .limit(1)
    .maybeSingle();
  if (dedupErr) {
    console.warn(`[a2a-dispatch] dedup lookup failed for ${input.dedup_key}: ${dedupErr.message}`);
  }
  if (existing) {
    await logRefusal("deduped", "dedup_suppressed_24h");
    return { ok: false, reason: "deduped" };
  }

  let guardedPayload = input.payload;
  let guardLineage: { lineage_id: string; childDepth: number } | null = null;
  if (input.delegation_guard) {
    const guard = await checkDelegationAllowed({
      tenant_id: input.tenant_id,
      parentLineage: input.delegation_guard.parentLineage,
      source_agent_slug: input.source_agent_slug,
      target_agent_slug: input.target_agent_slug,
    });
    if (!guard.ok) {
      await logRefusal(guard.reason, "condition_unmet");
      return { ok: false, reason: guard.reason, escalate: guard.escalate };
    }
    guardLineage = { lineage_id: guard.lineage_id, childDepth: guard.childDepth };
    guardedPayload = buildChildLineagePayload(input.payload, guardLineage);
  }

  let child_run_id = "";
  try {
    const enq = await enqueueAgentRun({
      tenant_id: input.tenant_id,
      agent_slug: input.target_agent_slug,
      trigger: "a2a",
      payload: guardedPayload as object,
      parent_run_id: input.source_run_id,
    });
    if (!enq.run_id) {
      await logRefusal("enqueue_failed", "condition_unmet");
      return { ok: false, reason: "enqueue_failed" };
    }
    child_run_id = enq.run_id;
  } catch (e) {
    if (e instanceof StaffModelCapError) {
      await logRefusal("staff_model_cap", "cap_exceeded");
      return { ok: false, reason: "staff_model_cap", error: STAFF_MODEL_CAP_MESSAGE };
    }
    const planRefusal = asPlanUpgradeRequired(e);
    if (planRefusal) {
      await logRefusal("plan_upgrade_required", "condition_unmet");
      return {
        ok: false,
        reason: "plan_upgrade_required",
        required_tier: planRefusal.required_tier,
        error: planRefusal.message,
      };
    }
    if (e instanceof InsufficientCreditsError) {
      await logRefusal("insufficient_credits", "cap_exceeded");
      return { ok: false, reason: "insufficient_credits", error: (e as Error).message };
    }
    await logRefusal("enqueue_failed", "condition_unmet");
    return { ok: false, reason: "enqueue_failed", error: (e as Error).message };
  }

  if (guardLineage) {
    await recordDelegation({
      tenant_id: input.tenant_id,
      lineage_id: guardLineage.lineage_id,
      depth: guardLineage.childDepth,
      parent_run_id: input.source_run_id,
      child_run_id,
      source_agent_slug: input.source_agent_slug,
      target_agent_slug: input.target_agent_slug,
    });
  }

  const { error: insErr } = await sb.from("dispatch_history").insert({
    tenant_id: input.tenant_id,
    source_agent_slug: input.source_agent_slug,
    source_run_id: input.source_run_id,
    target_agent_slug: input.target_agent_slug,
    target_run_id: child_run_id,
    dedup_key: input.dedup_key,
    lineage_key: input.lineage_key,
  });
  if (insErr) {
    console.warn(`[a2a-dispatch] dispatch_history insert failed for ${input.dedup_key}: ${insErr.message}`);
  }

  if (input.note) {
    try {
      await writeNote(input.tenant_id, {
        title: input.note.title,
        body_markdown: input.note.body_markdown,
        source: "agent_run",
        source_ref: `dispatch_history:${input.dedup_key}`,
        note_type: "agent_experience",
        agent_slug: input.source_agent_slug,
        dedup_key: input.dedup_key,
        tags: input.note.tags ?? [
          `source-agent:${input.source_agent_slug}`,
          `target-agent:${input.target_agent_slug}`,
        ],
      });
    } catch (e) {
      console.warn(`[a2a-dispatch] writeNote failed: ${(e as Error).message}`);
    }
  }

  return { ok: true, child_run_id };
}

export async function countLineageBounces(input: {
  tenant_id: string;
  lineage_key: string;
  source_agent_slug: string;
  target_agent_slug: string;
}): Promise<number> {
  const sb = serviceClient();
  const { count, error } = await sb
    .from("dispatch_history")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", input.tenant_id)
    .eq("lineage_key", input.lineage_key)
    .eq("source_agent_slug", input.source_agent_slug)
    .eq("target_agent_slug", input.target_agent_slug);
  if (error) {
    console.warn(
      `[a2a-dispatch] lineage count failed for ${input.lineage_key}: ${error.message} — failing closed (cap reached)`,
    );
    return Number.POSITIVE_INFINITY;
  }
  return count ?? 0;
}
