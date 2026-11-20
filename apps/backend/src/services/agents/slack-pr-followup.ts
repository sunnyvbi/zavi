
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type OpenEngineerPr,
  isSafeCheckoutRef,
  classifyFollowupCandidates,
} from "./chat-pr-followup";
import { answerNonPushFollowup } from "./pr-nonpush-answer";
import { isContextFreeCourtesy } from "./acknowledgment-classify";

export async function deriveOpenEngineerPrsForSlackThread(args: {
  svc: SupabaseClient;
  tenant_id: string;
  team_id?: string;
  channel_id: string;
  thread_ts: string;
}): Promise<OpenEngineerPr[]> {
  const { data: runs } = await args.svc
    .from("agent_runs")
    .select("id, parsed, payload")
    .eq("tenant_id", args.tenant_id)
    .eq("agent_slug", "engineer")
    .eq("trigger", "slack")
    .filter("payload->slack->>thread_ts", "eq", args.thread_ts)
    .filter("payload->slack->>channel_id", "eq", args.channel_id)
    .order("enqueued_at", { ascending: false })
    .limit(50);

  const sameWorkspace = (runs ?? []).filter((r) => {
    if (!args.team_id) return true;
    const t = (r.payload as { slack?: { team_id?: unknown } } | null)?.slack?.team_id;
    return t === args.team_id;
  });

  const runIds = sameWorkspace
    .map((r) => r.id as string)
    .filter((id): id is string => typeof id === "string");
  if (runIds.length === 0) return [];

  const { data: decRows } = await args.svc
    .from("decisions")
    .select("id, agent_run_id, status")
    .eq("tenant_id", args.tenant_id)
    .eq("decision_class", "engineer.ship-pr")
    .in("agent_run_id", runIds)
    .in("status", ["acted", "dispatched"]);

  const runById = new Map<string, { parsed?: unknown }>();
  for (const r of sameWorkspace) runById.set(r.id as string, r as { parsed?: unknown });

  const seenPr = new Set<string>();
  const out: OpenEngineerPr[] = [];
  for (const dec of decRows ?? []) {
    const runId = dec.agent_run_id as string | null;
    if (!runId) continue;
    const parsed = (runById.get(runId)?.parsed ?? {}) as {
      pr_number?: unknown;
      pr_repo?: unknown;
      pr_url?: unknown;
      pr_head_branch?: unknown;
    };
    const prNumber = typeof parsed.pr_number === "number" ? parsed.pr_number : null;
    const prRepo = typeof parsed.pr_repo === "string" ? parsed.pr_repo : null;
    const prUrl = typeof parsed.pr_url === "string" ? parsed.pr_url : null;
    const headBranch = parsed.pr_head_branch;
    if (prNumber == null || !prRepo || !prUrl || !isSafeCheckoutRef(headBranch)) {
      continue;
    }
    const prKey = `${prRepo}#${prNumber}`;
    if (seenPr.has(prKey)) continue;
    seenPr.add(prKey);
    out.push({
      decision_id: dec.id as string,
      run_id: runId,
      pr_number: prNumber,
      pr_repo: prRepo,
      pr_url: prUrl,
      head_branch: headBranch,
    });
  }
  return out;
}

export function buildSlackFollowupRunPayload(args: {
  pr: OpenEngineerPr;
  instruction: string;
  slackPayload: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    slack: args.slackPayload,
    kind: "engineer_pr_followup",
    checkout_ref: args.pr.head_branch,
    target_pr_number: args.pr.pr_number,
    target_pr_repo: args.pr.pr_repo,
    target_pr_url: args.pr.pr_url,
    source: "slack",
    instruction: args.instruction,
  };
}

export type SlackFollowupDeps = {
  svc: SupabaseClient;
  enqueueAgentRun: (input: {
    agent_slug: string;
    tenant_id: string;
    trigger: "slack";
    cron_dedupe_key: string;
    payload: Record<string, unknown>;
  }) => Promise<{ run_id: string }>;
  postMessage: (a: {
    tenant_id: string;
    channel_id: string;
    thread_ts: string;
    text: string;
    team_id?: string;
  }) => Promise<void>;
};

export type SlackFollowupResult = {
  handled: boolean;
  action: "route" | "answer" | "clarify" | "skip" | "dedupe_drop" | "courtesy_noop";
  target_pr_number?: number;
};

export async function handleSlackEngineerFollowup(
  deps: SlackFollowupDeps,
  args: {
    tenant_id: string;
    team_id?: string;
    channel_id: string;
    thread_ts: string;
    original_ts?: string;
    event_id: string;
    text: string;
    slack_trace_id?: string;
    user?: string;
  },
): Promise<SlackFollowupResult> {
  const courtesyText = args.text.replace(/<@[A-Z0-9]+>/gi, "").trim();
  if (isContextFreeCourtesy(courtesyText)) {
    try {
      await deps.postMessage({
        tenant_id: args.tenant_id,
        channel_id: args.channel_id,
        thread_ts: args.thread_ts,
        text: "👍",
        team_id: args.team_id,
      });
    } catch (e) {
      console.warn(
        `[slack-pr-followup] courtesy 👍 post failed (still no-op): ${(e as Error).message}`,
      );
    }
    return { handled: true, action: "courtesy_noop" };
  }

  const openPrs = await deriveOpenEngineerPrsForSlackThread({
    svc: deps.svc,
    tenant_id: args.tenant_id,
    team_id: args.team_id,
    channel_id: args.channel_id,
    thread_ts: args.thread_ts,
  });
  const classification = classifyFollowupCandidates({ message: args.text, openPrs });

  if (classification.action === "route") {
    const pr = classification.pr;
    const slackPayload: Record<string, unknown> = {
      channel_id: args.channel_id,
      thread_ts: args.thread_ts,
      original_ts: args.original_ts ?? args.thread_ts,
      event_id: args.event_id,
      text: args.text,
      team_id: args.team_id,
      ...(args.user ? { user: args.user } : {}),
      ...(args.slack_trace_id ? { slack_trace_id: args.slack_trace_id } : {}),
    };
    const { run_id } = await deps.enqueueAgentRun({
      agent_slug: "engineer",
      tenant_id: args.tenant_id,
      trigger: "slack",
      cron_dedupe_key: `slack:${args.event_id}`,
      payload: buildSlackFollowupRunPayload({ pr, instruction: args.text, slackPayload }),
    });
    if (!run_id) {
      return { handled: false, action: "dedupe_drop", target_pr_number: pr.pr_number };
    }
    await deps.postMessage({
      tenant_id: args.tenant_id,
      channel_id: args.channel_id,
      thread_ts: args.thread_ts,
      text: `On it — applying that to PR #${pr.pr_number}.`,
      team_id: args.team_id,
    });
    return { handled: true, action: "route", target_pr_number: pr.pr_number };
  }

  if (classification.action === "clarify") {
    let answer: string | null = null;
    try {
      answer = await answerNonPushFollowup({
        tenant_id: args.tenant_id,
        text: args.text,
        prs: classification.prs,
      });
    } catch (e) {
      console.warn(
        `[slack-pr-followup] non-push answer failed (falling through to engineer): ${(e as Error).message}`,
      );
      answer = null;
    }
    if (answer) {
      await deps.postMessage({
        tenant_id: args.tenant_id,
        channel_id: args.channel_id,
        thread_ts: args.thread_ts,
        text: answer,
        team_id: args.team_id,
      });
      return { handled: true, action: "answer" };
    }
    return { handled: false, action: "skip" };
  }

  return { handled: false, action: "skip" };
}
