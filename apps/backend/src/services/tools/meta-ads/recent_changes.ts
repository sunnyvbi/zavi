import { fbGet, metaAdsCreds } from "./_client";

const CHANGE_EVENT_TYPES = new Set([
  "update_ad_set_budget",
  "update_ad_set_run_status",
  "update_campaign_run_status",
  "update_campaign_group_budget",
  "update_ad_set_bid_strategy",
]);

export async function fetchRecentlyChangedObjectIds(
  tenant_id: string,
  sinceIso: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const creds = await metaAdsCreds(tenant_id);
    const resp = (await fbGet(tenant_id, `${creds.ad_account_id}/activities`, {
      since: sinceIso,
      fields: "event_type,object_id",
      limit: 300,
    })) as { data?: Array<{ event_type?: string; object_id?: string | number }> };
    for (const row of resp.data ?? []) {
      if (row.event_type && CHANGE_EVENT_TYPES.has(row.event_type) && row.object_id != null) {
        ids.add(String(row.object_id));
      }
    }
  } catch {
  }
  return ids;
}
