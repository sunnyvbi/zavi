
import { z } from "zod";
import { slackFetch } from "./_client";
import { flattenSlackBlocks, hasStructuralBlocks } from "@/services/slack/flatten-blocks";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  channel_id: z.string(),
  thread_ts: z.string(),
  limit: z.number().int().min(1).max(50).default(20),
});

const TEXT_CAP = 500;
const RESPONSE_BYTE_CAP = 4 * 1024;
const FILES_PER_MESSAGE_CAP = 8;

type SlackFile = {
  id?: string;
  name?: string;
  filetype?: string;
  size?: number;
};

type SlackMessage = {
  ts?: string;
  user?: string;
  text?: string;
  bot_id?: string;
  files?: SlackFile[];
  blocks?: unknown;
  attachments?: unknown;
};

function displayText(m: SlackMessage): string {
  const text = m.text ?? "";
  if (text.trim() && !hasStructuralBlocks(m.blocks)) return text;
  const flat = flattenSlackBlocks(m.blocks, m.attachments);
  return flat || text;
}

type RepliesResp = {
  messages?: SlackMessage[];
  has_more?: boolean;
};

export type ThreadFileRef = {
  file_id: string;
  name: string;
  filetype: string;
  size: number;
};

type MappedMessage = {
  ts: string;
  user: string;
  text: string;
  files?: ThreadFileRef[];
};

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

export function mapFiles(files: SlackFile[] | undefined): ThreadFileRef[] | undefined {
  if (!Array.isArray(files) || files.length === 0) return undefined;
  const refs = files
    .filter((f) => typeof f?.id === "string" && f.id.length > 0)
    .slice(0, FILES_PER_MESSAGE_CAP)
    .map((f) => ({
      file_id: String(f.id),
      name: String(f.name ?? "file"),
      filetype: String(f.filetype ?? ""),
      size: Number(f.size ?? 0),
    }));
  return refs.length > 0 ? refs : undefined;
}

export function trimToCap(messages: MappedMessage[]): {
  messages: MappedMessage[];
  truncated: boolean;
} {
  const overCap = (ms: MappedMessage[]): boolean =>
    Buffer.byteLength(JSON.stringify({ messages: ms }), "utf-8") > RESPONSE_BYTE_CAP;

  let out = messages.slice();
  let truncated = false;

  while (out.length > 2 && overCap(out)) {
    out = [out[0], ...out.slice(2)];
    truncated = true;
  }

  let textCap = TEXT_CAP;
  while (overCap(out) && textCap > 40) {
    textCap = Math.floor(textCap / 2);
    out = out.map((m) => ({ ...m, text: truncate(m.text, textCap) }));
    truncated = true;
  }

  return { messages: out, truncated };
}

export const readThreadTool: ToolSpec = {
  name: "slack_read_thread",
  effect: "read",
  description:
    "Fetch replies to a Slack thread. Used to give the assistant context when a user mentions it inside an existing thread. Returns up to 20 most-recent replies, capped at ~4KB total. Messages that carry an upload include a `files` array of {file_id, name, filetype, size} — call slack_read_file with a file_id to read the document's contents.",
  input_schema: inputSchema,
  async execute(ctx, input: unknown) {
    const args = inputSchema.parse(input);
    const json = await slackFetch<RepliesResp>(
      ctx.tenant_id,
      "conversations.replies",
      {
        channel: args.channel_id,
        ts: args.thread_ts,
        limit: args.limit,
      },
      ctx.slack_team_id,
    );

    const all: MappedMessage[] = (json.messages ?? []).map((m) => {
      const files = mapFiles(m.files);
      return {
        ts: m.ts ?? "",
        user: m.user ?? m.bot_id ?? "unknown",
        text: truncate(displayText(m), TEXT_CAP),
        ...(files ? { files } : {}),
      };
    });

    const { messages, truncated } = trimToCap(all);

    return { messages, has_more: !!json.has_more, truncated };
  },
};
