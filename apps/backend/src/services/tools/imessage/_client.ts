
import { chunkText } from "@/services/tools/chunk-text";
import { formatForIMessage } from "@/services/tools/chat-format";
import { imessageEnabled, isRecipientGone, sendIMessageText } from "@/services/connectors/imessage/sendblue";

type IMessageReplyResult =
  | { ok: true; chunks: number }
  | { ok: false; disabled?: boolean; gone?: boolean; sent: number; error: string };

const BUBBLE_CHARS = 1500;
const MAX_BUBBLES = 10;
const BUBBLE_GAP_MS = 800;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function postIMessageReply(
  args: { handle: string; text: string },
  opts: { gapMs?: number } = {},
): Promise<IMessageReplyResult> {
  if (!imessageEnabled()) return { ok: false, disabled: true, sent: 0, error: "imessage_disabled" };
  const handle = String(args.handle ?? "").trim();
  if (!handle) return { ok: false, sent: 0, error: "no_handle" };
  const text = (args.text ?? "").trim();
  if (!text) return { ok: false, sent: 0, error: "empty_text" };

  const bubbles = chunkText(formatForIMessage(text), BUBBLE_CHARS).slice(0, MAX_BUBBLES);
  const gap = opts.gapMs ?? BUBBLE_GAP_MS;
  for (let i = 0; i < bubbles.length; i++) {
    if (i > 0 && gap > 0) await sleep(gap);
    const res = await sendIMessageText(handle, bubbles[i]);
    if (!res.ok) {
      return { ok: false, gone: isRecipientGone(res), sent: i, error: res.errorKey ?? res.errorMessage ?? `http_${res.status}` };
    }
  }
  return { ok: true, chunks: bubbles.length };
}
