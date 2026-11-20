
import { z } from "zod";
import { serviceClient } from "@/services/supabase";
import { jiraCreateIssue } from "@/services/mcp/internal/jira";
import { linearCreateIssue } from "@/services/mcp/internal/linear";
import { postMessageTool } from "@/services/tools/slack/post_message";
import {
  claimDecision,
  markDispatched,
  releaseClaim,
  type ClaimedDecisionRow,
} from "./atomic-claim";
import { checkAutoFireRateCap } from "./auto-fire-rate-cap";
import { isFleetHalted } from "@/services/agents/fleet-halt";
import { logEvent } from "@/services/logging/logEvent";
import { logDecisionNotTaken } from "@/services/agents/log-decision-not-taken";

const jiraCreateBody = z.object({
  project_key: z.string().min(1),
  issue_type: z.string().min(1).default("Task"),
  summary: z.string().min(1).max(255),
  description_markdown: z.string().max(30000).default(""),
});
const linearCreateBody = z.object({
  team_id: z.string().min(1),
  title: z.string().min(1).max(255),
  description_markdown: z.string().max(30000).default(""),
});
const slackPostBody = z.object({
  channel_id: z.string().min(1),
  text: z.string().min(1).max(39000),
  thread_ts: z.string().optional(),
});

export type OperatorActionStatus =
  | "executed"
  | "race_lost"
  | "pending_approval"
  | "rate_capped"
  | "rejected"
  | "failed";

export type OperatorActionResult = {
  ok: boolean;
  status: OperatorActionStatus;
  error?: string;
  not_started?: boolean;
  result?: {
    external_key?: string;
    channel?: string;
    ts?: string;
    url?: string;
  };
  already_claimed?: boolean;
};

export async function executeOperatorAction(
  decision_id: string,
): Promise<OperatorActionResult> {
  const peek = await serviceClient()
    .from("decisions")
    .select("status, autonomy_at_emit, tenant_id, decision_class")
    .eq("id", decision_id)
    .maybeSingle();
  const peekRow = peek.data as {
    status?: string;
    autonomy_at_emit?: string;
    tenant_id?: string;
    decision_class?: string;
  } | null;
  if (
    !peek.error &&
    peekRow &&
    peekRow.status === "proposed" &&
    peekRow.autonomy_at_emit === "auto" &&
    peekRow.tenant_id &&
    peekRow.decision_class
  ) {
    const capRes = await checkAutoFireRateCap(
      peekRow.tenant_id,
      peekRow.decision_class,
    );
    if (!capRes.allowed) {
      await logEvent({
        level: "warn",
        source: "operator-action-execute",
        code:
          capRes.reason === "count_error"
            ? "auto_fire_rate_cap_count_error"
            : "auto_fire_rate_capped",
        message:
          capRes.reason === "count_error"
            ? `auto-fire rate-cap count errored for class — failing closed, decision left proposed for manual approval`
            : `auto-fire rate cap reached for class — decision left proposed for manual approval`,
        tenant_id: peekRow.tenant_id,
        meta: {
          decision_class: peekRow.decision_class,
          count: capRes.count,
          cap: capRes.cap,
        },
      });
      await logDecisionNotTaken({
        tenant_id: peekRow.tenant_id,
        rejection_type: "cap_exceeded",
        decision_class: peekRow.decision_class,
        reason_code:
          capRes.reason === "count_error"
            ? "auto_fire_rate_cap_count_error"
            : "auto_fire_rate_capped",
      });
      return { ok: true, status: "rate_capped" };
    }
  }

  const row = await claimDecision(decision_id);
  if (!row) {
    const peek = await serviceClient()
      .from("decisions")
      .select("status, autonomy_at_emit")
      .eq("id", decision_id)
      .maybeSingle();
    const s = (peek.data as { status?: string } | null)?.status;
    const a = (peek.data as { autonomy_at_emit?: string } | null)?.autonomy_at_emit;
    if (s === "proposed" && a === "approval") {
      return { ok: true, status: "pending_approval" };
    }
    if (s === "rejected") {
      return { ok: true, status: "rejected" };
    }
    return { ok: true, status: "race_lost", already_claimed: true };
  }

  if (await isFleetHalted()) {
    await releaseClaim(decision_id, "fleet_halted");
    return { ok: false, status: "failed", error: "fleet_halted", not_started: true };
  }

  try {
    switch (row.decision_class) {
      case "operator.file-jira-issue":
        return await runJiraCreate(row);
      case "operator.file-linear-issue":
        return await runLinearCreate(row);
      case "operator.post-slack-message":
        return await runSlackPost(row);
      default: {
        const msg = `operator-action-execute: unsupported decision_class "${row.decision_class}"`;
        await releaseClaim(decision_id, msg);
        return { ok: false, status: "failed", error: msg, not_started: true };
      }
    }
  } catch (e) {
    const msg = (e as Error).message ?? "executeOperatorAction threw";
    await releaseClaim(decision_id, msg);
    return { ok: false, status: "failed", error: msg };
  }
}

