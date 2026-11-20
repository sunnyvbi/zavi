
import { callTelegram, telegramEnabled } from "@/services/connectors/telegram/adapter";
import { chunkText } from "@/services/tools/chunk-text";
import { formatForTelegram } from "@/services/tools/chat-format";

export type TelegramReplyResult =
  | { ok: true; chunks: number }
  | { ok: false; disabled?: boolean; gone?: boolean; sent: number; error: string };

const MAX_TELEGRAM_TEXT = 4096;
const MAX_CHUNKS = 8;

export async function postTelegramReply(args: {
  chat_id: number | string;
  reply_to_message_id?: number;
  text: string;
}): Promise<TelegramReplyResult> {
  if (!telegramEnabled()) {
    return { ok: false, disabled: true, sent: 0, error: "telegram_disabled" };
  }
  const chatId = Number(args.chat_id);
  if (!Number.isFinite(chatId) || chatId === 0) {
    return { ok: false, sent: 0, error: "no_chat_id" };
  }
  const text = (args.text ?? "").trim();
  if (!text) return { ok: false, sent: 0, error: "empty_text" };

  const chunks = chunkText(formatForTelegram(text), MAX_TELEGRAM_TEXT).slice(0, MAX_CHUNKS);
  for (let i = 0; i < chunks.length; i++) {
    const params: Record<string, unknown> = {
      chat_id: chatId,
      text: chunks[i],
    };
    if (i === 0 && args.reply_to_message_id) {
      params.reply_to_message_id = args.reply_to_message_id;
      params.allow_sending_without_reply = true;
    }
    const res = await callTelegram("sendMessage", params);
    if (!res.ok) {
      if ("disabled" in res && res.disabled) {
        return { ok: false, disabled: true, sent: i, error: res.error };
      }
      const gone = res.status === 403 || /chat not found/i.test(res.error);
      return { ok: false, gone, sent: i, error: res.error };
    }
  }
  return { ok: true, chunks: chunks.length };
}
