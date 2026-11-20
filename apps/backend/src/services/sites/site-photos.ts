
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import type { SitePhotoCheck } from "@/services/site-images/build-end-check";

export const PHOTOS_MISSING_REASON = "Photos couldn't be added to your site.";
export const PHOTO_RETRY_MESSAGE = "Add photos to the hero and the key sections of the site.";

export type SitePhotos = { status: "added" | "missing"; reason?: string; count?: number; checked_at: string; free_retry_run_id?: string };

export type SitePhotosView = { status: "missing"; reason: string; retry: "free" | "paid" };

export function sitePhotosFromCheck(check: SitePhotoCheck, now: Date): Omit<SitePhotos, "free_retry_run_id"> | null {
  if (check.kind === "ok") return { status: "added", count: check.count, checked_at: now.toISOString() };
  if (check.kind === "never_called" || check.kind === "none_landed") return { status: "missing", reason: check.kind, checked_at: now.toISOString() };
  return null;
}

export function sitePhotosView(raw: unknown): SitePhotosView | null {
  const p = raw as Partial<SitePhotos> | null;
  if (!p || typeof p !== "object" || p.status !== "missing") return null;
  return { status: "missing", reason: PHOTOS_MISSING_REASON, retry: typeof p.free_retry_run_id === "string" && p.free_retry_run_id ? "paid" : "free" };
}

type Res<T> = PromiseLike<{ data: T; error: { message: string } | null }>;
type SitePhotosClient = {
  from: (table: string) => {
    select: (cols: string) => { eq: (c: string, v: string) => { eq: (c: string, v: string) => { maybeSingle: () => Res<unknown> } } };
  };
};

type RecordRpc = (args: { p_tenant_id: string; p_site_id: string; p_photos: Record<string, unknown> }) => Res<unknown>;

export async function recordSitePhotos(
  input: { tenant_id: string; site_id: string; check: SitePhotoCheck },
  deps: { rpc?: RecordRpc; now?: () => Date } = {},
): Promise<"recorded" | "skipped" | "failed"> {
  const photos = sitePhotosFromCheck(input.check, (deps.now ?? (() => new Date()))());
  if (!photos) return "skipped";
  try {
    const rpc: RecordRpc = deps.rpc ?? ((args) => tenantRpc(asTenantId(args.p_tenant_id), "record_site_photos", args) as unknown as Res<unknown>);
    const { data, error } = await rpc({ p_tenant_id: input.tenant_id, p_site_id: input.site_id, p_photos: photos });
    if (error || data !== true) {
      console.warn(`[site-photos] not recorded for site=${input.site_id}: ${error?.message ?? "no root run"}`);
      return "failed";
    }
    return "recorded";
  } catch (e) {
    console.warn(`[site-photos] not recorded for site=${input.site_id}: ${(e as Error)?.message ?? e}`);
    return "failed";
  }
}

export async function readSitePhotos(client: unknown, tenant_id: string, run_id: string): Promise<SitePhotosView | null> {
  try {
    const { data, error } = await (client as SitePhotosClient)
      .from("conductor_runs")
      .select("site_photos")
      .eq("tenant_id", tenant_id)
      .eq("id", run_id)
      .maybeSingle();
    if (error || !data) return null;
    return sitePhotosView((data as { site_photos?: unknown }).site_photos);
  } catch {
    return null;
  }
}

export async function photoRetryFree(tenant_id: string, site_id: string): Promise<boolean> {
  const { data, error } = await tenantRpc(asTenantId(tenant_id), "photo_retry_free", { p_site_id: site_id });
  return !error && data === true;
}

export async function claimPhotoRetry(tenant_id: string, site_id: string, conductor_run_id: string): Promise<boolean> {
  const { data, error } = await tenantRpc(asTenantId(tenant_id), "claim_photo_retry", {
    p_site_id: site_id,
    p_conductor_run_id: conductor_run_id,
  });
  if (error) throw new Error(`claim_photo_retry failed: ${error.message}`);
  return data === true;
}
