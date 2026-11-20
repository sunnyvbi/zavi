
import type { Request, Response } from "express";
import crypto from "node:crypto";
import { oauthCallbackClient } from "@/services/tenant-client";
import { MEDIA_UNSUPPORTED_TEXT } from "@/services/connectors/chat-copy";
import { ingestAndEnqueueWorkItem } from "@/services/agents/work-queue";
import { extractBindToken, makeBindCode } from "@/services/connectors/bind-code";
import { sanitizeWhatsAppPayload } from "@/services/redactor/whatsapp-payload-sanitizer";
import { whatsappEnabled, whatsappEnv, callWhatsApp } from "@/services/connectors/whatsapp/adapter";
import { logEvent } from "@/services/logging/logEvent";

function svc() {
  return oauthCallbackClient(
    "whatsapp webhook: pre-tenant thread resolve + prefill token consume (tenant recovered from a server-minted token, no Bearer session exists)",
  );
}

async function resolveTenant(phoneNumberId: string, waId: string): Promise<string | null> {
  const { data, error } = await svc()
    .from("whatsapp_threads")
    .select("tenant_id, status")
    .eq("phone_number_id", phoneNumberId)
    .eq("wa_id", waId)
    .maybeSingle<{ tenant_id: string; status: string }>();
  if (error || !data || data.status !== "enabled") return null;
  return data.tenant_id;
}

async function touchWindow(phoneNumberId: string, waId: string, ts: string): Promise<void> {
  const { error } = await svc().rpc("touch_whatsapp_window", {
    p_phone_number_id: phoneNumberId,
    p_wa_id: waId,
    p_ts: ts,
  });
  if (error) {
    console.warn("[webhooks/whatsapp] touch_whatsapp_window failed:", error.message);
  }
}

async function flushCustomAgentPending(tenantId: string, phoneNumberId: string, waId: string): Promise<void> {
  try {
    const { flushCustomAgentWhatsAppPending } = await import("@/services/agents/custom-agent-runs");
    await flushCustomAgentWhatsAppPending({ tenant_id: tenantId, phone_number_id: phoneNumberId, wa_id: waId });
  } catch (e) {
    console.warn("[webhooks/whatsapp] custom agent pending flush failed:", (e as Error).message);
  }
}

async function replyText(waId: string, body: string): Promise<void> {
  await callWhatsApp(waId, { type: "text", text: { body, preview_url: false } }).catch(() => {});
}

const ACK_REACTION_EMOJI = "⏳";
async function reactAck(waId: string, messageId: string): Promise<void> {
  const r = await callWhatsApp(waId, {
    type: "reaction",
    reaction: { message_id: messageId, emoji: ACK_REACTION_EMOJI },
  }).catch(() => null);
  if (r && !r.ok) {
    await logEvent({
      level: "warn",
      source: "webhooks.whatsapp",
      code: "whatsapp_ack_reaction_failed",
      meta: { code: r.errorCode, http: r.status },
    }).catch(() => {});
  }
}

export async function whatsappWebhookVerify(req: Request, res: Response): Promise<void> {
  if (!whatsappEnabled()) {
    res.status(503).json({ error: { code: "whatsapp_disabled" } });
    return;
  }
  const env = whatsappEnv()!;
  const mode = String(req.query["hub.mode"] ?? "");
  const token = String(req.query["hub.verify_token"] ?? "");
  const challenge = String(req.query["hub.challenge"] ?? "");

  const a = Buffer.from(token);
  const b = Buffer.from(env.verifyToken);
  const tokenOk = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (mode !== "subscribe" || !tokenOk) {
    res.status(403).json({ error: { code: "verify_failed" } });
    return;
  }
  res.status(200).type("text/plain").send(challenge);
}

