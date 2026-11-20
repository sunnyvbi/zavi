
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildInfraRetryEvent, isMoneyPathSlug, isProviderOutageError, isUsageLimitError } from "./infra-retry";
import { BUILD_CONDUCTOR_RUN_ID_KEY } from "@/services/billing/tiers";
import { classifyUsageLimitStatus, type UsageLimitRunRow, type UsageLimitStatus } from "./usage-limit-status";

export const OUTAGE_RETRY_TRIGGERS: readonly string[] = ["chat", "mcp", "slack", "cron"];
export const OUTAGE_RETRY_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export const OUTAGE_RETRY_SETTLE_MS = 30_000;
export const OUTAGE_RETRY_PER_TICK = 5;
const CANDIDATE_LIMIT = 50;
const PREFILTER_READ_LIMIT = 1000;
const OUTAGE_PREFILTER =
  "error.ilike.*claude*,error.ilike.*anthropic*,error.ilike.*hit your*,error.ilike.*reached your*,error.ilike.*extra usage*";

export type OutageCandidate = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  status: string;
  error: string | null;
  infra_retry_count: number | null;
  trigger: string | null;
  batch_id: string | null;
  finished_at: string | null;
  enqueued_at: string | null;
  custom_trigger_id?: string | null;
  payload: unknown;
};

export type OutageSkipReason =
  | "not_outage"
  | "trigger"
  | "money_path"
  | "batch_child"
  | "conductor_child"
  | "already_marked"
  | "too_old"
  | "observed_execution"
  | "superseded"
  | "insufficient_credits"
  | "plan_upgrade_required"
  | "tenant_disabled"
  | "agent_hidden";

function payloadObj(p: unknown): Record<string, unknown> {
  return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
}

function ms(ts: string | null | undefined): number {
  if (!ts) return Number.NaN;
  return Date.parse(ts);
}

export function staticOutageSkip(row: OutageCandidate, now: number): OutageSkipReason | null {
  const payload = payloadObj(row.payload);
  if (payload.outage_retry != null) return "already_marked";
  if (!isProviderOutageError(row.error)) return "not_outage";
  if (!row.trigger || !OUTAGE_RETRY_TRIGGERS.includes(row.trigger)) return "trigger";
  if (isMoneyPathSlug(row.agent_slug)) return "money_path";
  if (row.batch_id != null) return "batch_child";
  const conductor = payload[BUILD_CONDUCTOR_RUN_ID_KEY];
  if (typeof conductor === "string" && conductor.trim()) return "conductor_child";
  const finished = ms(row.finished_at);
  if (!Number.isFinite(finished) || now - finished > OUTAGE_RETRY_MAX_AGE_MS) return "too_old";
  return null;
}

export function outageClass(error: string | null): "usage_limit" | "seat" {
  return isUsageLimitError(error) ? "usage_limit" : "seat";
}

export function providerRecoveredSince(failedAt: string | null, verdict: UsageLimitStatus): boolean {
  if (verdict.status !== "ok") return false;
  const success = ms(verdict.last_success_at);
  const failed = ms(failedAt);
  return Number.isFinite(success) && Number.isFinite(failed) && success > failed;
}

export type SupersessionKey =
  | { kind: "thread"; thread_id: string }
  | { kind: "slack"; channel_id: string; thread_ts: string }
  | { kind: "custom_trigger"; trigger_id: string }
  | { kind: "agent" };

export function supersessionKey(row: OutageCandidate): SupersessionKey | null {
  const payload = payloadObj(row.payload);
  if (row.trigger === "chat") {
    const t = payload.thread_id;
    return typeof t === "string" && t ? { kind: "thread", thread_id: t } : { kind: "agent" };
  }
  if (row.trigger === "slack") {
    const s = payloadObj(payload.slack);
    const c = s.channel_id;
    const ts = s.thread_ts;
    return typeof c === "string" && c && typeof ts === "string" && ts
      ? { kind: "slack", channel_id: c, thread_ts: ts }
      : { kind: "agent" };
  }
  if (row.trigger === "cron") {
    const tid = row.custom_trigger_id ?? payloadObj(payload.custom_agent).trigger_id;
    return typeof tid === "string" && tid ? { kind: "custom_trigger", trigger_id: tid } : { kind: "agent" };
  }
  return null;
}

type Svc = SupabaseClient;

async function anyRow(q: PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>, what: string): Promise<boolean> {
  const { data, error } = await q;
  if (error) throw new Error(`outage-retry ${what} read failed: ${error.message}`);
  return (data ?? []).length > 0;
}

export function isRealToolEvent(e: { stage: string; meta: unknown }): boolean {
  const meta = payloadObj(e.meta);
  const name = meta.tool_name;
  if (typeof name === "string" && name.length > 0) return name !== "assistant_turn";
  const code = meta.code;
  const runLevelDispatchError =
    e.stage === "tool_use_errored" && typeof code === "string" && code.startsWith("dispatch:");
  return !runLevelDispatchError;
}

