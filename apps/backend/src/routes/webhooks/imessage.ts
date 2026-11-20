
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Request, Response } from "express";
import { asTenantId, oauthCallbackClient, tenantRpc } from "@/services/tenant-client";
import { ingestAndEnqueueWorkItem } from "@/services/agents/work-queue";
import { extractBindToken, makeBindCode } from "@/services/connectors/bind-code";
import { INTAKE_FAILED_TEXT, MEDIA_UNSUPPORTED_TEXT } from "@/services/connectors/chat-copy";
import { normalizeHandle } from "@/services/connectors/imessage/handle";
import {
  imessageEnabled,
  imessageOwnsLine,
  sendIMessageText,
  startIMessageTyping,
  verifySendblueSecret,
} from "@/services/connectors/imessage/sendblue";
import { sanitizeIMessagePayload } from "@/services/redactor/imessage-payload-sanitizer";
import { logEvent } from "@/services/logging/logEvent";

const SETTINGS_URL = "https://www.zaviagent.com/workspace?tab=settings";

export const NOT_CONNECTED_TEXT = `Hi, this is Zavi. To talk to Zavi here, connect iMessage in your workspace settings: ${SETTINGS_URL}`;
export const PENDING_TEXT = "Almost there. Enter the code I sent you in Zavi Settings to finish connecting.";

const STOP_RE = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|opt[\s-]?out|revoke)\s*[.!]*\s*$/i;

function svc() {
  return oauthCallbackClient(
    "imessage webhook: pre-tenant thread resolve + prefill token consume (tenant recovered from a server-minted token, no Bearer session exists)",
  );
}

export async function imessageWebhook(req: Request, res: Response): Promise<void> {
  if (!imessageEnabled()) {
    res.status(503).json({ error: { code: "imessage_disabled" } });
    return;
  }
  if (!verifySendblueSecret(req.header("sb-signing-secret"))) {
    res.status(401).json({ error: { code: "bad_signature" } });
    return;
  }
  try {
    await handleInbound((req.body ?? {}) as Record<string, any>);
  } catch (e) {
    console.warn(`[webhooks/imessage] handler error (acking): ${(e as Error).message}`);
  }
  res.status(200).json({ ok: true });
}

async function handleInbound(body: Record<string, any>): Promise<void> {
  if (body.is_outbound === true) return;
  const messageHandle = String(body.message_handle ?? "");
  if (!messageHandle) return;
  if (String(body.group_id ?? "")) return;

  const line = normalizeHandle(body.sendblue_number || body.to_number);
  const handle = normalizeHandle(body.from_number || body.number);
  if (!line || !handle) return;
  if (!imessageOwnsLine(line)) {
    await logEvent({ level: "warn", source: "webhooks.imessage", code: "imessage_line_not_served" }).catch(() => {});
    return;
  }

  const text = String(body.content ?? "").trim();

  const token = extractBindToken(text);
  if (token) {
    await bind(token, line, handle);
    return;
  }

  const { data: thread } = await svc()
    .from("imessage_threads")
    .select("id, tenant_id, status")
    .eq("line", line)
    .eq("handle", handle)
    .maybeSingle<{ id: string; tenant_id: string; status: string }>();

  if (thread?.status === "enabled" && (body.opted_out === true || STOP_RE.test(text))) {
    await tenantRpc(asTenantId(thread.tenant_id), "unset_imessage_thread", { p_thread_id: thread.id });
    await logEvent({
      level: "info",
      source: "webhooks.imessage",
      code: "imessage_opted_out",
      tenant_id: thread.tenant_id,
    }).catch(() => {});
    return;
  }
  if (body.opted_out === true) return;

  if (thread?.status === "pending") {
    await sendIMessageText(handle, PENDING_TEXT);
    return;
  }
  if (thread?.status !== "enabled") {
    await sendIMessageText(handle, NOT_CONNECTED_TEXT);
    return;
  }
  const tenantId = thread.tenant_id;

  if (!text) {
    if (body.media_url) await sendIMessageText(handle, MEDIA_UNSUPPORTED_TEXT);
    return;
  }

  let result: Awaited<ReturnType<typeof ingestAndEnqueueWorkItem>>;
  try {
    result = await ingestAndEnqueueWorkItem({
      tenant_id: tenantId,
      provider: "imessage",
      external_event_id: messageHandle,
      event_type: "message",
      ingest_payload: sanitizeIMessagePayload(body),
      agent_slug: "operator",
      source: "webhook_imessage",
      dedupe_key: `imessage:${messageHandle}`,
      payload: {
        event_type: "message",
        imessage: {
          line,
          handle,
          message_handle: messageHandle,
          text,
        },
      },
    });
  } catch (e) {
    console.warn(`[webhooks/imessage] intake failed: ${(e as Error).message}`);
    await sendIMessageText(handle, INTAKE_FAILED_TEXT);
    return;
  }

  if (!result.duplicate) await startIMessageTyping(handle);
}

async function bind(token: string, line: string, handle: string): Promise<void> {
  const code = makeBindCode();
  const { data: status, error } = await svc().rpc("consume_imessage_link_token", {
    p_token: token,
    p_line: line,
    p_handle: handle,
    p_confirm_code: code,
  });
  if (error) {
    console.warn("[webhooks/imessage] consume_imessage_link_token failed:", error.message);
    await sendIMessageText(handle, "Something went wrong setting that up. Please try the link again.");
    return;
  }
  if (status === "ok") {
    await sendIMessageText(handle, `Almost done. Enter this code in Zavi Settings to finish connecting:\n\n${code}\n\nIt expires in 15 minutes.`);
    await logEvent({ level: "info", source: "webhooks.imessage.bind", code: "imessage_bind_pending" }).catch(() => {});
  } else if (status === "already_connected") {
    await sendIMessageText(handle, "This number is already connected to your Zavi workspace. Just text me.");
  } else if (status === "owned_by_other_tenant") {
    await sendIMessageText(handle, "This number is already connected to a Zavi workspace.");
    await logEvent({ level: "warn", source: "webhooks.imessage.bind", code: "imessage_bind_cross_tenant_refused" }).catch(() => {});
  } else {
    await sendIMessageText(handle, "That connect link has expired. Get a new one in Zavi Settings.");
  }
}
