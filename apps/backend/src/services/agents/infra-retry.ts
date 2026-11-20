
import type { serviceClient } from "@/services/supabase";
import type { inngest } from "../../../workers/client";
import { computeRunLane, type RunLane } from "./run-lane";
import { agentCapabilities } from "./agent-capabilities";
import { isCustomAgentSlug } from "@/services/billing/tiers";
import { isBuilderPolicyRefusal } from "./run-failure-code";
import {
  isOurSeatAuthError,
  isProviderAuthError,
  isProviderSeatDisabledNotice,
  isSeatEntitlementError,
} from "./seat-auth-error";

export {
  isProviderAuthError,
  isProviderSeatDisabledNotice,
  isSeatEntitlementError,
  isOurSeatAuthError,
} from "./seat-auth-error";

type Svc = ReturnType<typeof serviceClient>;
type InngestClient = typeof inngest;

export const INFRA_RETRY_CAP = 3;

export const BOOT_REQUEUE_SETTLE_MS = 180_000;

export function buildInfraRetryEvent(
  row: {
    id: string;
    tenant_id: string;
    agent_slug: string;
    trigger?: string | null;
    batch_id?: string | null;
  },
  count: number,
): {
  id: string;
  name: "agent.run.requested";
  data: {
    run_id: string;
    tenant_id: string;
    agent_slug: string;
    lane: RunLane;
  };
} {
  return {
    id: `${row.id}-infra-retry-${count}`,
    name: "agent.run.requested",
    data: {
      run_id: row.id,
      tenant_id: row.tenant_id,
      agent_slug: row.agent_slug,
      lane: computeRunLane(row.trigger, row.batch_id),
    },
  };
}

export const QUEUED_RESEND_BUCKET_MS = 2 * 60 * 60 * 1000;

export function buildQueuedResendEvent(
  row: {
    id: string;
    tenant_id: string;
    agent_slug: string;
    trigger?: string | null;
    batch_id?: string | null;
  },
  nowMs: number,
): {
  id: string;
  name: "agent.run.requested";
  data: {
    run_id: string;
    tenant_id: string;
    agent_slug: string;
    lane: RunLane;
  };
} {
  const bucket = Math.floor(nowMs / QUEUED_RESEND_BUCKET_MS);
  return {
    id: `${row.id}-queued-resend-${bucket}`,
    name: "agent.run.requested",
    data: {
      run_id: row.id,
      tenant_id: row.tenant_id,
      agent_slug: row.agent_slug,
      lane: computeRunLane(row.trigger, row.batch_id),
    },
  };
}

export const CHAT_QUEUED_EARLY_RESEND_MIN = 2;

export function buildChatEarlyResendEvent(row: {
  id: string;
  tenant_id: string;
  agent_slug: string;
  trigger?: string | null;
  batch_id?: string | null;
}): {
  id: string;
  name: "agent.run.requested";
  data: {
    run_id: string;
    tenant_id: string;
    agent_slug: string;
    lane: RunLane;
  };
} {
  return {
    id: `${row.id}-chat-early-resend`,
    name: "agent.run.requested",
    data: {
      run_id: row.id,
      tenant_id: row.tenant_id,
      agent_slug: row.agent_slug,
      lane: computeRunLane(row.trigger, row.batch_id),
    },
  };
}

export const MONEY_PATH_SLUGS: ReadonlySet<string> = new Set([
  "performance-marketer",
  "dispute-response",
]);

export function isMoneyPathSlug(slug: string): boolean {
  if (MONEY_PATH_SLUGS.has(slug)) return true;
  return agentCapabilities(slug).money_path === true;
}

export const CHAT_REPLAY_SAFE_SLUGS: ReadonlySet<string> = new Set([
  "advisor",
  "pm",
  "growth-lead",
  "chief-of-staff",
  "research",
]);

export const IDEMPOTENT_REPLAY_SAFE_SLUGS: ReadonlySet<string> = new Set([
  "fundraising",
]);

const USAGE_LIMIT_RE =
  /\b(hit your ((usage|weekly|session|opus|sonnet) )?limit|usage limit|reached your ((usage|weekly|session|opus|sonnet) )?limit|you'?ve reached your|limit\s*[·.\-]\s*resets|resets\s+\d{1,2}(:\d{2})?\s*(am|pm)|out of (extra )?usage|out of credits|insufficient (quota|credits))\b/i;

export function isUsageLimitError(error: string | null): boolean {
  return error != null && USAGE_LIMIT_RE.test(error);
}

const PROVIDER_USAGE_RE =
  /claude code|claude ai usage limit|(?:hit|reached) your (?:(?:usage|weekly|session|opus|sonnet) )?limit|out of extra usage/i;

export function isProviderUsageLimitError(error: string | null): boolean {
  return isUsageLimitError(error) && PROVIDER_USAGE_RE.test(error as string);
}

export function isProviderOutageError(error: string | null): boolean {
  if (error == null) return false;
  return isProviderUsageLimitError(error) || isSeatEntitlementError(error) || isOurSeatAuthError(error);
}

export function tagSeatAuthError(err: unknown): unknown {
  const msg = (err as Error)?.message ?? "";
  if (!isProviderAuthError(msg) || /claude code/i.test(msg)) return err;
  return new Error(`Claude Code returned an error result: ${msg}`);
}

const CAP_NOTICE_MAX_LEN = 200;
const CAP_NOTICE_RE =
  /^(you(?:'|\u2019)?re out of extra usage|you(?:'|\u2019)?ve (hit|reached) your (?:(?:weekly|session|opus|sonnet|usage) )?limit)\s*[·:.\-—]\s*resets?\b[\s\S]{0,60}?(\([A-Za-z_/+\-]+\)|\d)/i;

export function isProviderCapNotice(text: string | null): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length === 0 || t.length > CAP_NOTICE_MAX_LEN) return false;
  return CAP_NOTICE_RE.test(t);
}

