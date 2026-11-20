
import sgMail from "@sendgrid/mail";
import { getSecret } from "@/services/secrets/vault";
import { ExpectedToolError } from "@/services/tools/types";
import { guardOutboundSend, isSuppressed, recordWarmupSend, unsubscribeHeaders } from "./safety-net";
import { logEvent } from "@/services/logging/logEvent";

const EMAIL_SECRET_KEY = "email.api_key";
const EMAIL_FROM_KEY = "email.from_address";
const EMAIL_FROM_NAME_KEY = "email.from_name";

export const EMAIL_FROM_NOT_SET_MESSAGE =
  "SendGrid has no verified sender Zavi can send from, so nothing was sent. Verify a sender in SendGrid, or pick one in Email campaigns settings, then ask Zavi to send it again.";

export const EMAIL_SENDER_UNREADABLE_MESSAGE =
  "Zavi could not check which sender you picked in Email campaigns settings, so nothing was sent. Try again in a minute.";

export const SENDGRID_UNCONFIRMED =
  "SendGrid did not confirm the send, so it may or may not have gone out. Check SendGrid's activity feed before sending it again.";

async function sendgridVerifiedSender(
  tenant_id: string,
  apiKey: string,
): Promise<{ email: string; name: string | null } | null> {
  const { sendgrid, sendgridHttpCall } = await import("@/services/connectors/email-campaign/providers-sendgrid");
  const { readEmailSettingText } = await import("@/services/comms/bulk-outbound/readiness");
  const call = sendgridHttpCall(apiKey);
  const pinned = await readEmailSettingText(tenant_id, "sendgrid_sender_id").catch(() => {
    throw new ExpectedToolError("email_sender_unreadable", EMAIL_SENDER_UNREADABLE_MESSAGE);
  });
  if (pinned) {
    const s = await sendgrid.verifiedSender?.(call, pinned).catch(() => null);
    return s ?? null;
  }
  const d = await sendgrid.defaultSender(call, { id: "", name: "", member_count: null }).catch(() => ({ name: null, email: null }));
  return d.email ? { email: d.email, name: d.name } : null;
}

export type SendShape = {
  to: string;
  cc?: string[];
  subject: string;
  body_text: string;
  body_html?: string;
  reply_to?: string;
  from_override?: string;
  from_name_override?: string;
  in_reply_to?: string;
  references?: string[];
  attachments?: Array<{
    filename: string;
    content: string;
    type: string;
  }>;
};

export type SendResult = {
  ok: true;
  messageId: string;
  statusCode: number;
};

export async function emailSend(
  tenant_id: string,
  msg: SendShape,
  opts: { verifiedSenderFallback?: boolean } = {},
): Promise<SendResult> {
  const apiKey = await getSecret(tenant_id, EMAIL_SECRET_KEY);
  if (!apiKey) {
    throw new ExpectedToolError(
      "email_not_connected",
      "Email is not connected for this workspace. Visit /connectors to paste a SendGrid API key.",
    );
  }

  const storedFrom = msg.from_override ?? (await getSecret(tenant_id, EMAIL_FROM_KEY));
  const verified = storedFrom || !opts.verifiedSenderFallback ? null : await sendgridVerifiedSender(tenant_id, apiKey);
  const from = storedFrom ?? verified?.email ?? null;
  if (!from) {
    throw new ExpectedToolError("email_from_not_set", EMAIL_FROM_NOT_SET_MESSAGE);
  }

  const fromName =
    msg.from_name_override ??
    (await getSecret(tenant_id, EMAIL_FROM_NAME_KEY)) ??
    verified?.name ??
    from;

  const guard = await guardOutboundSend({
    tenantId: tenant_id,
    to: msg.to,
    fromAddress: from,
  });
  if (!guard.allowed) {
    await logEvent({
      level: "warn",
      source: "email.safety-net",
      code: guard.code,
      message: "outbound email refused by comms safety net",
      tenant_id,
      meta: {
        ...(guard.meta.effective_cap != null ? { cap: guard.meta.effective_cap } : {}),
        ...(guard.meta.day_index != null ? { count: guard.meta.day_index } : {}),
      },
    });
    throw new ExpectedToolError(guard.code, guard.reason, { ...guard.meta });
  }

  const headers: Record<string, string> = {};
  if (msg.in_reply_to) headers["In-Reply-To"] = msg.in_reply_to;
  if (msg.references && msg.references.length > 0) {
    headers["References"] = msg.references.join(" ");
  }
  Object.assign(headers, unsubscribeHeaders(guard.unsubToken));

  const ccList: string[] = [];
  for (const raw of msg.cc ?? []) {
    const addr = String(raw ?? "").trim().toLowerCase();
    if (!addr) continue;
    if (addr === msg.to.trim().toLowerCase()) continue;
    if (addr === from.trim().toLowerCase()) continue;
    if (msg.reply_to && addr === msg.reply_to.trim().toLowerCase()) continue;
    if (ccList.includes(addr)) continue;
    if (await isSuppressed(tenant_id, addr)) continue;
    ccList.push(addr);
  }

  sgMail.setApiKey(apiKey);

  try {
    const [resp] = await sgMail.send({
      to: msg.to,
      ...(ccList.length > 0 ? { cc: ccList } : {}),
      from: { email: from, name: fromName },
      replyTo: msg.reply_to ? { email: msg.reply_to } : undefined,
      subject: msg.subject,
      text: msg.body_text,
      html:
        msg.body_html ??
        msg.body_text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>"),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      customArgs: { tenant_id },
      ...(msg.attachments && msg.attachments.length > 0
        ? {
            attachments: msg.attachments.map((a) => ({
              filename: a.filename,
              content: a.content,
              type: a.type,
              disposition: "attachment" as const,
            })),
          }
        : {}),
    });
    await recordWarmupSend(tenant_id, guard.warmup);
    return {
      ok: true,
      messageId: (resp.headers["x-message-id"] as string) ?? "",
      statusCode: resp.statusCode,
    };
  } catch (e) {
    const err = e as { code?: number | string; response?: { body?: unknown }; message?: string; isAxiosError?: boolean; request?: unknown };
    const noAnswer = err.response === undefined && (err.isAxiosError === true || err.request !== undefined);
    if (noAnswer || (typeof err.code === "number" && err.code >= 500)) {
      await recordWarmupSend(tenant_id, guard.warmup);
      throw new ExpectedToolError("email_send_outcome_unknown", SENDGRID_UNCONFIRMED, { code: err.code });
    }
    throw new ExpectedToolError(
      "email_send_failed",
      err.message ?? "SendGrid send failed",
      { code: err.code, response: err.response?.body },
    );
  }
}
