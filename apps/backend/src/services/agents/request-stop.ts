
import type { SupabaseClient } from "@supabase/supabase-js";

export type RequestStopResult =
  | { ok: true; cancelling: true }
  | { ok: true; already_terminal: true }
  | { ok: false; error: string };

export async function requestStopForRun(
  sc: SupabaseClient,
  tenant_id: string,
  run_id: string,
): Promise<RequestStopResult> {
  if (!tenant_id || !run_id) {
    return { ok: false, error: "tenant_id and run_id are required" };
  }

  let cancelling = false;

  const { data: qd, error: qErr } = await sc
    .from("agent_runs")
    .update({
      stop_requested: true,
      status: "cancelled",
      finished_at: new Date().toISOString(),
      needs_run_end_emit: true,
    })
    .eq("id", run_id)
    .eq("tenant_id", tenant_id)
    .eq("status", "queued")
    .select("id");
  if (qErr) return { ok: false, error: qErr.message };
  cancelling = Array.isArray(qd) && qd.length > 0;

  if (!cancelling) {
    const { data: rd, error: rErr } = await sc
      .from("agent_runs")
      .update({ stop_requested: true })
      .eq("id", run_id)
      .eq("tenant_id", tenant_id)
      .eq("status", "running")
      .select("id");
    if (rErr) return { ok: false, error: rErr.message };
    cancelling = Array.isArray(rd) && rd.length > 0;
  }

  if (!cancelling) return { ok: true, already_terminal: true };
  return { ok: true, cancelling: true };
}
