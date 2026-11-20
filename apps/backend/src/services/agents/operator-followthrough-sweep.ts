
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";
import { isFleetHalted } from "./fleet-halt";
import { willBeInfraRetried, type InfraRetryRow } from "./infra-retry";
import { notifyThreadOwner } from "@/services/notifications/push-fanout";

type Svc = ReturnType<typeof serviceClient>;

export const OPERATOR_FOLLOWTHROUGH_SLA_MINUTES_DEFAULT = 10;
const FAILED_SETTLE_MINUTES = 2;

export function operatorFollowthroughSlaMinutes(): number {
  const raw = process.env.OPERATOR_FOLLOWTHROUGH_SLA_MINUTES;
  const v = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(v) && v > 0 ? v : OPERATOR_FOLLOWTHROUGH_SLA_MINUTES_DEFAULT;
}

const NON_TERMINAL: ReadonlySet<string> = new Set(["queued", "running", "blocked"]);
const FAILED_TERMINAL: ReadonlySet<string> = new Set([
  "failed",
  "dispatch_error",
  "cancelled",
]);

interface HandoffChildRow {
  id: string;
  tenant_id: string;
  agent_slug: string;
  status: string;
  error: string | null;
  started_at: string | null;
  finished_at?: string | null;
  infra_retry_count: number;
  last_progress_at: string | null;
  payload: unknown;
}

function operatorThreadIdOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const tid = (payload as { operator_thread_id?: unknown }).operator_thread_id;
  return typeof tid === "string" && tid.length > 0 ? tid : null;
}

function isBatchChild(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const b = (payload as { handoff_batch_id?: unknown }).handoff_batch_id;
  return typeof b === "string" && b.length > 0;
}

function minutesSince(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 60_000));
}

export function composeInterimBody(agentSlug: string, minutes: number): string {
  const mins = minutes <= 0 ? "under a minute" : `${minutes} min`;
  return (
    `@${agentSlug} is still running — ${mins} in. I'll post the result here ` +
    `as soon as it finishes.`
  );
}

export function composeFailedBody(agentSlug: string): string {
  return (
    `@${agentSlug}'s run didn't finish — it failed before posting a result. ` +
    `Want me to retry it?`
  );
}

export interface OperatorFollowthroughResult {
  scanned: number;
  interim_posted: number;
  failed_posted: number;
  skipped_dedupe: number;
  skipped_infra_retry: number;
  errors: number;
  halted: boolean;
}

async function postSweeperLine(
  svc: Svc,
  args: {
    tenant_id: string;
    run_id: string;
    operator_thread_id: string;
    body: string;
    kind: "interim" | "failed";
  },
): Promise<string | null> {
  const { data: thread, error: thErr } = await svc
    .from("agent_threads")
    .select("id")
    .eq("id", args.operator_thread_id)
    .eq("tenant_id", args.tenant_id)
    .eq("agent_slug", "operator")
    .maybeSingle();
  if (thErr) return `thread lookup failed: ${thErr.message}`;
  if (!thread) return "operator thread not found for tenant";

  const { error: insErr } = await svc.from("agent_thread_messages").insert({
    thread_id: args.operator_thread_id,
    tenant_id: args.tenant_id,
    sender_role: "assistant",
    body: args.body.slice(0, 32000),
    agent_run_id: null,
    meta: { operator_sweeper: { kind: args.kind, run_id: args.run_id }, handoff: true },
  });
  if (insErr) return insErr.message;

  await svc
    .from("agent_threads")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", args.operator_thread_id);
  void notifyThreadOwner({
    tenant_id: args.tenant_id,
    thread_id: args.operator_thread_id,
    agent_slug: "operator",
    body: "Zavi posted a new message.",
  }).catch(() => {});
  return null;
}

async function existingMessageState(
  svc: Svc,
  thread_id: string,
  run_id: string,
): Promise<
  | { ok: true; hasRealResult: boolean; hasInterim: boolean; hasFailed: boolean }
  | { ok: false }
> {
  const { data, error } = await svc
    .from("agent_thread_messages")
    .select("meta")
    .eq("thread_id", thread_id)
    .eq("sender_role", "assistant")
    .or(`agent_run_id.eq.${run_id},meta->operator_sweeper->>run_id.eq.${run_id}`);
  if (error) return { ok: false };
  let hasRealResult = false;
  let hasInterim = false;
  let hasFailed = false;
  for (const m of (data ?? []) as Array<{ meta: unknown }>) {
    const meta = (m.meta ?? {}) as { operator_sweeper?: { kind?: string } };
    const kind = meta.operator_sweeper?.kind;
    if (kind === "interim") hasInterim = true;
    else if (kind === "failed") hasFailed = true;
    else hasRealResult = true;
  }
  return { ok: true, hasRealResult, hasInterim, hasFailed };
}

