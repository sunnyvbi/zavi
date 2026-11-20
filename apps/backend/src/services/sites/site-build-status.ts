
import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { SiteRow, SiteStatus } from "./contract";

export type SiteSessionSummary = {
  hostname: string;
  live_url: string | null;
  status: SiteStatus;
  name?: string | null;
  repo?: string | null;
};

const HIDDEN: ReadonlySet<SiteStatus> = new Set(["fell_back_old", "deleting", "deleted"]);

export function isVisibleSite(site: SiteRow | null | undefined): site is SiteRow {
  return !!site && !HIDDEN.has(site.status);
}

export function siteDeployedUrl(site: SiteRow): string | null {
  if (!site.live_deploy_id) return null;
  if (typeof site.live_url === "string" && /^https:\/\//.test(site.live_url)) return site.live_url;
  return `https://${site.hostname}`;
}

const NEVER_PUBLISHED: ReadonlySet<SiteStatus> = new Set<SiteStatus>(["provisioning", "building"]);

export function sitePublishedUrl(site: SiteRow): string | null {
  return NEVER_PUBLISHED.has(site.status) ? null : siteDeployedUrl(site);
}

const SERVING: ReadonlySet<SiteStatus> = new Set<SiteStatus>(["live", "publishing"]);
const OFFLINE: ReadonlySet<SiteStatus> = new Set<SiteStatus>(["failed", "paused", "waking"]);

export function siteLiveUrl(site: SiteRow): string | null {
  return SERVING.has(site.status) ? siteDeployedUrl(site) : null;
}

export type SiteLiveState = { live_url: string | null; site_offline: boolean };
export type SiteLiveDeps = {
  offlineCheck: boolean;
  verify: (hostname: string, deploy_id: string) => Promise<boolean>;
  now?: () => number;
};

export const SITE_LIVE_CHECK_TTL_MS = 60_000;
const SITE_LIVE_CHECK_MAX = 500;
type LiveCheck = { at: number; value: boolean } | { at: number; pending: Promise<boolean> };
const liveChecks = new Map<string, LiveCheck>();

export function resetSiteLiveChecks(): void {
  liveChecks.clear();
}

function verifyCached(hostname: string, deploy_id: string, deps: SiteLiveDeps): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const key = `${hostname}\n${deploy_id}`;
  const hit = liveChecks.get(key);
  if (hit && "pending" in hit) return hit.pending;
  if (hit && now() - hit.at < SITE_LIVE_CHECK_TTL_MS) return Promise.resolve(hit.value);
  const pending = Promise.resolve()
    .then(() => deps.verify(hostname, deploy_id))
    .then((ok) => ok === true, () => false)
    .then((value) => {
      liveChecks.delete(key);
      liveChecks.set(key, { at: now(), value });
      return value;
    });
  if (!hit && liveChecks.size >= SITE_LIVE_CHECK_MAX) {
    const oldest = liveChecks.keys().next();
    if (!oldest.done) liveChecks.delete(oldest.value);
  }
  liveChecks.set(key, { at: now(), pending });
  return pending;
}

export async function siteLiveState(site: SiteRow, deps: SiteLiveDeps): Promise<SiteLiveState> {
  const url = siteLiveUrl(site);
  if (!deps.offlineCheck || !site.live_deploy_id) return { live_url: url, site_offline: false };
  if (OFFLINE.has(site.status)) return { live_url: null, site_offline: true };
  if (!url || site.status !== "live") return { live_url: url, site_offline: false };
  const ok = await verifyCached(site.hostname, site.live_deploy_id, deps);
  return ok ? { live_url: url, site_offline: false } : { live_url: null, site_offline: true };
}

export function siteRepoUrl(site: SiteRow): string | null {
  return site.github_full_name ? `https://github.com/${site.github_full_name}` : null;
}

export function siteSessionSummary(site: SiteRow, opts: { name?: boolean; repo?: boolean } = {}): SiteSessionSummary {
  return {
    hostname: site.hostname,
    live_url: siteLiveUrl(site),
    status: site.status,
    ...(opts.name ? { name: typeof site.name === "string" && site.name.trim() ? site.name.trim() : null } : {}),
    ...(opts.repo ? { repo: typeof site.github_full_name === "string" && site.github_full_name.trim() ? site.github_full_name.trim() : null } : {}),
  };
}

export type SiteOwnerAdmin = { admin_url: string; admin_setup_email: string };

export function siteOwnerAdmin(site: SiteRow, liveUrl: string | null, autoSiteOwner: boolean): SiteOwnerAdmin | null {
  if (!liveUrl || !autoSiteOwner) return null;
  const email = typeof site.owner_email === "string" ? site.owner_email.trim() : "";
  if (!email) return null;
  return { admin_url: `https://${site.hostname}/admin`, admin_setup_email: email };
}

