
import type { SupabaseClient } from "@supabase/supabase-js";
import { requestStopForRun } from "@/services/agents/request-stop";
import { enqueueWorkItem } from "@/services/agents/work-queue";
import { reserveSlackAnswerBarrier } from "@/services/slack/outbox";
import { FleetHaltedError } from "@/services/agents/fleet-halt";
import {
  parseSlackMessageLifecycle,
  type SlackMessageLifecycle,
} from "@/services/slack/message-lifecycle-parser";

const NON_TERMINAL_STATUSES = ["queued", "running"] as const;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

type LifecycleRowState = {
  tombstoned: boolean;
  latest_edit_ts: string | null;
  latest_refire_event_id: string | null;
};

function extractEditContext(event: Record<string, unknown>): {
  edited_ts: string;
  user: string;
  thread_ts: string;
  is_bot: boolean;
} {
  const msg = (event.message as Record<string, unknown> | undefined) ?? {};
  const nestedEdited = (msg.edited as Record<string, unknown> | undefined) ?? {};
  const topEdited = (event.edited as Record<string, unknown> | undefined) ?? {};
  const botId = typeof msg.bot_id === "string" && msg.bot_id.length > 0 ? msg.bot_id : event.bot_id;
  return {
    edited_ts: str(nestedEdited.ts) || str(topEdited.ts),
    user: str(msg.user) || str(event.user),
    thread_ts: str(msg.thread_ts) || str(event.thread_ts),
    is_bot: typeof botId === "string" && botId.length > 0,
  };
}

export type ApplyLifecycleResult =
  | { handled: false; reason: string }
  | {
      handled: true;
      kind: "deleted" | "changed";
      channel_id: string;
      source_ts: string;
      runs_stopped: number;
      pending_items_dropped: number;
      refired: boolean;
    };

export async function applySlackMessageLifecycle(args: {
  sc: SupabaseClient;
  tenant_id: string;
  team_id: string;
  edit_event_id: string;
  event: Record<string, unknown>;
}): Promise<ApplyLifecycleResult> {
  const { sc, tenant_id, team_id, edit_event_id, event } = args;

  const lifecycle: SlackMessageLifecycle = parseSlackMessageLifecycle(event);
  if (!lifecycle) return { handled: false, reason: "not_lifecycle_event" };
  if (!tenant_id || !team_id) {
    return { handled: false, reason: "missing_tenant_or_team" };
  }

  const { kind, channel_id, source_ts } = lifecycle;

  if (kind === "deleted") {
    const { error: rpcErr } = await sc.rpc("mark_slack_source_lifecycle", {
      p_tenant: tenant_id,
      p_team: team_id,
      p_channel: channel_id,
      p_source_ts: source_ts,
      p_tombstone: true,
      p_edit_ts: null,
      p_refire_event_id: null,
    });
    if (rpcErr) {
      throw new Error(`mark_slack_source_lifecycle (delete) failed: ${rpcErr.message}`);
    }
    const runs_stopped = await stopSourceRuns({ sc, tenant_id, team_id, channel_id, source_ts });
    const pending_items_dropped = await dropSourceItems({
      sc, tenant_id, team_id, channel_id, source_ts,
    });
    return {
      handled: true, kind, channel_id, source_ts, runs_stopped, pending_items_dropped,
      refired: false,
    };
  }

  const editCtx = extractEditContext(event);
  if (!editCtx.edited_ts || editCtx.is_bot) {
    return { handled: false, reason: "not_user_edit" };
  }

  const { data: rpcData, error: rpcErr } = await sc.rpc("mark_slack_source_lifecycle", {
    p_tenant: tenant_id,
    p_team: team_id,
    p_channel: channel_id,
    p_source_ts: source_ts,
    p_tombstone: false,
    p_edit_ts: editCtx.edited_ts,
    p_refire_event_id: edit_event_id,
  });
  if (rpcErr) {
    throw new Error(`mark_slack_source_lifecycle (edit) failed: ${rpcErr.message}`);
  }
  const state = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as LifecycleRowState | undefined;
  const winnerEventId = state?.latest_refire_event_id ?? null;

  if (state?.tombstoned) {
    const runs_stopped = await stopSourceRuns({ sc, tenant_id, team_id, channel_id, source_ts });
    return {
      handled: true, kind, channel_id, source_ts, runs_stopped, pending_items_dropped: 0,
      refired: false,
    };
  }

  if (state?.latest_edit_ts !== editCtx.edited_ts || winnerEventId !== edit_event_id) {
    return {
      handled: true, kind, channel_id, source_ts, runs_stopped: 0, pending_items_dropped: 0,
      refired: false,
    };
  }

  const runs_stopped = await stopSourceRuns({
    sc, tenant_id, team_id, channel_id, source_ts, excludeEventId: winnerEventId,
  });
  const pending_items_dropped = await dropSourceItems({
    sc, tenant_id, team_id, channel_id, source_ts, excludeEventId: winnerEventId,
  });

  let refired = false;
  const thread_ts = editCtx.thread_ts || source_ts;
  try {
    await enqueueWorkItem({
      tenant_id,
      agent_slug: "operator",
      source: "webhook_slack",
      dedupe_key: `slack:${edit_event_id}`,
      payload: {
        event_type: "message",
        slack: {
          channel_id,
          thread_ts,
          original_ts: source_ts,
          event_id: edit_event_id,
          text: lifecycle.new_text,
          user: editCtx.user,
          team_id,
        },
      },
    });
    refired = true;
    await reserveSlackAnswerBarrier({ tenant_id, channel_id, thread_ts, event_id: edit_event_id });
  } catch (e) {
    if (!(e instanceof FleetHaltedError)) {
      console.warn(
        `[source-message-lifecycle] re-fire enqueue failed (${channel_id}/${source_ts}): ${(e as Error).message}`,
      );
    }
  }

  return {
    handled: true, kind, channel_id, source_ts, runs_stopped, pending_items_dropped, refired,
  };
}

