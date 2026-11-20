
import type { Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { SitePublicResolver, SiteRow, SiteStatus, SiteStore } from "./contract";
import { BuildSessionError, buildSessionParam, resolveBuildSessionApp, type SessionSiteDeps } from "./session-site";
import { SITE_MARKER_SELECT, siteIdFromMarkerRow } from "./site-run";
import { siteStore } from "./store";
import { sitePublicResolver } from "./public-resolver";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GONE_SITE_STATUSES: ReadonlySet<SiteStatus> = new Set<SiteStatus>(["fell_back_old", "deleting", "deleted"]);
const NOT_DEFAULT_STATUSES: ReadonlySet<SiteStatus> = new Set<SiteStatus>([...GONE_SITE_STATUSES, "failed"]);

export function isGoneSite(site: Pick<SiteRow, "status">): boolean {
  return GONE_SITE_STATUSES.has(site.status);
}

export type AppIdentityDeps = {
  store: () => Pick<SiteStore, "get" | "getByRun" | "getByRepo" | "listForTenant">;
  resolver: () => Pick<SitePublicResolver, "byHostname" | "byRepo">;
  readRunMarkers: (tenant_id: string, run_id: string) => Promise<{ s0?: unknown; s1?: unknown; s2?: unknown } | null>;
};

export const realAppIdentityDeps: AppIdentityDeps = {
  store: () => siteStore(),
  resolver: () => sitePublicResolver(),
  async readRunMarkers(tenant_id, run_id) {
    const { data, error } = await (tenantClient(asTenantId(tenant_id)).from("conductor_runs").select(`id, ${SITE_MARKER_SELECT}`) as any)
      .eq("id", run_id)
      .maybeSingle();
    if (error) throw new Error(`conductor_runs read failed: ${error.message ?? "unknown error"}`);
    return (data as { s0?: unknown; s1?: unknown; s2?: unknown } | null) ?? null;
  },
};

function own(tenant_id: string, site: SiteRow | null | undefined): SiteRow | null {
  return site && site.tenant_id === tenant_id ? site : null;
}

export async function siteForRepo(
  tenant_id: string,
  github_full_name: string,
  deps: AppIdentityDeps = realAppIdentityDeps,
): Promise<SiteRow | null> {
  const name = String(github_full_name ?? "").trim();
  if (!tenant_id || !name) return null;
  return own(tenant_id, await deps.store().getByRepo(tenant_id, name));
}

export async function siteForHostname(
  tenant_id: string,
  hostname: string,
  deps: AppIdentityDeps = realAppIdentityDeps,
): Promise<SiteRow | null> {
  const host = String(hostname ?? "").trim().toLowerCase();
  if (!tenant_id || !host) return null;
  const ref = await deps.resolver().byHostname(host);
  if (!ref || ref.tenant_id !== tenant_id) return null;
  return own(tenant_id, await deps.store().get(tenant_id, ref.site_id));
}

export async function siteForRun(
  tenant_id: string,
  conductor_run_id: string,
  deps: AppIdentityDeps = realAppIdentityDeps,
): Promise<SiteRow | null> {
  const run_id = String(conductor_run_id ?? "").trim().toLowerCase();
  if (!tenant_id || !UUID_RE.test(run_id)) return null;
  const root = own(tenant_id, await deps.store().getByRun(tenant_id, run_id));
  if (root) return root;
  const markers = await deps.readRunMarkers(tenant_id, run_id);
  const pointed = siteIdFromMarkerRow(markers);
  return pointed ? own(tenant_id, await deps.store().get(tenant_id, pointed)) : null;
}

export async function defaultSiteForTenant(
  tenant_id: string,
  deps: AppIdentityDeps = realAppIdentityDeps,
): Promise<SiteRow | null> {
  const sites = await deps.store().listForTenant(tenant_id);
  return (
    sites
      .filter((s) => s.tenant_id === tenant_id && !NOT_DEFAULT_STATUSES.has(s.status))
      .sort((a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? ""))[0] ?? null
  );
}

export type RepoEventOwner =
  | { kind: "not_site"; tenant_id: string | null }
  | { kind: "site"; tenant_id: string; site_id: string; status: SiteStatus; active: boolean; connector_mismatch: boolean }
  | { kind: "lookup_failed"; error: string };

export async function resolveRepoEventOwner(
  repoFullName: string | null | undefined,
  connectorTenantId: string | null,
  deps: Pick<AppIdentityDeps, "resolver"> = realAppIdentityDeps,
): Promise<RepoEventOwner> {
  const name = String(repoFullName ?? "").trim();
  if (!name) return { kind: "not_site", tenant_id: connectorTenantId };
  let ref: { tenant_id: string; site_id: string; status: SiteStatus } | null;
  try {
    ref = await deps.resolver().byRepo(name);
  } catch (e) {
    return { kind: "lookup_failed", error: (e as Error).message };
  }
  if (!ref) return { kind: "not_site", tenant_id: connectorTenantId };
  return {
    kind: "site",
    tenant_id: ref.tenant_id,
    site_id: ref.site_id,
    status: ref.status,
    active: !GONE_SITE_STATUSES.has(ref.status),
    connector_mismatch: connectorTenantId !== null && connectorTenantId !== ref.tenant_id,
  };
}

export type RequestedApp =
  | { kind: "site"; site: SiteRow; run_id: string | null; via: "build_session" | "site_id" | "default_site" }
  | { kind: "legacy"; via: "workspace_app" | "old_flow_session" | "no_active_site"; run_id: string | null };

export class AppSelectionError extends Error {
  constructor(
    readonly status: 400 | 404 | 503,
    readonly code: "invalid_site_id" | "invalid_app" | "site_not_found" | "app_selection_conflict" | "site_check_failed",
    message: string,
  ) {
    super(message);
    this.name = "AppSelectionError";
  }
}

function param(req: Request, name: string): unknown {
  const q = (req.query as Record<string, unknown> | undefined)?.[name];
  if (q !== undefined) return q;
  return (req.body as Record<string, unknown> | undefined)?.[name];
}

export function siteIdParam(req: Request): unknown {
  return param(req, "site_id");
}

export const WORKSPACE_APP = "workspace";
export function appParam(req: Request): unknown {
  return param(req, "app");
}

export async function resolveRequestedApp(
  sb: Pick<SupabaseClient, "from">,
  tenant_id: string,
  params: { build_session_id: unknown; site_id: unknown; app?: unknown },
  deps: AppIdentityDeps = realAppIdentityDeps,
): Promise<RequestedApp> {
  const sessionDeps: SessionSiteDeps = {
    getSiteByRun: (t, r) => deps.store().getByRun(t, r),
    getSite: (t, s) => deps.store().get(t, s),
  };
  const rawSite = params.site_id;
  const rawSession = params.build_session_id;
  const hasSession = rawSession !== undefined && rawSession !== null;
  const hasSite = rawSite !== undefined && rawSite !== null;

  if (params.app !== undefined && params.app !== null) {
    if (params.app !== WORKSPACE_APP) throw new AppSelectionError(400, "invalid_app", `app must be '${WORKSPACE_APP}'`);
    if (hasSite || hasSession) {
      throw new AppSelectionError(400, "app_selection_conflict", "app=workspace cannot be combined with a site or a Build session");
    }
    return { kind: "legacy", via: "workspace_app", run_id: null };
  }

  if (hasSite) {
    if (typeof rawSite !== "string" || !UUID_RE.test(rawSite.trim())) {
      throw new AppSelectionError(400, "invalid_site_id", "site_id must be a site id");
    }
    const site_id = rawSite.trim().toLowerCase();
    let site: SiteRow | null;
    try {
      site = own(tenant_id, await deps.store().get(tenant_id, site_id));
    } catch (e) {
      throw new AppSelectionError(503, "site_check_failed", `sites read failed: ${(e as Error).message}`);
    }
    if (!site || isGoneSite(site)) throw new AppSelectionError(404, "site_not_found", "site not found");
    if (hasSession) {
      const session = await resolveBuildSessionApp(sb, tenant_id, rawSession, sessionDeps);
      if (session.kind !== "site" || session.site.id !== site.id) {
        throw new AppSelectionError(400, "app_selection_conflict", "build_session_id and site_id name different apps");
      }
      return { kind: "site", site, run_id: session.run_id, via: "site_id" };
    }
    return { kind: "site", site, run_id: site.root_conductor_run_id ?? null, via: "site_id" };
  }

  if (hasSession) {
    const session = await resolveBuildSessionApp(sb, tenant_id, rawSession, sessionDeps);
    if (session.kind === "old_flow") return { kind: "legacy", via: "old_flow_session", run_id: session.run_id };
    if (session.kind === "site") {
      if (session.site.status === "fell_back_old") return { kind: "legacy", via: "old_flow_session", run_id: session.run_id };
      if (isGoneSite(session.site)) throw new AppSelectionError(404, "site_not_found", "This site was deleted.");
      return { kind: "site", site: session.site, run_id: session.run_id, via: "build_session" };
    }
  }

  let site: SiteRow | null;
  try {
    site = await defaultSiteForTenant(tenant_id, deps);
  } catch (e) {
    throw new AppSelectionError(503, "site_check_failed", `sites read failed: ${(e as Error).message}`);
  }
  if (site) return { kind: "site", site, run_id: site.root_conductor_run_id ?? null, via: "default_site" };
  return { kind: "legacy", via: "no_active_site", run_id: null };
}

export function resolveAppForRequest(
  req: Request,
  sb: Pick<SupabaseClient, "from">,
  tenant_id: string,
  deps: AppIdentityDeps = realAppIdentityDeps,
): Promise<RequestedApp> {
  return resolveRequestedApp(
    sb,
    tenant_id,
    { build_session_id: buildSessionParam(req), site_id: siteIdParam(req), app: appParam(req) },
    deps,
  );
}

export function sendAppSelectionError(res: Response, e: unknown): void {
  if (e instanceof AppSelectionError || e instanceof BuildSessionError) {
    res.status(e.status).json({ error: { code: e.code, message: e.message } });
    return;
  }
  throw e;
}
