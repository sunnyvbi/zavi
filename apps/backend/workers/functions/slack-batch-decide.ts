
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { captureAdminCorrection } from "@/services/staff/capture-admin-correction";
import {
  approveBatch,
  rejectBatch,
  neverAutoSlugSet,
  type DecisionMeta,
  type DecisionMetaLoader,
  type RejectCapture,
} from "@/services/approvals/batch-decide-service";

function metaLoader(tenant_id: string): DecisionMetaLoader {
  return async (ids) => {
    const map = new Map<string, DecisionMeta>();
    if (ids.length === 0) return { ok: true, meta: map };
    const svc = serviceClient();
    const { data, error } = await svc
      .from("decisions")
      .select("id, decision_class, handler, autonomy_at_emit")
      .eq("tenant_id", tenant_id)
      .in("id", ids);
    if (error) return { ok: false, error: error.message };
    const { data: naData, error: naErr } = await svc
      .from("decision_classes")
      .select("slug")
      .eq("never_auto", true);
    if (naErr) return { ok: false, error: naErr.message };
    const neverAuto = neverAutoSlugSet((naData ?? []) as Array<{ slug?: unknown }>);
    for (const row of (data ?? []) as Array<{
      id: string;
      decision_class: string | null;
      handler: string | null;
      autonomy_at_emit: string | null;
    }>) {
      map.set(row.id, {
        decision_class: row.decision_class,
        handler: row.handler,
        autonomy_at_emit: row.autonomy_at_emit,
        never_auto: row.decision_class ? neverAuto.has(row.decision_class) : false,
      });
    }
    return { ok: true, meta: map };
  };
}

function rejectCapture(tenant_id: string, actor_user_id: string): RejectCapture {
  return async (decision_id) => {
    const { data: dec } = await serviceClient()
      .from("decisions")
      .select("decision_class")
      .eq("id", decision_id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    const decision_class = (dec as { decision_class?: string } | null)?.decision_class;
    if (!decision_class) return;
    await captureAdminCorrection({
      tenant_id,
      decision_id,
      decision_class,
      actor: { user_id: actor_user_id },
      actor_kind: "customer",
      action: "reject",
      reason: null,
    });
  };
}

function postSummary(responseUrl: string | null | undefined, text: string): void {
  if (!responseUrl) return;
  void fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ replace_original: false, text }),
  }).catch((e) =>
    console.warn(`[slack-batch-decide] response_url update failed: ${(e as Error).message}`),
  );
}

type BatchDecideEvent = {
  tenant_id: string;
  run_id: string;
  actor_user_id: string;
  action: "approve" | "reject";
  cutoff_ms: number;
  response_url: string | null;
};

export async function runSlackBatchDecide(data: BatchDecideEvent): Promise<{
  total: number;
  applied: number;
  skipped: number;
  errored: number;
}> {
  const { tenant_id, run_id, actor_user_id, action, cutoff_ms, response_url } = data;
  const svc = serviceClient();

  let q = svc
    .from("decisions")
    .select("id")
    .eq("tenant_id", tenant_id)
    .eq("agent_run_id", run_id)
    .eq("status", "proposed")
    .eq("autonomy_at_emit", "approval")
    .limit(200);
  if (cutoff_ms > 0) q = q.lte("emitted_at", new Date(cutoff_ms).toISOString());

  const { data: rows, error } = await q;
  if (error) {
    console.warn(`[slack-batch-decide] id re-derive failed for run ${run_id}: ${error.message}`);
    postSummary(response_url, "Couldn't read the pending approvals — nothing changed. Try again.");
    return { total: 0, applied: 0, skipped: 0, errored: 0 };
  }
  const ids = ((rows ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (ids.length === 0) {
    postSummary(response_url, "ℹ️ Nothing left to act on — these were already handled.");
    return { total: 0, applied: 0, skipped: 0, errored: 0 };
  }

  if (action === "approve") {
    const res = await approveBatch({
      decision_ids: ids,
      tenant_id,
      actor_user_id,
      loadMeta: metaLoader(tenant_id),
    });
    if (res.aborted) {
      postSummary(response_url, "Couldn't verify which are safe to bulk-approve — nothing approved. Try again.");
      return { total: res.total, applied: 0, skipped: 0, errored: res.total };
    }
    const applied = res.approved ?? 0;
    const skippedNote = res.skipped > 0 ? ` ${res.skipped} skipped (money/customer-facing — approve individually).` : "";
    const errNote = res.errored > 0 ? ` ${res.errored} errored.` : "";
    postSummary(response_url, `✅ Approved ${applied} via Slack.${skippedNote}${errNote}`);
    return { total: res.total, applied, skipped: res.skipped, errored: res.errored };
  }

  const res = await rejectBatch({
    decision_ids: ids,
    tenant_id,
    actor_user_id,
    captureReject: rejectCapture(tenant_id, actor_user_id),
  });
  const applied = res.rejected ?? 0;
  const errNote = res.errored > 0 ? ` ${res.errored} errored.` : "";
  postSummary(response_url, `✅ Rejected ${applied} via Slack.${errNote}`);
  return { total: res.total, applied, skipped: res.skipped, errored: res.errored };
}

export const slackBatchDecideFn = inngest.createFunction(
  { id: "slack-batch-decide", retries: 1, concurrency: 4 },
  { event: "slack.batch.decide" },
  async ({ event, step, logger }) => {
    const res = await step.run("batch-decide", () => runSlackBatchDecide(event.data as BatchDecideEvent));
    logger?.info?.(`slack-batch-decide ${(event.data as BatchDecideEvent).run_id}: ${JSON.stringify(res)}`);
    return res;
  },
);
