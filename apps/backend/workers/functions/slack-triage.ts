
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { enqueueAgentRun } from "@/services/agents/runner";
import {
  SandboxRepoAccessRequiredError,
  repoAccessBlockedMessage,
} from "@/services/sandbox/repo-access-gate";
import { listAgents } from "@/services/agents/registry";
import { filterTenantVisibleAgents } from "@/services/agents/visibility";
import { scrubZaviArchitectureLeak } from "@/services/agents/brand-rewrite";
import { logEvent } from "@/services/logging/logEvent";
import { callMcpTool } from "@/services/mcp/execute";
import {
  classifyMessage,
  type ActiveAgent,
} from "@/services/slack/triage-classifier";
import {
  decideSlackRoute,
  parseExplicitSlug,
  OPERATOR_SLUG,
} from "@/services/slack/routing";
import { dispatchOperatorOnLowConf } from "@/services/slack/dispatch-operator-on-low-conf";
import { handleSlackEngineerFollowup } from "@/services/agents/slack-pr-followup";
import { detectSummon } from "@/services/meetings/summon-detect";
import { reserveSlackAnswerBarrier } from "@/services/slack/outbox";
import { detectRemember } from "@/services/memory-cards/remember-detect";
import {
  loadThreadExcerpt,
  renderThreadExcerptBlock,
} from "@/services/slack/load-thread-excerpt";
import {
  ACK_EMOJI,
  addReaction,
  swapReaction,
} from "@/services/tools/slack/_reactions";

const RATE_LIMIT = 30;
const OK_EMOJI = "white_check_mark";
const WARN_EMOJI = "warning";

type IngestedRow = {
  id: string;
  tenant_id: string;
  provider: string;
  external_event_id: string;
  payload: Record<string, unknown>;
};

type SlackEvent = {
  type?: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  channel_type?: string;
};

async function markDoneAndReplied(
  tenant_id: string,
  event_id: string,
): Promise<void> {
  await serviceClient()
    .from("slack_triage_claims")
    .update({
      status: "done",
      replied_at: new Date().toISOString(),
      answer_kind: "provisional",
    })
    .eq("tenant_id", tenant_id)
    .eq("event_id", event_id);
}

async function markDonePendingReply(
  tenant_id: string,
  event_id: string,
): Promise<void> {
  await serviceClient()
    .from("slack_triage_claims")
    .update({ status: "done" })
    .eq("tenant_id", tenant_id)
    .eq("event_id", event_id);
}

async function enqueueOperator(
  tenant_id: string,
  event_id: string,
  slackPayload: {
    channel_id: string;
    thread_ts: string;
    original_ts: string;
    event_id: string;
    text: string;
    user?: string;
    team_id?: string;
  },
): Promise<void> {
  await enqueueAgentRun({
    agent_slug: OPERATOR_SLUG,
    tenant_id,
    trigger: "slack",
    cron_dedupe_key: `slack:${event_id}`,
    payload: { slack: slackPayload },
  });
  await reserveSlackAnswerBarrier({
    tenant_id,
    channel_id: slackPayload.channel_id,
    thread_ts: slackPayload.thread_ts,
    event_id,
  });
  await markDonePendingReply(tenant_id, event_id);
}

async function post(
  tenant_id: string,
  channel_id: string,
  text: string,
  thread_ts: string,
  team_id?: string,
): Promise<boolean> {
  const guarded = scrubZaviArchitectureLeak(text);
  if (guarded.blocked) {
    console.warn(
      `[slack-triage] zavi_architecture_leak_scrubbed tenant=${tenant_id} hits=${guarded.hits.join("|")}`,
    );
  }
  const r = await callMcpTool(
    { tenant_id, run_id: "", slack_target_team_id: team_id, slack_inbound_delivery: true },
    "slack",
    "post_message",
    { channel_id, text: guarded.text, thread_ts },
  );
  return !r.is_error;
}

