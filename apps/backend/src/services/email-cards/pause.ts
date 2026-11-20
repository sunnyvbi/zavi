import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { getBoolSettingStrictResolved } from "@/services/settings";
import { readGlobalBulkStop } from "@/services/comms/bulk-outbound/config";

export async function emailSendPaused(tenantId: string): Promise<boolean> {
  const { data, error } = await tenantRpc(asTenantId(tenantId), "email_send_paused", {});
  if (error) throw new Error("email_send_paused failed");
  return data === true;
}

export async function setEmailSendPaused(
  tenantId: string,
  actorUserId: string,
  paused: boolean,
): Promise<{ ok: true; paused: boolean; resumed: string[] } | { ok: false; code: string }> {
  const { data, error } = await tenantRpc(asTenantId(tenantId), "set_email_pause", { p_actor_user_id: actorUserId, p_paused: paused });
  if (error) throw new Error("set_email_pause failed");
  const out = (data ?? {}) as { ok?: boolean; code?: string; paused?: boolean; resumed?: unknown };
  if (out.ok !== true) return { ok: false, code: typeof out.code === "string" ? out.code : "refused" };
  return { ok: true, paused: out.paused === true, resumed: Array.isArray(out.resumed) ? out.resumed.filter((x): x is string => typeof x === "string") : [] };
}

export type EmailSendHold = "abuse" | "global" | "disabled" | "unknown";

export type BulkApproveStop = "bulk_abuse_hold" | "bulk_outbound_disabled";

export async function bulkApproveStop(tenantId: string): Promise<BulkApproveStop | null> {
  const { data, error } = await tenantClient(asTenantId(tenantId)).from("email_bulk_abuse_holds").select("cleared_at").maybeSingle();
  if (error) throw new Error("email_bulk_abuse_holds read failed");
  if (data && !(data as { cleared_at: string | null }).cleared_at) return "bulk_abuse_hold";
  return (await getBoolSettingStrictResolved("bulk_outbound_enabled", tenantId)) ? null : "bulk_outbound_disabled";
}

export async function emailSendHeld(tenantId: string): Promise<EmailSendHold | null> {
  const globalStop = await readGlobalBulkStop();
  if (globalStop === "stopped") return "global";
  const { data, error } = await tenantClient(asTenantId(tenantId)).from("email_bulk_abuse_holds").select("cleared_at").maybeSingle();
  if (error) throw new Error("email_bulk_abuse_holds read failed");
  if (data && !(data as { cleared_at: string | null }).cleared_at) return "abuse";
  if (!(await getBoolSettingStrictResolved("bulk_outbound_enabled", tenantId))) return "disabled";
  if (globalStop !== "running") return "unknown";
  return null;
}
