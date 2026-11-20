
import {
  callWhatsApp,
  whatsappEnabled,
  whatsappEnv,
  WINDOW_CLOSED_ERROR_CODES,
  RECIPIENT_GONE_ERROR_CODES,
} from "@/services/connectors/whatsapp/adapter";
import { chunkText } from "@/services/tools/chunk-text";
import { formatForWhatsApp } from "@/services/tools/chat-format";

export type WhatsAppReplyResult =
  | { ok: true; chunks: number; templateFallback?: boolean }
  | { ok: false; disabled?: boolean; gone?: boolean; windowClosed?: boolean; sent: number; error: string };

const MAX_WHATSAPP_TEXT = 4096;
const MAX_CHUNKS = 8;

export const WINDOW_SAFETY_BUFFER_MS = 60_000;

export function chunkWhatsAppText(text: string, limit = MAX_WHATSAPP_TEXT): string[] {
  return chunkText(text, limit);
}

export function windowIsOpen(windowExpiresAt: string | null | undefined, now = Date.now()): boolean {
  if (!windowExpiresAt) return false;
  const deadline = Date.parse(windowExpiresAt);
  if (!Number.isFinite(deadline)) return false;
  return now < deadline - WINDOW_SAFETY_BUFFER_MS;
}

export async function postWhatsAppWindowTemplate(args: {
  wa_id: string;
}): Promise<WhatsAppReplyResult> {
  const env = whatsappEnv();
  if (!env) return { ok: false, disabled: true, sent: 0, error: "whatsapp_disabled" };

  const res = await callWhatsApp(args.wa_id, {
    type: "template",
    template: { name: env.windowTemplate, language: { code: "en" } },
  });

  if (!res.ok) {
    const gone = res.errorCode ? RECIPIENT_GONE_ERROR_CODES.has(res.errorCode) : false;
    return { ok: false, gone, sent: 0, error: res.errorMessage || `http_${res.status}` };
  }
  return { ok: true, chunks: 1, templateFallback: true };
}

export async function postWhatsAppReply(args: {
  wa_id: string;
  text: string;
  windowExpiresAt: string | null;
}): Promise<WhatsAppReplyResult> {
  if (!whatsappEnabled()) {
    return { ok: false, disabled: true, sent: 0, error: "whatsapp_disabled" };
  }
  const waId = String(args.wa_id ?? "").trim();
  if (!waId) return { ok: false, sent: 0, error: "no_wa_id" };

  const text = (args.text ?? "").trim();
  if (!text) return { ok: false, sent: 0, error: "empty_text" };

  if (!windowIsOpen(args.windowExpiresAt)) {
    return { ok: false, windowClosed: true, sent: 0, error: "window_closed" };
  }

  const chunks = chunkWhatsAppText(formatForWhatsApp(text)).slice(0, MAX_CHUNKS);
  let sent = 0;

  for (const chunk of chunks) {
    if (!windowIsOpen(args.windowExpiresAt)) {
      return sent === 0
        ? { ok: false, windowClosed: true, sent: 0, error: "window_closed" }
        : { ok: false, windowClosed: true, sent, error: "window_closed_mid_send" };
    }

    const res = await callWhatsApp(waId, {
      type: "text",
      text: { body: chunk, preview_url: false },
    });

    if (!res.ok) {
      const windowClosed = res.errorCode ? WINDOW_CLOSED_ERROR_CODES.has(res.errorCode) : false;
      const gone = res.errorCode ? RECIPIENT_GONE_ERROR_CODES.has(res.errorCode) : false;
      return {
        ok: false,
        gone,
        windowClosed,
        sent,
        error: res.errorMessage || `http_${res.status}`,
      };
    }
    sent += 1;
  }

  return { ok: true, chunks: sent };
}
