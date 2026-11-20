
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Request, Response } from "express";
import { oauthCallbackClient } from "@/services/tenant-client";
import { ingestAndEnqueueWorkItem } from "@/services/agents/work-queue";
import {
  telegramEnabled,
  telegramEnv,
  verifyWebhookSecret,
  callTelegram,
} from "@/services/connectors/telegram/adapter";
import { sanitizeTelegramUpdatePayload } from "@/services/redactor/telegram-payload-sanitizer";
import { stripBotMention, mentionsBot } from "@/services/connectors/telegram/mention";
import {
  ON_IT_ACK,
  MEDIA_UNSUPPORTED_TEXT,
  INTAKE_FAILED_TEXT,
} from "@/services/connectors/chat-copy";
import { logEvent } from "@/services/logging/logEvent";

const SETTINGS_URL = "https://www.zaviagent.com/workspace?tab=settings";

const MEDIA_FIELDS = [
  "photo",
  "document",
  "video",
  "audio",
  "voice",
  "video_note",
  "sticker",
  "animation",
] as const;

function hasMedia(msg: any): boolean {
  return MEDIA_FIELDS.some((f) => msg?.[f] != null);
}

function svc() {
  return oauthCallbackClient(
    "telegram webhook: pre-tenant chat resolve + deep-link token consume (tenant recovered from server-minted state, no Bearer session exists)",
  );
}

function chatOf(node: any): { id: number; type: string; title: string } | null {
  const chat = node?.chat;
  const id = Number(chat?.id);
  if (!Number.isFinite(id) || id === 0) return null;
  return {
    id,
    type: String(chat?.type ?? ""),
    title: String(chat?.title ?? chat?.first_name ?? ""),
  };
}

function senderOf(msg: any): { id: number | null; username: string } {
  const id = Number(msg?.from?.id);
  return {
    id: Number.isFinite(id) && id !== 0 ? id : null,
    username: typeof msg?.from?.username === "string" ? msg.from.username : "",
  };
}

async function resolveTenant(chatId: number): Promise<string | null> {
  const { data, error } = await svc()
    .from("telegram_chats")
    .select("tenant_id, status")
    .eq("chat_id", chatId)
    .maybeSingle<{ tenant_id: string; status: string }>();
  if (error || !data || data.status !== "enabled") return null;
  return data.tenant_id;
}

async function handleDeepLinkBind(
  chat: { id: number; type: string; title: string },
  msg: any,
  token: string,
): Promise<void> {
  const sender = senderOf(msg);
  const { data: status, error } = await svc().rpc("consume_telegram_link_token", {
    p_token: token,
    p_chat_id: chat.id,
    p_chat_type: chat.type,
    p_chat_title: chat.title.slice(0, 200),
    p_tg_user_id: sender.id,
    p_tg_username: sender.username.slice(0, 64) || null,
  });
  if (error) {
    console.warn("[webhooks/telegram] consume_telegram_link_token failed:", error.message);
    await callTelegram("sendMessage", {
      chat_id: chat.id,
      text: "Something went wrong setting that up. Please tap the link again.",
    }).catch(() => {});
    return;
  }
  const s = String(status);
  if (s === "chat_already_bound") {
    await logEvent({
      level: "warn",
      source: "webhooks.telegram.bind",
      code: "telegram_bind_cross_tenant_refused",
      meta: { chat_id: chat.id, tg_user_id: sender.id },
    }).catch(() => {});
  }
  const text =
    s === "ok"
      ? "✅ Connected. This chat is now linked to your Zavi workspace — just send a message to get started."
      : s === "chat_already_bound"
        ? "This chat is already connected to a different Zavi workspace. Disconnect it there first, or use another chat."
        : `That connect link is invalid or has expired. Mint a fresh one at ${SETTINGS_URL} and tap it again.`;
  await callTelegram("sendMessage", { chat_id: chat.id, text }).catch(() => {});
}

async function handleStartInstructions(chat: {
  id: number;
  type: string;
  title: string;
}): Promise<void> {
  const existingTenant = await resolveTenant(chat.id);
  const text = existingTenant
    ? "This chat is already connected to a Zavi workspace. Just send a message to get started."
    : `👋 To connect this chat, sign in at ${SETTINGS_URL} as a workspace owner/admin, ` +
      `hit "Connect Telegram", and tap the link it gives you${
        chat.type === "private" ? "" : " (choose this group when Telegram asks)"
      }.`;
  await callTelegram("sendMessage", { chat_id: chat.id, text }).catch(() => {});
}