async function runJiraCreate(
  row: ClaimedDecisionRow,
): Promise<OperatorActionResult> {
  const parsed = jiraCreateBody.safeParse(row.body);
  if (!parsed.success) {
    const msg = `jira.create_issue body invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`;
    await releaseClaim(row.id, msg);
    return { ok: false, status: "failed", error: msg, not_started: true };
  }
  const r = await jiraCreateIssue(row.tenant_id, parsed.data);
  if (!r.key) {
    await releaseClaim(row.id, "jira create returned no key");
    return { ok: false, status: "failed", error: "jira create returned no key" };
  }
  await recordTicketLedger(row, "jira", r.key);
  await markDispatched(row.id);
  const siteName = await fetchJiraSiteName(row.tenant_id);
  const browseUrl = siteName
    ? `https://${siteName}.atlassian.net/browse/${r.key}`
    : undefined;
  return {
    ok: true,
    status: "executed",
    result: { external_key: r.key, url: browseUrl },
  };
}

async function fetchJiraSiteName(tenant_id: string): Promise<string | null> {
  const { data, error } = await serviceClient()
    .from("connector_metadata")
    .select("team_name")
    .eq("tenant_id", tenant_id)
    .eq("slug", "jira")
    .maybeSingle();
  if (error) {
    console.warn(
      `[operator-action-execute] connector_metadata read failed for jira/${tenant_id}: ${error.message}`,
    );
    return null;
  }
  const name = (data as { team_name?: string } | null)?.team_name ?? null;
  if (!name || !/^[a-z0-9][a-z0-9-]*$/i.test(name)) return null;
  return name;
}

async function runLinearCreate(
  row: ClaimedDecisionRow,
): Promise<OperatorActionResult> {
  const parsed = linearCreateBody.safeParse(row.body);
  if (!parsed.success) {
    const msg = `linear.create_issue body invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`;
    await releaseClaim(row.id, msg);
    return { ok: false, status: "failed", error: msg, not_started: true };
  }
  const r = await linearCreateIssue(row.tenant_id, parsed.data);
  const key = r.identifier || r.id;
  if (!key) {
    await releaseClaim(row.id, "linear create returned no identifier");
    return { ok: false, status: "failed", error: "linear create returned no identifier" };
  }
  await recordTicketLedger(row, "linear", key);
  await markDispatched(row.id);
  return {
    ok: true,
    status: "executed",
    result: { external_key: key, url: r.url || undefined },
  };
}

async function runSlackPost(
  row: ClaimedDecisionRow,
): Promise<OperatorActionResult> {
  const parsed = slackPostBody.safeParse(row.body);
  if (!parsed.success) {
    const msg = `slack.post_message body invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`;
    await releaseClaim(row.id, msg);
    return { ok: false, status: "failed", error: msg, not_started: true };
  }
  const ctx = {
    tenant_id: row.tenant_id,
    log: () => {},
  };
  const out = (await postMessageTool.execute(ctx, parsed.data)) as {
    ts?: string;
    channel?: string;
  };
  await markDispatched(row.id);
  return {
    ok: true,
    status: "executed",
    result: {
      channel: out.channel ?? parsed.data.channel_id,
      ts: out.ts ?? "",
    },
  };
}

async function recordTicketLedger(
  row: ClaimedDecisionRow,
  connector: "jira" | "linear",
  external_key: string,
): Promise<void> {
  if (!external_key) return;
  let agent_slug = "unknown";
  if (row.agent_run_id) {
    const { data } = await serviceClient()
      .from("agent_runs")
      .select("agent_slug")
      .eq("id", row.agent_run_id)
      .maybeSingle();
    agent_slug =
      (data as { agent_slug?: string } | null)?.agent_slug ?? "unknown";
  }
  const { error } = await serviceClient()
    .from("connector_ticket_ledger")
    .upsert(
      {
        tenant_id: row.tenant_id,
        connector,
        external_key,
        agent_run_id: row.agent_run_id,
        agent_slug,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,connector,external_key" },
    );
  if (error) {
    console.warn(
      `[operator-action-execute] ${connector} ledger upsert failed for ${external_key}: ${error.message}`,
    );
  }
}
