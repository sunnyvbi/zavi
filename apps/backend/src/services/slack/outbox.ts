
import { serviceClient } from "@/services/supabase";
import { inngest } from "@/../workers/client";
import { logEvent } from "@/services/logging/logEvent";

export type SlackOutboxKind =
  | "answer_anchor"
  | "remember"
  | "handoff_ack"
  | "pr_link"
  | "low_conf"
  | "artifact_link"
  | "repo_access"
  | "reply_tail"
  | "welcome_dm"
  | "channel_intro"
  | "connector_alert"
  | "social_publish_result"
  | "ad_launch_result"
  | "cgo_note"
  | "live_stunt_review"
  | "metric_anomaly"
  | "site_check_result"
  | "cgo_reply_result";

export type EnqueueSlackOutboxArgs = {
  tenant_id: string;
  channel_id: string;
  thread_ts?: string | null;
  kind: SlackOutboxKind;
  body: string;
  run_id?: string | null;
  team_id?: string | null;
  idempotency_key?: string | null;
  depends_on_answer?: boolean;
};

export async function enqueueSlackOutbox(args: EnqueueSlackOutboxArgs): Promise<number | null> {
  try {
    const { data, error } = await serviceClient().rpc("enqueue_slack_outbox", {
      p_tenant_id: args.tenant_id,
      p_channel_id: args.channel_id,
      p_thread_ts: args.thread_ts ?? "",
      p_kind: args.kind,
      p_body: args.body,
      p_run_id: args.run_id ?? null,
      p_team_id: args.team_id ?? null,
      p_idempotency_key: args.idempotency_key ?? null,
      p_anchor: false,
      p_anchor_slack_ts: null,
      p_depends_on_answer: args.depends_on_answer ?? false,
    });
    if (error) {
      await logEvent({
        level: "warn",
        source: "slack.outbox",
        code: "enqueue_failed",
        tenant_id: args.tenant_id,
        run_id: args.run_id ?? undefined,
        meta: { kind: args.kind },
      });
      return null;
    }
    void inngest
      .send({ name: "slack.outbox.enqueued", data: { tenant_id: args.tenant_id } })
      .catch(() => {});
    return typeof data === "number" ? data : null;
  } catch {
    return null;
  }
}

export function answerBarrierKey(eventId: string): string {
  return `barrier:${eventId}`;
}

export async function reserveSlackAnswerBarrier(args: {
  tenant_id: string;
  channel_id: string;
  thread_ts?: string | null;
  event_id: string;
  run_id?: string | null;
}): Promise<void> {
  if (!args.event_id || !args.channel_id) return;
  try {
    await serviceClient().rpc("reserve_slack_answer_barrier", {
      p_tenant_id: args.tenant_id,
      p_channel_id: args.channel_id,
      p_thread_ts: args.thread_ts ?? "",
      p_run_id: args.run_id ?? null,
      p_idempotency_key: answerBarrierKey(args.event_id),
    });
  } catch {
  }
}

export async function completeSlackAnswerBarrier(args: {
  tenant_id: string;
  channel_id: string;
  thread_ts?: string | null;
  event_id: string;
  run_id?: string | null;
  slack_ts?: string | null;
}): Promise<void> {
  if (!args.event_id || !args.channel_id) return;
  try {
    await serviceClient().rpc("complete_slack_answer_barrier", {
      p_tenant_id: args.tenant_id,
      p_channel_id: args.channel_id,
      p_thread_ts: args.thread_ts ?? "",
      p_run_id: args.run_id ?? null,
      p_idempotency_key: answerBarrierKey(args.event_id),
      p_slack_ts: args.slack_ts ?? null,
    });
  } catch {
  }
}