export async function whatsappWebhook(req: Request, res: Response): Promise<void> {
  if (!whatsappEnabled()) {
    res.status(503).json({ error: { code: "whatsapp_disabled" } });
    return;
  }
  const env = whatsappEnv()!;

  const rawBuf = (req.body as Buffer | undefined) ?? Buffer.alloc(0);
  const signature = String(req.header("x-hub-signature-256") ?? "");
  if (!signature) {
    res.status(401).json({ error: { code: "no_signature" } });
    return;
  }
  const { verifyHubSignature256 } = await import("@/services/connectors/hub-signature");
  if (!verifyHubSignature256(rawBuf, signature, env.appSecret)) {
    res.status(401).json({ error: { code: "bad_signature" } });
    return;
  }

  let body: any;
  try {
    body = JSON.parse(rawBuf.toString("utf8"));
  } catch {
    res.status(200).json({ ok: true });
    return;
  }

  res.status(200).json({ ok: true });

  try {
    await handleBatch(body);
  } catch (e) {
    console.warn("[webhooks/whatsapp] batch failed:", (e as Error).message);
  }
}

async function handleBatch(body: any): Promise<void> {
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value;
      if (!value) continue;

      const phoneNumberId = String(value?.metadata?.phone_number_id ?? "");
      if (!phoneNumberId) continue;

      const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
      for (const st of statuses) {
        await logEvent({
          level: String(st?.status) === "failed" ? "warn" : "info",
          source: "webhooks.whatsapp.status",
          code: `whatsapp_status_${String(st?.status ?? "unknown")}`,
          meta: {
            code: Number(st?.errors?.[0]?.code) || undefined,
          },
        }).catch(() => {});
      }

      const messages = Array.isArray(value?.messages) ? value.messages : [];
      const contacts = Array.isArray(value?.contacts) ? value.contacts : [];
      for (const msg of messages) {
        try {
          await handleMessage(phoneNumberId, msg, contacts, value);
        } catch (e) {
          console.warn("[webhooks/whatsapp] message failed:", (e as Error).message);
        }
      }
    }
  }
}

async function handleMessage(
  phoneNumberId: string,
  msg: any,
  contacts: any[],
  value: any,
): Promise<void> {
  const waId = String(msg?.from ?? "");
  const messageId = String(msg?.id ?? "");
  if (!waId || !messageId) return;

  const displayName = String(contacts?.[0]?.profile?.name ?? "") || null;
  const msgType = String(msg?.type ?? "");
  const caption =
    msgType === "image" || msgType === "video" || msgType === "document"
      ? String((msg as Record<string, { caption?: unknown }> | undefined)?.[msgType]?.caption ?? "")
      : "";
  const text = msgType === "text" ? String(msg?.text?.body ?? "") : caption;

  const tsSec = Number(msg?.timestamp);
  const inboundAt = Number.isFinite(tsSec) && tsSec > 0
    ? new Date(tsSec * 1000).toISOString()
    : new Date().toISOString();

  const token = extractBindToken(text);
  if (token) {
    const code = makeBindCode();
    const { data: status, error } = await svc().rpc("consume_whatsapp_link_token", {
      p_token: token,
      p_phone_number_id: phoneNumberId,
      p_wa_id: waId,
      p_confirm_code: code,
      p_display_name: displayName,
    });
    if (error) {
      console.warn("[webhooks/whatsapp] consume_whatsapp_link_token failed:", error.message);
      await replyText(waId, "Something went wrong setting that up. Please try the link again.");
      return;
    }
    if (status === "ok") {
      await replyText(
        waId,
        `Almost done. Enter this code in Zavi Settings to finish connecting:\n\n${code}\n\nIt expires in 15 minutes.`,
      );
      await logEvent({
        level: "info",
        source: "webhooks.whatsapp.bind",
        code: "whatsapp_bind_pending",
      }).catch(() => {});
    } else if (status === "owned_by_other_tenant") {
      await replyText(waId, "This WhatsApp number is already connected to a Zavi workspace.");
      await logEvent({
        level: "warn",
        source: "webhooks.whatsapp.bind",
        code: "whatsapp_bind_cross_tenant_refused",
      }).catch(() => {});
    } else {
      await replyText(waId, "That connect link has expired. Generate a new one in Zavi Settings.");
    }
    return;
  }

  const tenantId = await resolveTenant(phoneNumberId, waId);
  if (!tenantId) return;

  if (await handleCustomAgentWhatsApp({ tenantId, phoneNumberId, waId, messageId, msg, text, inboundAt, contacts, value })) {
    return;
  }

  if (!text.trim()) {
    await replyText(waId, MEDIA_UNSUPPORTED_TEXT);
    await touchWindow(phoneNumberId, waId, inboundAt);
    await flushCustomAgentPending(tenantId, phoneNumberId, waId);
    return;
  }

  const sanitized = sanitizeWhatsAppPayload({
    metadata: value?.metadata,
    contacts,
    message: msg,
  }) as Record<string, unknown>;

  const result = await ingestAndEnqueueWorkItem({
    tenant_id: tenantId,
    provider: "whatsapp",
    external_event_id: messageId,
    event_type: "message",
    ingest_payload: sanitized,
    agent_slug: "operator",
    source: "webhook_whatsapp",
    dedupe_key: `whatsapp:${messageId}`,
    payload: {
      event_type: "message",
      whatsapp: {
        phone_number_id: phoneNumberId,
        wa_id: waId,
        message_id: messageId,
        text,
      },
    },
  });

  await touchWindow(phoneNumberId, waId, inboundAt);
  await flushCustomAgentPending(tenantId, phoneNumberId, waId);

  if (!result.duplicate) {
    await reactAck(waId, messageId);
  }
}

