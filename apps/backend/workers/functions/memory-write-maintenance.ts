
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { finishPendingNote, searchMemory } from "@/services/memory";
import { purgeForgetRequest } from "@/services/memory/remembered";
import {
  ABSTENTION_PROBES,
  scoreAbstention,
  scoreKnowledgeUpdate,
} from "@/services/memory/write-canary";
import { logReview } from "@/services/logging/log-review";

const PURGE_SWEEP_LIMIT = 200;
const ENRICH_SWEEP_LIMIT = 100;
const ENRICH_MIN_AGE_MS = 5 * 60 * 1000;
const TASK_CARD_TTL_DAYS = 30;
const LOG_RETENTION_DAYS = 90;
const DELETE_BATCH = 500;
const MAX_DELETE_BATCHES = 20;
const CANARY_MAX_TENANTS = 200;
const CANARY_UPDATES_PER_TENANT = 3;
const PROPOSAL_REQUEUE_AFTER_MS = 60 * 60 * 1000;
const PROPOSAL_EXPIRE_AFTER_MS = 24 * 60 * 60 * 1000;
const PROPOSAL_SWEEP_LIMIT = 200;
const UNSETTLED_RUN_STATUSES: ReadonlySet<string> = new Set([
  "paused_awaiting_approval",
  "paused_awaiting_child",
  "queued",
  "running",
]);

function daysAgo(d: number): string {
  return new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
}

export async function sweepDueForgets(): Promise<{ purged: number; retry: number }> {
  const { data, error } = await serviceClient()
    .from("memory_forget_request")
    .select("id, tenant_id")
    .or("state.eq.pending,and(state.eq.purged,resolved_at.is.null)")
    .lte("purge_after", new Date().toISOString())
    .order("purge_after", { ascending: true })
    .limit(PURGE_SWEEP_LIMIT);
  if (error) throw new Error(`forget sweep read failed: ${error.message}`);
  let purged = 0;
  let retry = 0;
  for (const r of (data ?? []) as Array<{ id: string; tenant_id: string }>) {
    const out = await purgeForgetRequest(r.tenant_id, r.id);
    if (out === "purged") purged += 1;
    else if (out === "retry") retry += 1;
  }
  return { purged, retry };
}

export async function sweepPendingEnrichment(): Promise<{ done: number; pending: number; failed: number }> {
  const { data, error } = await serviceClient()
    .from("memory_note")
    .select("id, tenant_id")
    .eq("enrichment_state", "pending")
    .lt("updated_at", new Date(Date.now() - ENRICH_MIN_AGE_MS).toISOString())
    .order("updated_at", { ascending: true })
    .limit(ENRICH_SWEEP_LIMIT);
  if (error) throw new Error(`enrichment sweep read failed: ${error.message}`);
  const counts = { done: 0, pending: 0, failed: 0 };
  for (const n of (data ?? []) as Array<{ id: string; tenant_id: string }>) {
    try {
      const out = await finishPendingNote(n.tenant_id, n.id);
      if (out === "done" || out === "pending" || out === "failed") counts[out] += 1;
    } catch (e) {
      counts.pending += 1;
      console.warn(`[memory-enrichment-retry] ${n.id}: ${(e as Error).message}`);
    }
  }
  if (counts.failed > 0) {
    logReview({
      feature: "memory_write",
      event: "enrichment",
      outcome: "failed",
      run_id: `enrichment-sweep:${new Date().toISOString().slice(0, 13)}`,
      meta: { failed: counts.failed },
    });
  }
  return counts;
}

