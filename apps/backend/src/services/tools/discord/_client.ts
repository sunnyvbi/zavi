
import { callDiscord, discordEnabled } from "@/services/connectors/discord/adapter";
import { chunkText } from "@/services/tools/chunk-text";
import { formatForDiscord } from "@/services/tools/chat-format";

export type DiscordReplyResult =
  | { ok: true; chunks: number }
  | { ok: false; disabled?: boolean; gone?: boolean; sent: number; error: string };

const MAX_DISCORD_TEXT = 2000;
const MAX_CHUNKS = 14;

export async function postDiscordReply(args: {
  channel_id: string;
  reply_to_message_id?: string;
  text: string;
}): Promise<DiscordReplyResult> {
  if (!discordEnabled()) {
    return { ok: false, disabled: true, sent: 0, error: "discord_disabled" };
  }
  const channelId = String(args.channel_id ?? "");
  if (!channelId) return { ok: false, sent: 0, error: "no_channel_id" };
  const text = (args.text ?? "").trim();
  if (!text) return { ok: false, sent: 0, error: "empty_text" };

  const chunks = chunkText(formatForDiscord(text), MAX_DISCORD_TEXT).slice(0, MAX_CHUNKS);
  for (let i = 0; i < chunks.length; i++) {
    const body: Record<string, unknown> = { content: chunks[i] };
    if (i === 0 && args.reply_to_message_id) {
      body.message_reference = {
        message_id: args.reply_to_message_id,
        fail_if_not_exists: false,
      };
    }
    const res = await callDiscord("POST", `/channels/${channelId}/messages`, body);
    if (!res.ok) {
      if ("disabled" in res && res.disabled) {
        return { ok: false, disabled: true, sent: i, error: res.error };
      }
      const gone = res.status === 403 || res.status === 404;
      return { ok: false, gone, sent: i, error: res.error };
    }
  }
  return { ok: true, chunks: chunks.length };
}
