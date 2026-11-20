import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { BulkRefusal, BulkSenderReady } from "@/services/comms/bulk-outbound/readiness";

export type EmailRunPreflight = { verdict: "ok" } | { verdict: "retry" | "block"; code: string; sentence: string | null };

export type PreflightDeps = {
  checkSender: (tenantId: string) => Promise<BulkSenderReady | BulkRefusal>;
  cardCapFull: (tenantId: string) => Promise<boolean>;
};

const SENDER_RETRY = new Set(["bulk_sending_paused", "bulk_check_failed"]);

export async function emailCardCapFull(tenantId: string): Promise<boolean> {
  const { EMAIL_CARD_CAP_PER_TENANT_24H: cap } = await import("@/services/tools/email/propose_campaign");
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await tenantClient(asTenantId(tenantId)).from("email_card_reservations").select("id").gt("created_at", since).limit(cap);
  if (error) return false;
  return (data ?? []).length >= cap;
}

const LIVE: PreflightDeps = {
  checkSender: async (tenantId) => (await import("@/services/comms/bulk-outbound/readiness")).checkBulkSender(tenantId),
  cardCapFull: emailCardCapFull,
};

export async function emailRunPreflight(
  tenantId: string,
  plan: { route: string; cards?: boolean },
  depsIn: Partial<PreflightDeps> = {},
): Promise<EmailRunPreflight> {
  const deps = { ...LIVE, ...depsIn };
  if (plan.cards && (await deps.cardCapFull(tenantId))) return { verdict: "retry", code: "email_card_cap_reached", sentence: null };
  if (plan.route !== "zavi_list") return { verdict: "ok" };
  const sender = await deps.checkSender(tenantId);
  if (sender.ok) return { verdict: "ok" };
  return { verdict: SENDER_RETRY.has(sender.code) ? "retry" : "block", code: sender.code, sentence: sender.sentence };
}
