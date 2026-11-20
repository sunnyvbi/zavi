
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { handleSiteThumbnailRequest, SITE_THUMBNAIL_EVENT, type ThumbnailTenantOf } from "@/services/sites/site-thumbnail-capture";

export const SITE_THUMBNAIL_TENANT_C8reverified = true;

export const realThumbnailTenantOf: ThumbnailTenantOf = async (req) => {
  const q =
    "run_id" in req
      ? serviceClient().from("conductor_runs").select("tenant_id").eq("id", req.run_id)
      : serviceClient().from("sites").select("tenant_id").eq("id", req.site_id);
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(`thumbnail tenant lookup failed: ${error.message}`);
  const tenant = (data as { tenant_id?: unknown } | null)?.tenant_id;
  return typeof tenant === "string" ? tenant : null;
};

export const siteThumbnailFn = inngest.createFunction(
  {
    id: "site-thumbnail",
    retries: 2,
    concurrency: [{ limit: 1, key: "event.data.tenant_id" }, { limit: 3 }],
    throttle: { limit: 120, period: "1h" },
  },
  { event: SITE_THUMBNAIL_EVENT },
  async ({ event }: { event: { data?: unknown } }) => handleSiteThumbnailRequest(event.data, realThumbnailTenantOf),
);
