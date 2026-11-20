
import { z } from "zod";
import { slackFetch } from "./_client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  types: z
    .enum([
      "public_channel",
      "private_channel",
      "public_channel,private_channel",
    ])
    .default("public_channel,private_channel"),
  limit: z.number().int().min(1).max(200).default(100),
});

type SlackChannelText = { value?: string };

type SlackChannel = {
  id?: string;
  name?: string;
  is_member?: boolean;
  is_archived?: boolean;
  purpose?: SlackChannelText;
  topic?: SlackChannelText;
  num_members?: number;
};

type ListChannelsResp = {
  channels?: SlackChannel[];
  response_metadata?: { next_cursor?: string };
};

export const listChannelsTool: ToolSpec = {
  name: "slack_list_channels",
  effect: "read",
  description:
    "List Slack channels the bot has access to. Returns id+name+is_member+is_archived+purpose+topic+num_members — call this first to pick a channel before paging history.",
  input_schema: inputSchema,
  async execute(ctx, input: unknown) {
    const { types, limit } = inputSchema.parse(input);
    const json = await slackFetch<ListChannelsResp>(
      ctx.tenant_id,
      "conversations.list",
      {
        types,
        limit,
        exclude_archived: true,
      },
      ctx.slack_team_id,
    );
    const channels = (json.channels ?? []).map((c) => ({
      id: c.id ?? "",
      name: c.name ?? "",
      is_member: !!c.is_member,
      is_archived: !!c.is_archived,
      purpose: c.purpose?.value ?? "",
      topic: c.topic?.value ?? "",
      num_members: typeof c.num_members === "number" ? c.num_members : 0,
    }));
    return {
      channels,
      next_cursor: json.response_metadata?.next_cursor ?? null,
    };
  },
};