async function stopSourceRuns(args: {
  sc: SupabaseClient;
  tenant_id: string;
  team_id: string;
  channel_id: string;
  source_ts: string;
  excludeEventId?: string | null;
}): Promise<number> {
  const { sc, tenant_id, team_id, channel_id, source_ts, excludeEventId } = args;
  let q = sc
    .from("agent_runs")
    .select("id")
    .eq("tenant_id", tenant_id)
    .eq("trigger", "slack")
    .eq("payload->slack->>team_id", team_id)
    .eq("payload->slack->>channel_id", channel_id)
    .eq("payload->slack->>original_ts", source_ts)
    .in("status", NON_TERMINAL_STATUSES as unknown as string[]);
  if (excludeEventId) q = q.neq("payload->slack->>event_id", excludeEventId);

  const { data: rows, error } = await q;
  if (error) {
    console.warn(
      `[source-message-lifecycle] run lookup failed (${channel_id}/${source_ts}): ${error.message}`,
    );
    return 0;
  }
  let stopped = 0;
  for (const r of (rows ?? []) as Array<{ id: string }>) {
    const res = await requestStopForRun(sc, tenant_id, r.id);
    if (res.ok && "cancelling" in res) stopped += 1;
  }
  return stopped;
}

async function dropSourceItems(args: {
  sc: SupabaseClient;
  tenant_id: string;
  team_id: string;
  channel_id: string;
  source_ts: string;
  excludeEventId?: string | null;
}): Promise<number> {
  const { sc, tenant_id, team_id, channel_id, source_ts, excludeEventId } = args;
  let q = sc
    .from("agent_work_items")
    .update({ status: "dropped", updated_at: new Date().toISOString() })
    .eq("tenant_id", tenant_id)
    .eq("status", "pending")
    .eq("payload->slack->>team_id", team_id)
    .eq("payload->slack->>channel_id", channel_id)
    .eq("payload->slack->>original_ts", source_ts);
  if (excludeEventId) q = q.neq("payload->slack->>event_id", excludeEventId);

  const { data, error } = await q.select("id");
  if (error) {
    console.warn(
      `[source-message-lifecycle] work-item drop failed (${channel_id}/${source_ts}): ${error.message}`,
    );
    return 0;
  }
  return Array.isArray(data) ? data.length : 0;
}

export type ReplySuppression =
  | { suppressed: false }
  | { suppressed: true; reason: "tombstoned" | "superseded" };

export async function isSlackReplySuppressed(args: {
  sc: SupabaseClient;
  tenant_id: string;
  team_id: string;
  channel_id: string;
  source_ts: string;
  run_event_id: string;
}): Promise<ReplySuppression> {
  const { sc, tenant_id, team_id, channel_id, source_ts, run_event_id } = args;
  if (!tenant_id || !team_id || !channel_id || !source_ts) {
    return { suppressed: false };
  }

  const { data, error } = await sc
    .from("slack_source_message_lifecycle")
    .select("tombstoned, latest_edit_ts, latest_refire_event_id")
    .eq("tenant_id", tenant_id)
    .eq("team_id", team_id)
    .eq("channel_id", channel_id)
    .eq("source_ts", source_ts)
    .maybeSingle<LifecycleRowState>();

  if (error) {
    console.warn(
      `[source-message-lifecycle] suppression read failed (${channel_id}/${source_ts}): ${error.message}`,
    );
    return { suppressed: false };
  }
  if (!data) return { suppressed: false };

  if (data.tombstoned) return { suppressed: true, reason: "tombstoned" };

  if (data.latest_edit_ts != null && run_event_id !== data.latest_refire_event_id) {
    return { suppressed: true, reason: "superseded" };
  }

  return { suppressed: false };
}
