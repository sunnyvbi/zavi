import { composioExecuteTool, type OwnedComposioAccount } from "@/services/connectors/composio/api";
import { composioReceipt } from "@/services/connectors/composio/publish-receipt";

export const GMAIL_SEND_TOOL = "GMAIL_SEND_EMAIL";

export const GMAIL_UNCONFIRMED =
  "Gmail did not confirm the send, so it may or may not have gone out. Check your Gmail Sent folder before sending it again.";

export type GmailMessage = { to: string; subject: string; body_text: string; body_html?: string };

export type GmailSendResult =
  | { ok: true; message_id: string }
  | { ok: false; error: string; outcome_unknown: boolean };

export async function sendEmailViaComposioGmail(
  account: OwnedComposioAccount,
  msg: GmailMessage,
): Promise<GmailSendResult> {
  const html = msg.body_html?.trim();
  const r = await composioExecuteTool({
    tool_slug: GMAIL_SEND_TOOL,
    user_id: account.tenant_id,
    connected_account_id: account.connected_account_id,
    arguments: {
      recipient_email: msg.to,
      subject: msg.subject,
      body: html || msg.body_text,
      is_html: Boolean(html),
    },
  });
  if (!r.ok) {
    if (r.outcome_unknown) return { ok: false, error: GMAIL_UNCONFIRMED, outcome_unknown: true };
    const why = typeof r.error === "string" && r.error ? r.error : "the send was refused";
    return { ok: false, error: `Gmail did not send it: ${why}`, outcome_unknown: false };
  }
  const { id } = composioReceipt(r.data);
  if (!id) return { ok: false, error: GMAIL_UNCONFIRMED, outcome_unknown: true };
  return { ok: true, message_id: id };
}
