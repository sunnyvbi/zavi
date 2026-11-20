import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { handleSitePreviewSnapshotRequest, SITE_PREVIEW_SNAPSHOT_EVENT, type SnapshotTenantOf } from "@/services/sites/site-preview-snapshot-capture";

export const SITE_PREVIEW_SNAPSHOT_TENANT_C8reverified = true;

export const realSnapshotTenantOf: SnapshotTenantOf = async (req) => {
  const { data, error } = await serviceClient().from("sites").select("tenant_id").eq("id", req.site_id).maybeSingle();
  if (error) throw new Error(`preview snapshot tenant lookup failed: ${error.message}`);
  const tenant = (data as { tenant_id?: unknown } | null)?.tenant_id;
  return typeof tenant === "string" ? tenant : null;
};

export const sitePreviewSnapshotFn = inngest.createFunction(
  {
    id: "site-preview-snapshot",
    retries: 2,
    debounce: { key: "event.data.site_id", period: "45s", timeout: "5m" },
    concurrency: [{ limit: 1, key: "event.data.tenant_id" }, { limit: 3 }],
    throttle: { limit: 240, period: "1h" },
  },
  { event: SITE_PREVIEW_SNAPSHOT_EVENT },
  async ({ event }: { event: { data?: unknown } }) => handleSitePreviewSnapshotRequest(event.data, realSnapshotTenantOf),
);
