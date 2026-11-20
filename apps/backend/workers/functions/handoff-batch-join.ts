
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import {
  composeHandoffBody,
  parentReplyPending,
  PARENT_REPLY_POLL_MS,
  PARENT_REPLY_WAIT_MS,
} from "@/services/agents/handoff-result";
import type { RunOutcome } from "@/services/agents/outcome-model";
import { extractReceipts } from "@/services/agents/delegation-result-schema";
import { agentDisplayName } from "@/services/agents/entitlement";
import { notifyThreadOwner } from "@/services/notifications/push-fanout";

const POLL_INTERVAL_MS = 5_000;
const MAX_POLLS = 14;

const FOLLOW_INTERVAL = "15s";
const FOLLOW_MAX_POLLS = 120;

const CHILD_COLUMNS =
  "id, agent_slug, status, output_text, raw_response_text, error, tool_calls, outcome, parsed";

const NON_TERMINAL = new Set(["queued", "running", "blocked"]);

type ChildRow = {
  id: string;
  agent_slug: string;
  status: string;
  output_text: string | null;
  raw_response_text: string | null;
  error: string | null;
  tool_calls: Array<{ name?: string }> | null;
  outcome: Partial<RunOutcome> | null;
  parsed: Record<string, unknown> | null;
};

type BatchRow = { tenant_id: string; operator_thread_id: string };

export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function childSection(batch: BatchRow, c: ChildRow): string {
  const mapped: "success" | "error" | "failed" =
    c.status === "success" ? "success" : c.status === "parse_failed" ? "failed" : "error";
  const body = composeHandoffBody({
    tenant_id: batch.tenant_id,
    run_id: c.id,
    operator_thread_id: batch.operator_thread_id,
    from_agent_slug: c.agent_slug,
    status: mapped,
    parse_failed: c.status === "parse_failed",
    output_text: c.output_text,
    raw_response_text: c.raw_response_text,
    error: c.error,
    outcome: c.outcome,
    parsed: c.parsed,
    evidence: { receipts: extractReceipts(c.output_text, c.tool_calls) },
  }).trim();
  const name = agentDisplayName(c.agent_slug);
  if (mapped === "success") return `**${name}**\n${body}`;
  return `**${name}** couldn't finish.\n${body}`;
}

export function composeCombinedBody(
  batch: BatchRow,
  childIds: string[],
  children: ChildRow[],
): { body: string; doneIds: string[]; pendingIds: string[] } {
  const byId = new Map(children.map((c) => [c.id, c]));
  const done = childIds.map((id) => byId.get(id)).filter((c): c is ChildRow => !!c && !NON_TERMINAL.has(c.status));
  const pendingIds = childIds.filter((id) => !done.some((c) => c.id === id));
  const pendingNames = pendingIds.map((id) => agentDisplayName(byId.get(id)?.agent_slug ?? "specialist"));
  const doneNames = done.map((c) => agentDisplayName(c.agent_slug));

  let header: string;
  if (pendingIds.length === 0) {
    header = "Here's what the specialists found.";
  } else if (done.length === 0) {
    header =
      pendingIds.length === 1
        ? `${pendingNames[0]} is still working and will post its answer here when it's done.`
        : `${joinNames(pendingNames)} are still working. Each will post its answer here when it's done.`;
  } else {
    const doneLine = `${joinNames(doneNames)} ${done.length === 1 ? "is" : "are"} done.`;
    const pendingLine =
      pendingIds.length === 1
        ? `${pendingNames[0]} is still working and will post here when it's ready.`
        : `${joinNames(pendingNames)} are still working. Each will post here when it's ready.`;
    header = `${doneLine} ${pendingLine}`;
  }
  const sections = done.map((c) => childSection(batch, c));
  const combined = sections.length > 0 ? [header, "", sections.join("\n\n---\n\n")].join("\n") : header;
  return {
    body: combined.length > 32000 ? combined.slice(0, 32000) : combined,
    doneIds: done.map((c) => c.id),
    pendingIds,
  };
}

