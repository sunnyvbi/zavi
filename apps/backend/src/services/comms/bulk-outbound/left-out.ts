import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { BULK_COHORT_HARD_CAP } from "./cohort";

export type LeftOutFacts = {
  contactCount: number;
  total: number;
  skipped: number;
  stopped: number;
  sendableNow: number | null;
};

export function leftOutOfList(f: LeftOutFacts): number {
  const skippedForBlock = Math.max(0, f.skipped - f.stopped);
  const notFrozen = Math.max(0, f.contactCount - f.total);
  if (f.total < BULK_COHORT_HARD_CAP) return notFrozen + skippedForBlock;
  if (f.sendableNow === null) return skippedForBlock;
  const blockedNow = Math.max(0, f.contactCount - f.sendableNow);
  return Math.max(skippedForBlock, Math.min(blockedNow, notFrozen + skippedForBlock));
}

type SendRow = { id: string; total: number; skipped: number; list_version_id: string };

export async function readLeftOut(tenantId: string, send: { id: string } | { decision_id: string }): Promise<number | null> {
  try {
    const db = tenantClient(asTenantId(tenantId));
    const [column, value] = "id" in send ? ["id", send.id] : ["decision_id", send.decision_id];
    const { data: row, error } = await db.from("email_bulk_sends").select("id, total, skipped, list_version_id").eq(column, value).maybeSingle();
    if (error || !row) return null;
    const s = row as SendRow;
    const { data: version, error: versionError } = await db.from("email_list_versions").select("contact_count").eq("id", s.list_version_id).maybeSingle();
    const contactCount = Number((version as { contact_count?: unknown } | null)?.contact_count);
    if (versionError || !Number.isFinite(contactCount)) return null;
    let stopped = 0;
    if (s.skipped > 0) {
      const { count, error: stoppedError } = await db
        .from("email_bulk_send_recipients")
        .select("contact_id", { count: "exact", head: true })
        .eq("send_id", s.id)
        .eq("status", "skipped")
        .eq("skip_reason", "stopped");
      if (stoppedError || count === null) return null;
      stopped = count;
    }
    let sendableNow: number | null = null;
    if (s.total >= BULK_COHORT_HARD_CAP) {
      const { data, error: countError } = await tenantRpc(asTenantId(tenantId), "email_list_version_freeze_count", { p_version_id: s.list_version_id });
      if (!countError && typeof data === "number") sendableNow = data;
    }
    return leftOutOfList({ contactCount, total: s.total, skipped: s.skipped, stopped, sendableNow });
  } catch {
    return null;
  }
}
