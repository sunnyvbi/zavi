
import { inngest } from "../client";
import {
  findStuckLowConfDispatches,
  markLowConfDispatchRecovered,
  LOW_CONF_RECOVERY_TEXT,
} from "@/services/slack/dispatch-operator-on-low-conf";
import { callMcpTool } from "@/services/mcp/execute";
import { logEvent } from "@/services/logging/logEvent";
import { serviceClient } from "@/services/supabase";

const STUCK_CUTOFF_MS = 60_000;

export async function runLowConfDispatchSweepHandler(): Promise<{
  scanned: number;
  recovered: number;
  failed_post: number;
}> {
  const stuck = await findStuckLowConfDispatches(STUCK_CUTOFF_MS);
  let recovered = 0;
  let failed_post = 0;

  const sb = serviceClient();
  for (const row of stuck) {
    if (row.source_message_ts) {
      const { data: claimed } = await sb
        .from("slack_triage_claims")
        .update({ status: "done", replied_at: new Date().toISOString() })
        .eq("tenant_id", row.tenant_id)
        .eq("event_id", row.source_message_ts)
        .is("replied_at", null)
        .select("event_id");
      void claimed;
    }

    const { data: chRow } = await sb
      .from("slack_channels")
      .select("team_id")
      .eq("tenant_id", row.tenant_id)
      .eq("channel_id", row.channel_id)
      .limit(1)
      .maybeSingle<{ team_id: string | null }>();
    const recoveryTeamId =
      typeof chRow?.team_id === "string" && chRow.team_id ? chRow.team_id : undefined;

    const result = await callMcpTool(
      { tenant_id: row.tenant_id, run_id: "", slack_target_team_id: recoveryTeamId },
      "slack",
      "post_message",
      {
        channel_id: row.channel_id,
        text: LOW_CONF_RECOVERY_TEXT,
        thread_ts: row.thread_ts,
      },
    );
    if (result.is_error) {
      failed_post += 1;
      await logEvent({
        level: "warn",
        source: "slack.low_conf_dispatch.sweep",
        code: "low_conf_dispatch_recovery_post_failed",
        message: `recovery post failed for ${row.tenant_id}:${row.channel_id}:${row.thread_ts}`,
        tenant_id: row.tenant_id,
      });
      continue;
    }
    await markLowConfDispatchRecovered(row);
    recovered += 1;
    await logEvent({
      level: "warn",
      source: "slack.low_conf_dispatch.sweep",
      code: "low_conf_dispatch_no_reply",
      message: `recovered stuck dispatch for ${row.tenant_id} after ${STUCK_CUTOFF_MS}ms`,
      tenant_id: row.tenant_id,
      meta: { run_id: row.run_id, dispatched_at: row.dispatched_at },
    });
  }

  return { scanned: stuck.length, recovered, failed_post };
}

export const lowConfDispatchSweepFn = inngest.createFunction(
  { id: "low-conf-dispatch-sweep", concurrency: 1 },
  { cron: "*/5 * * * *" },
  async ({ logger }) => {
    const res = await runLowConfDispatchSweepHandler();
    logger.info(
      `low-conf-dispatch-sweep: scanned=${res.scanned} recovered=${res.recovered} failed_post=${res.failed_post}`,
    );
    return res;
  },
);
