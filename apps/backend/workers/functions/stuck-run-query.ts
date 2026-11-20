
import type { SupabaseClient } from "@supabase/supabase-js";
import { INTERACTIVE_TRIGGERS } from "@/services/agents/run-lane";

export type StuckRunRow = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  trigger: string;
  started_at: string | null;
  last_progress_at: string | null;
  payload: unknown;
  batch_id: string | null;
  child_index: number | null;
  infra_retry_count?: number | null;
  worker_id?: string | null;
};

const SELECT_COLS =
  "id, tenant_id, agent_slug, trigger, started_at, last_progress_at, payload, batch_id, child_index, infra_retry_count, worker_id";

export function buildStaleOrHardCapFilter(
  staleCutoff: string,
  hardCapCutoff: string,
): string {
  return [
    `and(last_progress_at.not.is.null,last_progress_at.lt.${staleCutoff})`,
    `and(last_progress_at.is.null,started_at.not.is.null,started_at.lt.${staleCutoff})`,
    `and(started_at.not.is.null,started_at.lt.${hardCapCutoff})`,
    `and(started_at.is.null,last_progress_at.not.is.null,last_progress_at.lt.${hardCapCutoff})`,
  ].join(",");
}

export async function fetchChatBucketStuckRows(
  svc: SupabaseClient,
  chatStaleCutoff: string,
  hardCapCutoff: string,
): Promise<{ rows: StuckRunRow[]; error: { message: string } | null }> {
  const { data, error } = await svc
    .from("agent_runs")
    .select(SELECT_COLS)
    .eq("status", "running")
    .in("trigger", [...INTERACTIVE_TRIGGERS])
    .is("batch_id", null)
    .or(buildStaleOrHardCapFilter(chatStaleCutoff, hardCapCutoff));
  return { rows: (data ?? []) as StuckRunRow[], error };
}

export async function fetchNonChatBucketStuckRows(
  svc: SupabaseClient,
  nonchatStaleCutoff: string,
  hardCapCutoff: string,
): Promise<{ rows: StuckRunRow[]; error: { message: string } | null }> {
  const { data, error } = await svc
    .from("agent_runs")
    .select(SELECT_COLS)
    .eq("status", "running")
    .or(`trigger.not.in.(${INTERACTIVE_TRIGGERS.join(",")}),batch_id.not.is.null`)
    .or(buildStaleOrHardCapFilter(nonchatStaleCutoff, hardCapCutoff));
  return { rows: (data ?? []) as StuckRunRow[], error };
}
