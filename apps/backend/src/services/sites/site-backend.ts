
import type { SiteRow, SiteStore } from "./contract";
import { siteStore } from "./store";

export type SiteBackendKind = "pooled" | "dedicated";

export class SiteBackendUnresolved extends Error {
  readonly code = "site_backend_unresolved";
  readonly retryable = true;
  constructor(readonly site_id: string, readonly reason: string) {
    super(`site_backend_unresolved: site=${site_id} ${reason}`);
    this.name = "SiteBackendUnresolved";
  }
}

export function siteBackendKindOf(site: Pick<SiteRow, "backend_mode" | "kernel_shard_id"> | null | undefined): SiteBackendKind | null {
  if (!site) return null;
  if (site.kernel_shard_id) return "pooled";
  switch (site.backend_mode) {
    case "static":
    case "pooled":
      return "pooled";
    case "dedicated":
      return "dedicated";
    default:
      return null;
  }
}

export function payloadSiteId(payload: unknown): string | null {
  const id = (payload as { site_id?: unknown } | null | undefined)?.site_id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

export function payloadSiteBackend(payload: unknown): SiteBackendKind | null {
  const b = (payload as { site_backend?: unknown } | null | undefined)?.site_backend;
  return b === "pooled" || b === "dedicated" ? b : null;
}

export function requireSiteBackend(payload: unknown): SiteBackendKind | null {
  const site_id = payloadSiteId(payload);
  if (!site_id) return null;
  const kind = payloadSiteBackend(payload);
  if (!kind) throw new SiteBackendUnresolved(site_id, "payload carries no resolved site_backend");
  return kind;
}

export type SiteBackendDeps = { store: () => Pick<SiteStore, "get" | "getByRepo"> };
const realDeps: SiteBackendDeps = { store: () => siteStore() };

export async function resolveSiteBackend(
  tenant_id: string,
  site_id: string,
  deps: SiteBackendDeps = realDeps,
): Promise<SiteBackendKind> {
  let row: SiteRow | null;
  try {
    row = await deps.store().get(tenant_id, site_id);
  } catch (e) {
    throw new SiteBackendUnresolved(site_id, `sites read failed: ${(e as Error)?.message ?? String(e)}`);
  }
  if (!row || row.tenant_id !== tenant_id) throw new SiteBackendUnresolved(site_id, "no such site for this tenant");
  const kind = siteBackendKindOf(row);
  if (!kind) throw new SiteBackendUnresolved(site_id, `unknown backend_mode ${JSON.stringify(row.backend_mode ?? null)}`);
  return kind;
}

export async function resolveSiteBackendForRepo(
  tenant_id: string,
  repo_full_name: string,
  deps: SiteBackendDeps = realDeps,
): Promise<{ site_id: string; site_backend: SiteBackendKind } | null> {
  const repo = String(repo_full_name ?? "").trim();
  if (!tenant_id || !repo) return null;
  let row: SiteRow | null;
  try {
    row = await deps.store().getByRepo(tenant_id, repo);
  } catch (e) {
    throw new SiteBackendUnresolved(`repo:${repo}`, `sites read failed: ${(e as Error)?.message ?? String(e)}`);
  }
  if (!row || row.tenant_id !== tenant_id) return null;
  const kind = siteBackendKindOf(row);
  if (!kind) throw new SiteBackendUnresolved(row.id, `unknown backend_mode ${JSON.stringify(row.backend_mode ?? null)}`);
  return { site_id: row.id, site_backend: kind };
}

export async function resolvePayloadSiteBackend(
  tenant_id: string,
  payload: unknown,
  deps: SiteBackendDeps = realDeps,
): Promise<SiteBackendKind | null> {
  const site_id = payloadSiteId(payload);
  return site_id ? resolveSiteBackend(tenant_id, site_id, deps) : null;
}
