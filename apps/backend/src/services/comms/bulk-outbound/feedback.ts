
import { asTenantId, preTenantRpc, tenantRpc } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";
import { shutOffBulkEmail } from "./shutoff";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BulkFeedbackKind = "complaint" | "hard_bounce";

export function bulkFeedbackKind(event: string, type: string | undefined): BulkFeedbackKind | null {
  const e = event.toLowerCase();
  if (e === "spamreport") return "complaint";
  if (e === "bounce" && (type ?? "").toLowerCase() !== "blocked") return "hard_bounce";
  return null;
}

export async function resolveBulkRecipientTenant(sendId: string, email: string): Promise<string | null> {
  if (!UUID_RE.test(sendId) || !email) return null;
  const { data, error } = await preTenantRpc("email_bulk_resolve_recipient", { p_send_id: sendId, p_email: email });
  if (error) throw new Error("email_bulk_resolve_recipient failed");
  return typeof data === "string" && UUID_RE.test(data) ? data : null;
}

export type BulkFeedbackDeps = { shutOff?: typeof shutOffBulkEmail };

export async function recordBulkFeedback(
  args: { tenantId: string; sendId: string; email: string; kind: BulkFeedbackKind },
  deps: BulkFeedbackDeps = {},
): Promise<{ counted: boolean; tripped: boolean }> {
  if (!UUID_RE.test(args.tenantId) || !UUID_RE.test(args.sendId)) return { counted: false, tripped: false };
  const { data, error } = await tenantRpc(asTenantId(args.tenantId), "email_bulk_record_feedback", {
    p_send_id: args.sendId,
    p_email: args.email,
    p_kind: args.kind,
  });
  if (error) throw new Error("email_bulk_record_feedback failed");
  const out = data as { ok?: boolean; counted?: boolean; tripped?: boolean; reason?: string | null } | null;
  if (!out?.ok) return { counted: false, tripped: false };
  if (out.tripped) {
    try {
      await (deps.shutOff ?? shutOffBulkEmail)(args.tenantId, args.sendId, out.reason ?? "abuse_complaints");
    } catch (e) {
      await logEvent({
        level: "error",
        source: "bulk-email",
        code: "bulk_email.shutoff_failed",
        message: "bulk email shutoff did not complete; the workspace abuse hold still stops sending",
        tenant_id: args.tenantId,
        meta: { bulk_send_id: args.sendId, reason: out.reason ?? "abuse_complaints", error_class: (e as Error)?.name ?? "Error" },
      }).catch(() => undefined);
      throw e;
    }
  }
  return { counted: out.counted === true, tripped: out.tripped === true };
}
