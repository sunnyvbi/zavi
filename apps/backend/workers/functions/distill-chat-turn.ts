import { inngest } from "../client";
import { distillConcurrency } from "./distill-concurrency";
import { serviceClient } from "@/services/supabase";
import { liveConnectorsForTenant } from "@/services/memory/live-connectors";
import { hasReadFileBudgetRefusal } from "@/services/agents/unverified-absence-verifier";
import type { ToolCallTrace } from "@/services/tools/types";
import {
  CHAT_DISTILL_SYSTEM_PROMPT,
  runDistill,
} from "@/services/memory/distill";
import { shouldDistillRun } from "@/services/agents/should-distill";
import {
  loadPendingProposals,
  MAX_PROPOSALS_PER_RUN,
  type MemoryProposal,
} from "@/services/memory/write-path";
import { PROPOSALS_ONLY_NOTE } from "@/services/memory/write-gate";
import { carriesCapturedPageContext } from "@/services/agents/untrusted-context";
import { resolveChatTurnChain } from "@/services/agents/run-owner";
import { logEvent } from "@/services/logging/logEvent";

type AgentRunRow = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  trigger: string;
  payload: { thread_id?: string; user_message_id?: string; resume_of_run_id?: string; page_context?: unknown } | null;
  tool_calls: ToolCallTrace[] | null;
};

type ThreadMessageRow = {
  id: string;
  sender_role: "user" | "assistant" | "system";
  body: string;
  created_at: string;
  distilled_at: string | null;
  agent_run_id?: string | null;
};

const CONTEXT_TURNS = 6;
const MAX_USER_PROMPT_CHARS = 12_000;
export const DISTILL_CLAIM_TTL_MS = 15 * 60 * 1000;
const TERMINAL_FAILURE_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "cancelled",
  "canceled",
  "error",
  "dispatch_error",
  "parse_failed",
  "timeout",
  "timed_out",
]);

const SOURCE = "distill-chat-turn";
const NOTHING = { written: 0, skipped: 0 } as const;

type Svc = ReturnType<typeof serviceClient>;

function dbError(what: string, err: { message?: string } | null | undefined): Error {
  return new Error(`distill-chat-turn: ${what} failed: ${err?.message ?? "unknown error"}`);
}

async function stampRuns(svc: Svc, tenant_id: string, runIds: string[], at: string): Promise<void> {
  if (runIds.length === 0) return;
  const { error } = await svc
    .from("agent_runs")
    .update({ distilled_at: at })
    .eq("tenant_id", tenant_id)
    .in("id", runIds);
  if (error) throw dbError("agent_runs stamp", error);
}

async function stampMessages(svc: Svc, tenant_id: string, ids: string[], at: string): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await svc
    .from("agent_thread_messages")
    .update({ distilled_at: at })
    .eq("tenant_id", tenant_id)
    .in("id", ids);
  if (error) throw dbError("thread message stamp", error);
}

async function hasLiveSuccessor(svc: Svc, run: AgentRunRow): Promise<boolean> {
  const threadId = typeof run.payload?.thread_id === "string" ? run.payload.thread_id : null;
  if (!threadId) return false;
  const { data, error } = await svc
    .from("agent_runs")
    .select("id")
    .eq("tenant_id", run.tenant_id)
    .eq("payload->>resume_of_run_id", run.id)
    .eq("agent_slug", run.agent_slug)
    .eq("trigger", run.trigger)
    .eq("payload->>thread_id", threadId)
    .is("enqueued_by", null)
    .not("status", "in", `(${[...TERMINAL_FAILURE_STATUSES].join(",")})`)
    .limit(1);
  if (error) throw dbError("successor lookup", error);
  return Array.isArray(data) && data.length > 0;
}

async function loadChainProposals(tenant_id: string, chain: string[]): Promise<MemoryProposal[]> {
  const out: MemoryProposal[] = [];
  const seen = new Set<string>();
  for (const runId of [...chain].reverse()) {
    if (out.length >= MAX_PROPOSALS_PER_RUN) break;
    for (const p of await loadPendingProposals(tenant_id, runId)) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
      if (out.length >= MAX_PROPOSALS_PER_RUN) break;
    }
  }
  return out;
}

