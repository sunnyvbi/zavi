import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { siteStore } from "@/services/sites/store";
import { isVisibleSite } from "@/services/sites/site-build-status";
import { siteIdFromEditsApp } from "@/services/sites/site-inline-edits";
import type { SiteRow } from "@/services/sites/contract";
import { sitePreviewSnapshotStore, type SitePreviewSnapshotRow } from "@/services/sites/site-preview-snapshot";
import { signTenantArtifactPaths } from "@/routes/run-artifacts/file-url";

export type PreviewSnapshotView = { url: string; width: number; height: number; taken_at: string };

export type PreviewSnapshotRouteDeps = {
  loadSite: (tenant_id: string, site_id: string) => Promise<SiteRow | null>;
  fresh: (tenant_id: string, site_id: string) => Promise<SitePreviewSnapshotRow[]>;
  sign: (tenant_id: string, paths: string[]) => Promise<Array<string | null>>;
};

const realDeps = (): PreviewSnapshotRouteDeps => ({
  loadSite: (tenant_id, site_id) => siteStore().get(tenant_id, site_id),
  fresh: (tenant_id, site_id) => sitePreviewSnapshotStore().fresh(tenant_id, site_id),
  sign: (tenant_id, paths) => signTenantArtifactPaths(tenant_id, paths.map((storagePath) => ({ storagePath }))),
});

export function makeGetSitePreviewSnapshot(deps: () => PreviewSnapshotRouteDeps = realDeps) {
  return async function getSitePreviewSnapshot(req: Request, res: Response): Promise<void> {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    res.setHeader("Cache-Control", "private, no-store");
    const site_id = siteIdFromEditsApp(req.query?.app_id);
    if (!site_id) {
      res.status(400).json({ error: { code: "not_a_site", message: "app_id must name a site (site:<id>)." } });
      return;
    }
    try {
      const d = deps();
      const site = await d.loadSite(auth.tenant_id, site_id);
      if (!site || site.tenant_id !== auth.tenant_id || site.id !== site_id || !isVisibleSite(site)) {
        res.status(404).json({ error: { code: "site_not_found", message: "This site is not in your workspace." } });
        return;
      }
      const rows = await d.fresh(auth.tenant_id, site_id);
      const signed = rows.length ? await d.sign(auth.tenant_id, rows.map((r) => r.path)) : [];
      const snapshots: Record<string, PreviewSnapshotView> = {};
      rows.forEach((r, i) => {
        const url = signed[i];
        if (url) snapshots[r.device] = { url, width: r.width, height: r.height, taken_at: r.taken_at };
      });
      res.json({ snapshots });
    } catch (e) {
      console.warn(`[site-preview-snapshot] read failed site=${site_id}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      res.json({ snapshots: {} });
    }
  };
}

export const getSitePreviewSnapshot = makeGetSitePreviewSnapshot();
