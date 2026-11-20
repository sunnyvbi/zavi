
import { z } from "zod";
import { slackFetch } from "./_client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  channel_id: z
    .string()
    .min(1)
    .describe("Slack channel_id, e.g. C01ABCDEF (from list_channels)."),
  max_results: z.number().int().min(1).max(200).default(50),
});

type MembersResp = {
  members?: string[];
  response_metadata?: { next_cursor?: string };
};

export const listChannelMembersTool: ToolSpec = {
  name: "slack_list_channel_members",
  effect: "read",
  description:
    "List user_ids in a Slack channel. Returns the first max_results user_ids (default 50, max 200) plus a next_cursor if more exist. Pair with slack_read_user_profile to resolve names/titles when needed.",
  input_schema: inputSchema,
  async execute(ctx, input: unknown) {
    const { channel_id, max_results } = inputSchema.parse(input);
    const json = await slackFetch<MembersResp>(
      ctx.tenant_id,
      "conversations.members",
      { channel: channel_id, limit: max_results },
      ctx.slack_team_id,
    );
    const members = json.members ?? [];
    return {
      channel_id,
      members,
      next_cursor: json.response_metadata?.next_cursor ?? null,
      total_returned: members.length,
    };
  },
};
