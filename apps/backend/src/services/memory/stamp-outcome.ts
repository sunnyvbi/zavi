
import { serviceClient } from "../supabase";
import { aggregateRunOutcome, type NoteOutcome } from "./outcome-aggregate";
import { decisionVerdict } from "../decisions/status";

const TERMINAL_STATUSES = ["acted", "rejected"];
const PAGE_SIZE = 500;

type Sb = ReturnType<typeof serviceClient>;

async function applyRunOutcome(
  sb: Sb,
  runId: string,
  tenant_id: string,
  outcome: NoteOutcome,
  nowIso: string,
): Promise<{ episodeStamped: boolean; notes: number }> {
  let episodeStamped = false;
  let notes = 0;

  const { data: updated, error: msErr } = await sb
    .from("memory_signal")
    .update({ outcome })
    .eq("tenant_id", tenant_id)
    .eq("agent_run_id", runId)
    .eq("signal_kind", "episode")
    .is("outcome", null)
    .select("id");
  if (msErr) {
    console.warn(`[outcome-stamp] episode stamp ${runId} failed: ${msErr.message}`);
    return { episodeStamped, notes };
  }
  if (updated && updated.length > 0) episodeStamped = true;

  const { data: noteRows, error: nSelErr } = await sb
    .from("memory_note")
    .select("id, metadata")
    .eq("tenant_id", tenant_id)
    .eq("source_ref", runId);
  if (nSelErr) {
    console.warn(`[outcome-stamp] note scan ${runId} failed: ${nSelErr.message}`);
    return { episodeStamped, notes };
  }
  for (const n of (noteRows ?? []) as Array<{ id: string; metadata: Record<string, unknown> | null }>) {
    if (n.metadata?.outcome === outcome) continue;
    const merged = { ...(n.metadata ?? {}), outcome, outcome_at: nowIso };
    const { error: nErr } = await sb
      .from("memory_note")
      .update({ metadata: merged })
      .eq("id", n.id)
      .eq("tenant_id", tenant_id);
    if (!nErr) notes += 1;
  }
  return { episodeStamped, notes };
}

export async function stampOutcomeForRun(
  runId: string,
  tenant_id: string,
): Promise<{ episodeStamped: boolean; notes: number }> {
  const sb = serviceClient();
  const { data: decisions, error } = await sb
    .from("decisions")
    .select("status, dispatch_error, body")
    .eq("agent_run_id", runId)
    .eq("tenant_id", tenant_id)
    .in("status", TERMINAL_STATUSES);
  if (error || !decisions || decisions.length === 0) return { episodeStamped: false, notes: 0 };
  const outcome = aggregateRunOutcome(
    (
      decisions as Array<{
        status: string;
        dispatch_error?: string | null;
        body?: Record<string, unknown> | null;
      }>
    )
      .filter((d) => decisionVerdict(d) !== null)
      .map((d) => (decisionVerdict(d) === "accepted" ? "acted" : "rejected")),
  );
  if (!outcome) return { episodeStamped: false, notes: 0 };
  return applyRunOutcome(sb, runId, tenant_id, outcome, new Date().toISOString());
}

export async function stampOutcomeForDecision(
  decisionId: string,
  tenant_id: string,
): Promise<{ episodeStamped: boolean; notes: number }> {
  const { data, error } = await serviceClient()
    .from("decisions")
    .select("agent_run_id")
    .eq("id", decisionId)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  const runId = (data as { agent_run_id: string | null } | null)?.agent_run_id;
  if (error || !runId) return { episodeStamped: false, notes: 0 };
  return stampOutcomeForRun(runId, tenant_id);
}

export async function stampOutcomeForDecisionId(
  decisionId: string,
): Promise<{ episodeStamped: boolean; notes: number }> {
  const { data, error } = await serviceClient()
    .from("decisions")
    .select("agent_run_id, tenant_id")
    .eq("id", decisionId)
    .maybeSingle();
  const row = data as { agent_run_id: string | null; tenant_id: string | null } | null;
  if (error || !row?.agent_run_id || !row.tenant_id) return { episodeStamped: false, notes: 0 };
  return stampOutcomeForRun(row.agent_run_id, row.tenant_id);
}

export async function stampOutcomes(): Promise<{ runs: number; notes: number }> {
  const sb = serviceClient();

  const { data: decisions, error: dErr } = await sb
    .from("decisions")
    .select("agent_run_id, tenant_id, status")
    .in("status", TERMINAL_STATUSES)
    .not("agent_run_id", "is", null)
    .order("emitted_at", { ascending: false })
    .limit(PAGE_SIZE);
  if (dErr) {
    console.warn(`[outcome-stamp] decisions scan failed: ${dErr.message}`);
    return { runs: 0, notes: 0 };
  }
  if (!decisions || decisions.length === 0) return { runs: 0, notes: 0 };

  const byRun = new Map<string, { tenant_id: string; statuses: string[] }>();
  for (const d of decisions as Array<{ agent_run_id: string; tenant_id: string; status: string }>) {
    const cur = byRun.get(d.agent_run_id) ?? { tenant_id: d.tenant_id, statuses: [] };
    cur.statuses.push(d.status);
    byRun.set(d.agent_run_id, cur);
  }

  let runs = 0;
  let notes = 0;
  const nowIso = new Date().toISOString();
  for (const [runId, { tenant_id, statuses }] of byRun) {
    const outcome = aggregateRunOutcome(statuses);
    if (!outcome) continue;
    const res = await applyRunOutcome(sb, runId, tenant_id, outcome, nowIso);
    if (res.episodeStamped) runs += 1;
    notes += res.notes;
  }
  return { runs, notes };
}
