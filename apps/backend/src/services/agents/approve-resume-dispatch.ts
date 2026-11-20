
import type { SupabaseClient } from "@supabase/supabase-js";
import { stampDirectChannelRunWithin } from "@/services/channels/direct-run";
import { channelForAgent } from "./channel-agents";
import type { AgentTrigger } from "./types";
import {
  PAUSED_AWAITING_APPROVAL,
  RESUME_RESOLVED_STATUS,
  buildResumeTurn,
  buildResumePayload,
} from "./approve-resume";

export type ResumeEnqueue = (input: {
  agent_slug: string;
  tenant_id: string;
  trigger: AgentTrigger;
  payload: unknown;
  parent_run_id?: string | null;
  before_dispatch?: (run_id: string) => Promise<unknown>;
}) => Promise<{ run_id: string }>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SvcClient = SupabaseClient<any, any, any>;

export type ResumeDeps = {
  enqueue: ResumeEnqueue;
  svc: SvcClient;
};

type PausedRunRow = {
  id: string;
  status: string;
  trigger: string | null;
  agent_slug: string;
  payload: unknown;
  tenant_id: string;
  channel_slug?: string | null;
};

export type ResumeOutcome = {
  resumed: boolean;
  run_id?: string;
  reason: string;
};

async function loadRun(
  svc: SvcClient,
  agent_run_id: string,
  tenant_id: string,
): Promise<PausedRunRow | null> {
  const { data, error } = await svc
    .from("agent_runs")
    .select("id, status, trigger, agent_slug, payload, tenant_id, channel_slug")
    .eq("id", agent_run_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (error) throw new Error(`paused-run read failed: ${error.message}`);
  return data as PausedRunRow | null;
}

const STILL_RUNNING = new Set(["queued", "running"]);

async function hasContinuation(svc: SvcClient, run_id: string, tenant_id: string): Promise<boolean> {
  const { data, error } = await svc
    .from("agent_runs")
    .select("id")
    .eq("tenant_id", tenant_id)
    .eq("payload->>resume_of_run_id", run_id)
    .limit(1);
  if (error) throw new Error(`continuation read failed: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

export async function resumeAfterDecision(
  args: {
    tenant_id: string;
    agent_run_id: string | null;
    approved: boolean;
    toolName: string;
    decisionSummary?: string | null;
    outcome?: string | null;
    allowFinished?: boolean;
  },
  deps: ResumeDeps,
): Promise<ResumeOutcome> {
  try {
    if (!args.agent_run_id) return { resumed: false, reason: "no_run" };

    const svc = deps.svc;
    const run = await loadRun(svc, args.agent_run_id, args.tenant_id);
    if (!run) return { resumed: false, reason: "not_paused" };
    if (STILL_RUNNING.has(run.status)) return { resumed: false, reason: "still_running" };
    const finishedChat =
      args.allowFinished === true &&
      run.status === RESUME_RESOLVED_STATUS &&
      run.trigger === "chat" &&
      !(await hasContinuation(svc, run.id, args.tenant_id));
    if (run.status !== PAUSED_AWAITING_APPROVAL && !finishedChat) {
      return { resumed: false, reason: "not_paused" };
    }

    const resumeTurn = buildResumeTurn({
      toolName: args.toolName,
      decisionSummary: args.decisionSummary,
      outcome: args.outcome,
      approved: args.approved,
    });
    const payload = buildResumePayload({
      originalPayload: run.payload,
      resumeTurn,
      pausedRunId: run.id,
    });

    const effectiveTrigger = (run.trigger ?? "chat") as AgentTrigger;
    if (
      effectiveTrigger === "chat" &&
      typeof payload.thread_id === "string" &&
      payload.thread_id
    ) {
      payload.internal_resume_turn = resumeTurn;
      delete payload.user_message;
    }

    const channel = run.channel_slug ?? (effectiveTrigger === "chat" ? channelForAgent(run.agent_slug)?.channel_slug : null);
    const { run_id } = await deps.enqueue({
      agent_slug: run.agent_slug,
      tenant_id: args.tenant_id,
      trigger: effectiveTrigger,
      payload,
      parent_run_id: run.id,
      ...(channel ? { before_dispatch: (id: string) => stampDirectChannelRunWithin(args.tenant_id, id, channel) } : {}),
    });

    const { error: flipErr } = await svc
      .from("agent_runs")
      .update({ status: RESUME_RESOLVED_STATUS })
      .eq("id", run.id)
      .eq("status", PAUSED_AWAITING_APPROVAL);
    if (flipErr) {
      console.warn(
        `[approve-resume] continuation ${run_id} enqueued but paused-run flip failed for ${run.id}: ${flipErr.message}`,
      );
    }
    return { resumed: true, run_id, reason: "resumed" };
  } catch (e) {
    console.warn(
      `[approve-resume] resumeAfterDecision failed for run ${args.agent_run_id ?? "n/a"} (approved=${args.approved}): ${(e as Error).message}`,
    );
    return { resumed: false, reason: "error" };
  }
}