export class ProviderUsageLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUsageLimitError";
  }
}

const CONFIG_ERROR_RE = /^resolve-repo-creds:/;

export function isConfigError(error: string | null): boolean {
  return error != null && CONFIG_ERROR_RE.test(error);
}

const CLONE_PREFIX_RE = /^cloneRepo failed\b/;
const CLONE_REFUSED_RE =
  /write access to repository not granted|repository not found|permission to \S+ denied/i;
const CLONE_RATE_LIMIT_RE = /rate limit|too many requests|secondary rate/i;

export function isRepoAccessDenied(error: string | null | undefined): boolean {
  if (typeof error !== "string" || !CLONE_PREFIX_RE.test(error)) return false;
  return CLONE_REFUSED_RE.test(error) && !CLONE_RATE_LIMIT_RE.test(error);
}

export function isInfraRetryable(status: string, error: string | null): boolean {
  if (isUsageLimitError(error)) return false;
  if (isConfigError(error)) return false;
  if (isRepoAccessDenied(error)) return false;
  if (isBuilderPolicyRefusal(error)) return false;
  if (isSeatEntitlementError(error)) return false;
  if (status === "dispatch_error") return true;
  if (status === "failed") {
    const e = error ?? "";
    return e.startsWith("boot_reap:") || e.startsWith("watchdog_reap:");
  }
  return false;
}

export interface InfraRetryRow {
  id: string;
  tenant_id: string;
  agent_slug: string;
  status: string;
  error: string | null;
  infra_retry_count: number;
  last_progress_at: string | null;
  trigger?: string | null;
  payload?: unknown;
  conductor_run_id?: string | null;
}

export function willBeInfraRetried(row: InfraRetryRow): boolean {
  if (isMoneyPathSlug(row.agent_slug)) return false;
  if (isDoneForYouPayload(row.payload)) return false;
  if (isCustomAgentSlug(row.agent_slug)) return false;
  if (isConductorChild(row)) return false;
  if (row.last_progress_at !== null) return false;
  if (row.infra_retry_count >= INFRA_RETRY_CAP) return false;
  return isInfraRetryable(row.status, row.error);
}

export function isConductorChild(row: Pick<InfraRetryRow, "conductor_run_id">): boolean {
  return typeof row.conductor_run_id === "string" && row.conductor_run_id.trim().length > 0;
}

export async function tryInfraRetryRun(
  svc: Svc,
  inngestClient: InngestClient,
  row: InfraRetryRow,
  source: "boot" | "scan",
): Promise<boolean> {
  if (source === "scan") {
    if (!willBeInfraRetried(row)) return false;
  } else {
    if (isMoneyPathSlug(row.agent_slug)) return false;
    if (isCustomAgentSlug(row.agent_slug)) return false;
    if (isDoneForYouPayload(row.payload)) return false;
    const chatReplaySafe =
      row.trigger === "chat" && CHAT_REPLAY_SAFE_SLUGS.has(row.agent_slug);
    if (row.last_progress_at !== null && !chatReplaySafe) return false;
    if (row.status !== "running") return false;
    if (row.infra_retry_count >= INFRA_RETRY_CAP) return false;
  }

  return casRequeueAndDispatch(
    svc,
    inngestClient,
    row,
    source === "boot" ? "defer" : "now",
  );
}

async function casRequeueAndDispatch(
  svc: Svc,
  inngestClient: InngestClient,
  row: InfraRetryRow,
  dispatch: "now" | "defer" = "now",
): Promise<boolean> {
  const nextCount = row.infra_retry_count + 1;
  const { data: casRows, error: casErr } = await svc
    .from("agent_runs")
    .update({
      status: "queued",
      infra_retry_count: nextCount,
      enqueued_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      error: null,
      needs_run_end_emit: false,
    })
    .eq("id", row.id)
    .eq("status", row.status)
    .eq("infra_retry_count", row.infra_retry_count)
    .select("id");
  if (casErr || !casRows || casRows.length === 0) return false;

  if (dispatch === "defer") return true;

  await inngestClient.send(buildInfraRetryEvent(row, nextCount));
  return true;
}