async function handleMyChatMember(update: any): Promise<void> {
  const mcm = update?.my_chat_member;
  const chat = chatOf(mcm);
  if (!chat) return;
  const status = String(mcm?.new_chat_member?.status ?? "");

  if (status === "left" || status === "kicked") {
    await svc().rpc("unset_telegram_connection", {
      p_tenant_id: null,
      p_chat_id: chat.id,
    });
    return;
  }
  if (status === "member" || status === "administrator") {
    await handleStartInstructions(chat);
  }
}

async function handleMessage(update: any): Promise<void> {
  const msg = update?.message;
  const chat = chatOf(msg);
  if (!chat) return;
  if (msg?.from?.is_bot === true) return;

  const isCaption = typeof msg?.text !== "string" && typeof msg?.caption === "string";
  const rawText: string =
    typeof msg?.text === "string" ? msg.text : isCaption ? String(msg.caption) : "";
  const rawEntities = isCaption ? msg?.caption_entities : msg?.entities;

  const start = rawText.match(/^\/start(?![\w])(?:@\w+)?(?:\s+(\S+))?/);
  if (start) {
    const token = start[1] ?? "";
    if (/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
      await handleDeepLinkBind(chat, msg, token);
    } else {
      await handleStartInstructions(chat);
    }
    return;
  }

  const tenantId = await resolveTenant(chat.id);
  if (!tenantId) return;

  const env = telegramEnv();
  if (chat.type !== "private") {
    if (!env?.botUsername) {
      console.warn(
        "[webhooks/telegram] group message dropped: TELEGRAM_BOT_USERNAME unset (required for group mention-gating)",
      );
      return;
    }
    const isMention = mentionsBot(rawText, rawEntities, env.botUsername);
    const repliedTo = msg?.reply_to_message?.from;
    const isReplyToThisBot =
      Boolean(repliedTo?.is_bot) &&
      typeof repliedTo?.username === "string" &&
      repliedTo.username.toLowerCase() === env.botUsername.toLowerCase();
    if (!isMention && !isReplyToThisBot) return;
  }

  const updateId = Number(update?.update_id);
  if (!Number.isFinite(updateId)) return;

  const taskText = stripBotMention(rawText, rawEntities, env?.botUsername ?? "");

  if (!taskText) {
    if (hasMedia(msg)) {
      void callTelegram("sendMessage", {
        chat_id: chat.id,
        text: MEDIA_UNSUPPORTED_TEXT,
        reply_to_message_id: Number(msg?.message_id) || undefined,
        allow_sending_without_reply: true,
      }).catch(() => {});
    }
    return;
  }

  const sanitized = sanitizeTelegramUpdatePayload(update) as Record<string, unknown>;

  const sender = senderOf(msg);
  let result: Awaited<ReturnType<typeof ingestAndEnqueueWorkItem>>;
  try {
    result = await ingestAndEnqueueWorkItem({
    tenant_id: tenantId,
    provider: "telegram",
    external_event_id: String(updateId),
    event_type: "message",
    ingest_payload: sanitized,
    agent_slug: "operator",
    source: "webhook_telegram",
    dedupe_key: `telegram:${updateId}`,
    payload: {
      event_type: "message",
      telegram: {
        chat_id: chat.id,
        chat_type: chat.type,
        message_id: Number(msg?.message_id) || null,
        update_id: updateId,
        text: taskText,
        from_user_id: sender.id,
        from_username: sender.username || null,
      },
      },
    });
  } catch (e) {
    console.warn(`[webhooks/telegram] intake failed: ${(e as Error).message}`);
    void callTelegram("sendMessage", {
      chat_id: chat.id,
      text: INTAKE_FAILED_TEXT,
      reply_to_message_id: Number(msg?.message_id) || undefined,
      allow_sending_without_reply: true,
    }).catch(() => {});
    return;
  }

  if (!result.duplicate) {
    void callTelegram("sendMessage", {
      chat_id: chat.id,
      text: ON_IT_ACK,
      reply_to_message_id: Number(msg?.message_id) || undefined,
      allow_sending_without_reply: true,
    }).catch(() => {});
  }
}

export async function telegramWebhook(req: Request, res: Response): Promise<void> {
  if (!telegramEnabled()) {
    res.status(503).json({
      error: {
        code: "telegram_disabled",
        message: "Telegram connector not configured (TELEGRAM_BOT_TOKEN unset).",
      },
    });
    return;
  }

  if (!verifyWebhookSecret(req.headers["x-telegram-bot-api-secret-token"])) {
    res.status(401).json({ error: { code: "telegram_auth_failed" } });
    return;
  }

  try {
    const update = req.body as any;
    if (update?.message) {
      await handleMessage(update);
    } else if (update?.my_chat_member) {
      await handleMyChatMember(update);
    }
  } catch (e) {
    console.warn(`[webhooks/telegram] handler error (acking): ${(e as Error).message}`);
  }
  res.status(200).json({ ok: true });
}
