
import { stripPlanBlock } from "./plan-emit";
import { stripLeadNarration } from "./lead-narration";
import { stripHtmlPreviewBlock } from "@/agents/engineer/html-preview";

export const CHAT_EMPTY_FALLBACK =
  "_I finished but produced no response. See the Runs tab for details._";

export const RPC_BODY_CAP = 32000;
export const THREAD_EVENT_BODY_CAP = 8000;

export function isChatProseReply(text: string, envelopeName: string): boolean {
  const prose = text.trim();
  return !prose.includes(`<${envelopeName}`) && prose.length > 50;
}

export type ChatReplyResultLike = {
  output_text: string;
  parsed: unknown;
  parse_ok: boolean;
  parse_error?: string;
  raw_response_text?: string;
  stop_reason?: string;
  schema_soft_failed?: boolean;
  coercion_notes?: string[];
};

export type ChatReplySelection = {
  text: string;
  meta: Record<string, unknown>;
  emptyFallbackUsed: boolean;
};

export function selectChatReplyText(args: {
  result: ChatReplyResultLike;
  agentSlug: string;
  envelopeName?: string;
}): ChatReplySelection {
  const { result, agentSlug, envelopeName } = args;
  const meta: Record<string, unknown> = {};

  let bodyText = result.output_text ?? "";

  if (
    envelopeName &&
    result.parse_ok &&
    Array.isArray(result.coercion_notes) &&
    result.coercion_notes.length > 0
  ) {
    meta.coercion_notes = result.coercion_notes;
  }

  if (
    envelopeName &&
    result.parse_ok &&
    typeof result.parse_error === "string" &&
    result.parse_error.startsWith("salvaged:")
  ) {
    meta.parse_salvaged = true;
    meta.parse_salvage_path = result.parse_error.split(":")[1] ?? "unknown";
  } else if (envelopeName && result.schema_soft_failed) {
    const errStr = result.parse_error ?? "";
    const softParsed = result.parsed as { rendered_markdown?: unknown } | null;
    const prose =
      softParsed && typeof softParsed.rendered_markdown === "string"
        ? softParsed.rendered_markdown.trim()
        : (result.output_text ?? "").trim();
    meta.schema_soft_failed = true;
    meta.parse_error = errStr;
    meta.raw_output_preview = (result.raw_response_text ?? "").slice(0, 4000);
    bodyText =
      prose.length > 0
        ? prose
        : `_${agentSlug} produced a response but one field didn't validate._`;
  } else if (envelopeName && !result.parse_ok) {
    const errStr = result.parse_error ?? "";
    const prose = (result.output_text ?? "").trim();

    if (isChatProseReply(prose, envelopeName)) {
      meta.envelope_omitted = true;
      if (errStr) meta.envelope_omitted_reason = errStr;
      bodyText = prose;
    } else {
      meta.parse_failed = true;
      meta.parse_error = errStr || "envelope did not parse";
      meta.raw_output_preview = prose.slice(0, 4000);
      const wasTruncated = result.stop_reason === "max_tokens";
      bodyText = wasTruncated
        ? `_${agentSlug} ran long and got cut off before it could finish. Try breaking the ask into a smaller piece, or re-running with less context._`
        : `_${agentSlug} couldn't finish that one cleanly — the response didn't come together. Try rephrasing the ask or breaking it into smaller pieces._`;
    }
  }

  bodyText = stripPlanBlock(bodyText, agentSlug);

  bodyText = stripHtmlPreviewBlock(bodyText);

  if (agentSlug === "qa") {
    bodyText = bodyText.replace(/<drafts>[\s\S]*?<\/drafts>/g, "").trim();
  }

  const lead = stripLeadNarration(bodyText);
  if (lead.stripped) {
    bodyText = lead.text;
    meta.lead_narration_removed = true;
  }

  let emptyFallbackUsed = false;
  if (bodyText.trim().length === 0) {
    bodyText = CHAT_EMPTY_FALLBACK;
    emptyFallbackUsed = true;
    meta.empty = true;
  }

  return { text: bodyText, meta, emptyFallbackUsed };
}

export function floorReplyBody(bodyText: string): {
  text: string;
  refloored: boolean;
} {
  if (bodyText.trim().length === 0) {
    return { text: CHAT_EMPTY_FALLBACK, refloored: true };
  }
  return { text: bodyText, refloored: false };
}

export type TerminalChatEmit = {
  bodyText: string;
  empty: boolean;
  shouldEmit: boolean;
};

export function selectTerminalChatEmit(args: {
  result: ChatReplyResultLike;
  agentSlug: string;
  envelopeName?: string;
  trigger: string;
}): TerminalChatEmit {
  const sel = selectChatReplyText({
    result: args.result,
    agentSlug: args.agentSlug,
    envelopeName: args.envelopeName,
  });
  return {
    bodyText: sel.text,
    empty: sel.emptyFallbackUsed,
    shouldEmit: args.trigger === "chat" || !sel.emptyFallbackUsed,
  };
}