export function buildChatTurnTranscript(input: {
  prior: Array<{ sender_role: string; body: string }>;
  userBody: string;
  replies: Array<{ label: string; body: string }>;
  max: number;
}): string {
  const { prior, userBody, replies, max } = input;
  const PRIOR_HEADER = "## Prior context (oldest first)";
  const TURN_HEADER = "## This turn";
  const tip = replies[replies.length - 1] ?? { label: "assistant", body: "(no reply)" };
  const earlier = replies.slice(0, -1);
  const line = (label: string, body: string) => `**${label}**: ${body}`;

  const skeleton = PRIOR_HEADER.length + 1 + 1 + TURN_HEADER.length + 1;
  let userLine = line("user", userBody);
  let tipLine = line(tip.label, tip.body);
  if (skeleton + userLine.length + 1 + tipLine.length > max) {
    const half = Math.max(0, Math.floor((max - skeleton - 1) / 2));
    userLine = userLine.slice(0, half);
    tipLine = tipLine.slice(0, Math.max(0, max - skeleton - 1 - userLine.length));
  }
  let budget = max - (skeleton + userLine.length + 1 + tipLine.length);

  const earlierLines: string[] = [];
  for (const r of earlier) {
    const l = line(r.label, r.body);
    if (budget <= 1) break;
    const kept = l.length + 1 <= budget ? l : l.slice(0, budget - 1);
    earlierLines.push(kept);
    budget -= kept.length + 1;
  }

  const priorLines: string[] = [];
  for (let i = prior.length - 1; i >= 0; i--) {
    const l = line(prior[i].sender_role, prior[i].body);
    if (l.length + 1 > budget) break;
    priorLines.unshift(l);
    budget -= l.length + 1;
  }

  return [PRIOR_HEADER, ...priorLines, "", TURN_HEADER, userLine, ...earlierLines, tipLine].join("\n").slice(0, max);
}

