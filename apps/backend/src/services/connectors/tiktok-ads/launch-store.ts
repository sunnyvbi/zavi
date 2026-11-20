
import { asTenantId, tenantClient } from "@/services/tenant-client";

export type LaunchIds = {
  tag: string;
  advertiser_id: string;
  campaign_id?: string | null;
  adgroup_id?: string | null;
  ad_id?: string | null;
  image_id?: string | null;
};

export interface LaunchStore {
  load(): Promise<LaunchIds | null>;
  save(ids: LaunchIds): Promise<void>;
}

const COLUMNS = "tag, advertiser_id, campaign_id, adgroup_id, ad_id, image_id";

export function launchStore(tenantId: string, actionId: string): LaunchStore {
  const db = tenantClient(asTenantId(tenantId));
  return {
    async load() {
      const { data, error } = await db.from("tiktok_ad_launches").select(COLUMNS).eq("action_id", actionId).maybeSingle();
      if (error) throw new Error(`tiktok_ad_launches read failed: ${error.message}`);
      return (data as LaunchIds | null) ?? null;
    },
    async save(ids) {
      const { error } = await db.from("tiktok_ad_launches").upsert(
        {
          action_id: actionId,
          tag: ids.tag,
          advertiser_id: ids.advertiser_id,
          campaign_id: ids.campaign_id ?? null,
          adgroup_id: ids.adgroup_id ?? null,
          ad_id: ids.ad_id ?? null,
          image_id: ids.image_id ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id,action_id" },
      );
      if (error) throw new Error(`tiktok_ad_launches write failed: ${error.message}`);
    },
  };
}
