
import { z } from "zod";
import { slackFetch } from "./_client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  channel_id: z
    .string()
    .min(1)
    .describe("Slack channel_id where the message lives."),
  ts: z
    .string()
    .min(1)
    .describe(
      "Slack message timestamp (the `ts` field on a message — e.g. '1700000000.000100').",
    ),
});

type Reaction = {
  name?: string;
  count?: number;
  users?: string[];
};

type ReactionsGetResp = {
  message?: {
    reactions?: Reaction[];
  };
};

type PermalinkResp = { permalink?: string };

export const getReactionsTool: ToolSpec = {
  name: "slack_get_reactions",
  effect: "read",
  description:
    "List emoji reactions on a single Slack message. Returns `{channel_id, ts, permalink, reactions:[{name,count,users:[user_id,...]}]}`. The permalink is the clickable 'jump to message' URL — without it the agent can only say 'N people reacted' with no context. Use to answer 'did anyone ack/approve this?'.",
  input_schema: inputSchema,
  async execute(ctx, input: unknown) {
    const { channel_id, ts } = inputSchema.parse(input);
    const json = await slackFetch<ReactionsGetResp>(
      ctx.tenant_id,
      "reactions.get",
      { channel: channel_id, timestamp: ts, full: true },
      ctx.slack_team_id,
    );
    const reactions = json.message?.reactions ?? [];
    let permalink = "";
    try {
      const p = await slackFetch<PermalinkResp>(
        ctx.tenant_id,
        "chat.getPermalink",
        { channel: channel_id, message_ts: ts },
        ctx.slack_team_id,
      );
      permalink = p.permalink ?? "";
    } catch {
    }
    return {
      channel_id,
      ts,
      permalink,
      reactions: reactions.map((r) => ({
        name: r.name ?? "",
        count: r.count ?? 0,
        users: r.users ?? [],
      })),
    };
  },
};