export async function distillChatTurn(run_id: string): Promise<{ written: number; skipped: number }> {
  if (process.env.PRAXIS_DISTILL_CHAT_ENABLED === "0") {
    return { ...NOTHING };
  }

  const svc = serviceClient();

  const { data: runData, error: runErr } = await svc
    .from("agent_runs")
    .select("id, tenant_id, agent_slug, trigger, payload, tool_calls")
    .eq("id", run_id)
    .maybeSingle();
  if (runErr) throw new Error(`agent_runs read failed: ${runErr.message}`);
  if (!runData) {
    return { ...NOTHING };
  }
  const run = runData as AgentRunRow;
  if (run.trigger !== "chat") {
    return { ...NOTHING };
  }

  if (await hasLiveSuccessor(svc, run)) {
    await logEvent({
      level: "info",
      source: SOURCE,
      code: "distill.chat_turn_deferred_to_tip",
      message: `run ${run.id} was resumed; its turn is distilled by the continuation`,
      tenant_id: run.tenant_id,
      run_id: run.id,
      meta: { agent_slug: run.agent_slug },
    });
    return { ...NOTHING };
  }

  const resolved = await resolveChatTurnChain(svc, run.tenant_id, run.id);
  if (!resolved.ok) {
    if (resolved.reason === "not_chat") return { ...NOTHING };
    await logEvent({
      level: "warn",
      source: SOURCE,
      code: "distill.chat_turn_chain_broken",
      message: `run ${run.id}: no user-typed root for this chat turn; stamped without distilling`,
      tenant_id: run.tenant_id,
      run_id: run.id,
      meta: { agent_slug: run.agent_slug },
    });
    await stampRuns(svc, run.tenant_id, [run.id], new Date().toISOString());
    return { ...NOTHING };
  }
  const { chain, thread_id, user_message_id, root_run_id } = resolved;
  const tipId = run.id;
  if (chain.length > 1) {
    await logEvent({
      level: "info",
      source: SOURCE,
      code: "distill.chat_turn_resume_chain",
      message: `run ${run.id} resumes root ${root_run_id}`,
      tenant_id: run.tenant_id,
      run_id: run.id,
      meta: { agent_slug: run.agent_slug, run_id_ref: root_run_id, count: chain.length },
    });
  }

  const { data: brainEvents, error: brainErr } = await svc
    .from("agent_run_events")
    .select("id")
    .in("agent_run_id", chain)
    .like("meta->>tool_name", "%brain__%")
    .limit(1);
  if (brainErr) throw dbError("brain event read", brainErr);
  const used_brain_correction = Array.isArray(brainEvents) && brainEvents.length > 0;
  const gate = shouldDistillRun({
    agent_slug: run.agent_slug,
    trigger: "chat",
    used_brain_correction,
  });
  if (!gate.ok) {
    const at = new Date().toISOString();
    await stampMessages(svc, run.tenant_id, [user_message_id], at);
    await stampRuns(svc, run.tenant_id, chain, at);
    return { ...NOTHING };
  }

  const readUserMsg = async (): Promise<ThreadMessageRow | null> => {
    const { data, error } = await svc
      .from("agent_thread_messages")
      .select("id, sender_role, body, created_at, distilled_at")
      .eq("id", user_message_id)
      .eq("tenant_id", run.tenant_id)
      .eq("thread_id", thread_id)
      .eq("sender_role", "user")
      .maybeSingle();
    if (error) throw new Error(`thread_message read failed: ${error.message}`);
    return (data as ThreadMessageRow | null) ?? null;
  };
  let userMsg = await readUserMsg();
  if (!userMsg) {
    await logEvent({
      level: "warn",
      source: SOURCE,
      code: "distill.chat_turn_message_missing",
      message: `run ${run.id}: user message of the turn not found; stamped without distilling`,
      tenant_id: run.tenant_id,
      run_id: run.id,
      meta: { agent_slug: run.agent_slug, run_id_ref: root_run_id, count: chain.length },
    });
    await stampRuns(svc, run.tenant_id, chain, new Date().toISOString());
    return { ...NOTHING };
  }

  let claimed = false;
  const claimedAt = new Date().toISOString();
  if (!userMsg.distilled_at) {
    const staleBefore = new Date(Date.now() - DISTILL_CLAIM_TTL_MS).toISOString();
    const { data: claimRows, error: claimErr } = await svc
      .from("agent_thread_messages")
      .update({ distill_claimed_at: claimedAt })
      .eq("id", user_message_id)
      .eq("tenant_id", run.tenant_id)
      .is("distilled_at", null)
      .or(`distill_claimed_at.is.null,distill_claimed_at.lt."${staleBefore}"`)
      .select("id");
    if (claimErr) throw dbError("distill claim", claimErr);
    claimed = Array.isArray(claimRows) && claimRows.length > 0;
    if (!claimed) {
      userMsg = await readUserMsg();
      if (!userMsg) {
        await stampRuns(svc, run.tenant_id, chain, new Date().toISOString());
        return { ...NOTHING };
      }
      if (!userMsg.distilled_at) {
        await logEvent({
          level: "info",
          source: SOURCE,
          code: "distill.chat_turn_claim_busy",
          message: `run ${run.id}: another worker holds the turn's distill claim`,
          tenant_id: run.tenant_id,
          run_id: run.id,
          meta: { agent_slug: run.agent_slug, run_id_ref: root_run_id, count: chain.length },
        });
        return { ...NOTHING };
      }
    }
  }

  if (!claimed) {
    const proposals = await loadChainProposals(run.tenant_id, chain);
    if (proposals.length > 0) {
      const res = await runDistill({
        tenant_id: run.tenant_id,
        source: "auto_distill_chat",
        source_ref: tipId,
        systemPrompt: CHAT_DISTILL_SYSTEM_PROMPT,
        userPrompt: [`## Agent: ${run.agent_slug}`, "", PROPOSALS_ONLY_NOTE].join("\n"),
        baseTags: [`agent:${run.agent_slug}`, `thread:${thread_id}`],
        thread_id,
        liveConnectors: await liveConnectorsForTenant(svc, run.tenant_id),
        gate: { ceiling: 2, queryText: "", run_id: tipId },
        proposals: { agent_slug: run.agent_slug, items: proposals },
      });
      if (res.failed > 0) {
        throw new Error(`distill-chat-turn: ${res.failed} note write(s) failed for run ${tipId}`);
      }
      await stampRuns(svc, run.tenant_id, chain, new Date().toISOString());
      return { written: res.written, skipped: res.skipped };
    }
    await stampRuns(svc, run.tenant_id, chain, new Date().toISOString());
    return { ...NOTHING };
  }

  const claimedMsg = userMsg;
  try {
    return await distillClaimedTurn(svc, run, {
      chain,
      payloads: resolved.payloads,
      thread_id,
      userMsg: claimedMsg,
    });
  } catch (e) {
    const { error: releaseErr } = await svc
      .from("agent_thread_messages")
      .update({ distill_claimed_at: null })
      .eq("id", user_message_id)
      .eq("tenant_id", run.tenant_id)
      .eq("distill_claimed_at", claimedAt)
      .is("distilled_at", null);
    if (releaseErr) {
      await logEvent({
        level: "warn",
        source: SOURCE,
        code: "distill.chat_turn_claim_release_failed",
        error: releaseErr,
        tenant_id: run.tenant_id,
        run_id: run.id,
        meta: { agent_slug: run.agent_slug },
      });
    }
    throw e;
  }
}

