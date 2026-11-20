
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import type { SeoAuditReport } from "@/services/tools/growth/seo/analyze";
import type { GeoReport } from "@/services/tools/growth/geo/analyze";
import { runAuditForUrl, type SiteAuditRunResult } from "@/services/tools/growth/seo/run";
import type { SiteRow } from "./contract";

export const SITE_SEO_SCHEMA = 3;
export const OK_TTL_MS = 24 * 60 * 60 * 1000;
export const ERROR_TTL_MS = 30 * 60 * 1000;
export const REFRESH_COOLDOWN_MS = 2 * 60 * 1000;
const CRAWL_PATHS = ["/"];

export type SiteSeoRow = {
  site_id: string;
  tenant_id: string;
  url: string;
  deploy_id: string | null;
  status: "ok" | "error";
  error_code: string | null;
  report: SeoAuditReport | null;
  geo_report: GeoReport | null;
  notes: string[];
  schema_version: number;
  fetched_at: string;
};

export type SiteSeo =
  | { state: "not_live" }
  | {
      state: "ready" | "error";
      url: string;
      fetched_at: string;
      current: boolean;
      error_code: string | null;
      notes: string[];
      seo: Pick<SeoAuditReport, "pages_analyzed" | "non_html_urls" | "findings" | "pages"> | null;
      geo: Pick<GeoReport, "score" | "crawlers" | "llms_txt" | "findings" | "not_checked" | "disclosure"> | null;
      refresh_after: string | null;
    };

export type SiteSeoDeps = {
  read(tenant_id: string, site_id: string): Promise<SiteSeoRow | null>;
  write(row: SiteSeoRow): Promise<void>;
  crawl(url: string, paths: string[]): Promise<SiteAuditRunResult>;
  now(): number;
};

type SiteRef = Pick<SiteRow, "id" | "tenant_id" | "status" | "hostname" | "live_url" | "live_deploy_id">;

export function liveUrlOf(site: SiteRef): string | null {
  const raw = (site.live_url ?? "").trim();
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.protocol === "https:") return u.origin;
    } catch {
    }
  }
  return site.status === "live" && site.hostname ? `https://${site.hostname}` : null;
}

function isFresh(row: SiteSeoRow, url: string, deployId: string | null, now: number): boolean {
  if (row.schema_version !== SITE_SEO_SCHEMA || row.url !== url) return false;
  if ((row.deploy_id ?? null) !== deployId) return false;
  const age = now - Date.parse(row.fetched_at);
  return Number.isFinite(age) && age < (row.status === "ok" ? OK_TTL_MS : ERROR_TTL_MS);
}

export function viewOf(row: SiteSeoRow, deployId: string | null, now: number): SiteSeo {
  const refreshAt = Date.parse(row.fetched_at) + REFRESH_COOLDOWN_MS;
  const r = row.report;
  const g = row.geo_report;
  return {
    state: row.status === "ok" ? "ready" : "error",
    url: row.url,
    fetched_at: row.fetched_at,
    current: (row.deploy_id ?? null) === deployId,
    error_code: row.error_code,
    notes: row.notes ?? [],
    seo: r ? { pages_analyzed: r.pages_analyzed, non_html_urls: r.non_html_urls ?? [], findings: r.findings ?? [], pages: r.pages ?? [] } : null,
    geo: g
      ? { score: g.score, crawlers: g.crawlers ?? [], llms_txt: g.llms_txt ?? null, findings: g.findings ?? [], not_checked: g.not_checked ?? [], disclosure: g.disclosure }
      : null,
    refresh_after: refreshAt > now ? new Date(refreshAt).toISOString() : null,
  };
}

const inFlight = new Map<string, Promise<SiteSeoRow>>();

async function crawlAndStore(deps: SiteSeoDeps, site: SiteRef, url: string): Promise<SiteSeoRow> {
  const running = inFlight.get(site.id);
  if (running) return running;
  const p = (async () => {
    const base = { site_id: site.id, tenant_id: site.tenant_id, url, deploy_id: site.live_deploy_id ?? null, schema_version: SITE_SEO_SCHEMA };
    let row: SiteSeoRow;
    try {
      const run = await deps.crawl(url, CRAWL_PATHS);
      row = { ...base, status: "ok", error_code: null, report: run.seo, geo_report: run.geo, notes: run.notes, fetched_at: new Date(deps.now()).toISOString() };
    } catch (e) {
      if (!(e instanceof ExpectedToolError)) throw e;
      const notes = e.code === "seo_site_unreachable" && e.message ? [e.message] : [];
      row = { ...base, status: "error", error_code: e.code, report: null, geo_report: null, notes, fetched_at: new Date(deps.now()).toISOString() };
    }
    await deps.write(row);
    return row;
  })().finally(() => inFlight.delete(site.id));
  inFlight.set(site.id, p);
  return p;
}

export async function siteSeo(deps: SiteSeoDeps, site: SiteRef, opts: { refresh?: boolean } = {}): Promise<SiteSeo> {
  const url = liveUrlOf(site);
  if (!url) return { state: "not_live" };
  const deployId = site.live_deploy_id ?? null;
  const now = deps.now();
  const row = await deps.read(site.tenant_id, site.id);
  if (row && row.url === url) {
    const age = now - Date.parse(row.fetched_at);
    const cooling = Number.isFinite(age) && age < REFRESH_COOLDOWN_MS;
    if (opts.refresh ? cooling : isFresh(row, url, deployId, now)) return viewOf(row, deployId, now);
  }
  return viewOf(await crawlAndStore(deps, site, url), deployId, deps.now());
}

export function resetSiteSeoInFlight(): void {
  inFlight.clear();
}

const COLUMNS = "site_id, tenant_id, url, deploy_id, status, error_code, report, geo_report, notes, schema_version, fetched_at";

export const defaultSiteSeoDeps: SiteSeoDeps = {
  async read(tenant_id, site_id) {
    try {
      const { data, error } = await tenantClient(asTenantId(tenant_id)).from("site_seo_audits").select(COLUMNS).eq("site_id", site_id).maybeSingle();
      return error || !data ? null : (data as unknown as SiteSeoRow);
    } catch {
      return null;
    }
  },
  async write(row) {
    try {
      const { error } = await tenantClient(asTenantId(row.tenant_id))
        .from("site_seo_audits")
        .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "tenant_id,site_id" });
      if (error) throw new Error(error.message);
    } catch (e) {
      console.warn(`[site-seo] cache write failed site=${row.site_id}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  },
  crawl: (url, paths) => runAuditForUrl(url, paths),
  now: () => Date.now(),
};