export async function triageOne(
  ingested_event_id: string,
  slack_trace_id = "",
): Promise<unknown> {
  const svc = serviceClient();

  const { data: row } = await svc
    .from("ingested_events")
    .select("id, tenant_id, provider, external_event_id, payload")
    .eq("id", ingested_event_id)
    .maybeSingle<IngestedRow>();
  if (!row || row.provider !== "slack") return { skip: "not_slack" };

  const tenant_id = row.tenant_id;
  const event_id = row.external_event_id;
  const ev = ((row.payload?.event as SlackEvent) ?? {}) as SlackEvent;

  const source_team_id =
    typeof (row.payload as { team_id?: unknown })?.team_id === "string"
      ? (row.payload as { team_id: string }).team_id
      : undefined;

  let meta: { bot_user_id: string | null } | null = null;
  if (source_team_id) {
    const { data } = await svc
      .from("slack_workspaces")
      .select("bot_user_id")
      .eq("tenant_id", tenant_id)
      .eq("team_id", source_team_id)
      .maybeSingle<{ bot_user_id: string | null }>();
    meta = data ?? null;
  }
  if (!meta) {
    const { data } = await svc
      .from("connector_metadata")
      .select("bot_user_id")
      .eq("tenant_id", tenant_id)
      .eq("slug", "slack")
      .maybeSingle<{ bot_user_id: string | null }>();
    meta = data ?? null;
  }
  if (!meta?.bot_user_id) {
    await logEvent({
      level: "warn",
      source: "slack-triage",
      code: "slack.triage.no_bot_user_id",
      message: `Slack connected but bot_user_id is NULL — fail-closed skip [${slack_trace_id}]`,
      tenant_id,
    });
    return { skip: "no_bot_user_id_fail_closed" };
  }
  if (ev.bot_id) return { skip: "bot_message" };
  if (ev.subtype) return { skip: `subtype:${ev.subtype}` };
  if (ev.user && ev.user === meta.bot_user_id) return { skip: "self_message" };
  if (ev.type !== "message" && ev.type !== "app_mention")
    return { skip: `type:${ev.type ?? "none"}` };
  const text = String(ev.text ?? "").trim();
  if (!text) return { skip: "empty_text" };

  if (detectSummon(text)) return { skip: "notetaker_summon" };
  if (detectRemember(text)) return { skip: "memory_remember" };

  const channel_id = String(ev.channel ?? "");
  const original_ts = String(ev.ts ?? "");
  const thread_ts = String(ev.thread_ts ?? ev.ts ?? "");
  if (!channel_id || !original_ts) return { skip: "no_channel_or_ts" };

  const { data: verdict } = await svc.rpc("slack_triage_consume", {
    p_tenant_id: tenant_id,
    p_event_id: event_id,
    p_limit: RATE_LIMIT,
  });
  if (verdict !== "ok") return { skip: String(verdict) };

  await addReaction(tenant_id, channel_id, original_ts, ACK_EMOJI, source_team_id);

  const active: ActiveAgent[] = await filterTenantVisibleAgents(
    listAgents().map((a) => ({
      slug: a.slug,
      name: a.name,
      description: a.description,
    })),
    tenant_id,
  );

  if (active.length === 0 && listAgents().length > 0) {
    await logEvent({
      level: "warn",
      source: "slack-triage",
      code: "slack.triage.empty_roster",
      message: `built Slack roster is empty while the registry has agents — connector-blindness check [${slack_trace_id}]`,
      tenant_id,
      meta: { total: listAgents().length },
    });
  }

  const slugs = new Set(active.map((a) => a.slug));

  let threadExcerpt: string | undefined;
  if (source_team_id && thread_ts && thread_ts !== original_ts) {
    try {
      const excerpt = await loadThreadExcerpt({
        tenant_id,
        team_id: source_team_id,
        channel: channel_id,
        thread_ts,
        event_ts: original_ts,
      });
      if (excerpt) threadExcerpt = renderThreadExcerptBlock(excerpt);
    } catch {
    }
  }

  const explicit = parseExplicitSlug(text, slugs);
  const decision = await classifyMessage({
    message_text: text,
    active_agents: active,
    explicit_mention_slug: explicit,
    tenant_id,
    event: { channel_id, thread_ts },
    source_team_id,
    thread_excerpt: threadExcerpt,
  });
  const slackPayload = {
    channel_id,
    thread_ts,
    original_ts,
    event_id,
    text,
    user: ev.user,
    team_id: source_team_id,
    slack_trace_id,
  };

  if (
    thread_ts &&
    thread_ts !== original_ts &&
    slugs.has("engineer") &&
    (explicit === undefined || explicit === "engineer") &&
    text.trim().length > 0
  ) {
    try {
      const fr = await handleSlackEngineerFollowup(
        {
          svc,
          enqueueAgentRun: (input) => enqueueAgentRun(input),
          postMessage: async (a) => {
            await post(a.tenant_id, a.channel_id, a.text, a.thread_ts, a.team_id);
          },
        },
        {
          tenant_id,
          team_id: source_team_id,
          channel_id,
          thread_ts,
          original_ts,
          event_id,
          text,
          slack_trace_id,
          user: ev.user,
        },
      );
      if (fr.handled) {
        if (fr.action === "clarify" || fr.action === "courtesy_noop") {
          await swapReaction(
            tenant_id,
            channel_id,
            original_ts,
            ACK_EMOJI,
            OK_EMOJI,
            source_team_id,
          );
          await markDoneAndReplied(tenant_id, event_id);
        } else {
          await markDonePendingReply(tenant_id, event_id);
        }
        return {
          action:
            fr.action === "route"
              ? "pr_followup_routed"
              : fr.action === "courtesy_noop"
                ? "pr_followup_courtesy_noop"
                : "pr_followup_clarify",
          ...(fr.target_pr_number ? { target_pr_number: fr.target_pr_number } : {}),
        };
      }
    } catch (e) {
      console.warn(
        `[slack-triage] pr-followup intercept failed (continuing to normal routing): ${(e as Error).message}`,
      );
    }
  }

  if (!decision) {
    await logEvent({
      level: "warn",
      source: "slack-triage",
      code: "slack.triage.classify_failed",
      message: `classifier returned null (model throw or no <triage> block) [${slack_trace_id}]`,
      tenant_id,
      meta: { iter: active.length },
    });
  }

  let workspaceDefaultSlug: string | undefined;
  if (source_team_id) {
    const { data: wsRow } = await svc
      .from("slack_workspaces")
      .select("default_agent_slug")
      .eq("tenant_id", tenant_id)
      .eq("team_id", source_team_id)
      .maybeSingle<{ default_agent_slug: string | null }>();
    workspaceDefaultSlug =
      typeof wsRow?.default_agent_slug === "string" && wsRow.default_agent_slug
        ? wsRow.default_agent_slug
        : undefined;
  }

  const operatorWillRun = ev.type === "app_mention" || ev.channel_type === "im";

  const route = decideSlackRoute({
    decision,
    explicit,
    active,
    workspaceDefaultSlug,
    operatorWillRun,
  });

  switch (route.kind) {
    case "route_operator":
      await enqueueOperator(tenant_id, event_id, slackPayload);
      return route.result;

    case "enqueue_direct":
      try {
        await enqueueAgentRun({
          agent_slug: route.agent_slug,
          tenant_id,
          trigger: "slack",
          cron_dedupe_key: `slack:${event_id}`,
          payload: { slack: slackPayload },
        });
        await reserveSlackAnswerBarrier({
          tenant_id,
          channel_id: slackPayload.channel_id,
          thread_ts: slackPayload.thread_ts,
          event_id,
        });
      } catch (e) {
        if (e instanceof SandboxRepoAccessRequiredError) {
          const ok = await post(
            tenant_id,
            channel_id,
            repoAccessBlockedMessage(e.status),
            thread_ts,
            source_team_id,
          );
          await swapReaction(
            tenant_id,
            channel_id,
            original_ts,
            ACK_EMOJI,
            ok ? OK_EMOJI : WARN_EMOJI,
            source_team_id,
          );
          await markDoneAndReplied(tenant_id, event_id);
          return ok
            ? { skip: "repo_access_blocked", status: e.status }
            : { skip: "repo_access_post_failed", status: e.status };
        }
        throw e;
      }
      await markDonePendingReply(tenant_id, event_id);
      return route.result;

    case "low_conf_operator_dispatch": {
      const ok = await post(tenant_id, channel_id, route.placeholder_text, thread_ts, source_team_id);
      if (!ok) {
        await swapReaction(tenant_id, channel_id, original_ts, ACK_EMOJI, WARN_EMOJI, source_team_id);
        await markDoneAndReplied(tenant_id, event_id);
        return { skip: "low_conf_placeholder_post_failed" };
      }
      const outcome = await dispatchOperatorOnLowConf({
        tenant_id,
        channel_id,
        thread_ts,
        source_message_ts: original_ts,
        source_event_id: event_id,
        user_message: text,
        user: ev.user,
        source_team_id,
        slack_trace_id,
      });
      await swapReaction(tenant_id, channel_id, original_ts, ACK_EMOJI, OK_EMOJI, source_team_id);
      await markDonePendingReply(tenant_id, event_id);
      return { ...route.result, dispatch: outcome.kind };
    }

    case "ack_and_route_operator": {
      try {
        await enqueueOperator(tenant_id, event_id, slackPayload);
      } catch (e) {
        await logEvent({
          level: "warn",
          source: "slack-triage",
          code: "slack.triage.ack_backstop_enqueue_failed",
          message: `operator backstop enqueue failed; no ack posted, claim left open for any live run to deliver [${slack_trace_id}]: ${(e as Error).message}`,
          tenant_id,
        });
        return { ...route.result, posted: false, backstop: "enqueue_failed" };
      }
      const { data: claimRow } = await svc
        .from("slack_triage_claims")
        .select("replied_at")
        .eq("tenant_id", tenant_id)
        .eq("event_id", event_id)
        .maybeSingle<{ replied_at: string | null }>();
      if (claimRow?.replied_at) {
        return { ...route.result, posted: false, ack_skipped: "answer_already_delivered" };
      }
      const ok = await post(tenant_id, channel_id, route.placeholder_text, thread_ts, source_team_id);
      if (!ok) {
        await logEvent({
          level: "warn",
          source: "slack-triage",
          code: "slack.triage.ack_post_failed",
          message: `ack post failed; operator run still owns the reply [${slack_trace_id}]`,
          tenant_id,
          meta: { reason: String(route.result.reason ?? "") },
        });
      }
      return { ...route.result, posted: ok, ack_posted: ok };
    }

    case "post_and_terminate": {
      const ok = await post(tenant_id, channel_id, route.text, thread_ts, source_team_id);
      if (route.success_emoji_on_post_ok) {
        if (!ok) {
          await swapReaction(tenant_id, channel_id, original_ts, ACK_EMOJI, WARN_EMOJI, source_team_id);
          await markDoneAndReplied(tenant_id, event_id);
          return {
            skip: "post_failed",
            tier: (route.result as { tier?: number }).tier,
          };
        }
        await swapReaction(tenant_id, channel_id, original_ts, ACK_EMOJI, OK_EMOJI, source_team_id);
        await markDoneAndReplied(tenant_id, event_id);
        return route.result;
      }
      await swapReaction(tenant_id, channel_id, original_ts, ACK_EMOJI, WARN_EMOJI, source_team_id);
      await markDoneAndReplied(tenant_id, event_id);
      return route.result;
    }
  }
}

export const slackTriageFn = inngest.createFunction(
  { id: "slack-triage", retries: 1, concurrency: 4 },
  { event: "webhook.slack.ingested" },
  async ({ event, step, logger }) => {
    const id = event.data.ingested_event_id;
    const traceId = event.data.slack_trace_id ?? "";
    const res = await step.run("triage", () => triageOne(id, traceId));
    logger.info(`slack-triage [${traceId}] ${id}: ${JSON.stringify(res)}`);
    return res;
  },
);
