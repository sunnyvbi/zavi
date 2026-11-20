
import { loadUnpublishedSiteChanges } from "@/services/sites/site-pending";
import { siteDeployedUrl } from "@/services/sites/site-build-status";
import { siteStore } from "@/services/sites/store";
import type { SiteRow } from "@/services/sites/contract";
import { siteHostOf as hostOf } from "./snapshot";

export type SitePublishState = {
  pending: number;
  capped: boolean;
};

export type SitePublishDeps = {
  listSites: (tenant_id: string) => Promise<SiteRow[]>;
  loadPending: (tenant_id: string, site_id: string) => Promise<{ changes: unknown[]; capped: boolean }>;
};

export function siteForCrawl(sites: readonly SiteRow[], crawled: string | null): SiteRow | null {
  const host = hostOf(crawled);
  if (!host) return null;
  return (
    sites.find((s) => {
      const live = siteDeployedUrl(s);
      return live !== null && (hostOf(live) === host || hostOf(s.hostname) === host);
    }) ?? null
  );
}

export async function getSitePublishState(
  tenant_id: string,
  crawled: string | null,
  deps: SitePublishDeps,
): Promise<SitePublishState | null> {
  try {
    const site = siteForCrawl(await deps.listSites(tenant_id), crawled);
    if (!site) return null;
    const read = await deps.loadPending(tenant_id, site.id);
    return { pending: read.changes.length, capped: read.capped };
  } catch {
    return null;
  }
}

export function sitePublishDeps(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: { from: (table: string) => any },
): SitePublishDeps {
  return {
    listSites: (tenant_id) => siteStore().listForTenant(tenant_id),
    loadPending: (tenant_id, site_id) => loadUnpublishedSiteChanges(db, tenant_id, site_id),
  };
}