export type SiteStatusBlock = {
  id: string;
  hostname: string;
  status: SiteStatus;
  live_url: string | null;
  admin_url: string;
  repo_url: string | null;
  search_hidden?: true;
};

export function siteStatusBlock(site: SiteRow): SiteStatusBlock {
  return {
    id: site.id,
    hostname: site.hostname,
    status: site.status,
    live_url: siteLiveUrl(site),
    admin_url: `https://${site.hostname}/admin`,
    repo_url: siteRepoUrl(site),
    ...(site.live_deploy_id && site.search_released_at === null ? { search_hidden: true as const } : {}),
  };
}

type GraphNode = { payload?: { stage?: unknown } | null };
const KNOWN_STAGES = ["provision", "spec", "scaffold", "build", "qa", "deploy"];

export function siteGraphStages(graph: ReadonlyArray<GraphNode> | null | undefined): string[] {
  const out: string[] = [];
  for (const n of graph ?? []) {
    const s = n?.payload?.stage;
    if (typeof s === "string" && KNOWN_STAGES.includes(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

export type SiteSandboxPreviewRow = { id: string; preview_url: string | null; preview_status: string | null; updated_at?: string | null };

export async function loadSiteSandboxPreview(tenant_id: string, repo_full_name: string): Promise<SiteSandboxPreviewRow | null> {
  const { data, error } = await (tenantClient(asTenantId(tenant_id))
    .from("tenant_sandbox")
    .select("id, preview_url, preview_status, updated_at") as any)
    .eq("repo_full_name", repo_full_name)
    .maybeSingle();
  if (error) return null;
  return (data as SiteSandboxPreviewRow | null) ?? null;
}

export type SitePreview = { url: string | null; kind: "none" | "instant" | "final"; compiling?: boolean };

export type SitePreviewDeps = {
  loadSandbox: (tenant_id: string, repo_full_name: string) => Promise<SiteSandboxPreviewRow | null>;
  probe: (url: string) => Promise<"live" | "compiling" | "dead" | string>;
  clearDead: (row_id: string) => Promise<void>;
  now?: () => number;
  deadGraceMs?: number;
  unpublishedChanges?: boolean;
};

export const SITE_PREVIEW_DEAD_GRACE_MS = 90_000;
const DEAD_TRACK_MAX = 2_000;
const deadSince = new Map<string, number>();

export function resetSitePreviewDeadTracking(): void {
  deadSince.clear();
}

export function sitePreviewDeadPending(row: SiteSandboxPreviewRow | null): boolean {
  if (!row || row.preview_status !== "live" || !row.preview_url) return false;
  return deadSince.has(`${row.id}\n${row.preview_url}`);
}

export async function sitePreview(tenant_id: string, site: SiteRow, deps: SitePreviewDeps): Promise<SitePreview> {
  const live = siteDeployedUrl(site);
  if (live && deps.unpublishedChanges !== true) return { url: live, kind: "final" };
  const sandbox = await sandboxPreview(tenant_id, site, deps);
  if (live && sandbox.kind === "none") return { url: live, kind: "final" };
  return sandbox;
}

async function sandboxPreview(tenant_id: string, site: SiteRow, deps: SitePreviewDeps): Promise<SitePreview> {
  if (!site.github_full_name) return { url: null, kind: "none" };
  const row = await deps.loadSandbox(tenant_id, site.github_full_name).catch(() => null);
  if (!row || row.preview_status !== "live" || !row.preview_url) return { url: null, kind: "none" };
  const state = await deps.probe(row.preview_url).catch(() => "dead");
  const key = `${row.id}\n${row.preview_url}`;
  if (state === "dead") {
    const now = (deps.now ?? Date.now)();
    const since = deadSince.get(key);
    if (since === undefined) {
      if (deadSince.size >= DEAD_TRACK_MAX) {
        const oldest = deadSince.keys().next();
        if (!oldest.done) deadSince.delete(oldest.value);
      }
      deadSince.set(key, now);
    }
    if (since !== undefined && now - since >= (deps.deadGraceMs ?? SITE_PREVIEW_DEAD_GRACE_MS)) {
      deadSince.delete(key);
      await deps.clearDead(row.id).catch(() => undefined);
    }
    return { url: null, kind: "none" };
  }
  deadSince.delete(key);
  return state === "compiling"
    ? { url: row.preview_url, kind: "instant", compiling: true }
    : { url: row.preview_url, kind: "instant" };
}
