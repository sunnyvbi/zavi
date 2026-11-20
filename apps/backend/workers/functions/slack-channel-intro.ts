
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { enqueueSlackOutbox, type EnqueueSlackOutboxArgs } from "@/services/slack/outbox";
import { renderTailoredIntro, type Pitch } from "@/services/slack-onboarding/pitches";

type IngestedRow = {
  id: string;
  tenant_id: string;
  provider: string;
  payload: Record<string, unknown>;
};

type SlackJoinEvent = {
  type?: string;
  user?: string;
  channel?: string;
  inviter?: string;
  channel_type?: string;
};

export function channelIntroText(): string {
  return [
    `:wave: *Hi team, I'm Zavi, an AI growth agent for your business.*`,
    ``,
    `I work with a set of AI teammates (engineer, performance-marketer, support-lead, growth-lead, ops, pm, qa, research and more) here to take real work off your plate.`,
    ``,
    `*How to use me right here:*`,
    `• @-mention me in this channel, like \`@Zavi summarize what I missed\` or \`@Zavi pull last week's ad performance\`.`,
    `• DM me directly for anything you'd hand a teammate.`,
    ``,
    `Ask me something small to start. I learn your company as we go.`,
  ].join("\n");
}

export function shouldPostChannelIntro(
  ev: SlackJoinEvent,
  botUserId: string | null | undefined,
): boolean {
  if (ev.type !== "member_joined_channel") return false;
  if (!botUserId) return false;
  if (ev.user !== botUserId) return false;
  const inviter = ev.inviter ?? "";
  if (!inviter) return false;
  if (inviter === botUserId) return false;
  return true;
}

export function buildChannelIntroEnqueueArgs(args: {
  tenant_id: string;
  team_id?: string;
  channel_id: string;
  ingested_event_id: string;
  body: string;
}): EnqueueSlackOutboxArgs {
  return {
    tenant_id: args.tenant_id,
    channel_id: args.channel_id,
    kind: "channel_intro",
    body: args.body,
    team_id: args.team_id,
    idempotency_key: `${args.ingested_event_id}:channel_intro`,
  };
}

export const slackChannelIntroFn = inngest.createFunction(
  { id: "slack-channel-intro", concurrency: 4, retries: 2 },
  { event: "webhook.slack.ingested" },
  async ({ event, step, logger }) => {
    if (event.data.event_type !== "member_joined_channel") {
      return { skip: "not_member_joined" };
    }
    const ingestedId = event.data.ingested_event_id as string;
    const svc = serviceClient();

    const ctx = await step.run("load-ingested-event", async () => {
      const { data: row } = await svc
        .from("ingested_events")
        .select("id, tenant_id, provider, payload")
        .eq("id", ingestedId)
        .maybeSingle<IngestedRow>();
      if (!row || row.provider !== "slack") return null;
      const ev = ((row.payload?.event as SlackJoinEvent) ?? {}) as SlackJoinEvent;
      const team_id =
        typeof (row.payload as { team_id?: unknown })?.team_id === "string"
          ? (row.payload as { team_id: string }).team_id
          : undefined;
      return { tenant_id: row.tenant_id, team_id, ev };
    });
    if (!ctx) return { skip: "no_row_or_not_slack" };
    const { tenant_id, team_id, ev } = ctx;

    const botUserId = await step.run("resolve-bot-user-id", async () => {
      if (team_id) {
        const { data } = await svc
          .from("slack_workspaces")
          .select("bot_user_id")
          .eq("tenant_id", tenant_id)
          .eq("team_id", team_id)
          .maybeSingle<{ bot_user_id: string | null }>();
        if (data?.bot_user_id) return data.bot_user_id;
      }
      const { data } = await svc
        .from("connector_metadata")
        .select("bot_user_id")
        .eq("tenant_id", tenant_id)
        .eq("slug", "slack")
        .maybeSingle<{ bot_user_id: string | null }>();
      return data?.bot_user_id ?? null;
    });

    if (!shouldPostChannelIntro(ev, botUserId)) {
      return { skip: "not_human_invite_of_bot" };
    }

    const channel_id = String(ev.channel ?? "");
    if (!channel_id) return { skip: "no_channel" };

    const draft = await step.run("load-onboarding-draft", async () => {
      if (!team_id) return null;
      const { data } = await svc
        .from("slack_onboarding_drafts")
        .select("company_name, pitches")
        .eq("tenant_id", tenant_id)
        .eq("team_id", team_id)
        .maybeSingle<{ company_name: string | null; pitches: Pitch[] | null }>();
      if (!data || !data.pitches || data.pitches.length === 0) return null;
      return data;
    });

    const introText =
      draft && draft.pitches
        ? renderTailoredIntro({
            companyName: draft.company_name || "your company",
            pitches: draft.pitches,
            forChannel: true,
          })
        : channelIntroText();

    const enqueued = await step.run("post-channel-intro", async () => {
      const seq = await enqueueSlackOutbox(
        buildChannelIntroEnqueueArgs({
          tenant_id,
          team_id,
          channel_id,
          ingested_event_id: ingestedId,
          body: introText,
        }),
      );
      return seq != null;
    });
    if (!enqueued) {
      logger.warn(
        `slack-channel-intro: outbox enqueue failed for tenant ${tenant_id} channel ${channel_id}`,
      );
    } else if (draft) {
      await step.run("stamp-channel-posted", async () => {
        await svc
          .from("slack_workspaces")
          .update({ channel_intro_posted_at: new Date().toISOString() })
          .eq("tenant_id", tenant_id)
          .eq("team_id", team_id);
      });
    }

    return {
      outcome: enqueued ? "enqueued" : "enqueue_failed",
      tenant_id,
      channel_id,
      tailored: !!draft,
    };
  },
);
