
import { serviceClient } from "@/services/supabase";

export type CronRunOutcome =
  | "produced_decision"
  | "produced_note"
  | "produced_artifact"
  | "empty"
  | "failed";

export const SUCCESS_STATUSES: ReadonlySet<string> = new Set(["success"]);

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "success",
  "parse_failed",
  "dispatch_error",
  "error",
  "failed",
]);

export const SIDE_EFFECT_STAGES: ReadonlySet<string> = new Set([
  "tool_use_completed",
]);

export type OutcomeCounts = {
  status: string;
  decisionCount: number;
  noteCount: number;
  sideEffectCount: number;
};

export function classifyOutcomeFromCounts(
  c: OutcomeCounts,
): CronRunOutcome | null {
  const status = c.status;

  if (!TERMINAL_STATUSES.has(status)) return null;

  if (!SUCCESS_STATUSES.has(status)) return "failed";

  if (c.decisionCount > 0) return "produced_decision";
  if (c.noteCount > 0) return "produced_note";
  if (c.sideEffectCount > 0) return "produced_artifact";

  return "empty";
}

export function isSucceededButEmpty(outcome: CronRunOutcome | null): boolean {
  return outcome === "empty";
}

export type OutcomeRollup = {
  count: number;
  by_class: Record<CronRunOutcome, number>;
  empty_rate: number;
  fail_rate: number;
  productive_rate: number;
};

export function rollupOutcomes(
  outcomes: ReadonlyArray<CronRunOutcome | null>,
): OutcomeRollup {
  const by_class: Record<CronRunOutcome, number> = {
    produced_decision: 0,
    produced_note: 0,
    produced_artifact: 0,
    empty: 0,
    failed: 0,
  };
  let count = 0;
  for (const o of outcomes) {
    if (o == null) continue;
    by_class[o] += 1;
    count += 1;
  }
  const rate = (n: number) => (count === 0 ? 0 : n / count);
  const productive =
    by_class.produced_decision +
    by_class.produced_note +
    by_class.produced_artifact;
  return {
    count,
    by_class,
    empty_rate: rate(by_class.empty),
    fail_rate: rate(by_class.failed),
    productive_rate: rate(productive),
  };
}

export async function classifyCronRunOutcome(
  run_id: string,
): Promise<CronRunOutcome | null> {
  const counts = await fetchOutcomeCounts(run_id);
  if (counts == null) return null;
  return classifyOutcomeFromCounts(counts);
}

const AGENT_NOTE_SOURCES = [
  "agent_run",
  "auto_distill_agent_run",
] as const;

export async function fetchOutcomeCounts(
  run_id: string,
): Promise<OutcomeCounts | null> {
  const sb = serviceClient();

  const runRes = await sb
    .from("agent_runs")
    .select("status")
    .eq("id", run_id)
    .maybeSingle();
  if (runRes.error) {
    throw new Error(`cron-outcome: agent_runs read failed: ${runRes.error.message}`);
  }
  const runRow = runRes.data as { status?: string } | null;
  if (!runRow || typeof runRow.status !== "string") return null;

  const [decRes, noteRes, evtRes] = await Promise.all([
    sb
      .from("decisions")
      .select("id", { head: true, count: "exact" })
      .eq("agent_run_id", run_id),
    sb
      .from("memory_note")
      .select("id", { head: true, count: "exact" })
      .eq("source_ref", run_id)
      .in("source", AGENT_NOTE_SOURCES as unknown as string[]),
    sb
      .from("agent_run_events")
      .select("id", { head: true, count: "exact" })
      .eq("agent_run_id", run_id)
      .in("stage", Array.from(SIDE_EFFECT_STAGES)),
  ]);

  if (decRes.error)
    throw new Error(`cron-outcome: decisions read failed: ${decRes.error.message}`);
  if (noteRes.error)
    throw new Error(`cron-outcome: memory_note read failed: ${noteRes.error.message}`);
  if (evtRes.error)
    throw new Error(`cron-outcome: agent_run_events read failed: ${evtRes.error.message}`);

  return {
    status: runRow.status,
    decisionCount: decRes.count ?? 0,
    noteCount: noteRes.count ?? 0,
    sideEffectCount: evtRes.count ?? 0,
  };
}

export type RollupOptions = {
  limit?: number;
};

export async function rollupCronOutcomes(
  tenant_id: string,
  agent_slug: string,
  opts: RollupOptions = {},
): Promise<OutcomeRollup> {
  const limit = opts.limit ?? 30;
  const sb = serviceClient();

  const runsRes = await sb
    .from("agent_runs")
    .select("id")
    .eq("tenant_id", tenant_id)
    .eq("agent_slug", agent_slug)
    .eq("trigger", "cron")
    .order("enqueued_at", { ascending: false })
    .limit(limit);
  if (runsRes.error) {
    throw new Error(`cron-outcome rollup: agent_runs read failed: ${runsRes.error.message}`);
  }
  const runIds = ((runsRes.data ?? []) as Array<{ id: string }>).map((r) => r.id);

  const outcomes = await Promise.all(
    runIds.map((id) => classifyCronRunOutcome(id)),
  );
  return rollupOutcomes(outcomes);
}