export async function sweepPendingProposals(): Promise<{ expired: number; requeued_runs: number }> {
  const sb = serviceClient();
  const now = Date.now();
  const expireBefore = new Date(now - PROPOSAL_EXPIRE_AFTER_MS).toISOString();

  const { data: oldData, error: oldErr } = await sb
    .from("memory_write_log")
    .select("id, tenant_id")
    .eq("action", "proposed")
    .is("decided_at", null)
    .lt("created_at", expireBefore)
    .order("created_at", { ascending: true })
    .limit(PROPOSAL_SWEEP_LIMIT);
  if (oldErr) throw new Error(`proposal expiry read failed: ${oldErr.message}`);
  const expiredIds = ((oldData ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (expiredIds.length > 0) {
    const { error } = await sb.from("memory_write_log").update({ action: "proposal_expired" }).in("id", expiredIds);
    if (error) throw new Error(`proposal expiry write failed: ${error.message}`);
    logReview({
      feature: "memory_write",
      event: "proposal_expired",
      outcome: "failed",
      run_id: `proposal-sweep:${new Date(now).toISOString().slice(0, 13)}`,
      meta: { expired: expiredIds.length },
    });
  }

  const { data: dueData, error: dueErr } = await sb
    .from("memory_write_log")
    .select("id, tenant_id, run_id")
    .eq("action", "proposed")
    .is("decided_at", null)
    .is("reason", null)
    .lt("created_at", new Date(now - PROPOSAL_REQUEUE_AFTER_MS).toISOString())
    .gte("created_at", expireBefore)
    .order("created_at", { ascending: true })
    .limit(PROPOSAL_SWEEP_LIMIT);
  if (dueErr) throw new Error(`proposal requeue read failed: ${dueErr.message}`);
  const due = (dueData ?? []) as Array<{ id: string; tenant_id: string; run_id: string | null }>;
  if (due.length === 0) return { expired: expiredIds.length, requeued_runs: 0 };

  const runIds = Array.from(new Set(due.map((r) => r.run_id).filter((x): x is string => !!x)));
  const { data: runData, error: runErr } = runIds.length
    ? await sb.from("agent_runs").select("id, tenant_id, agent_slug, trigger, status").in("id", runIds)
    : { data: [], error: null };
  if (runErr) throw new Error(`proposal requeue run read failed: ${runErr.message}`);
  const runs = new Map(
    ((runData ?? []) as Array<{ id: string; tenant_id: string; agent_slug: string; trigger: string; status: string }>).map(
      (r) => [r.id, r],
    ),
  );
  let requeued = 0;
  const settledRuns = new Set<string>();
  for (const run_id of runIds) {
    const run = runs.get(run_id);
    const owner = due.find((d) => d.run_id === run_id)?.tenant_id;
    if (run && run.tenant_id === owner && UNSETTLED_RUN_STATUSES.has(run.status)) continue;
    settledRuns.add(run_id);
    if (!run || run.tenant_id !== owner || run.status !== "success") continue;
    await inngest.send({
      name: run.trigger === "chat" ? "chat.turn_complete" : "agent.run.distillable",
      data: { run_id: run.id, tenant_id: run.tenant_id, agent_slug: run.agent_slug },
    });
    requeued += 1;
  }
  const markIds = due.filter((r) => !r.run_id || settledRuns.has(r.run_id)).map((r) => r.id);
  if (markIds.length > 0) {
    const { error: markErr } = await sb
      .from("memory_write_log")
      .update({ reason: "requeued" })
      .in("id", markIds);
    if (markErr) throw new Error(`proposal requeue mark failed: ${markErr.message}`);
  }
  return { expired: expiredIds.length, requeued_runs: requeued };
}

type IdPage = PromiseLike<{ data: unknown; error: { message: string } | null }>;

async function deleteInBatches(table: string, nextIds: () => IdPage): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_DELETE_BATCHES; i += 1) {
    const { data, error } = await nextIds();
    if (error) throw new Error(`${table} retention read failed: ${error.message}`);
    const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (ids.length === 0) break;
    const { error: delErr } = await serviceClient().from(table).delete().in("id", ids);
    if (delErr) throw new Error(`${table} retention delete failed: ${delErr.message}`);
    total += ids.length;
    if (ids.length < DELETE_BATCH) break;
  }
  return total;
}

export async function runRetention(): Promise<{ task_cards: number; write_log: number; forget_requests: number }> {
  const sb = serviceClient();
  const task_cards = await deleteInBatches("memory_note", () =>
    sb
      .from("memory_note")
      .select("id")
      .eq("archive_reason", "task_card_retired")
      .lt("archived_at", daysAgo(TASK_CARD_TTL_DAYS))
      .limit(DELETE_BATCH),
  );
  const write_log = await deleteInBatches("memory_write_log", () =>
    sb.from("memory_write_log").select("id").lt("created_at", daysAgo(LOG_RETENTION_DAYS)).limit(DELETE_BATCH),
  );
  const forget_requests = await deleteInBatches("memory_forget_request", () =>
    sb
      .from("memory_forget_request")
      .select("id")
      .neq("state", "pending")
      .lt("created_at", daysAgo(LOG_RETENTION_DAYS))
      .limit(DELETE_BATCH),
  );
  return { task_cards, write_log, forget_requests };
}

