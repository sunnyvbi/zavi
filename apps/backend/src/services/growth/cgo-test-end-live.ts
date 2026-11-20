import { endWithinTest, googleEndWithinTest } from "./cgo-test-end";

const META_ADSET_PAGE = 50;

export async function liveEndWithinTest(tenant_id: string, platform: "meta" | "google", level: "campaign" | "adset", objectId: string, endsOn: string): Promise<boolean> {
  if (platform === "google") {
    const { gadsGetCampaignEnd } = await import("@/services/tools/google-ads/_client");
    const { end_date_time } = await gadsGetCampaignEnd(tenant_id, objectId);
    return googleEndWithinTest(end_date_time, endsOn);
  }
  const { fbGet } = await import("@/services/tools/meta-ads/_client");
  if (level === "adset") {
    const set = (await fbGet(tenant_id, objectId, { fields: "id,end_time" })) as { end_time?: string } | null;
    return endWithinTest(set?.end_time, endsOn);
  }
  const r = (await fbGet(tenant_id, `${objectId}/adsets`, { fields: "id,end_time", limit: META_ADSET_PAGE })) as { data?: Array<{ end_time?: string }>; paging?: { next?: string } } | null;
  const sets = r?.data ?? [];
  if (sets.length === 0 || r?.paging?.next) return false;
  return sets.every((s) => endWithinTest(s.end_time, endsOn));
}

export async function metaAdSetCampaignId(tenant_id: string, adSetId: string): Promise<string | null> {
  const { fbGet } = await import("@/services/tools/meta-ads/_client");
  const set = (await fbGet(tenant_id, adSetId, { fields: "id,campaign_id" })) as { campaign_id?: string } | null;
  return typeof set?.campaign_id === "string" && set.campaign_id ? set.campaign_id : null;
}
