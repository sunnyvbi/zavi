import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import type { SiteRow } from "@/services/sites/contract";
import { isVisibleSite } from "@/services/sites/site-build-status";
import { siteStore } from "@/services/sites/store";
import { asTenantId, tenantRpc } from "@/services/tenant-client";

const RENAME_ROLES = ["owner", "admin"] as const;
const SITE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SITE_NAME_MAX = 80;

export type SiteRenameDeps = {
  get: (tenant_id: string, site_id: string) => Promise<SiteRow | null>;
  setName: (tenant_id: string, site_id: string, expected: string | null, name: string) => Promise<{ outcome: string; name: string | null }>;
};

export function realSiteRenameDeps(): SiteRenameDeps {
  const store = siteStore();
  return {
    get: (t, id) => store.get(t, id),
    setName: async (t, id, expected, name) => {
      const { data, error } = await tenantRpc(asTenantId(t), "site_set_name", { p_site_id: id, p_expected_name: expected, p_name: name });
      if (error) throw new Error(`site_set_name failed: ${error.message ?? "unknown"}`);
      const out = data as { outcome?: unknown; name?: unknown } | null;
      return { outcome: String(out?.outcome ?? ""), name: typeof out?.name === "string" ? out.name : null };
    },
  };
}

export async function postSiteRename(req: Request, res: Response): Promise<void> {
  await handleSiteRename(req, res, realSiteRenameDeps());
}

export async function handleSiteRename(req: Request, res: Response, deps: SiteRenameDeps): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    if (!(await requireTenantRole(auth, RENAME_ROLES, res))) return;
  } catch (e) {
    res.status(500).json({ error: { code: "role_check_failed", message: (e as Error).message } });
    return;
  }
  const tenant_id = auth.tenant_id;
  const rawId = (req.params as { site_id?: unknown } | undefined)?.site_id;
  const site_id = typeof rawId === "string" ? rawId.trim().toLowerCase() : "";
  const rawName = (req.body as { name?: unknown } | undefined)?.name;
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!SITE_ID_RE.test(site_id) || !name || name.length > SITE_NAME_MAX) {
    res.status(400).json({ error: { code: "bad_request", message: `Give the site a name of up to ${SITE_NAME_MAX} characters.` } });
    return;
  }
  try {
    const site = await deps.get(tenant_id, site_id);
    if (!site || site.tenant_id !== tenant_id || !isVisibleSite(site)) {
      res.status(404).json({ error: { code: "site_not_found", message: "site not found" } });
      return;
    }
    const out = await deps.setName(tenant_id, site_id, site.name ?? null, name);
    if (out.outcome === "updated" || out.outcome === "already_applied") {
      res.status(200).json({ name: out.name });
      return;
    }
    if (out.outcome === "not_found") {
      res.status(404).json({ error: { code: "site_not_found", message: "site not found" } });
      return;
    }
    res.status(409).json({ error: { code: "name_changed", message: "The name just changed. Try again." } });
  } catch (e) {
    console.warn(`[site-rename] failed tenant=${tenant_id} site=${site_id}: ${(e as Error)?.message ?? e}`);
    res.status(500).json({ error: { code: "rename_failed", message: "We couldn't save that. Please try again." } });
  }
}