export async function observedExecution(svc: Svc, row: OutageCandidate): Promise<boolean> {
  const t = row.tenant_id;
  const id = row.id;
  const events = (async () => {
    const { data, error } = await svc
      .from("agent_run_events")
      .select("stage, meta")
      .eq("agent_run_id", id)
      .in("stage", ["tool_use_started", "tool_use_completed", "tool_use_errored"]);
    if (error) throw new Error(`outage-retry events read failed: ${error.message}`);
    return ((data ?? []) as Array<{ stage: string; meta: unknown }>).some(isRealToolEvent);
  })();
  const checks = [
    events,
    anyRow(svc.from("decisions").select("id").eq("tenant_id", t).eq("agent_run_id", id).limit(1), "decisions"),
    anyRow(svc.from("agent_runs").select("id").eq("tenant_id", t).eq("parent_run_id", id).limit(1), "children"),
    anyRow(svc.from("run_artifacts").select("id").eq("tenant_id", t).eq("run_id", id).limit(1), "artifacts"),
    anyRow(svc.from("channel_actions").select("id").eq("tenant_id", t).eq("run_id", id).limit(1), "channel_actions"),
    anyRow(svc.from("agent_tool_effects").select("run_id").eq("tenant_id", t).eq("run_id", id).limit(1), "tool_effects"),
  ];
  return (await Promise.all(checks)).some(Boolean);
}

export async function isSuperseded(svc: Svc, row: OutageCandidate): Promise<boolean> {
  const key = supersessionKey(row);
  if (!key || !row.enqueued_at) return false;
  let q = svc
    .from("agent_runs")
    .select("id")
    .eq("tenant_id", row.tenant_id)
    .eq("agent_slug", row.agent_slug)
    .eq("trigger", row.trigger as string)
    .gt("enqueued_at", row.enqueued_at)
    .neq("id", row.id);
  if (key.kind === "thread") q = q.eq("payload->>thread_id", key.thread_id);
  if (key.kind === "slack") q = q.eq("payload->slack->>channel_id", key.channel_id).eq("payload->slack->>thread_ts", key.thread_ts);
  if (key.kind === "custom_trigger") q = q.eq("custom_trigger_id", key.trigger_id);
  return anyRow(q.limit(1), "supersession");
}

export async function providerVerdict(svc: Svc, since: string): Promise<UsageLimitStatus> {
  const [succ, fails] = await Promise.all([
    svc
      .from("agent_runs")
      .select("id, agent_slug, tenant_id, status, error, finished_at")
      .eq("status", "success")
      .gt("cost_usd", 0)
      .gte("finished_at", since)
      .order("finished_at", { ascending: false })
      .limit(1),
    svc
      .from("agent_runs")
      .select("id, agent_slug, tenant_id, status, error, finished_at")
      .in("status", ["dispatch_error", "failed"])
      .gte("finished_at", since)
      .or(OUTAGE_PREFILTER)
      .order("finished_at", { ascending: false })
      .limit(PREFILTER_READ_LIMIT),
  ]);
  if (succ.error) throw new Error(`outage-retry success read failed: ${succ.error.message}`);
  if (fails.error) throw new Error(`outage-retry failure read failed: ${fails.error.message}`);
  const rows = [...((succ.data ?? []) as UsageLimitRunRow[]), ...((fails.data ?? []) as UsageLimitRunRow[])];
  return classifyUsageLimitStatus(rows, (e) => isProviderOutageError(e));
}

export type OutageRetryDeps = {
  svc: Svc;
  send: (event: ReturnType<typeof buildInfraRetryEvent>) => Promise<unknown>;
  slackClaimId: (event_id: string, run_id: string, payload: Record<string, unknown> | null) => string;
  log: (e: { level: "info" | "warn"; code: string; tenant_id: string; run_id: string; agent_slug: string; stage?: string; failure_class?: string; retry_count?: number; message?: string }) => Promise<void>;
  now?: () => number;
};

export type OutageRetrySummary = { requeued: number; skipped: number; waiting: number; errors: number };

function slackClaimIds(row: OutageCandidate, claimId: OutageRetryDeps["slackClaimId"]): string[] {
  if (row.trigger !== "slack") return [];
  const payload = payloadObj(row.payload);
  const eventId = payloadObj(payload.slack).event_id;
  return typeof eventId === "string" && eventId ? [claimId(eventId, row.id, payload)] : [];
}

