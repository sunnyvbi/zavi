
import { z } from "zod";
import { slackFetch } from "./_client";
import { mapFiles } from "./read_thread";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  channel_id: z.string(),
  oldest_ts: z.string().optional(),
  latest_ts: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

const TEXT_CAP = 800;
const RESPONSE_BYTE_CAP = 16 * 1024;

type SlackMessage = {
  ts?: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  bot_id?: string;
  files?: Array<{ id?: string; name?: string; filetype?: string; size?: number }>;
};

type HistoryResp = {
  messages?: SlackMessage[];
  has_more?: boolean;
};

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

export const getChannelHistoryTool: ToolSpec = {
  name: "slack_get_channel_history",
  effect: "read",
  description:
    "Fetch recent messages from a Slack channel. Use list_channels first to find channel_id. Pass oldest_ts (epoch like \"1715120000.000000\") to bound the time window — without it, the model wastes tokens on noise. Output is capped at ~16KB; on overflow, oldest messages drop and truncated=true.",
  input_schema: inputSchema,
  async execute(ctx, input: unknown) {
    const args = inputSchema.parse(input);
    const json = await slackFetch<HistoryResp>(
      ctx.tenant_id,
      "conversations.history",
      {
        channel: args.channel_id,
        limit: args.limit,
        oldest: args.oldest_ts,
        latest: args.latest_ts,
      },
      ctx.slack_team_id,
    );

    const all = (json.messages ?? []).map((m) => {
      const files = mapFiles(m.files);
      return {
        ts: m.ts ?? "",
        user: m.user ?? m.bot_id ?? "unknown",
        text: truncate(m.text ?? "", TEXT_CAP),
        thread_ts: m.thread_ts,
        ...(files ? { files } : {}),
      };
    });

    let messages = all;
    let truncated = false;
    while (Buffer.byteLength(JSON.stringify({ messages }), "utf-8") > RESPONSE_BYTE_CAP && messages.length > 0) {
      messages = messages.slice(0, -1);
      truncated = true;
    }

    return {
      messages,
      has_more: !!json.has_more,
      truncated,
    };
  },
};
