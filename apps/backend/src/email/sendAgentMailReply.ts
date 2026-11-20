
import sgMail from "@sendgrid/mail";
import { isSuppressed } from "@/services/tools/email/safety-net";
import { logEvent } from "@/services/logging/logEvent";
import { systemSenderEmail } from "./system-identity";
import { markdownToEmailText, markdownToReplyHtml } from "./markdown-email";
import { mintMessageId } from "./sendAgentOwnedEmail";

export type AgentMailReply = {
  tenant_id: string;
  to: string;
  cc?: string[];
  subject: string;
  body_text: string;
  reply_to: string;
  from_name?: string;
  in_reply_to?: string;
  references?: string[];
  message_id?: string;
};

export type AgentMailSendResult =
  | { sent: true; messageId: string }
  | { sent: false; reason: string };

function systemKey(): string | null {
  return process.env.SYSTEM_SENDGRID_API_KEY ?? null;
}

export function bracketId(id: string | undefined | null): string {
  const bare = String(id ?? "").trim().replace(/^<|>$/g, "").trim();
  return bare ? `<${bare}>` : "";
}

function systemFrom(): string {
  return systemSenderEmail();
}

export async function sendAgentMailReply(msg: AgentMailReply): Promise<AgentMailSendResult> {
  const apiKey = systemKey();
  const from = systemFrom();
  if (!apiKey) {
    await logEvent({
      level: "error",
      source: "agentmail-reply",
      code: "email.reply.system_sender_unset",
      message:
        "SYSTEM_SENDGRID_API_KEY missing — AgentMail cannot reply. Set it in AWS Secrets Manager praxis-envprod-1 and restart the container.",
      tenant_id: msg.tenant_id,
    });
    return { sent: false, reason: "system_sender_unset" };
  }

  const to = msg.to.trim().toLowerCase();

  if (await isSuppressed(msg.tenant_id, to)) {
    return { sent: false, reason: "recipient_suppressed" };
  }

  const selfAddrs = new Set([to, from.trim().toLowerCase(), msg.reply_to.trim().toLowerCase()]);
  const cc: string[] = [];
  for (const raw of msg.cc ?? []) {
    const addr = String(raw ?? "").trim().toLowerCase();
    if (!addr || selfAddrs.has(addr) || cc.includes(addr)) continue;
    if (await isSuppressed(msg.tenant_id, addr)) continue;
    cc.push(addr);
  }

  const headers: Record<string, string> = {};
  const inReplyTo = bracketId(msg.in_reply_to);
  if (inReplyTo) headers["In-Reply-To"] = inReplyTo;
  const references = (msg.references ?? []).map(bracketId).filter(Boolean);
  if (references.length > 0) headers["References"] = references.join(" ");

  const useIdentityFrom =
    process.env.AGENTMAIL_FROM_IDENTITY !== "0" &&
    /@inbox\.zaviagent\.com$/i.test(msg.reply_to.trim().toLowerCase());
  const fromEmail = useIdentityFrom ? msg.reply_to.trim() : from;
  const messageId = bracketId(msg.message_id) || mintMessageId(fromEmail);
  headers["Message-ID"] = messageId;

  sgMail.setApiKey(apiKey);
  try {
    await sgMail.send({
      to,
      ...(cc.length > 0 ? { cc } : {}),
      from: { email: fromEmail, name: msg.from_name || "Zavi" },
      replyTo: { email: msg.reply_to },
      subject: msg.subject,
      text: markdownToEmailText(msg.body_text),
      html: markdownToReplyHtml(msg.body_text),
      headers,
    });
    return { sent: true, messageId };
  } catch (e) {
    const detail = (e as { response?: { body?: unknown } })?.response?.body;
    await logEvent({
      level: "error",
      source: "agentmail-reply",
      code: "email.reply.sendgrid_failed",
      message: `SendGrid rejected the AgentMail reply: ${(e as Error).message}${
        detail ? ` :: ${JSON.stringify(detail).slice(0, 300)}` : ""
      }`,
      tenant_id: msg.tenant_id,
    });
    throw e;
  }
}
