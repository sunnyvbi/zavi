import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import type { SiteRow } from "@/services/sites/contract";
import { bumpHostVersion, requestHostVerify, syncHostRecord, type HostSyncDeps } from "@/services/sites/host-record";
import { isVisibleSite } from "@/services/sites/site-build-status";
import { siteStore } from "@/services/sites/store";
import { asTenantId, tenantRpc } from "@/services/tenant-client";

const RELEASE_ROLES = ["owner", "admin", "member"] as const;
const SITE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SiteSearchReleaseDeps = {
  get: (tenant_id: string, site_id: string) => Promise<SiteRow | null>;
  release: (tenant_id: string, site_id: string) => Promise<SiteRow>;
  host: () => Promise<HostSyncDeps>;
};

async function releaseSearch(tenant_id: string, site_id: string): Promise<SiteRow> {
  const { data, error } = await tenantRpc(asTenantId(tenant_id), "site_release_search", { p_site_id: site_id });
  if (error) throw new Error(`site_release_search failed: ${error.message ?? "unknown"}`);
  const row = (Array.isArray(data) ? data[0] : data) as SiteRow | null;
  if (!row?.id || row.tenant_id !== tenant_id) throw new Error("site_release_search returned no row");
  return row;
}

export function realSiteSearchReleaseDeps(): SiteSearchReleaseDeps {
  const store = siteStore();
  return {
    get: (t, id) => store.get(t, id),
    release: releaseSearch,
    host: async () => {
      const { cloudflareKv } = await import("@/services/site-shards/gateway-kv");
      return { kv: cloudflareKv(), bump: bumpHostVersion, get: (t, id) => store.get(t, id), requestVerify: requestHostVerify };
    },
  };
}

export async function postSiteSearchRelease(req: Request, res: Response): Promise<void> {
  await handleSiteSearchRelease(req, res, realSiteSearchReleaseDeps());
}

export async function handleSiteSearchRelease(req: Request, res: Response, deps: SiteSearchReleaseDeps): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    if (!(await requireTenantRole(auth, RELEASE_ROLES, res))) return;
  } catch (e) {
    res.status(500).json({ error: { code: "role_check_failed", message: (e as Error).message } });
    return;
  }
  const tenant_id = auth.tenant_id;
  const rawId = (req.params as { site_id?: unknown } | undefined)?.site_id;
  const site_id = typeof rawId === "string" ? rawId.trim().toLowerCase() : "";
  if (!SITE_ID_RE.test(site_id)) {
    res.status(400).json({ error: { code: "bad_request", message: "site_id must be a uuid" } });
    return;
  }
  try {
    const site = await deps.get(tenant_id, site_id);
    if (!site || site.tenant_id !== tenant_id || !isVisibleSite(site)) {
      res.status(404).json({ error: { code: "site_not_found", message: "site not found" } });
      return;
    }
    if (site.search_released_at) {
      res.status(200).json({ search_hidden: false });
      return;
    }
    await deps.release(tenant_id, site_id);
  } catch (e) {
    console.warn(`[site-search-release] release failed tenant=${tenant_id} site=${site_id}: ${(e as Error)?.message ?? e}`);
    res.status(500).json({ error: { code: "release_failed", message: "We couldn't save that. Please try again." } });
    return;
  }
  try {
    await syncHostRecord(await deps.host(), { tenant_id, site_id });
  } catch (e) {
    console.warn(`[site-search-release] host record sync deferred tenant=${tenant_id} site=${site_id}: ${(e as Error)?.message ?? e}`);
  }
  res.status(200).json({ search_hidden: false });
}
