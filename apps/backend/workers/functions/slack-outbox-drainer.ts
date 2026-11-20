
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { callMcpTool } from "@/services/mcp/execute";
import { logEvent } from "@/services/logging/logEvent";
import { slackPostErrorFrom } from "@/services/tools/slack/_post_error";
import { decodeOutboxBody } from "@/services/slack/outbox-body";

const MAX_ATTEMPTS = 5;
const CLAIM_LIMIT = 50;
const MAX_PASSES = 10;

function cgoNoteExtras(body: string): { unfurl_links: false; blocks?: string } {
  const { blocks } = decodeOutboxBody(body);
  return { unfurl_links: false, ...(blocks ? { blocks: JSON.stringify(blocks) } : {}) };
}

type OutboxRow = {
  id: number;
  tenant_id: string;
  team_id: string | null;
  channel_id: string;
  thread_ts: string | null;
  run_id: string | null;
  kind: string;
  body: string;
  seq: number;
  attempts: number;
};

export function extractSlackTs(result: unknown): string | null {
  const r = result as { content?: unknown; ts?: unknown } | null;
  if (r && typeof r.content === "string") {
    try {
      const parsed = JSON.parse(r.content) as { ts?: unknown };
      if (typeof parsed.ts === "string" && parsed.ts) return parsed.ts;
    } catch {
    }
  }
  return typeof r?.ts === "string" && r.ts ? r.ts : null;
}

export function nextStatusOnFailure(attempts: number, max: number = MAX_ATTEMPTS): "pending" | "failed" {
  return attempts >= max ? "failed" : "pending";
}

export function outboxThreadTs(threadTs: string | null | undefined): string | undefined {
  return threadTs ? threadTs : undefined;
}

const STALE_SENDING_SECONDS = 300;

async function drainOnce(): Promise<{ posted: number; failed: number; requeued: number; reaped: number }> {
  const svc = serviceClient();
  let posted = 0;
  let failed = 0;
  let requeued = 0;
  let reaped = 0;

  try {
    const { data: reapedCount } = await svc.rpc("reap_stale_slack_outbox", {
      p_older_seconds: STALE_SENDING_SECONDS,
    });
    reaped = typeof reapedCount === "number" ? reapedCount : 0;
    if (reaped > 0) {
      await logEvent({
        level: "warn",
        source: "slack.outbox",
        code: "stale_sending_reaped",
        meta: { count: String(reaped) },
      });
    }
  } catch {
  }

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const { data: rows, error } = await svc.rpc("claim_ready_slack_outbox", { p_limit: CLAIM_LIMIT });
    if (error) {
      await logEvent({ level: "warn", source: "slack.outbox", code: "claim_failed" });
      break;
    }
    const claimed = (rows ?? []) as OutboxRow[];
    if (claimed.length === 0) break;

    for (const row of claimed) {
      try {
        const res = await callMcpTool(
          {
            tenant_id: row.tenant_id,
            run_id: row.run_id ?? "",
            slack_target_team_id: row.team_id ?? undefined,
            slack_inbound_delivery: true,
          },
          "slack",
          "post_message",
          {
            channel_id: row.channel_id,
            text: row.kind === "cgo_note" ? decodeOutboxBody(row.body).text : row.body,
            thread_ts: outboxThreadTs(row.thread_ts),
            ...(row.kind === "cgo_note" ? cgoNoteExtras(row.body) : {}),
          },
        );
        if (res.is_error) {
          const { code, detail } = slackPostErrorFrom(res.content);
          throw new Error(detail ? `${code}: ${detail}` : code);
        }
        await svc
          .from("slack_outbox")
          .update({ status: "sent", slack_ts: extractSlackTs(res), sent_at: new Date().toISOString() })
          .eq("id", row.id);
        posted++;
      } catch (e) {
        const nextStatus = nextStatusOnFailure(row.attempts, MAX_ATTEMPTS);
        const terminal = nextStatus === "failed";
        await svc
          .from("slack_outbox")
          .update({
            status: nextStatus,
            last_error: terminal ? (e instanceof Error ? e.message.slice(0, 200) : "post_failed") : null,
          })
          .eq("id", row.id);
        if (terminal) failed++;
        else requeued++;
        await logEvent({
          level: "warn",
          source: "slack.outbox",
          code: terminal ? "deliver_failed_terminal" : "deliver_retry",
          tenant_id: row.tenant_id,
          run_id: row.run_id ?? undefined,
          meta: {
            kind: row.kind,
            attempts: String(row.attempts + 1),
            reason: e instanceof Error ? e.message.slice(0, 120) : "post_failed",
          },
        });
      }
    }
    if (claimed.length < CLAIM_LIMIT) break;
  }

  return { posted, failed, requeued, reaped };
}

export const slackOutboxDrainerFn = inngest.createFunction(
  { id: "slack-outbox-drainer", concurrency: 2, retries: 1 },
  [{ cron: "*/5 * * * *" }, { event: "slack.outbox.enqueued" }],
  async ({ step, logger }) => {
    const res = await step.run("drain", () => drainOnce());
    logger.info(`slack-outbox-drainer: ${JSON.stringify(res)}`);
    return res;
  },
);
