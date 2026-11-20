
import { z } from "zod";
import { slackFetch } from "./_client";
import { looksLikeChannelId, resolveChannelId } from "./_resolve_channel";
import { ExpectedToolError } from "@/services/tools/types";
import type { ToolSpec } from "@/services/tools/types";
import { linksToOwnApp } from "@/services/web-base";

const inputSchema = z
  .object({
    channel_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Channel id (C...), an already-open DM channel id (D...), OR a channel NAME like \"#general\" or \"general\" (auto-resolved to its id).",
      ),
    user_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Slack user_id (U...) to DM directly — auto-opens the 1:1 DM. Resolve a name via slack_search_users first. Use INSTEAD of channel_id.",
      ),
    user_ids: z
      .array(z.string().min(1))
      .min(2)
      .max(8)
      .optional()
      .describe(
        "2-8 Slack user_ids for a group DM (mpim) — auto-opened. Use INSTEAD of channel_id.",
      ),
    text: z.string().min(1).max(39000),
    thread_ts: z.string().optional(),
    unfurl_links: z
      .boolean()
      .optional()
      .describe("false stops Slack from adding link and media preview cards to this message."),
    blocks: z
      .string()
      .max(39000)
      .optional()
      .describe("Block Kit blocks as a JSON array string. text stays the notification fallback."),
  })
  .refine(
    (v) =>
      [v.channel_id, v.user_id, v.user_ids].filter((x) => x !== undefined)
        .length === 1,
    {
      message:
        "Provide exactly one of: channel_id, user_id (1:1 DM), or user_ids (group DM).",
    },
  );

type PostResp = { ts?: string; channel?: string };
type OpenResp = { channel?: { id?: string } };

export const postMessageTool: ToolSpec = {
  name: "slack_post_message",
  effect: "write",
  description:
    "Send a Slack message. Target EXACTLY ONE of: channel_id (post to a channel), user_id (DM a person — auto-opens the DM), or user_ids (group DM of 2-8 people — auto-opens). To DM someone, call slack_search_users to get their user_id, then pass it here as user_id — you do NOT need a channel id. Pass thread_ts to reply in an existing thread. text is capped at 39000 chars (Slack's hard limit).",
  input_schema: inputSchema,
  async execute(ctx, input: unknown) {
    const args = inputSchema.parse(input);

    let channel = args.channel_id;
    if (channel && !looksLikeChannelId(channel)) {
      channel = await resolveChannelId(ctx.tenant_id, channel, ctx.slack_team_id);
    }
    if (!channel) {
      const users = args.user_id ? [args.user_id] : args.user_ids!;
      const open = await slackFetch<OpenResp>(
        ctx.tenant_id,
        "conversations.open",
        { users: users.join(",") },
        ctx.slack_team_id,
      );
      channel = open.channel?.id;
      if (!channel) {
        throw new ExpectedToolError(
          "slack_dm_open_failed",
          "Could not open a DM channel for the given user(s).",
          { user_count: users.length },
        );
      }
    }

    const json = await slackFetch<PostResp>(
      ctx.tenant_id,
      "chat.postMessage",
      {
        channel,
        text: args.text,
        thread_ts: args.thread_ts,
        ...(args.unfurl_links === false || (args.unfurl_links === undefined && linksToOwnApp(args.text)) ? { unfurl_links: false, unfurl_media: false } : {}),
        ...(args.blocks ? { blocks: args.blocks } : {}),
      },
      ctx.slack_team_id,
    );
    return { ts: json.ts ?? "", channel: json.channel ?? channel };
  },
};
