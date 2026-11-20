
import { z } from "zod";
import { slackFetch } from "./_client";
import { ExpectedToolError } from "@/services/tools/types";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  user_ids: z
    .array(z.string().min(1))
    .min(1)
    .max(8)
    .describe(
      "Slack user_id(s) like U01ABCDEF (resolve names via slack_search_users FIRST — Slack ignores display-name strings). Pass ONE id for a 1:1 DM; 2-8 ids for a group DM (mpim).",
    ),
});

type OpenResp = { channel?: { id?: string } };

export const openDmTool: ToolSpec = {
  name: "slack_open_dm",
  effect: "write",
  description:
    "Open a direct-message channel to one or more people and return its channel_id. Pass ONE user_id for a 1:1 DM, or 2-8 user_ids for a group DM (mpim). ALWAYS resolve a name to its user_id with slack_search_users first. Returns { channel_id } you can pass to slack_post_message. For a simple one-off DM you can skip this and call slack_post_message with user_id directly — it auto-opens the DM.",
  input_schema: inputSchema,
  async execute(ctx, input: unknown) {
    const { user_ids } = inputSchema.parse(input);
    const json = await slackFetch<OpenResp>(
      ctx.tenant_id,
      "conversations.open",
      { users: user_ids.join(",") },
      ctx.slack_team_id,
    );
    const channel_id = json.channel?.id;
    if (!channel_id) {
      throw new ExpectedToolError(
        "slack_open_dm_failed",
        "conversations.open returned no channel id",
        { user_count: user_ids.length },
      );
    }
    return { channel_id, user_ids };
  },
};