async function handleCustomAgentWhatsApp(a: {
  tenantId: string;
  phoneNumberId: string;
  waId: string;
  messageId: string;
  msg: unknown;
  text: string;
  inboundAt: string;
  contacts: unknown[];
  value: any;
}): Promise<boolean> {
  const chat = await import("@/services/agents/custom-agent-chat");
  const button = chat.parseWhatsAppConfirmButton(a.msg);
  let code = button?.code ?? chat.parseConfirmText(a.text);
  if (code && !button && !(await chat.confirmCodeIssued(a.tenantId, code, "whatsapp"))) code = null;
  const touched = async () => {
    await touchWindow(a.phoneNumberId, a.waId, a.inboundAt);
    await flushCustomAgentPending(a.tenantId, a.phoneNumberId, a.waId);
  };

  if (code) {
    await touched();
    try {
      const owner = await chat.whatsappOwnerUserId(a.tenantId, a.phoneNumberId, a.waId);
      if (!owner) {
        await replyText(a.waId, chat.WHATSAPP_NOT_OWNER_REPLY);
        return true;
      }
      const result = await chat.runCustomAgentConfirm(
        a.tenantId,
        {
          code,
          surface: "whatsapp",
          external_user_id: a.waId,
          phone_number_id: a.phoneNumberId,
          draft_hash: button?.hash ?? null,
        },
        { created_by: owner, slack_user_id: null },
      );
      await replyText(a.waId, result.text);
    } catch (e) {
      console.warn("[webhooks/whatsapp] custom agent confirm failed:", (e as Error).message);
      await replyText(a.waId, chat.CONFIRM_FAILED_REPLY);
    }
    return true;
  }

  if (!a.text.trim()) return false;
  const hit = await chat.resolveCustomAgentMention(a.tenantId, a.text).catch(() => null);
  if (!hit) return false;
  if (hit.kind === "paused") {
    await touched();
    await replyText(a.waId, chat.customAgentPausedReply(hit.agent.name));
    return true;
  }
  const free = await chat.tenantIsFree(a.tenantId);
  if (free !== false) {
    await touched();
    await replyText(a.waId, free === true ? chat.planRefusalText() : chat.GENERIC_RETRY_REPLY);
    return true;
  }
  const result = await ingestAndEnqueueWorkItem({
    tenant_id: a.tenantId,
    provider: "whatsapp",
    external_event_id: a.messageId,
    event_type: "message",
    ingest_payload: sanitizeWhatsAppPayload({
      metadata: a.value?.metadata,
      contacts: a.contacts,
      message: a.msg,
    }) as Record<string, unknown>,
    agent_slug: hit.agent.slug,
    source: "webhook_whatsapp",
    dedupe_key: `whatsapp:${a.messageId}`,
    payload: {
      event_type: "message",
      task_description: chat.customMentionTask(hit.task),
      custom_agent_mention: true,
      whatsapp: {
        phone_number_id: a.phoneNumberId,
        wa_id: a.waId,
        message_id: a.messageId,
        text: a.text,
      },
    },
  });
  await touched();
  if (!result.duplicate) await reactAck(a.waId, a.messageId);
  return true;
}
