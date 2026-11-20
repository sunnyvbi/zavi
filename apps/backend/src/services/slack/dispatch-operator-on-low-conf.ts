
import { OPERATOR_SLUG } from "./routing";
import { enqueueAgentRun } from "@/services/agents/runner";
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";

const ENQUEUE_TIMEOUT_MS = 30_000;

export const LOW_CONF_PLACEHOLDER =
  "On it. Pulling your context together now.";

export const LOW_CONF_RECOVERY_TEXT =
  "Sorry, I couldn't pull context fast enough. Try rephrasing with a specific area (marketing, ops, code, etc.) or DM me directly with more context.";

export interface DispatchInput {
  tenant_id: string;
  channel_id: string;
  thread_ts: string;
  source_message_ts: string;
  source_event_id: string;
  user_message: string;
  user?: string;
  slack_trace_id?: string;
  source_team_id?: string;
}

export type DispatchOutcome =
  | { kind: "enqueued"; run_id: string }
  | { kind: "duplicate" }
  | { kind: "enqueue_failed"; reason: "timeout" | "error"; error?: string };

function withTimeout<T>(
  label: string,
  ms: number,
  fn: () => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}_timeout_${ms}ms`)),
      ms,
    );
    fn().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export async function dispatchOperatorOnLowConf(
  input: DispatchInput,
): Promise<DispatchOutcome> {
  const sb = serviceClient();

  const { error: insertErr } = await sb.from("low_conf_dispatches").insert({
    tenant_id: input.tenant_id,
    channel_id: input.channel_id,
    thread_ts: input.thread_ts,
    source_message_ts: input.source_message_ts,
    status: "pending_reply",
  });
  if (insertErr) {
    if (insertErr.code === "23505") {
      return { kind: "duplicate" };
    }
    await logEvent({
      level: "warn",
      source: "slack.low_conf_dispatch",
      code: "low_conf_dispatch_ledger_insert_failed",
      message: `ledger insert failed before enqueue: ${insertErr.message}`,
      tenant_id: input.tenant_id,
    });
    return {
      kind: "enqueue_failed",
      reason: "error",
      error: insertErr.message,
    };
  }

  let run_id: string | null = null;
  try {
    const result = await withTimeout(
      "low_conf_dispatch_enqueue",
      ENQUEUE_TIMEOUT_MS,
      () =>
        enqueueAgentRun({
          agent_slug: OPERATOR_SLUG,
          tenant_id: input.tenant_id,
          trigger: "slack",
          cron_dedupe_key: `slack:${input.source_event_id}`,
          payload: {
            slack: {
              channel_id: input.channel_id,
              thread_ts: input.thread_ts,
              original_ts: input.source_message_ts,
              event_id: input.source_event_id,
              text: input.user_message,
              user: input.user,
              team_id: input.source_team_id,
              slack_trace_id: input.slack_trace_id ?? "",
            },
            low_conf_dispatch: true,
          },
        }),
    );
    run_id = result.run_id;
  } catch (e) {
    const msg = (e as Error).message ?? "unknown";
    const isTimeout = msg.includes("timeout");
    await sb
      .from("low_conf_dispatches")
      .update({ status: "enqueue_failed" })
      .eq("tenant_id", input.tenant_id)
      .eq("channel_id", input.channel_id)
      .eq("thread_ts", input.thread_ts)
      .eq("source_message_ts", input.source_message_ts);
    await logEvent({
      level: "warn",
      source: "slack.low_conf_dispatch",
      code: isTimeout
        ? "low_conf_dispatch_enqueue_timeout"
        : "low_conf_dispatch_enqueue_failed",
      message: `enqueue ${isTimeout ? "timed out" : "failed"}: ${msg}`,
      tenant_id: input.tenant_id,
    });
    return {
      kind: "enqueue_failed",
      reason: isTimeout ? "timeout" : "error",
      error: msg,
    };
  }

  if (!run_id) {
    const { error: dedupeMarkErr } = await sb
      .from("low_conf_dispatches")
      .update({ status: "replied", replied_at: new Date().toISOString() })
      .eq("tenant_id", input.tenant_id)
      .eq("channel_id", input.channel_id)
      .eq("thread_ts", input.thread_ts)
      .eq("source_message_ts", input.source_message_ts);
    if (dedupeMarkErr) {
      await logEvent({
        level: "warn",
        source: "slack.low_conf_dispatch",
        code: "low_conf_dispatch_dedupe_mark_failed",
        message: `dedupe-loser ledger mark failed (sweep may post recovery on top): ${dedupeMarkErr.message}`,
        tenant_id: input.tenant_id,
      });
    }
    return { kind: "duplicate" };
  }

  const { error: updateErr } = await sb
    .from("low_conf_dispatches")
    .update({ run_id })
    .eq("tenant_id", input.tenant_id)
    .eq("channel_id", input.channel_id)
    .eq("thread_ts", input.thread_ts)
    .eq("source_message_ts", input.source_message_ts);
  if (updateErr) {
    await logEvent({
      level: "warn",
      source: "slack.low_conf_dispatch",
      code: "low_conf_dispatch_ledger_stamp_failed",
      message: `run_id stamp failed (sweep will still recover by composite key): ${updateErr.message}`,
      tenant_id: input.tenant_id,
      meta: { run_id },
    });
  }

  return { kind: "enqueued", run_id: run_id! };
}

export interface StuckDispatch {
  tenant_id: string;
  channel_id: string;
  thread_ts: string;
  source_message_ts: string;
  run_id: string | null;
  dispatched_at: string;
}

export async function findStuckLowConfDispatches(
  cutoff_ms = 60_000,
): Promise<StuckDispatch[]> {
  const sb = serviceClient();
  const cutoffIso = new Date(Date.now() - cutoff_ms).toISOString();
  const { data, error } = await sb
    .from("low_conf_dispatches")
    .select("tenant_id, channel_id, thread_ts, source_message_ts, run_id, dispatched_at")
    .in("status", ["pending_reply", "enqueue_failed"])
    .lt("dispatched_at", cutoffIso)
    .limit(50);
  if (error) {
    await logEvent({
      level: "warn",
      source: "slack.low_conf_dispatch.sweep",
      code: "low_conf_dispatch_sweep_scan_failed",
      message: `sweep scan failed: ${error.message}`,
    });
    return [];
  }
  return (data ?? []) as StuckDispatch[];
}

export async function markLowConfDispatchRecovered(
  row: StuckDispatch,
): Promise<void> {
  const sb = serviceClient();
  const { error } = await sb
    .from("low_conf_dispatches")
    .update({ status: "recovered", recovered_at: new Date().toISOString() })
    .eq("tenant_id", row.tenant_id)
    .eq("channel_id", row.channel_id)
    .eq("thread_ts", row.thread_ts)
    .eq("source_message_ts", row.source_message_ts)
    .in("status", ["pending_reply", "enqueue_failed"]);
  if (error) {
    await logEvent({
      level: "warn",
      source: "slack.low_conf_dispatch.sweep",
      code: "low_conf_dispatch_mark_recovered_failed",
      message: `mark recovered failed: ${error.message}`,
      tenant_id: row.tenant_id,
    });
  }
}

export async function markLowConfDispatchReplied(
  run_id: string,
): Promise<void> {
  const sb = serviceClient();
  const { error } = await sb
    .from("low_conf_dispatches")
    .update({ status: "replied", replied_at: new Date().toISOString() })
    .eq("run_id", run_id)
    .eq("status", "pending_reply");
  if (error) {
    await logEvent({
      level: "warn",
      source: "slack.low_conf_dispatch",
      code: "low_conf_dispatch_mark_replied_failed",
      message: `mark replied failed for run ${run_id}: ${error.message}`,
    });
  }
}
