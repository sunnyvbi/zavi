
import { z } from "zod";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";

export type StoredLinkedInAction = {
  body: { step?: { responsibility?: string; deliverable?: { presentation?: unknown } }; exact_change?: { rows?: Array<{ item: string; before: string; after: string }> } };
  status: string;
  exec_class: string | null;
  exec_status: string | null;
  approved_by: string | null;
  exec_payload?: unknown;
};

export async function readAction(tenantId: string, actionId: string): Promise<StoredLinkedInAction> {
  z.string().uuid().parse(actionId);
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("channel_actions")
    .select("id, channel_slug, body, status, exec_class, exec_status, approved_by, exec_payload")
    .eq("id", actionId)
    .eq("channel_slug", "linkedin_ads")
    .maybeSingle();
  if (error) throw new Error("Could not read campaign action.");
  if (!data) throw new ExpectedToolError("linkedin_ads_not_found", "Action not found in this workspace.");
  return data as StoredLinkedInAction;
}

export function assertReviewable(row: StoredLinkedInAction) {
  if (row.status !== "pending" || row.exec_class || row.body?.step?.responsibility !== "client") {
    throw new ExpectedToolError("linkedin_ads_conflict", "This action changed. Refresh Next steps.");
  }
}

export function assertPreparable(row: StoredLinkedInAction) {
  const bound = row.exec_class === "linkedin_ads.create_campaign_bundle" && row.status === "pending" && !row.exec_status && !row.approved_by && row.body?.step?.responsibility === "client";
  if (!bound) assertReviewable(row);
}
