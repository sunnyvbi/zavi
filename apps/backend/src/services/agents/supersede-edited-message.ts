import type { SupabaseClient } from "@supabase/supabase-js";
import { requestStopForRun } from "./request-stop";

export type SupersedeResult = {
  superseded: boolean;
  stopped_run_id: string | null;
};

export async function supersedeEditedMessage(
  sc: SupabaseClient,
  args: {
    tenant_id: string;
    thread_id: string;
    original_message_id: string;
    new_message_id: string;
  },
): Promise<SupersedeResult> {
  const { tenant_id, thread_id, original_message_id, new_message_id } = args;
  const none: SupersedeResult = { superseded: false, stopped_run_id: null };
  if (!tenant_id || !thread_id || !original_message_id || !new_message_id) {
    return none;
  }
  if (original_message_id === new_message_id) return none;

  const { data: original, error: rerr } = await sc
    .from("agent_thread_messages")
    .select("id, sender_role, thread_id, meta, agent_run_id, created_at")
    .eq("id", original_message_id)
    .eq("tenant_id", tenant_id)
    .eq("thread_id", thread_id)
    .maybeSingle();
  if (rerr) throw rerr;
  if (!original) return none;
  if (original.sender_role !== "user") return none;
  const meta = (original.meta ?? {}) as Record<string, unknown>;
  if (typeof meta.superseded_by === "string" && meta.superseded_by) {
    return {
      superseded: meta.superseded_by === new_message_id,
      stopped_run_id: null,
    };
  }

  const { data: replacement, error: replacementError } = await sc
    .from("agent_thread_messages")
    .select("created_at")
    .eq("id", new_message_id)
    .eq("tenant_id", tenant_id)
    .eq("thread_id", thread_id)
    .maybeSingle();
  if (replacementError) throw replacementError;
  if (!replacement) return none;

  const superseded_at = new Date().toISOString();
  const { error: uerr } = await sc
    .from("agent_thread_messages")
    .update({
      meta: { ...meta, superseded_by: new_message_id, superseded_at },
    })
    .eq("id", original_message_id)
    .eq("tenant_id", tenant_id);
  if (uerr) throw uerr;

  let stopped_run_id: string | null = null;
  const { data: runs, error: runsError } = await sc
    .from("agent_runs")
    .select("id, status")
    .eq("tenant_id", tenant_id)
    .filter("payload->>user_message_id", "eq", original_message_id)
    .order("enqueued_at", { ascending: false })
    .limit(1);
  if (runsError) throw runsError;
  const run = Array.isArray(runs) ? runs[0] : undefined;
  if (run?.id) {
    const runId = run.id as string;
    const stop = await requestStopForRun(sc, tenant_id, runId);
    if (!stop.ok) throw new Error(stop.error);
    if ("cancelling" in stop && stop.cancelling) stopped_run_id = runId;
    const { data: replies, error: repliesError } = await sc
      .from("agent_thread_messages")
      .select("id, meta")
      .eq("tenant_id", tenant_id)
      .eq("thread_id", thread_id)
      .eq("agent_run_id", runId)
      .eq("sender_role", "assistant");
    if (repliesError) throw repliesError;
    for (const reply of (replies ?? []) as Array<{
      id: string;
      meta: unknown;
    }>) {
      const rmeta = (reply.meta ?? {}) as Record<string, unknown>;
      const { error: replyError } = await sc
        .from("agent_thread_messages")
        .update({
          meta: { ...rmeta, superseded_by: new_message_id, superseded_at },
        })
        .eq("id", reply.id)
        .eq("tenant_id", tenant_id);
      if (replyError) throw replyError;
    }
  }

  const { data: later, error: laterError } = await sc
    .from("agent_thread_messages")
    .select("id, meta, sender_role, agent_run_id")
    .eq("tenant_id", tenant_id)
    .eq("thread_id", thread_id)
    .gt("created_at", original.created_at as string)
    .lt("created_at", replacement.created_at as string)
    .filter("meta->>superseded_by", "is", null);
  if (laterError) throw laterError;
  const laterRows = (later ?? []) as Array<{
    id: string;
    meta: unknown;
    sender_role: string;
    agent_run_id: string | null;
  }>;
  for (const row of laterRows) {
    const lmeta = (row.meta ?? {}) as Record<string, unknown>;
    const { error: laterUpdateError } = await sc
      .from("agent_thread_messages")
      .update({
        meta: { ...lmeta, superseded_by: new_message_id, superseded_at },
      })
      .eq("id", row.id)
      .eq("tenant_id", tenant_id);
    if (laterUpdateError) throw laterUpdateError;
  }
  const laterUserRows = laterRows.filter((row) => row.sender_role === "user");
  const laterRunIds = new Set(
    laterUserRows
      .filter((row) => row.agent_run_id)
      .map((row) => row.agent_run_id as string),
  );
  if (laterUserRows.length > 0) {
    const { data: linkedRuns, error: linkedRunsError } = await sc
      .from("agent_runs")
      .select("id")
      .eq("tenant_id", tenant_id)
      .in("status", ["queued", "running"])
      .in(
        "payload->>user_message_id",
        laterUserRows.map((row) => row.id),
      );
    if (linkedRunsError) throw linkedRunsError;
    for (const r of (linkedRuns ?? []) as Array<{ id: string }>) {
      laterRunIds.add(r.id);
    }
  }
  for (const runId of laterRunIds) {
    const stop = await requestStopForRun(sc, tenant_id, runId);
    if (!stop.ok) throw new Error(stop.error);
    if ("cancelling" in stop && stop.cancelling && !stopped_run_id) {
      stopped_run_id = runId;
    }
  }

  return { superseded: true, stopped_run_id };
}
