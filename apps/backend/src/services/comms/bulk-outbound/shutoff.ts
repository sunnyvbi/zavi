
import { logEvent } from "@/services/logging/logEvent";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { holdSentence } from "./notices";
import { postBulkSendNotice } from "./thread-notice";

export const ABUSE_SHUTOFF_ACTOR = "system:bulk-email-abuse-shutoff";

export async function shutOffBulkEmail(tenantId: string, sendId: string, reason: string): Promise<void> {
  const { data, error } = await tenantRpc(asTenantId(tenantId), "email_bulk_abuse_switch_off", {});
  if (error) throw new Error("email_bulk_abuse_switch_off failed");
  await logEvent({
    level: "error",
    source: "bulk-email",
    code: "bulk_email.abuse_shutoff",
    message: `bulk email switched off for a workspace: ${reason}`,
    tenant_id: tenantId,
    meta: { reason, bulk_send_id: sendId },
  }).catch(() => undefined);
  if (data !== true) return;
  await postBulkSendNotice(
    tenantId,
    sendId,
    `Bulk email is now switched off for this workspace because ${holdSentence(reason)}. ` +
      `Nothing more will be sent. Check that everyone on the list really agreed to hear from you, then contact support to switch it back on.`,
  ).catch(() => undefined);
}