async function distillClaimedTurn(
  svc: Svc,
  run: AgentRunRow,
  turn: { chain: string[]; payloads: Record<string, unknown>[]; thread_id: string; userMsg: ThreadMessageRow },
): Promise<{ written: number; skipped: number }> {
  const { chain, payloads, thread_id, userMsg } = turn;
  const tipId = run.id;

  const { data: replyData, error: replyErr } = await svc
    .from("agent_thread_messages")
    .select("id, sender_role, body, created_at, distilled_at, agent_run_id")
    .eq("tenant_id", run.tenant_id)
    .eq("thread_id", thread_id)
    .in("agent_run_id", chain)
    .eq("sender_role", "assistant")
    .order("created_at", { ascending: true });
  if (replyErr) throw dbError("reply read", replyErr);
  const replies = ((replyData ?? []) as ThreadMessageRow[]).filter(
    (m) => typeof m.agent_run_id === "string" && chain.includes(m.agent_run_id),
  );
  const tipReplies = replies.filter((m) => m.agent_run_id === tipId);
  const tipReply = tipReplies[0] ?? null;
  const isResumed = chain.length > 1;
  const labelled: Array<{ label: string; body: string }> = [];
  chain.forEach((runId, i) => {
    const label = !isResumed
      ? `${run.agent_slug} (assistant)`
      : i === chain.length - 1
        ? `${run.agent_slug} (assistant, after the approval)`
        : `${run.agent_slug} (assistant, before pausing for approval)`;
    for (const m of replies) if (m.agent_run_id === runId) labelled.push({ label, body: m.body });
  });
  if (tipReplies.length === 0) {
    labelled.push({
      label: isResumed ? `${run.agent_slug} (assistant, after the approval)` : `${run.agent_slug} (assistant)`,
      body: "(no reply)",
    });
  }

  const { data: priorData, error: priorErr } = await svc
    .from("agent_thread_messages")
    .select("id, sender_role, body, created_at")
    .eq("tenant_id", run.tenant_id)
    .eq("thread_id", thread_id)
    .lt("created_at", userMsg.created_at)
    .order("created_at", { ascending: false })
    .limit(CONTEXT_TURNS);
  if (priorErr) throw dbError("prior context read", priorErr);
  const prior = ((priorData ?? []) as ThreadMessageRow[]).reverse();

  const userPrompt = buildChatTurnTranscript({
    prior,
    userBody: userMsg.body,
    replies: labelled,
    max: MAX_USER_PROMPT_CHARS,
  });

  let toolCalls: ToolCallTrace[] = Array.isArray(run.tool_calls) ? run.tool_calls : [];
  if (isResumed) {
    const { data: traceRows, error: traceErr } = await svc
      .from("agent_runs")
      .select("id, tool_calls")
      .eq("tenant_id", run.tenant_id)
      .in("id", chain);
    if (traceErr) throw dbError("chain tool trace read", traceErr);
    toolCalls = ((traceRows ?? []) as Array<{ tool_calls: ToolCallTrace[] | null }>).flatMap((r) =>
      Array.isArray(r.tool_calls) ? r.tool_calls : [],
    );
  }

  const proposals = await loadChainProposals(run.tenant_id, chain);

  const result = await runDistill({
    tenant_id: run.tenant_id,
    source: "auto_distill_chat",
    source_ref: tipId,
    systemPrompt: CHAT_DISTILL_SYSTEM_PROMPT,
    userPrompt,
    baseTags: [`agent:${run.agent_slug}`, `thread:${thread_id}`],
    thread_id,
    liveConnectors: await liveConnectorsForTenant(svc, run.tenant_id),
    readBudgetRefused: hasReadFileBudgetRefusal(toolCalls),
    agent_slug: run.agent_slug,
    operator_message: userMsg.body,
    gate: {
      ceiling: [run.payload, ...payloads].some((p) => carriesCapturedPageContext(p)) ? 2 : 0,
      queryText: `${userMsg.body}\n\n${tipReply?.body ?? ""}`.slice(0, 4000),
      run_id: tipId,
      thread_message_id: tipReply?.id ?? null,
    },
    proposals: { agent_slug: run.agent_slug, items: proposals },
  });

  if (result.failed > 0) {
    throw new Error(`distill-chat-turn: ${result.failed} note write(s) failed for run ${tipId}`);
  }

  const stampAt = new Date().toISOString();
  await stampMessages(svc, run.tenant_id, [userMsg.id, ...replies.map((m) => m.id)], stampAt);
  await stampRuns(svc, run.tenant_id, chain, stampAt);

  return { written: result.written, skipped: result.skipped };
}

export const distillChatTurnFn = inngest.createFunction(
  {
    id: "distill-chat-turn",
    retries: 1,
    concurrency: distillConcurrency("distill-chat-turn-global"),
    singleton: { key: "event.data.run_id", mode: "skip" },
  },
  { event: "chat.turn_complete" },
  async ({ event, step, logger }) => {
    const run_id = event.data.run_id as string;
    if (!run_id) {
      logger.warn("[distill-chat-turn] missing run_id; no-op");
      return { written: 0, skipped: 0 };
    }
    const res = await step.run("distill", () => distillChatTurn(run_id));
    logger.info(`distill-chat-turn ${run_id}: written=${res.written} skipped=${res.skipped}`);
    return res;
  },
);
