
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { slackFetch } from "@/services/tools/slack/_client";
import { buildBatchControlBlocks } from "@/services/approvals/slack-approval-blocks";
import { budgetChoiceNote } from "@/services/approvals/budget-choice";
import {
  loadAllowlistableSet,
  loadDecisionHandlers,
  buildBubble,
  type PendingApprovalRow,
} from "./approval-slack-notify";
import { narrowApprovalTargets, type ApprovalCandidate } from "@/services/approvals/slack-approval-nl";

type NlRouteEvent = {
  tenant_id: string;
  run_ids: string[];
  thread_ts: string;
  channel_id: string;
  team_id: string | null;
  text: string;
};

function candidateSummary(body: unknown, cls: string | null): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const ev = (body as Record<string, unknown>).decision_evidence;
    if (ev && typeof ev === "object") {
      const r = (ev as Record<string, unknown>).reason_text;
      if (typeof r === "string" && r.trim()) return r.trim().slice(0, 120);
    }
    const b = body as Record<string, unknown>;
    if (typeof b.daily_budget_usd === "number") return `set daily budget to $${b.daily_budget_usd}/day`;
  }
  return cls ?? "decision";
}

export async function runSlackNlRoute(data: NlRouteEvent): Promise<{ reposted: number }> {
  const { tenant_id, run_ids, thread_ts, channel_id, team_id, text } = data;
  if (!channel_id || !thread_ts || run_ids.length === 0) return { reposted: 0 };
  const svc = serviceClient();

  const { data: rows, error } = await svc
    .from("decisions")
    .select("id, tenant_id, decision_class, agent_run_id, body")
    .eq("tenant_id", tenant_id)
    .in("agent_run_id", run_ids)
    .eq("status", "proposed")
    .eq("autonomy_at_emit", "approval")
    .limit(50);
  if (error) {
    console.warn(`[slack-nl-route] candidate scan failed: ${error.message}`);
    return { reposted: 0 };
  }
  const pending = (rows ?? []) as PendingApprovalRow[];
  if (pending.length === 0) {
    void postText(tenant_id, channel_id, thread_ts, team_id, "ℹ️ Nothing pending to act on in this thread.");
    return { reposted: 0 };
  }

  const candidates: ApprovalCandidate[] = pending.map((p, i) => ({
    index: i + 1,
    decision_class: p.decision_class,
    summary: candidateSummary(p.body, p.decision_class),
  }));
  let targetRows = pending;
  try {
    const picked = await narrowApprovalTargets(text, candidates, { tenantId: tenant_id });
    if (picked && picked.length > 0) {
      targetRows = picked.map((idx) => pending[idx - 1]).filter(Boolean);
      if (targetRows.length === 0) targetRows = pending;
    }
  } catch (e) {
    console.warn(`[slack-nl-route] narrow failed (re-posting all): ${(e as Error).message}`);
    targetRows = pending;
  }

  const allowlistableSet = await loadAllowlistableSet();
  const handlerByClass = await loadDecisionHandlers();
  void postText(
    tenant_id,
    channel_id,
    thread_ts,
    team_id,
    targetRows.length === pending.length
      ? `Here ${pending.length === 1 ? "is the" : `are the ${pending.length}`} pending approval${pending.length === 1 ? "" : "s"} from this thread — tap to act:`
      : `Here ${targetRows.length === 1 ? "is the one" : `are the ${targetRows.length}`} you mean — tap to act:`,
  );

  let reposted = 0;
  for (const row of targetRows) {
    try {
      const { blocks, fallback } = buildBubble(row, allowlistableSet, handlerByClass, await budgetChoiceNote(row.tenant_id, row));
      await slackFetch(
        tenant_id,
        "chat.postMessage",
        { channel: channel_id, text: fallback, blocks: JSON.stringify(blocks), thread_ts },
        team_id ?? undefined,
      );
      reposted++;
    } catch (e) {
      console.warn(`[slack-nl-route] re-post failed for ${row.id}: ${(e as Error).message}`);
    }
  }

  if (targetRows.length === pending.length && pending.length > 1 && run_ids.length === 1) {
    try {
      const blocks = buildBatchControlBlocks(run_ids[0], pending.length, Date.now());
      await slackFetch(
        tenant_id,
        "chat.postMessage",
        { channel: channel_id, text: "Approve or reject all", blocks: JSON.stringify(blocks), thread_ts },
        team_id ?? undefined,
      );
    } catch {
    }
  }

  return { reposted };
}

function postText(
  tenant_id: string,
  channel_id: string,
  thread_ts: string,
  team_id: string | null,
  text: string,
): Promise<unknown> {
  return slackFetch(tenant_id, "chat.postMessage", { channel: channel_id, text, thread_ts }, team_id ?? undefined).catch(
    (e) => console.warn(`[slack-nl-route] note post failed: ${(e as Error).message}`),
  );
}

export const slackNlRouteFn = inngest.createFunction(
  { id: "slack-nl-route", retries: 1, concurrency: 4 },
  { event: "slack.approval.nl_route" },
  async ({ event, step, logger }) => {
    const res = await step.run("nl-route", () => runSlackNlRoute(event.data as NlRouteEvent));
    logger?.info?.(`slack-nl-route: ${JSON.stringify(res)}`);
    return res;
  },
);
