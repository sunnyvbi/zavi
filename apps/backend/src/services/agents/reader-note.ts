
import type Anthropic from "@anthropic-ai/sdk";

type MessageContent = Anthropic.Messages.MessageParam["content"];

export const READER_NOTE =
  "Reader: this person runs the business, not the code. Answer in product terms: what it does, who it affects, " +
  "which screen to use. No code, field or file names unless they asked for code or are debugging.";

const READER_NOTE_TRIGGERS = new Set(["chat", "slack", "teams", "telegram", "discord", "whatsapp", "imessage", "email"]);

export function shouldAddReaderNote(args: { agentSlug: string; trigger: string | null | undefined }): boolean {
  return args.agentSlug === "operator" && READER_NOTE_TRIGGERS.has(args.trigger ?? "");
}

export function withReaderNote(content: MessageContent): MessageContent {
  if (typeof content === "string") {
    if (content.endsWith(READER_NOTE)) return content;
    return content.length > 0 ? `${content}\n\n${READER_NOTE}` : READER_NOTE;
  }
  const blocks = [...content];
  const last = blocks[blocks.length - 1];
  if (last && last.type === "text" && last.text.endsWith(READER_NOTE)) return content;
  if (last && last.type === "text") {
    blocks[blocks.length - 1] = { ...last, text: `${last.text}\n\n${READER_NOTE}` };
  } else {
    blocks.push({ type: "text", text: READER_NOTE });
  }
  return blocks;
}
