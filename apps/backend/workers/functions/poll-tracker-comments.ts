
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { writeNote } from "@/services/memory";
import { emitThreadEvent } from "@/services/agents/thread-event";
import {
  jiraListComments,
  AGENT_AUTO_SENTINEL as JIRA_SENTINEL,
  type TrackerComment,
} from "@/services/mcp/internal/jira";
import {
  linearListComments,
  AGENT_AUTO_SENTINEL as LINEAR_SENTINEL,
} from "@/services/mcp/internal/linear";

type LedgerRow = {
  tenant_id: string;
  connector: string;
  external_key: string;
  agent_run_id: string | null;
  agent_slug: string;
  last_seen_comment_at: string | null;
  seen_comment_ids: string[];
};

async function connectorEnabled(
  tenant_id: string,
  connector: string,
): Promise<boolean> {
  const { data } = await serviceClient()
    .from("tenant_mcp_servers")
    .select("enabled")
    .eq("tenant_id", tenant_id)
    .eq("server_id", connector)
    .maybeSingle();
  return (data as { enabled?: boolean } | null)?.enabled === true;
}

async function processRow(row: LedgerRow): Promise<number> {
  if (!(await connectorEnabled(row.tenant_id, row.connector))) return 0;

  const sentinel =
    row.connector === "jira" ? JIRA_SENTINEL : LINEAR_SENTINEL;
  let comments: TrackerComment[];
  if (row.connector === "jira") {
    comments = await jiraListComments(row.tenant_id, row.external_key);
  } else if (row.connector === "linear") {
    comments = await linearListComments(row.tenant_id, row.external_key);
  } else {
    return 0;
  }

  const cursor = row.last_seen_comment_at
    ? new Date(row.last_seen_comment_at).getTime()
    : 0;
  const seen = new Set(row.seen_comment_ids ?? []);

  const fresh = comments.filter((c) => {
    if (!c.id || seen.has(c.id)) return false;
    if (c.text.startsWith(sentinel)) return false;
    if (!c.text) return false;
    const t = c.created ? new Date(c.created).getTime() : 0;
    return t >= cursor;
  });
  if (fresh.length === 0) return 0;

  for (const c of fresh) {
    await writeNote(row.tenant_id, {
      title: `Operator feedback on ${row.connector}:${row.external_key}`,
      body_markdown: c.text,
      source: "operator_feedback",
      source_ref: `${row.connector}:${row.external_key}:${c.id}`,
      note_type: "agent_feedback",
      tags: [row.agent_slug, row.connector],
    });
    await emitThreadEvent({
      agent_run_id: row.agent_run_id,
      agent_slug: row.agent_slug,
      tenant_id: row.tenant_id,
      thread_id: null,
      kind: "reasoning",
      body: {
        iter: 0,
        text:
          `Operator replied on ${row.connector} ${row.external_key}: ` +
          c.text.slice(0, 7000),
      },
    });
  }

  const newest = fresh.reduce(
    (acc, c) => (new Date(c.created).getTime() > acc ? new Date(c.created).getTime() : acc),
    cursor,
  );
  const mergedIds = Array.from(
    new Set([...(row.seen_comment_ids ?? []), ...fresh.map((c) => c.id)]),
  ).slice(-500);

  await serviceClient()
    .from("connector_ticket_ledger")
    .update({
      last_seen_comment_at: new Date(newest).toISOString(),
      seen_comment_ids: mergedIds,
      updated_at: new Date().toISOString(),
    })
    .eq("tenant_id", row.tenant_id)
    .eq("connector", row.connector)
    .eq("external_key", row.external_key);

  return fresh.length;
}

export const pollTrackerCommentsFn = inngest.createFunction(
  { id: "poll-tracker-comments", concurrency: 1 },
  { cron: "50 * * * *" },
  async ({ logger }) => {
    const { data, error } = await serviceClient()
      .from("connector_ticket_ledger")
      .select(
        "tenant_id, connector, external_key, agent_run_id, agent_slug, last_seen_comment_at, seen_comment_ids",
      )
      .limit(500);
    if (error) {
      throw new Error(`connector_ticket_ledger scan failed: ${error.message}`);
    }
    let distilled = 0;
    let errors = 0;
    for (const row of (data ?? []) as LedgerRow[]) {
      try {
        distilled += await processRow(row);
      } catch (e) {
        errors++;
        logger.warn(
          `poll-tracker-comments: ${row.connector}:${row.external_key} failed — ${(e as Error).message}`,
        );
      }
    }
    logger.info(
      `poll-tracker-comments: scanned ${(data ?? []).length}, distilled ${distilled}, row-errors ${errors}`,
    );
    return { scanned: (data ?? []).length, distilled, errors };
  },
);