async function markSkipped(deps: OutageRetryDeps, row: OutageCandidate, reason: OutageSkipReason, now: number): Promise<void> {
  const { error } = await deps.svc.rpc("mark_outage_retry_skipped", {
    p_tenant_id: row.tenant_id,
    p_run_id: row.id,
    p_marker: { state: "skipped", reason, at: new Date(now).toISOString() },
  });
  await deps.log({
    level: error ? "warn" : "info",
    code: error ? "outage_retry_mark_failed" : "outage_retry_skipped",
    tenant_id: row.tenant_id,
    run_id: row.id,
    agent_slug: row.agent_slug,
    stage: reason,
    failure_class: outageClass(row.error),
    message: error ? `mark_outage_retry_skipped failed: ${error.message}` : undefined,
  });
}

async function requeue(deps: OutageRetryDeps, row: OutageCandidate, now: number): Promise<boolean | OutageSkipReason> {
  const count = row.infra_retry_count ?? 0;
  const failureClass = outageClass(row.error);
  const { data, error } = await deps.svc.rpc("requeue_outage_retry", {
    p_tenant_id: row.tenant_id,
    p_run_id: row.id,
    p_expected_status: row.status,
    p_expected_retry_count: count,
    p_expected_finished_at: row.finished_at,
    p_marker: {
      state: "requeued",
      at: new Date(now).toISOString(),
      prior_status: row.status,
      failure_class: failureClass,
      attempt: count + 1,
    },
    p_slack_claim_ids: slackClaimIds(row, deps.slackClaimId),
    p_supersession: supersessionKey(row),
  });
  if (error) {
    if (/insufficient_credits/.test(error.message)) return "insufficient_credits";
    if (/plan_upgrade_required/.test(error.message)) return "plan_upgrade_required";
    throw new Error(`requeue_outage_retry failed: ${error.message}`);
  }
  if (data === "tenant_disabled" || data === "agent_hidden" || data === "superseded") return data;
  if (data !== "requeued") return false;
  await deps.send(
    buildInfraRetryEvent(
      { id: row.id, tenant_id: row.tenant_id, agent_slug: row.agent_slug, trigger: row.trigger, batch_id: row.batch_id },
      count + 1,
    ),
  );
  await deps.log({
    level: "info",
    code: "outage_retry_requeued",
    tenant_id: row.tenant_id,
    run_id: row.id,
    agent_slug: row.agent_slug,
    failure_class: failureClass,
    retry_count: count + 1,
  });
  return true;
}

export async function runOutageRetrySweep(deps: OutageRetryDeps): Promise<OutageRetrySummary> {
  const now = (deps.now ?? Date.now)();
  const out: OutageRetrySummary = { requeued: 0, skipped: 0, waiting: 0, errors: 0 };
  const since = new Date(now - OUTAGE_RETRY_MAX_AGE_MS).toISOString();
  const settled = new Date(now - OUTAGE_RETRY_SETTLE_MS).toISOString();
  const { data, error } = await deps.svc
    .from("agent_runs")
    .select("id, tenant_id, agent_slug, status, error, infra_retry_count, trigger, batch_id, finished_at, enqueued_at, custom_trigger_id, payload")
    .in("status", ["dispatch_error", "failed"])
    .in("trigger", [...OUTAGE_RETRY_TRIGGERS])
    .is("batch_id", null)
    .is("payload->outage_retry", null)
    .gte("finished_at", since)
    .lt("finished_at", settled)
    .or(OUTAGE_PREFILTER)
    .order("finished_at", { ascending: true })
    .limit(PREFILTER_READ_LIMIT);
  if (error) throw new Error(`outage-retry candidate read failed: ${error.message}`);
  const candidates = ((data ?? []) as OutageCandidate[])
    .filter((r) => staticOutageSkip(r, now) === null)
    .slice(0, CANDIDATE_LIMIT);
  if (candidates.length === 0) return out;

  const oldest = candidates.reduce((m, r) => (ms(r.finished_at) < ms(m) ? (r.finished_at as string) : m), candidates[0].finished_at as string);
  const verdict = await providerVerdict(deps.svc, oldest);

  for (const row of candidates) {
    if (out.requeued >= OUTAGE_RETRY_PER_TICK) {
      out.waiting += 1;
      continue;
    }
    if (!providerRecoveredSince(row.finished_at, verdict)) {
      out.waiting += 1;
      continue;
    }
    try {
      if (await observedExecution(deps.svc, row)) {
        await markSkipped(deps, row, "observed_execution", now);
        out.skipped += 1;
        continue;
      }
      if (await isSuperseded(deps.svc, row)) {
        await markSkipped(deps, row, "superseded", now);
        out.skipped += 1;
        continue;
      }
      const res = await requeue(deps, row, now);
      if (res === true) out.requeued += 1;
      else if (typeof res === "string") {
        await markSkipped(deps, row, res, now);
        out.skipped += 1;
      }
    } catch (e) {
      out.errors += 1;
      await deps.log({
        level: "warn",
        code: "outage_retry_failed",
        tenant_id: row.tenant_id,
        run_id: row.id,
        agent_slug: row.agent_slug,
        failure_class: outageClass(row.error),
        message: (e as Error).message,
      });
    }
  }
  return out;
}
