import { getSecret } from "@/services/secrets/vault";
import { resolveOwnedComposioAccount } from "@/services/connectors/composio/account";
import { sendEmailViaComposioGmail, type GmailMessage } from "@/services/connectors/gmail-composio/send";
import { isSuppressed } from "@/services/tools/email/safety-net";
import { ExpectedToolError } from "@/services/tools/types";

export type EmailSenderKind = "sendgrid" | "gmail";

export const NO_EMAIL_SENDER_NOTE =
  "No email account is connected, so Zavi cannot send this. Write the email in your reply as a draft " +
  "for the operator to copy and send, and tell them they can connect Gmail on the Email campaigns " +
  "channel so Zavi can send the emails they approve.";

export class GmailSendError extends Error {
  constructor(
    message: string,
    public readonly outcome_unknown: boolean,
  ) {
    super(message);
    this.name = "GmailSendError";
  }
}

export async function connectedEmailSender(tenant_id: string): Promise<EmailSenderKind | null> {
  if (await getSecret(tenant_id, "email.api_key")) return "sendgrid";
  return (await resolveOwnedComposioAccount(tenant_id, "gmail")) ? "gmail" : null;
}

export async function sendFromConnectedGmail(
  tenant_id: string,
  msg: GmailMessage,
): Promise<{ message_id: string } | null> {
  const account = await resolveOwnedComposioAccount(tenant_id, "gmail");
  if (!account) return null;
  const suppression = await isSuppressed(tenant_id, msg.to);
  if (suppression) {
    throw new ExpectedToolError(
      "recipient_suppressed",
      `Recipient ${msg.to} is suppressed (${suppression}) for this workspace, so Zavi did not send it.`,
    );
  }
  const r = await sendEmailViaComposioGmail(account, msg);
  if (!r.ok) throw new GmailSendError(r.error, r.outcome_unknown);
  return { message_id: r.message_id };
}