export async function tryBuildChildResume(
  svc: Svc,
  inngestClient: InngestClient,
  row: InfraRetryRow,
): Promise<boolean> {
  if (isMoneyPathSlug(row.agent_slug)) return false;
  if (row.status !== "running") return false;
  if (row.infra_retry_count >= INFRA_RETRY_CAP) return false;
  if (row.trigger !== "a2a") return false;

  const { data: dh, error: dhErr } = await svc
    .from("dispatch_history")
    .select("source_run_id")
    .eq("target_run_id", row.id)
    .eq("source_agent_slug", "conductor")
    .limit(1);
  if (dhErr || !dh || dh.length === 0) return false;
  const conductorRunId = (dh[0] as { source_run_id?: string }).source_run_id;
  if (!conductorRunId) return false;

  const { data: cr, error: crErr } = await svc
    .from("conductor_runs")
    .select("kind, goal_graph")
    .eq("id", conductorRunId)
    .single();
  if (crErr || !cr) return false;
  if ((cr as { kind?: string }).kind !== "build_app") return false;
  const graph = (cr as { goal_graph?: unknown }).goal_graph;
  const boundToDispatchedNode =
    Array.isArray(graph) &&
    graph.some(
      (n) =>
        n &&
        typeof n === "object" &&
        (n as { status?: string }).status === "dispatched" &&
        (n as { child_run_id?: string }).child_run_id === row.id,
    );
  if (!boundToDispatchedNode) return false;

  const { data: dec, error: decErr } = await svc
    .from("decisions")
    .select("id")
    .eq("agent_run_id", row.id)
    .limit(1);
  if (decErr) return false;
  if (dec && dec.length > 0) return false;

  return casRequeueAndDispatch(svc, inngestClient, row, "defer");
}

export async function tryIdempotentAgentResume(
  svc: Svc,
  inngestClient: InngestClient,
  row: InfraRetryRow,
): Promise<boolean> {
  if (isMoneyPathSlug(row.agent_slug)) return false;
  if (!IDEMPOTENT_REPLAY_SAFE_SLUGS.has(row.agent_slug)) return false;
  if (row.trigger === "cron" || row.trigger === "a2a") return false;
  if (row.status !== "running") return false;
  if (row.infra_retry_count >= INFRA_RETRY_CAP) return false;

  const { data: dec, error: decErr } = await svc
    .from("decisions")
    .select("id")
    .eq("agent_run_id", row.id)
    .limit(1);
  if (decErr) return false;
  if (dec && dec.length > 0) return false;

  return casRequeueAndDispatch(svc, inngestClient, row, "defer");
}

const ENGINEER_RESUME_SLUG = "engineer";

export async function tryEngineerResume(
  svc: Svc,
  inngestClient: InngestClient,
  row: InfraRetryRow,
): Promise<boolean> {
  if (isMoneyPathSlug(row.agent_slug)) return false;
  if (row.agent_slug !== ENGINEER_RESUME_SLUG) return false;
  if (row.trigger === "cron" || row.trigger === "a2a") return false;
  if (row.status !== "running") return false;
  if (row.infra_retry_count >= INFRA_RETRY_CAP) return false;

  const { data: dec, error: decErr } = await svc
    .from("decisions")
    .select("id")
    .eq("agent_run_id", row.id)
    .limit(1);
  if (decErr) return false;
  if (dec && dec.length > 0) return false;

  return casRequeueAndDispatch(svc, inngestClient, row, "defer");
}

const OPERATOR_RESUME_SLUG = "operator";

const ASSISTANT_TURN_TOOL = "assistant_turn";

export async function tryOperatorSlackResume(
  svc: Svc,
  inngestClient: InngestClient,
  row: InfraRetryRow,
): Promise<boolean> {
  if (isMoneyPathSlug(row.agent_slug)) return false;
  if (row.agent_slug !== OPERATOR_RESUME_SLUG) return false;
  if (row.trigger !== "slack") return false;
  if (row.status !== "running") return false;
  if (row.infra_retry_count >= INFRA_RETRY_CAP) return false;

  const { data: dec, error: decErr } = await svc
    .from("decisions")
    .select("id")
    .eq("agent_run_id", row.id)
    .limit(1);
  if (decErr) return false;
  if (dec && dec.length > 0) return false;

  const { data: evts, error: evtErr } = await svc
    .from("agent_run_events")
    .select("stage, meta")
    .eq("agent_run_id", row.id)
    .in("stage", ["tool_use_started", "tool_use_completed", "tool_use_errored"]);
  if (evtErr) return false;
  for (const e of (evts ?? []) as Array<{ meta: { tool_name?: string } | null }>) {
    if (e.meta?.tool_name !== ASSISTANT_TURN_TOOL) return false;
  }

  return casRequeueAndDispatch(svc, inngestClient, row, "defer");
}

export function isDoneForYouPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const d = (payload as Record<string, unknown>).done_for_you;
  return !!d && typeof d === "object";
}