export function answersPushBody(names: string[]): string {
  return names.length === 1 ? `${names[0]} answered your question.` : "Your specialists' answers are in.";
}

export const handoffBatchJoinFn = inngest.createFunction(
  {
    id: "handoff-batch-join",
    idempotency: "event.data.batch_id",
    retries: 3,
  },
  { event: "handoff.batch.join.requested" },
  async ({ event, step, logger }) => {
    const batch_id = event.data?.batch_id as string | undefined;
    if (!batch_id || typeof batch_id !== "string") {
      throw new Error("handoff-batch-join: missing batch_id in event payload");
    }
    const sb = serviceClient();

    const { data: batch, error: batchErr } = await step.run("read-batch", async () =>
      sb
        .from("handoff_batches")
        .select(
          "id, tenant_id, parent_run_id, operator_thread_id, child_run_ids, deadline_at, status",
        )
        .eq("batch_id", batch_id)
        .maybeSingle(),
    );
    if (batchErr || !batch) {
      logger.warn(`handoff-batch-join: batch ${batch_id} not found; nothing to join`);
      return { status: "skip", reason: "batch_not_found" };
    }
    if (batch.status !== "pending") {
      return { status: "skip", reason: `already_${batch.status}` };
    }

    const childIds = (batch.child_run_ids as string[]) ?? [];
    const deadlineMs = Date.parse(batch.deadline_at as string);

    let timedOut = false;
    for (let poll = 0; poll < MAX_POLLS; poll++) {
      const children = (await step.run(`poll-children-${poll}`, async () => {
        const { data } = await sb
          .from("agent_runs")
          .select("id, agent_slug, status, output_text, raw_response_text, error")
          .in("id", childIds);
        return (data ?? []) as ChildRow[];
      })) as ChildRow[];

      const allTerminal =
        children.length >= childIds.length &&
        children.every((c) => !NON_TERMINAL.has(c.status));
      if (allTerminal) break;

      if (Date.now() >= deadlineMs) {
        timedOut = true;
        break;
      }
      await step.sleep(`wait-${poll}`, `${POLL_INTERVAL_MS}ms`);
      if (Date.now() >= deadlineMs) {
        timedOut = true;
        break;
      }
    }

    const newStatus = timedOut ? "timed_out" : "synthesized";
    const { data: claimedId, error: claimErr } = await step.run("claim", async () =>
      sb.rpc("claim_handoff_batch", {
        p_batch_id: batch_id,
        p_new_status: newStatus,
      }),
    );
    if (claimErr) {
      logger.warn(`handoff-batch-join: claim RPC error for ${batch_id}: ${claimErr.message}`);
      return { status: "error", reason: "claim_failed" };
    }
    if (!claimedId) {
      return { status: "skip", reason: "claim_lost" };
    }

    for (let w = 0; w * PARENT_REPLY_POLL_MS < PARENT_REPLY_WAIT_MS; w++) {
      const pending = await step.run(`parent-reply-pending-${w}`, () =>
        parentReplyPending(sb, batch.tenant_id as string, batch.parent_run_id as string),
      );
      if (!pending) break;
      await step.sleep(`parent-reply-wait-${w}`, `${PARENT_REPLY_POLL_MS}ms`);
    }

    const finalChildren = (await step.run("read-final-children", async () => {
      const { data } = await sb.from("agent_runs").select(CHILD_COLUMNS).in("id", childIds);
      return (data ?? []) as ChildRow[];
    })) as ChildRow[];

    const trusted: BatchRow = {
      tenant_id: batch.tenant_id as string,
      operator_thread_id: batch.operator_thread_id as string,
    };
    const { body, doneIds, pendingIds } = composeCombinedBody(trusted, childIds, finalChildren);

    await step.run("post-combined", async () => {
      const { error: insErr } = await sb.from("agent_thread_messages").upsert(
        {
          id: batch.id,
          thread_id: batch.operator_thread_id,
          tenant_id: batch.tenant_id,
          sender_role: "assistant",
          body,
          agent_run_id: null,
          meta: {
            from_agent_slug: "operator",
            handoff: true,
            parent_run_id: batch.parent_run_id,
            child_run_ids: doneIds,
          },
        },
        { onConflict: "id", ignoreDuplicates: true },
      );
      if (insErr) {
        throw new Error(`handoff-batch-join: post insert error for ${batch_id}: ${insErr.message}`);
      }
      await sb
        .from("agent_threads")
        .update({ last_message_at: new Date().toISOString() })
        .eq("id", batch.operator_thread_id);
    });

    if (doneIds.length > 0) {
      await step.run("push-combined", () =>
        notifyThreadOwner({
          tenant_id: trusted.tenant_id,
          thread_id: trusted.operator_thread_id,
          agent_slug: "operator",
          body: answersPushBody(
            finalChildren.filter((c) => doneIds.includes(c.id)).map((c) => agentDisplayName(c.agent_slug)),
          ),
        }),
      );
    }

    let waiting = [...pendingIds];
    for (let poll = 0; poll < FOLLOW_MAX_POLLS && waiting.length > 0; poll++) {
      await step.sleep(`follow-wait-${poll}`, FOLLOW_INTERVAL);
      const rows = (await step.run(`follow-read-${poll}`, async () => {
        const { data } = await sb.from("agent_runs").select(CHILD_COLUMNS).in("id", waiting);
        return (data ?? []) as ChildRow[];
      })) as ChildRow[];
      const landed = rows.filter((c) => !NON_TERMINAL.has(c.status));
      for (const c of landed) {
        await step.run(`follow-post-${c.id}`, () => postLateChild(sb, trusted, c));
      }
      const landedIds = new Set(landed.map((c) => c.id));
      waiting = waiting.filter((id) => !landedIds.has(id));
    }

    if (waiting.length > 0) {
      await step.run("follow-giveup", async () => {
        const rows = ((await sb.from("agent_runs").select("id, agent_slug").in("id", waiting)).data ??
          []) as Array<{ id: string; agent_slug: string }>;
        const names = waiting.map((id) => agentDisplayName(rows.find((r) => r.id === id)?.agent_slug ?? "specialist"));
        const line =
          names.length === 1
            ? `${names[0]} is still working after 30 minutes. Ask me to check on it anytime.`
            : `${joinNames(names)} are still working after 30 minutes. Ask me to check on them anytime.`;
        const { error } = await sb.from("agent_thread_messages").insert({
          thread_id: trusted.operator_thread_id,
          tenant_id: trusted.tenant_id,
          sender_role: "assistant",
          body: line,
          agent_run_id: null,
          meta: { from_agent_slug: "operator", handoff: true, parent_run_id: batch.parent_run_id },
        });
        if (error) throw new Error(`handoff-batch-join: give-up post error for ${batch_id}: ${error.message}`);
        await notifyThreadOwner({
          tenant_id: trusted.tenant_id,
          thread_id: trusted.operator_thread_id,
          agent_slug: "operator",
          body: line,
        });
      });
    }

    return {
      status: timedOut ? "timed_out" : "synthesized",
      batch_id,
      children: childIds.length,
      late_posted: pendingIds.length - waiting.length,
    };
  },
);

async function postLateChild(
  sb: ReturnType<typeof serviceClient>,
  batch: BatchRow,
  c: ChildRow,
): Promise<void> {
  const { error } = await sb.rpc("record_handoff_chat_message", {
    p_operator_thread_id: batch.operator_thread_id,
    p_tenant_id: batch.tenant_id,
    p_run_id: c.id,
    p_body: childSection(batch, c).slice(0, 32000),
  });
  if (error && (error as { code?: string }).code !== "23505") {
    throw new Error(`handoff-batch-join: late post error for run ${c.id}: ${error.message}`);
  }
  if (error) return;
  await notifyThreadOwner({
    tenant_id: batch.tenant_id,
    thread_id: batch.operator_thread_id,
    agent_slug: c.agent_slug,
    body: answersPushBody([agentDisplayName(c.agent_slug)]),
  });
}
