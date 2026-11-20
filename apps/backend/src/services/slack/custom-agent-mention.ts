
import { asPlanUpgradeRequired } from "@/services/billing/tiers";
import { refusalFor } from "@/services/agents/refusal";
import {
  customAgentPausedReply,
  customMentionTask,
  planRefusalText,
  type MentionResolution,
} from "@/services/agents/custom-agent-chat";

export type SlackMentionArgs = {
  tenant_id: string;
  team_id: string;
  channel_id: string;
  thread_ts: string;
  original_ts: string;
  event_id: string;
  raw_text: string;
  sanitized_text: string;
  user: string;
  ingested_event_id: string;
  event_type: string;
  slack_trace_id: string;
};

export type SlackMentionDeps = {
  resolve: (tenant_id: string, text: string) => Promise<MentionResolution | null>;
  enqueueAgentRun: (input: {
    agent_slug: string;
    tenant_id: string;
    trigger: "slack";
    cron_dedupe_key: string;
    payload: Record<string, unknown>;
  }) => Promise<{ run_id: string }>;
  postMessage: (a: { tenant_id: string; team_id: string; channel_id: string; thread_ts: string; text: string }) => Promise<void>;
  claimReply: (tenant_id: string, event_id: string) => Promise<boolean>;
  afterRouted: (args: SlackMentionArgs) => Promise<void>;
  isCreditsError: (e: unknown) => boolean;
  warn: (msg: string) => void;
};

export type SlackMentionOutcome = "none" | "routed" | "paused" | "refused";

export async function routeSlackCustomAgentMention(
  deps: SlackMentionDeps,
  args: SlackMentionArgs,
): Promise<SlackMentionOutcome> {
  let hit: MentionResolution | null;
  try {
    hit = await deps.resolve(args.tenant_id, args.raw_text);
  } catch (e) {
    deps.warn(`[slack/custom-agent-mention] resolve failed: ${(e as Error).message}`);
    return "none";
  }
  if (!hit) return "none";

  const reply = (text: string) =>
    deps
      .postMessage({ tenant_id: args.tenant_id, team_id: args.team_id, channel_id: args.channel_id, thread_ts: args.thread_ts, text })
      .catch(() => {});

  if (hit.kind === "paused") {
    await reply(customAgentPausedReply(hit.agent.name));
    return "paused";
  }

  let task = args.sanitized_text;
  try {
    const again = await deps.resolve(args.tenant_id, args.sanitized_text);
    if (again && again.kind === "run" && again.agent.id === hit.agent.id) task = again.task;
  } catch {
  }

  let run_id: string;
  try {
    ({ run_id } = await deps.enqueueAgentRun({
      agent_slug: hit.agent.slug,
      tenant_id: args.tenant_id,
      trigger: "slack",
      cron_dedupe_key: `slack:${args.event_id}`,
      payload: {
        ingested_event_id: args.ingested_event_id,
        event_type: args.event_type,
        slack_trace_id: args.slack_trace_id,
        task_description: customMentionTask(task),
        custom_agent_mention: true,
        slack: {
          channel_id: args.channel_id,
          thread_ts: args.thread_ts,
          original_ts: args.original_ts,
          event_id: args.event_id,
          text: args.sanitized_text,
          user: args.user,
          team_id: args.team_id,
        },
      },
    }));
  } catch (e) {
    if (asPlanUpgradeRequired(e)) {
      await reply(planRefusalText());
      return "refused";
    }
    if (deps.isCreditsError(e)) {
      await reply(refusalFor({ kind: "credits" }).message);
      return "refused";
    }
    deps.warn(`[slack/custom-agent-mention] enqueue failed, falling through: ${(e as Error).message}`);
    return "none";
  }

  if (!run_id) return "routed";
  if (!(await deps.claimReply(args.tenant_id, args.event_id))) {
    deps.warn(`[slack/custom-agent-mention] reply claim failed for event ${args.event_id}; falling through`);
    return "none";
  }
  await deps.afterRouted(args).catch(() => {});
  return "routed";
}