export async function sweepOperatorFollowthrough(
  svc: Svc = serviceClient(),
  nowMs: number = Date.now(),
): Promise<OperatorFollowthroughResult> {
  const empty: OperatorFollowthroughResult = {
    scanned: 0,
    interim_posted: 0,
    failed_posted: 0,
    skipped_dedupe: 0,
    skipped_infra_retry: 0,
    errors: 0,
    halted: false,
  };

  if (await isFleetHalted()) {
    return { ...empty, halted: true };
  }

  const slaMin = operatorFollowthroughSlaMinutes();
  const slaCutoffIso = new Date(nowMs - slaMin * 60_000).toISOString();

  const candidateStatuses = [...NON_TERMINAL, ...FAILED_TERMINAL];
  const { data: rows, error } = await svc
    .from("agent_runs")
    .select(
      "id, tenant_id, agent_slug, status, error, started_at, finished_at, infra_retry_count, last_progress_at, payload",
    )
    .eq("trigger", "handoff")
    .is("batch_id", null)
    .in("status", candidateStatuses)
    .order("started_at", { ascending: true, nullsFirst: true })
    .limit(200);

  if (error) {
    await logEvent({
      level: "error",
      source: "operator-followthrough-sweep",
      code: "select_failed",
      error: new Error(error.message),
    });
    return { ...empty, errors: 1 };
  }

  const result: OperatorFollowthroughResult = { ...empty };
  for (const r of (rows ?? []) as HandoffChildRow[]) {
    const threadId = operatorThreadIdOf(r.payload);
    if (!threadId) continue;
    if (isBatchChild(r.payload)) continue;
    result.scanned += 1;

    try {
      if (NON_TERMINAL.has(r.status)) {
        const mins = minutesSince(r.started_at, nowMs);
        if (mins === null || mins < slaMin) continue;

        const state = await existingMessageState(svc, threadId, r.id);
        if (!state.ok) {
          result.errors += 1;
          continue;
        }
        if (state.hasInterim || state.hasRealResult) {
          result.skipped_dedupe += 1;
          continue;
        }
        const { data: fresh } = await svc.from("agent_runs").select("status").eq("id", r.id).maybeSingle();
        if (!fresh || !NON_TERMINAL.has((fresh as { status: string }).status)) {
          result.skipped_dedupe += 1;
          continue;
        }
        const postErr = await postSweeperLine(svc, {
          tenant_id: r.tenant_id,
          run_id: r.id,
          operator_thread_id: threadId,
          body: composeInterimBody(r.agent_slug, mins),
          kind: "interim",
        });
        if (postErr) {
          result.errors += 1;
          await logEvent({
            level: "warn",
            source: "operator-followthrough-sweep",
            code: "interim_post_failed",
            tenant_id: r.tenant_id,
            run_id: r.id,
            message: postErr,
            meta: { agent_slug: r.agent_slug },
          });
          continue;
        }
        result.interim_posted += 1;
        await logEvent({
          level: "warn",
          source: "operator-followthrough-sweep",
          code: "interim_posted",
          tenant_id: r.tenant_id,
          run_id: r.id,
          message: `handoff child non-terminal >${slaMin}m — posted interim status`,
          meta: { agent_slug: r.agent_slug, minutes: mins },
        });
      } else {
        const since = minutesSince(r.finished_at ?? null, nowMs);
        if (since !== null && since < FAILED_SETTLE_MINUTES) continue;
        const infraRow: InfraRetryRow = {
          id: r.id,
          tenant_id: r.tenant_id,
          agent_slug: r.agent_slug,
          status: r.status,
          error: r.error,
          infra_retry_count: r.infra_retry_count,
          last_progress_at: r.last_progress_at,
        };
        if (willBeInfraRetried(infraRow)) {
          result.skipped_infra_retry += 1;
          continue;
        }

        const state = await existingMessageState(svc, threadId, r.id);
        if (!state.ok) {
          result.errors += 1;
          continue;
        }
        if (state.hasRealResult || state.hasFailed) {
          result.skipped_dedupe += 1;
          continue;
        }
        const postErr = await postSweeperLine(svc, {
          tenant_id: r.tenant_id,
          run_id: r.id,
          operator_thread_id: threadId,
          body: composeFailedBody(r.agent_slug),
          kind: "failed",
        });
        if (postErr) {
          result.errors += 1;
          await logEvent({
            level: "warn",
            source: "operator-followthrough-sweep",
            code: "failed_post_failed",
            tenant_id: r.tenant_id,
            run_id: r.id,
            message: postErr,
            meta: { agent_slug: r.agent_slug },
          });
          continue;
        }
        result.failed_posted += 1;
        await logEvent({
          level: "warn",
          source: "operator-followthrough-sweep",
          code: "failed_posted",
          tenant_id: r.tenant_id,
          run_id: r.id,
          message: "handoff child failed without a result — posted retry offer",
          meta: { agent_slug: r.agent_slug, status: r.status },
        });
      }
    } catch (e) {
      result.errors += 1;
      await logEvent({
        level: "warn",
        source: "operator-followthrough-sweep",
        code: "row_threw",
        tenant_id: r.tenant_id,
        run_id: r.id,
        error: e instanceof Error ? e : new Error(String(e)),
      });
    }
  }

  if (result.interim_posted > 0 || result.failed_posted > 0 || result.errors > 0) {
    await logEvent({
      level: result.errors > 0 ? "warn" : "info",
      source: "operator-followthrough-sweep",
      code: "swept",
      meta: {
        scanned: result.scanned,
        interim_posted: result.interim_posted,
        failed_posted: result.failed_posted,
        skipped_dedupe: result.skipped_dedupe,
        skipped_infra_retry: result.skipped_infra_retry,
        errors: result.errors,
      },
    });
  }

  return result;
}