export async function runWriteCanaries(): Promise<{ update_pass: number; update_fail: number; abstain_pass: number; abstain_fail: number }> {
  const { data, error } = await serviceClient()
    .from("memory_write_log")
    .select("tenant_id, note_id, matched_note_id, candidate_title")
    .eq("action", "updated")
    .is("restored_at", null)
    .gte("created_at", daysAgo(1))
    .order("created_at", { ascending: false })
    .limit(CANARY_MAX_TENANTS * CANARY_UPDATES_PER_TENANT);
  if (error) throw new Error(`canary read failed: ${error.message}`);
  const byTenant = new Map<string, Array<{ note_id: string; matched_note_id: string; title: string }>>();
  for (const r of (data ?? []) as Array<{ tenant_id: string; note_id: string | null; matched_note_id: string | null; candidate_title: string | null }>) {
    if (!r.note_id || !r.matched_note_id || !r.candidate_title) continue;
    const list = byTenant.get(r.tenant_id) ?? [];
    if (list.length < CANARY_UPDATES_PER_TENANT) list.push({ note_id: r.note_id, matched_note_id: r.matched_note_id, title: r.candidate_title });
    byTenant.set(r.tenant_id, list);
  }
  const totals = { update_pass: 0, update_fail: 0, abstain_pass: 0, abstain_fail: 0 };
  const tenants = Array.from(byTenant.keys()).slice(0, CANARY_MAX_TENANTS);
  for (const tenant_id of tenants) {
    for (const u of byTenant.get(tenant_id)!) {
      try {
        const hits = await searchMemory(tenant_id, u.title, 5, { benchOverride: { reranker: true } });
        const outcome = scoreKnowledgeUpdate(hits, u.note_id, u.matched_note_id);
        totals[outcome === "pass" ? "update_pass" : "update_fail"] += 1;
        logReview({ feature: "memory_write_canary", event: "knowledge_update", outcome, run_id: u.note_id, tenant_id });
      } catch (e) {
        console.warn(`[memory-write-canary] update canary failed for ${tenant_id}: ${(e as Error).message}`);
      }
    }
    try {
      const probe = ABSTENTION_PROBES[tenants.indexOf(tenant_id) % ABSTENTION_PROBES.length];
      const hits = await searchMemory(tenant_id, probe, 5, { benchOverride: { reranker: true } });
      const outcome = scoreAbstention(hits);
      totals[outcome === "pass" ? "abstain_pass" : "abstain_fail"] += 1;
      logReview({
        feature: "memory_write_canary",
        event: "abstention",
        outcome,
        run_id: `abstention:${new Date().toISOString().slice(0, 10)}`,
        tenant_id,
        meta: { top_score: Math.round((hits[0]?.score ?? 0) * 1000) / 1000 },
      });
    } catch (e) {
      console.warn(`[memory-write-canary] abstention canary failed for ${tenant_id}: ${(e as Error).message}`);
    }
  }
  return totals;
}

export const memoryForgetPurgeFn = inngest.createFunction(
  { id: "memory-forget-purge", retries: 3 },
  { event: "memory.note.forget.requested" },
  async ({ event, step }) => {
    const request_id = String(event.data.request_id ?? "");
    const req = await step.run("read-request", async () => {
      const { data } = await serviceClient()
        .from("memory_forget_request")
        .select("id, tenant_id, purge_after, state")
        .eq("id", request_id)
        .maybeSingle();
      return (data as { id: string; tenant_id: string; purge_after: string; state: string } | null) ?? null;
    });
    if (!req || req.state !== "pending") return { skipped: "not_pending" };
    await step.sleepUntil("undo-window", new Date(req.purge_after));
    return await step.run("purge", () => purgeForgetRequest(req.tenant_id, req.id));
  },
);

export const memoryWriteMaintenanceFn = inngest.createFunction(
  { id: "memory-write-maintenance", concurrency: 1 },
  { cron: "*/15 * * * *" },
  async ({ step }) => {
    const forgets = await step.run("forget-sweep", () => sweepDueForgets());
    const enrichment = await step.run("enrichment-retry", () => sweepPendingEnrichment());
    const proposals = await step.run("proposal-sweep", () => sweepPendingProposals());
    return { forgets, enrichment, proposals };
  },
);

export const memoryWriteDailyFn = inngest.createFunction(
  { id: "memory-write-daily", concurrency: 1 },
  { cron: "15 12 * * *" },
  async ({ step }) => {
    const retention = await step.run("retention", () => runRetention());
    const canaries = await step.run("canaries", () => runWriteCanaries());
    return { retention, canaries };
  },
);
